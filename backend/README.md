# Backend｜生活圈 AI 助理

FastAPI 服務，把前端聊天室接到 Amazon Bedrock，並用掛在 S3 上的 Bedrock
知識庫做檢索增強（RAG）。做法參考同一層 workspace 的 `AWS-s3-KB-Test` 專案。

## 流向

```text
瀏覽器 (Vue SPA)
   |  POST /api/chat        同源、Server-Sent Events 串流
   v
nginx (web 容器, :8080)     反向代理 /api/ -> chat:8000
   |
   v
FastAPI (chat 容器, :8000)  app.py
   |
   +-- bedrock-agent-runtime.retrieve      -> 知識庫（資料來源在 S3）
   +-- bedrock-runtime.converse_stream     -> Claude，逐字串流回前端
```

`chat` 容器沒有對外開 port，只能經由 `web` 容器代理進來，所以不會多一個對外
的攻擊面，前端也因為同源而不需要 CORS。

## 設定

全部走環境變數，預設值在 `app.py` 最上面，compose 的對應在根目錄
`.env.example`。**AWS 憑證不在其中**：容器靠 EC2 的 IAM Role（IMDS）取得，
不要把 access key 放進 `.env`、compose 或前端。

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `AWS_REGION` | `us-west-2` | Bedrock 所在區域 |
| `BEDROCK_MODEL_ID` | Claude Sonnet 4.5 | 對話模型 |
| `MAX_TOKENS` | `2048` | 單次回覆上限 |
| `KNOWLEDGE_BASE_ID` | 空 | 留空就不檢索，只用模型本身回答 |
| `KB_NUM_RESULTS` | `5` | 每次檢索取幾個片段 |
| `KB_SEARCH_MODE` | `managed` | `managed` 為 S3 Vectors 這類受管知識庫，`vector` 為自建向量庫 |
| `SYSTEM_PROMPT` | 見 `app.py` | 留空使用內建的生活圈助理提示詞 |
| `MAX_HISTORY_MESSAGES` | `20` | 送給模型的歷史訊息上限 |
| `MAX_MESSAGE_CHARS` | `4000` | 單則訊息長度上限 |

`KB_SEARCH_MODE` 填錯時後端會接到 `ValidationException`，並自動改用另一種
search config 重試一次，所以設定寫反不會直接壞掉。

## IAM 權限

Instance profile 至少需要：

- `bedrock:InvokeModelWithResponseStream`（對應 `converse_stream`）
- `bedrock:Retrieve`，資源指向那個知識庫的 ARN

知識庫本身讀 S3 是由 Bedrock 的 service role 負責，不是這台機器的角色。

## 端點

- `POST /api/chat` — 收 `{ messages: [{role, content}], use_kb, context }`，
  回 SSE。事件型別有 `{sources}`（先送）、`{text}`（逐字）、`{done}`、`{error}`。
- `GET /api/health` — 容器 healthcheck 用。**故意不呼叫 AWS**，這樣它反映的是
  「服務本身活著」，不會因為雲端設定有問題就讓容器被判定壞掉而反覆重啟。

## 安全性（尚未處理，上線前要補）

`/api/chat` **目前沒有任何身分驗證**。任何能連到這個站的人都可以送出提問，
而每一次提問都會產生 Bedrock 費用。目前只有兩層很薄的防護：

1. nginx 對每個來源 IP 限流（`docker/nginx/default.conf`，30 req/min、burst 10）；
2. 後端限制歷史訊息數量與單則長度。

這擋得住手滑和輕度濫用，擋不住有心人。正式對外前建議加上 Cognito JWT 或至少
一組共享密鑰，並考慮把限流搬到 CloudFront／WAF。另外站台目前是純 HTTP，
提問內容在傳輸中沒有加密。

## 本機開發

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --reload --port 8000
```

沒有 AWS 憑證也起得來：`/api/health` 正常，`/api/chat` 會回一個 `error` 事件，
前端收到後會自動退回本機情境回覆，聊天室不會卡住。
