"""/api/chat —— 帶工具迴圈的 SSE 串流對話。

這裡的核心是 tool-use 迴圈：模型可以在一次回答裡多次呼叫工具（先查排名、
再撈名冊），我們把每一輪的結果餵回去，直到它不再要求工具為止。

`MAX_TOOL_ROUNDS` 是硬性上限。沒有上限的話，模型偶爾會反覆查同一件事，
既拖時間也燒 token，而使用者只會看到一個一直不動的氣泡。
"""

from __future__ import annotations

import logging

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app import config, prompts
from app.ai.tools import TOOL_SPECS, dispatch, json_size, summarise_for_ui
from app.bedrock import kb_retriever, sse, stream_one_turn, to_bedrock_messages

logger = logging.getLogger("living-circle-chat.chat")

router = APIRouter()


class Message(BaseModel):
    role: str
    content: str


class ChatContext(BaseModel):
    """前端目前的畫面狀態，讓回答能貼合使用者正在看的分頁。"""

    activeView: str | None = None
    minuteLimit: int | None = None


class ChatRequest(BaseModel):
    messages: list[Message] = Field(default_factory=list)
    use_kb: bool = True
    context: ChatContext | None = None


@router.post("/api/chat")
def chat(request: ChatRequest):
    messages = to_bedrock_messages(request.messages)

    def event_stream():
        if not messages:
            yield sse({"error": "沒有可送出的訊息內容。"})
            return

        working = list(messages)
        system_prompt = prompts.build_system_prompt([], request.context)
        tool_context = {"retrieve": kb_retriever if config.KNOWLEDGE_BASE_ID else None}
        tool_specs = TOOL_SPECS if config.ENABLE_TOOLS else None
        # 累積這次回答總共讀了哪些資料，回傳給前端顯示來源
        used_tools: list[dict] = []
        kb_sources: list[dict] = []

        try:
            for round_index in range(config.MAX_TOOL_ROUNDS + 1):
                stop_payload = None
                tool_requests: list[dict] = []

                for kind, payload in stream_one_turn(working, system_prompt, tool_specs):
                    if kind == "text":
                        yield sse({"text": payload})
                    elif kind == "tool_use":
                        tool_requests.append(payload)
                        summary = summarise_for_ui(payload["name"], payload["input"])
                        used_tools.append({"tool": payload["name"], "summary": summary})
                        # 讓使用者看到 AI 正在讀什麼，而不是盯著一個不動的氣泡
                        yield sse({"tool": {"name": payload["name"], "summary": summary}})
                    elif kind == "stop":
                        stop_payload = payload

                if not tool_requests or stop_payload is None:
                    break

                if round_index >= config.MAX_TOOL_ROUNDS:
                    logger.warning("tool round limit reached (%s)", config.MAX_TOOL_ROUNDS)
                    yield sse(
                        {"error": f"查詢次數超過上限（{config.MAX_TOOL_ROUNDS} 輪），已中止。"}
                    )
                    break

                working.append({"role": "assistant", "content": stop_payload["assistant_blocks"]})

                tool_results = []
                for req in tool_requests:
                    result, is_error = dispatch(req["name"], req["input"], tool_context)
                    logger.info(
                        "tool=%s error=%s size=%s input=%s",
                        req["name"], is_error, json_size(result), req["input"],
                    )
                    if req["name"] == "search_documents" and not is_error:
                        for item in result.get("results", []):
                            if item.get("uri"):
                                kb_sources.append(
                                    {"uri": item["uri"], "score": item.get("score", 0)}
                                )
                    tool_results.append(
                        {
                            "toolResult": {
                                "toolUseId": req["toolUseId"],
                                "content": [{"json": result}],
                                **({"status": "error"} if is_error else {}),
                            }
                        }
                    )
                working.append({"role": "user", "content": tool_results})

            if kb_sources:
                # 去重後才送，同一份文件可能被多個片段命中
                seen = set()
                unique = []
                for item in kb_sources:
                    if item["uri"] in seen:
                        continue
                    seen.add(item["uri"])
                    unique.append(item)
                yield sse({"sources": unique})
            if used_tools:
                yield sse({"tools_used": used_tools})
            yield sse({"done": True})

        except ClientError as error:
            message = error.response.get("Error", {}).get("Message", str(error))
            logger.error("Bedrock error: %s", message)
            yield sse({"error": message})
        except BotoCoreError as error:
            # 沒有憑證、拿不到 IAM Role、連不出去都會落在這裡。
            logger.error("Bedrock connection error: %s", error)
            yield sse({"error": f"無法連線到 Bedrock：{error}"})
        except Exception as error:  # noqa: BLE001
            logger.exception("Unexpected error")
            yield sse({"error": str(error)})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # 少了這個，反向代理會把 SSE 緩衝起來，串流變成一次吐完。
            "X-Accel-Buffering": "no",
        },
    )
