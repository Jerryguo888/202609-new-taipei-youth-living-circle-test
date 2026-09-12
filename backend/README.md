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
| `ENABLE_CHARTS` | `true` | 是否要求模型畫圖表，設 `false` 只回文字 |
| `MAX_HISTORY_MESSAGES` | `20` | 送給模型的歷史訊息上限 |
| `MAX_MESSAGE_CHARS` | `4000` | 單則訊息長度上限 |

`KB_SEARCH_MODE` 填錯時後端會接到 `ValidationException`，並自動改用另一種
search config 重試一次，所以設定寫反不會直接壞掉。

`SYSTEM_PROMPT` 只換掉人格設定，圖表指示是另一個常數（`CHART_INSTRUCTIONS`）
永遠附加在後面，所以覆寫提示詞不會把畫圖能力一起弄掉。

## 圖表

模型會把圖表放在 ```` ```chart ```` 圍籬區塊裡，內容是一小段受限的 HTML
（橫條圖或表格）。前端**不會**直接渲染模型輸出：

```text
backend/app.py  CHART_INSTRUCTIONS      告訴模型可用的標籤與 class
      ↓
frontend/src/lib/chartHtml.js           DOMPurify 白名單消毒 + class/style 過濾
      ↓
frontend/src/style/global.css           .ai-chart* 實際樣式
```

這三處的 class 清單必須一致，改一邊沒改另一邊，圖表會被清掉一部分。

模型能控制的只有長條的 `width: N%`，顏色和排版都由 CSS 決定。對話的散文部分
完全不走 HTML 路徑，仍由 Vue 以純文字轉義輸出。

之所以要消毒而不是直接 `v-html`：模型讀得到 S3 知識庫，而知識庫內容是不可信
輸入。只要有人把一份帶提示注入的文件放進 S3，就可能讓模型吐出
`<img onerror=...>`，直接渲染等於開一個 XSS，而且觸發來源是我們自己的後端。
消毒規則涵蓋 script、事件屬性、`javascript:` URL、外部資源載入、CSS `url()`
外連與 position 覆蓋等手法。

## 部署到 EC2

### 1. IMDS hop limit 必須是 2（最容易踩的一個）

容器裡的 boto3 是透過 IMDSv2 拿 instance role 憑證。EC2 的
`http-put-response-hop-limit` 預設是 1，而**從 docker 容器出去會多算一個 hop**，
所以 token 請求拿不到回應，症狀就是 `Unable to locate credentials`。

```bash
aws ec2 modify-instance-metadata-options \
  --instance-id <instance-id> \
  --http-tokens required \
  --http-put-response-hop-limit 2
```

`AWS-s3-KB-Test` 已經在 EC2 上跑通，所以那台機器應該早就設好了；換到新的
instance 才需要重新設定。部署 workflow 會在最後檢查容器能不能取得憑證，
拿不到會發 warning 並附上這條指令。

### 2. Instance profile 權限

至少需要：

- `bedrock:InvokeModelWithResponseStream`（對應 `converse_stream`）
- `bedrock:Retrieve`，資源指向知識庫的 ARN

知識庫本身讀 S3 是由 Bedrock 的 service role 負責，不是這台機器的角色。

### 3. 跟 AWS-s3-KB-Test 共存

那個專案發佈在 host 的 8001，容器叫 `bedrock-chat`；這裡是 8080（`web`），
`chat` 不對外開 port，容器名前綴 `nt-youth-living-circle-`，所以兩者可以同時
在同一台機器上跑，不會撞 port 也不會撞名字。

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
