"""Amazon Bedrock 的所有往來都集中在這裡。

    瀏覽器 (Vue SPA)
        |  POST /api/chat  同源、SSE 串流
        v
    nginx (web 容器) --反向代理--> 這支服務 (chat 容器, :8000)
                                      |
                                      +-- bedrock-agent-runtime.retrieve
                                      |     -> 知識庫，資料來源是 S3
                                      +-- bedrock-runtime.converse_stream
                                            -> Claude

憑證一律走 IAM Role（EC2 instance profile），boto3 會自己取得。
不要在這裡或前端放 access key。
"""

from __future__ import annotations

import json
import logging

import boto3
from botocore.exceptions import ClientError

from app import config

logger = logging.getLogger("living-circle-chat.bedrock")

# 建立 client 不會驗證憑證，憑證是呼叫時才解析，所以這裡不會因為沒憑證而失敗。
# read_timeout 設得比 nginx 的 proxy_read_timeout 短，讓錯誤由這裡回報而不是
# 被 502 蓋掉 —— 502 看不出是超時還是服務掛了。
_boto_config = config.boto_config(read_timeout=60)

bedrock = boto3.client("bedrock-runtime", config=_boto_config)
bedrock_agent = boto3.client("bedrock-agent-runtime", config=_boto_config)


def sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def to_bedrock_messages(messages) -> list[dict]:
    """轉成 Bedrock converse 的格式，同時做長度與角色的防呆。

    Bedrock 要求 role 只能是 user/assistant、內容不可為空，而且必須以 user 結尾，
    否則會回 ValidationException。這裡直接把不合格的資料整理掉。
    """
    cleaned: list[dict] = []
    for message in messages[-config.MAX_HISTORY_MESSAGES :]:
        role = message.role if message.role in ("user", "assistant") else "user"
        text = (message.content or "").strip()[: config.MAX_MESSAGE_CHARS]
        if not text:
            continue
        # converse 不接受同一角色連續出現，合併成同一則。
        if cleaned and cleaned[-1]["role"] == role:
            cleaned[-1]["content"][0]["text"] += "\n" + text
            continue
        cleaned.append({"role": role, "content": [{"text": text}]})

    while cleaned and cleaned[0]["role"] != "user":
        cleaned.pop(0)
    return cleaned


# --------------------------------------------------------------------------
# 知識庫檢索
# --------------------------------------------------------------------------
def _retrieve(config_key: str, query: str, top_k: int) -> dict:
    return bedrock_agent.retrieve(
        knowledgeBaseId=config.KNOWLEDGE_BASE_ID,
        retrievalQuery={"text": query},
        retrievalConfiguration={config_key: {"numberOfResults": top_k}},
    )


def retrieve_from_kb(query: str, top_k: int | None = None) -> list[dict]:
    """向知識庫檢索片段；來源是掛在 KB 上的 S3 資料。"""
    primary = (
        "managedSearchConfiguration"
        if config.KB_SEARCH_MODE == "managed"
        else "vectorSearchConfiguration"
    )
    fallback = (
        "vectorSearchConfiguration"
        if primary == "managedSearchConfiguration"
        else "managedSearchConfiguration"
    )

    results = top_k or config.KB_NUM_RESULTS

    try:
        response = _retrieve(primary, query, results)
    except ClientError as error:
        # 知識庫型別跟設定對不上時 Bedrock 會回 ValidationException，
        # 換另一種 search config 再試一次，免得因為設定寫錯就整個不能用。
        if error.response.get("Error", {}).get("Code") != "ValidationException":
            raise
        logger.warning("KB %s rejected, retrying with %s", primary, fallback)
        response = _retrieve(fallback, query, results)

    chunks = []
    for item in response.get("retrievalResults", []):
        chunks.append(
            {
                "text": item.get("content", {}).get("text", ""),
                "uri": item.get("location", {}).get("s3Location", {}).get("uri", ""),
                "score": item.get("score", 0),
            }
        )
    return [chunk for chunk in chunks if chunk["text"]]


def kb_retriever(query: str, top_k: int) -> list[dict]:
    """給 search_documents 工具用的檢索函式；沒設 KB 就回空清單。"""
    if not config.KNOWLEDGE_BASE_ID:
        return []
    return retrieve_from_kb(query, top_k)


# --------------------------------------------------------------------------
# 對話串流
# --------------------------------------------------------------------------
def stream_one_turn(messages: list[dict], system_prompt: str, tool_specs: list[dict] | None):
    """跑一次 converse_stream，把事件轉成 (kind, payload) 交給外層處理。

    kind:
      text       要串給前端的文字
      tool_use   模型要求呼叫工具，payload 是 {toolUseId, name, input}
      stop       這一輪結束，payload 是 {reason, assistant_blocks}
    """
    kwargs = {
        "modelId": config.MODEL_ID,
        "messages": messages,
        "system": [{"text": system_prompt}],
        "inferenceConfig": {"maxTokens": config.MAX_TOKENS},
    }
    if tool_specs:
        kwargs["toolConfig"] = {"tools": tool_specs}

    response = bedrock.converse_stream(**kwargs)

    # toolUse 的參數是分段串流過來的（contentBlockDelta.delta.toolUse.input
    # 是 JSON 字串的片段），必須累積到 contentBlockStop 才能解析。
    pending: dict[int, dict] = {}
    assistant_blocks: list[dict] = []
    text_buffer: list[str] = []

    for event in response["stream"]:
        if "contentBlockStart" in event:
            index = event["contentBlockStart"]["contentBlockIndex"]
            start = event["contentBlockStart"].get("start", {})
            if "toolUse" in start:
                pending[index] = {
                    "toolUseId": start["toolUse"]["toolUseId"],
                    "name": start["toolUse"]["name"],
                    "raw_input": "",
                }

        elif "contentBlockDelta" in event:
            index = event["contentBlockDelta"]["contentBlockIndex"]
            delta = event["contentBlockDelta"]["delta"]
            if "text" in delta and delta["text"]:
                text_buffer.append(delta["text"])
                yield "text", delta["text"]
            elif "toolUse" in delta and index in pending:
                pending[index]["raw_input"] += delta["toolUse"].get("input", "")

        elif "contentBlockStop" in event:
            index = event["contentBlockStop"]["contentBlockIndex"]
            if index in pending:
                block = pending.pop(index)
                try:
                    parsed = json.loads(block["raw_input"]) if block["raw_input"].strip() else {}
                except json.JSONDecodeError:
                    logger.warning("tool input was not valid JSON: %r", block["raw_input"])
                    parsed = {}
                block["input"] = parsed
                assistant_blocks.append(
                    {
                        "toolUse": {
                            "toolUseId": block["toolUseId"],
                            "name": block["name"],
                            "input": parsed,
                        }
                    }
                )
                yield "tool_use", block

        elif "messageStop" in event:
            if text_buffer:
                # 文字區塊要放在 toolUse 之前，順序需與模型輸出一致
                assistant_blocks.insert(0, {"text": "".join(text_buffer)})
            yield "stop", {
                "reason": event["messageStop"].get("stopReason"),
                "assistant_blocks": assistant_blocks,
            }
