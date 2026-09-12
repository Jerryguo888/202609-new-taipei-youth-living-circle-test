"""生活圈 AI 助理後端：Amazon Bedrock + S3 知識庫。

架構（沿用 AWS-s3-KB-Test 的做法，改成掛在本專案的 nginx 後面）：

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

import json
import logging
import os

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("living-circle-chat")

def env_str(name: str, default: str) -> str:
    """compose 的 ${VAR:-} 會把未設定的變數變成空字串，而 os.getenv 只有在
    「完全沒有這個變數」時才會用 default，所以空字串要自己視為未設定。"""
    return (os.getenv(name) or "").strip() or default


def env_int(name: str, default: int) -> int:
    try:
        return int(env_str(name, str(default)))
    except ValueError:
        logger.warning("%s is not an integer, falling back to %s", name, default)
        return default


AWS_REGION = env_str("AWS_REGION", "us-west-2")
MODEL_ID = env_str("BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-5-20250929-v1:0")
MAX_TOKENS = env_int("MAX_TOKENS", 2048)

# 空字串代表不接知識庫，只用模型本身回答；這樣沒設定 KB 也不會壞掉。
KNOWLEDGE_BASE_ID = (os.getenv("KNOWLEDGE_BASE_ID") or "").strip()
KB_NUM_RESULTS = env_int("KB_NUM_RESULTS", 5)
# 「managed」對應 S3 Vectors 這類受管知識庫，「vector」對應自建向量庫。
# 兩個 boto3 都支援，但吃錯會被 ValidationException 擋掉，所以可切換＋自動退回。
KB_SEARCH_MODE = env_str("KB_SEARCH_MODE", "managed").lower()

# 這個端點沒有身分驗證（見 backend/README.md 的安全性說明），所以在這裡先擋掉
# 明顯過量的請求，避免有人拿它去燒 Bedrock 的費用。
MAX_HISTORY_MESSAGES = env_int("MAX_HISTORY_MESSAGES", 20)
MAX_MESSAGE_CHARS = env_int("MAX_MESSAGE_CHARS", 4000)

DEFAULT_SYSTEM_PROMPT = (
    "你是「新北青年生活圈」決策平台的 AI 助理，協助分析青年人口熱區、"
    "公共資源缺口、30 分鐘交通可達範圍與年度預算配置。"
    "請用繁體中文回答，語氣專業但好懂。"
    "涉及數字時要說明是推估還是實際資料，不要給沒有依據的精確數字。"
)
SYSTEM_PROMPT = env_str("SYSTEM_PROMPT", DEFAULT_SYSTEM_PROMPT)

ENABLE_CHARTS = env_str("ENABLE_CHARTS", "true").lower() not in ("false", "0", "no")

# 圖表指示刻意跟 SYSTEM_PROMPT 分開，並且永遠附加在後面。
# 這樣有人用環境變數換掉人格設定時，不會連圖表能力一起弄掉。
#
# 這份標籤與 class 的清單就是前端 sanitizer 的允許清單（見
# frontend/src/lib/chartHtml.js）。兩邊必須一致：模型用了清單外的東西，
# 前端會直接清掉，圖表就會缺一塊。改這裡務必同步改前端。
CHART_INSTRUCTIONS = """
## 畫圖表

當答案涉及排名、比較、佔比或分佈時，除了文字說明，請一併輸出一段圖表。
圖表要放在 ```chart 圍籬區塊裡，區塊內只能是下面規定的 HTML。

橫條圖（最常用，適合行政區排名）：

```chart
<div class="ai-chart">
  <h4 class="ai-chart-title">20~29 歲青年人口前三名</h4>
  <div class="ai-chart-row">
    <span class="ai-chart-label">板橋區</span>
    <span class="ai-chart-track"><span class="ai-chart-bar" style="width: 100%"></span></span>
    <span class="ai-chart-value">82,431 人</span>
  </div>
  <div class="ai-chart-row">
    <span class="ai-chart-label">中和區</span>
    <span class="ai-chart-track"><span class="ai-chart-bar" style="width: 78%"></span></span>
    <span class="ai-chart-value">64,512 人</span>
  </div>
  <p class="ai-chart-note">資料為推估值</p>
</div>
```

表格（適合多欄位對照）：

```chart
<table class="ai-table">
  <caption>各行政區托育稀缺率</caption>
  <thead><tr><th scope="col">行政區</th><th scope="col">稀缺率</th></tr></thead>
  <tbody><tr><th scope="row">林口區</th><td>68%</td></tr></tbody>
</table>
```

規則，請嚴格遵守：

1. 只能使用這些標籤：div、span、h4、p、strong、em、br、ul、ol、li、
   table、caption、thead、tbody、tr、th、td。
2. 只能使用這些 class：ai-chart、ai-chart-title、ai-chart-row、
   ai-chart-label、ai-chart-track、ai-chart-bar、ai-chart-bar-alt、
   ai-chart-value、ai-chart-note、ai-table。
3. 唯一允許的 style 是長條的寬度百分比，例如 style="width: 62%"。
   不要寫顏色、字型、position 或任何其他 CSS。
4. 絕對不要輸出 script、style、img、svg、iframe、連結、on* 事件屬性，
   或任何會載入外部資源的東西。這些都會被前端移除。
5. 長條寬度用相對比例：最大值那一條給 100%，其餘按比例換算。
6. 一次最多兩張圖表，每張最多 10 列，否則畫面會太擁擠。
7. 圍籬區塊外面要有文字結論，不要只丟圖表。數字沿用知識庫或前文的資料，
   沒有依據時不要自己編。
"""

# 逾時設得比 nginx 的 proxy_read_timeout 短，讓錯誤由這裡回報而不是被 502 蓋掉。
_boto_config = Config(
    region_name=AWS_REGION,
    connect_timeout=5,
    read_timeout=60,
    retries={"max_attempts": 2, "mode": "standard"},
)

# 建立 client 不會驗證憑證，憑證是呼叫時才解析，所以這裡不會因為沒憑證而失敗。
bedrock = boto3.client("bedrock-runtime", config=_boto_config)
bedrock_agent = boto3.client("bedrock-agent-runtime", config=_boto_config)

app = FastAPI(title="Living Circle Chat", docs_url=None, redoc_url=None)


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


def sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def to_bedrock_messages(messages: list[Message]) -> list[dict]:
    """轉成 Bedrock converse 的格式，同時做長度與角色的防呆。

    Bedrock 要求 role 只能是 user/assistant、內容不可為空，而且必須以 user 結尾，
    否則會回 ValidationException。這裡直接把不合格的資料整理掉。
    """
    cleaned: list[dict] = []
    for message in messages[-MAX_HISTORY_MESSAGES:]:
        role = message.role if message.role in ("user", "assistant") else "user"
        text = (message.content or "").strip()[:MAX_MESSAGE_CHARS]
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


def _retrieve(config_key: str, query: str) -> dict:
    return bedrock_agent.retrieve(
        knowledgeBaseId=KNOWLEDGE_BASE_ID,
        retrievalQuery={"text": query},
        retrievalConfiguration={config_key: {"numberOfResults": KB_NUM_RESULTS}},
    )


def retrieve_from_kb(query: str) -> list[dict]:
    """向知識庫檢索片段；來源是掛在 KB 上的 S3 資料。"""
    primary = (
        "managedSearchConfiguration"
        if KB_SEARCH_MODE == "managed"
        else "vectorSearchConfiguration"
    )
    fallback = (
        "vectorSearchConfiguration"
        if primary == "managedSearchConfiguration"
        else "managedSearchConfiguration"
    )

    try:
        response = _retrieve(primary, query)
    except ClientError as error:
        # 知識庫型別跟設定對不上時 Bedrock 會回 ValidationException，
        # 換另一種 search config 再試一次，免得因為設定寫錯就整個不能用。
        if error.response.get("Error", {}).get("Code") != "ValidationException":
            raise
        logger.warning("KB %s rejected, retrying with %s", primary, fallback)
        response = _retrieve(fallback, query)

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


def build_system_prompt(chunks: list[dict], context: ChatContext | None) -> str:
    parts = [SYSTEM_PROMPT]

    if ENABLE_CHARTS:
        parts.append(CHART_INSTRUCTIONS.strip())

    if context and (context.activeView or context.minuteLimit):
        state = []
        if context.activeView:
            state.append(f"目前分頁：{context.activeView}")
        if context.minuteLimit:
            state.append(f"目前設定的時間上限：{context.minuteLimit} 分鐘")
        parts.append("使用者畫面狀態（回答時可參考）：" + "、".join(state))

    if chunks:
        context_block = "\n\n".join(
            f"[參考資料 {index + 1} | 來源：{chunk['uri']}]\n{chunk['text']}"
            for index, chunk in enumerate(chunks)
        )
        parts.append(
            "以下是從知識庫檢索到的參考資料，請優先依據這些資料回答；"
            "資料不足時要明確說明，不要編造內容。\n\n" + context_block
        )

    return "\n\n".join(parts)


@app.get("/api/health")
def health():
    """容器 healthcheck 用，故意不呼叫 AWS，才能反映服務本身活著。"""
    return {
        "status": "ok",
        "region": AWS_REGION,
        "model": MODEL_ID,
        "knowledgeBase": bool(KNOWLEDGE_BASE_ID),
    }


@app.post("/api/chat")
def chat(request: ChatRequest):
    messages = to_bedrock_messages(request.messages)

    def event_stream():
        if not messages:
            yield sse({"error": "沒有可送出的訊息內容。"})
            return

        chunks: list[dict] = []
        if request.use_kb and KNOWLEDGE_BASE_ID:
            last_user = next(
                (m["content"][0]["text"] for m in reversed(messages) if m["role"] == "user"),
                "",
            )
            if last_user:
                try:
                    chunks = retrieve_from_kb(last_user)
                except (ClientError, BotoCoreError) as error:
                    # 檢索失敗不該讓整個對話失敗，退化成不帶知識庫繼續回答。
                    logger.error("KB retrieve failed: %s", error)
                if chunks:
                    yield sse(
                        {
                            "sources": [
                                {"uri": chunk["uri"], "score": chunk["score"]}
                                for chunk in chunks
                            ]
                        }
                    )

        try:
            response = bedrock.converse_stream(
                modelId=MODEL_ID,
                messages=messages,
                system=[{"text": build_system_prompt(chunks, request.context)}],
                inferenceConfig={"maxTokens": MAX_TOKENS},
            )
            for event in response["stream"]:
                if "contentBlockDelta" in event:
                    text = event["contentBlockDelta"]["delta"].get("text", "")
                    if text:
                        yield sse({"text": text})
                elif "messageStop" in event:
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
