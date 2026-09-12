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
FastAPI (chat 容器, :8000)  app/main.py
   |
   +-- bedrock-agent-runtime.retrieve      -> 知識庫（資料來源在 S3）
   +-- bedrock-runtime.converse_stream     -> Claude，逐字串流回前端
```

`chat` 容器沒有對外開 port，只能經由 `web` 容器代理進來，所以不會多一個對外
的攻擊面，前端也因為同源而不需要 CORS。

## 程式結構

```text
backend/
├── app/                    可 import 的程式；容器裡在 /srv/app
│   ├── config.py           所有環境變數與路徑，其他模組不自己讀 os.getenv
│   ├── prompts.py          系統提示詞（人格／工具說明／圖表契約三段可分開開關）
│   ├── bedrock.py          Bedrock client、KB 檢索、converse_stream 事件處理
│   ├── main.py             FastAPI 組裝點：建 app、掛 router、啟動警告
│   ├── routes.py           /api/health, /api/meta/*, /api/metrics/*, /api/records/*
│   ├── data/
│   │   ├── registry.py     讀 data_sources.yaml
│   │   ├── metrics.py      指標彙總查詢（本機快照／Athena）
│   │   ├── records.py      逐筆名冊查詢
│   │   └── fetch.py        抓取與正規化開放資料 API（fetch_all）
│   ├── ai/
│   │   ├── tools.py        工具 schema 與 dispatch
│   │   └── chat.py         /api/chat，含 tool-use 迴圈
│   └── admin/
│       ├── auth.py         密碼雜湊、session、鎖定
│       └── routes.py       /api/admin/*
├── scripts/                CLI 進入點，只做參數解析，邏輯都在 app/
│   ├── create_admin.py     建立第一個管理員
│   ├── build_snapshot.py   產生指標快照
│   └── fetch_sources.py    每月更新資料
├── curated/                內建資料（image 的墊底，/data 有新版就用新版）
└── data_sources.yaml
```

兩個刻意的取捨：

**`app/` 只放函式庫，`scripts/` 只放 CLI。** 後台的「立即更新」按鈕和排程的
`scripts/fetch_sources.py` 都呼叫同一個 `fetch.fetch_all()`。之前後台是靠假造
`sys.argv` 再呼叫 CLI 的 `main()`，能動但兩條路徑很容易分岔。

**路徑一律從 `config.PROJECT_ROOT` 推導，不依賴工作目錄。** 舊版寫
`curated/metrics_snapshot.json` 這種相對路徑，只有在 CWD 剛好是 `backend/`
時才找得到，換個地方執行腳本就會說找不到快照。

容器內 `WORKDIR=/srv` 而不是 `/app`：套件本身叫 `app`，用 `/app` 會變成
`/app/app` 那種讀起來很奇怪的路徑。`PYTHONPATH=/srv` 讓
`python scripts/create_admin.py` 這種寫法可以直接用。

## 設定

全部走環境變數，預設值集中在 `app/config.py`，compose 的對應在根目錄
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
| `SYSTEM_PROMPT` | 見 `app/prompts.py` | 留空使用內建的生活圈助理提示詞 |
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
backend/app/prompts.py  CHART_INSTRUCTIONS  告訴模型可用的標籤與 class
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

### 1. IMDS hop limit 必須是 2（執行環境最容易踩的一個）

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

### 2. 模型啟用（一次性，不是 EC2 role 的事）

Bedrock 的「Model access」頁面已於 2025-10 retired，`PutFoundationModelEntitlement`
這個 IAM 權限同時失效。現在所有 foundation model 預設就是啟用的，但第一次呼叫
第三方模型時 Bedrock 會在背景自動走 AWS Marketplace 訂閱流程，前置條件有三個：

- 執行第一次呼叫的身分需要 `aws-marketplace:Subscribe`、`Unsubscribe`、
  `ViewSubscriptions`
- **Anthropic 模型必須先填 First Time Use 表單**（每個帳號一次，或在
  organization 管理帳號填一次由成員帳號繼承）。從 Bedrock console 的
  model catalog 選一個 Anthropic 模型即可填，或呼叫 `PutUseCaseForModelAccess`。
  表單要填用途說明和一個網址（個人開發者用 GitHub 或作品集連結即可）。
- 帳號要有有效的 AWS Marketplace 付款方式

**不要把 marketplace 權限加到 EC2 的 instance profile。** 那些權限只有「帳號裡
第一次啟用該模型」時需要，用管理者身分做完這一次就好；模型啟用後單純呼叫不需要
marketplace 權限。給一台對外的網頁伺服器 `aws-marketplace:Subscribe` 是不必要的
擴權。

如果 `AWS-s3-KB-Test` 已經在同一個帳號同一個 region 用同一個模型跑通，
這一步等於做完了，不必重做。

### 3. Instance profile 權限

至少需要：

- `bedrock:InvokeModel` 與 `bedrock:InvokeModelWithResponseStream`（對應 `converse_stream`）
- `bedrock:Retrieve`，資源指向知識庫的 ARN

`BEDROCK_MODEL_ID` 預設是 `us.anthropic.…`，開頭的 `us.` 代表**跨區推論設定檔**。
這種情況權限必須同時涵蓋兩種 ARN：

- 設定檔本身：`arn:aws:bedrock:us-west-2:<帳號>:inference-profile/us.anthropic.…`
- 目的地各區的 foundation model：
  `arn:aws:bedrock:us-east-1::foundation-model/anthropic.…`（us-east-1、us-east-2、us-west-2）

只給一半會得到 `AccessDeniedException`，而訊息不會告訴你缺哪一半。注意
foundation-model 的 ARN 帳號欄位是空的（連續兩個冒號）。

知識庫本身讀 S3 是由 Bedrock 的 service role 負責，不是這台機器的角色。

啟用 Athena 時（`METRIC_BACKEND=athena`）還需要 `athena:StartQueryExecution`／
`GetQueryExecution`／`GetQueryResults`／`StopQueryExecution`、
`glue:GetTable`／`GetPartitions`／`GetDatabase`，以及 curated 前綴的
`s3:GetObject`＋`ListBucket` 和 athena-results 前綴的 `s3:PutObject`
（Athena 會把結果寫回 S3 再讓你讀）。

### 3. 跟 AWS-s3-KB-Test 共存

那個專案發佈在 host 的 8001，容器叫 `bedrock-chat`；這裡是 8080（`web`），
`chat` 不對外開 port，容器名前綴 `nt-youth-living-circle-`，所以兩者可以同時
在同一台機器上跑，不會撞 port 也不會撞名字。

## 端點

- `POST /api/chat` — 收 `{ messages: [{role, content}], use_kb, context }`，回 SSE。
  事件型別：`{tool}`（模型選了某份資料，即時顯示用）、`{text}`（逐字）、
  `{tools_used}`、`{sources}`、`{done}`、`{error}`。
- `GET /api/meta/datasets` — 資料目錄：指標、行政區、年度、快照時點、注意事項。
  與工具 `list_available_data` 共用同一份實作，文件不會跟實際能查的東西脫節。
- `GET /api/metrics/{metric}` — 數值查詢，參數同 `query_metrics` 工具。
  參數不合法回 400 並附可用選項。
- `GET /api/records/{table}` — 逐筆名冊，參數同 `lookup_records` 工具
  （`district`、`keyword`、`limit`）。
- `GET /api/health` — 容器 healthcheck 用。**故意不呼叫 AWS**，這樣它反映的是
  「服務本身活著」，不會因為雲端設定有問題就讓容器被判定壞掉而反覆重啟。

`/api/metrics` 和 AI 的 `query_metrics` 走同一個 `run_metric_query`，所以聊天室
講的數字和畫面上的圖表保證一致。兩邊各算一次一定會對不起來。

## AI 自己選資料（tool use）

模型有四個工具，由它自己決定用哪個、用幾次：

| 工具 | 用途 | 資料來源 |
| --- | --- | --- |
| `list_available_data` | 先看有哪些指標、名冊、行政區、年度可用 | 快照＋`data_sources.yaml` |
| `query_metrics` | 數字、排名、比較、逐年變化 | S3 curated / 指標快照 |
| `lookup_records` | 逐筆名冊：機構、地址、電話、時段、站點 | S3 curated / 名冊快照 |
| `search_documents` | 統計報表與政策文件 | Bedrock 知識庫 |

知識庫檢索是**工具**而不是每次都先跑一遍，原因有三：問「板橋區青年人口多少」
不需要語意檢索；數值題走 KB 本來就會答錯（向量檢索沒辦法排序或加總，模型只能
從撈回的片段裡猜一個看起來合理的數字）；讓模型自己選，UI 才能老實顯示這個答案
到底讀了什麼。

### API 資料不進知識庫

API 來源的資料一律只進 curated 層，走 `query_metrics` 或 `lookup_records`。
知識庫只留人工上傳的文件（主計處統計報表、政策說明）。

這不是為了省錢，是為了正確性。名冊是結構化資料：問「板橋區有哪些托育中心」時，
向量檢索比的是語意相似度，很容易把新莊的片段一起撈回來；而地址電話經過 embedding
再讓模型重述，是最容易出現幻覺的地方 —— 使用者會照著錯的門牌跑一趟。
`WHERE district = ?` 沒有這兩個問題，而且模型拿到的是原始資料列，
系統提示也明確要求地址電話原樣引用不得改寫。

副作用是 KB 保持很小，同步快、成本低。

### 名冊資料的坑

`app/data/fetch.py` 做了兩件不明顯但必要的正規化：

**行政區** 不要用 `([\u4e00-\u9fff]{1,4}區)` 這種正規表示式抽取。它在
「新北市板橋區」上會貪心地match到「北市板橋區」，實測會產生 38 個不存在的
行政區。改成拿快照裡權威的 29 個區名去比對，順便解決兩種髒資料：
「新北市汐止市樟樹一路」（2010 升格前舊名，沒有「區」字）和
「新北市三重水漾路」（直接省略行政區）。修正後 2712 筆記錄全部對得上，
未知與空白皆為 0。

**是否自費** 來源欄位 `own_expense` 的值是「是」／「否」。直接存的話關鍵字
搜尋完全無用，因為使用者和模型會用「自費」去找，而「是」裡面沒有這兩個字。
改存成「有自費疫苗」／「僅公費疫苗」—— 刻意選「僅公費」而不是「非自費」，
後者含有「自費」子字串會讓子字串搜尋把兩種都撈出來。
實測 686 筆分成 536／150，關鍵字「自費」零誤判。

### 每月更新資料（不需要重新部署）

資料更新跟程式部署是**分開**的。名冊讀取有兩層路徑：

```text
/data/records/<table>.json     具名 volume，每月更新寫進來（優先）
curated/records/<table>.json   烘進 image 的版本，第一次更新前的墊底
```

`RECORDS_DIR` 找不到檔案才會退回 image 內建版本，而且回傳值的 `notes` 會註明
「此表尚未執行過資料更新」，不會讓人誤以為看到的是最新資料。

手動更新：

```bash
docker compose run --rm refresh
```

自動更新由 `.github/workflows/refresh-data.yml` 每月排程（台灣時間每月 2 號
03:00），跑在既有的 self-hosted runner 上。用 Actions 排程而不是伺服器 crontab
的理由：排程進版控、每次執行有 log、可手動觸發、失敗有通知。crontab 半年後
沒人記得它存在，壞掉三個月也不會有人發現。

**執行中的容器不需要重啟。** 快取以檔案 mtime 為 key，外部行程覆寫檔案後下一次
查詢就會重讀。這點實測過：改掉 volume 裡的值之後，API 立刻回新值而
`RestartCount` 仍是 0。

如果快取只用「載入過就不再讀」的寫法，容器會一直回舊資料直到重啟 —— 而重啟不會
發生，因為部署沒有變。這是這種架構最容易忽略的坑。

### 壞資料不會覆蓋好資料

每月自動執行的情境下沒有人會盯著輸出，而「名冊突然變成 0 筆」在畫面上看起來
只是「查不到資料」。所以 `app/data/fetch.py` 有兩道關卡：

- 抓到 0 筆 → 保留既有檔案，不覆蓋
- 筆數比上次掉超過 `--max-shrink`（預設 50%）→ 保留既有檔案，不覆蓋

上游真的大幅精簡資料時，用 `--max-shrink 0.9` 或在 workflow 手動觸發時調整門檻
放行。寫檔用「暫存檔 + `os.replace`」，同一個檔案系統上是原子操作，
所以執行中的後端不會讀到寫一半的 JSON。

單獨重抓某個表：

```bash
cd backend
python scripts/fetch_sources.py --only vaccine_clinics
```

輸出欄位名刻意跟 Athena curated 層一致，所以本機檔案和 Athena 兩種後端共用同一組
工具參數。

YouBike 只留靜態欄位（站點、總柱數）。即時的可借車輛數刻意不進月更新快照 ——
那會變成一組看起來精確但過期好幾週的數字，比沒有更糟。

### 看資料多舊

`GET /api/meta/datasets` 的 `data_freshness` 會列出每個表的 `generated_at`、
筆數，以及是否還在用 image 內建版本（`bundled_fallback`）。
這份資料也會給模型，讓它能講出「依 X 月抓取的資料」。

前端會顯示兩塊：等待中的「正在查詢…」即時狀態，以及回答完成後的「讀取的資料」
清單。tool use 會讓首字延遲變長（模型要先查再答），那段等待需要有東西可看。

`MAX_TOOL_ROUNDS`（預設 4）限制一次回答最多幾輪工具往返，避免模型反覆查詢
拖時間又燒 token。

### 為什麼模型不能寫 SQL

`app/data/metrics.py` 只接受列舉過的 metric / by / year / district / age_band / order /
limit，SQL 由固定樣板組出來，過濾值走 Athena 的 `ExecutionParameters`
（等同 prepared statement）而不是字串拼接。

模型讀得到知識庫，而知識庫內容是不可信輸入。放行自由 SQL 等於同時開了資料外洩
和無上限 Athena 帳單兩個洞。

## 資料層

```text
data_sources.yaml               資料來源清單（更新作業和 list_available_data 共用）
scripts/build_snapshot.py       從 curated CSV 產生指標快照，含加總對帳
curated/metrics_snapshot.json   本機/降級用的數值來源
app/data/registry.py            讀 data_sources.yaml
app/data/metrics.py             LocalSnapshotStore（現在）＋ AthenaStore（S3 curated）
app/data/records.py             逐筆名冊查詢
app/data/fetch.py               抓取與正規化開放資料 API
```

`METRIC_BACKEND=local`（預設）讀快照，沒有 AWS 也能跑。設成 `athena` 就查
S3 curated 層；Athena 不通時會自動退回快照，並在結果的 `notes` 標明來源，
讓模型知道自己拿到的是快取而不是即時查詢。

### 切換到 Athena

在 GitHub repo 的 Settings → Secrets and variables → Actions → **Variables** 設：

| Variable | 值 |
| --- | --- |
| `METRIC_BACKEND` | `athena` |
| `ATHENA_OUTPUT_LOCATION` | `s3://<bucket>/athena-results/`（必填） |
| `ATHENA_DATABASE` | Glue 資料庫名，預設 `ntpc_youth` |
| `ATHENA_WORKGROUP` | 預設 `primary` |

部署 workflow 有兩道關卡：

1. **部署前**：`METRIC_BACKEND=athena` 但 `ATHENA_OUTPUT_LOCATION` 沒設或不是
   `s3://` 開頭時直接讓部署失敗。Athena 沒有結果位置會拒絕所有查詢，
   而後端會安靜退回快照 —— 那會變成「以為在查即時資料，其實拿到的是烘進 image
   的快取」，數字看起來正常但是舊的。這種錯誤沒有卡點就不會被發現。
2. **部署後**：實際打一次 `/api/metrics`，檢查回傳的 `source` 是不是 `athena`。
   不是就發 warning 並提示去檢查 instance role 權限與 Glue 表是否存在。
   這一步不讓部署失敗，因為網站和圖表用快照仍然可用。

Athena 需要的表名與欄位（跟 `app/data/metrics.py` 與 `app/data/records.py` 的白名單對應）：

| 表 | 欄位 | 給哪個工具 |
| --- | --- | --- |
| `population_youth` | `district`、`year`、`age_20_29`、`age_30_34` | `query_metrics` |
| `childcare_pressure` | `district`、`youth_per_center` | `query_metrics` |
| `childcare_facilities` | `district`、`name`、`kind`、`operator`、`address`、`phone`、`capacity` | 兩者 |
| `vaccine_clinics` | `district`、`name`、`address`、`phone`、`clinic_type`、`reservation`、`self_paid`、`remark` | `lookup_records` |
| `vaccine_schedules` | `district`、`vaccine_hours`、`bcg_hours`、`remark`、`updated` | `lookup_records` |
| `youbike_stations` | `district`、`name`、`station_id`、`address`、`docks`、`lat`、`lon` | `lookup_records` |

產生的 SQL 一律用雙引號包識別字，因為 `year` 在 Trino／Athena 是函式名稱，
不加引號當欄位名會踩保留字。建表時建議也用 `` `year` `` 包起來。

快照這一層不只是為了離線：Athena 每查一次有 1~3 秒固定延遲、最低以 10MB 計費，
而這些資料很小（29 區、幾百到幾千列）。熱門問題命中快照，跨季比較才走 Athena。

重新產生快照：

```bash
cd backend
python scripts/build_snapshot.py --strict
```

`--strict` 會在對帳失敗時以非零結束，季度作業請開啟，把壞資料擋在關卡前。
目前對帳條件是「各行政區加總 == 該年度新北市合計」，25 個年度全部通過。

## 已知的資料限制

這些會由 `list_available_data` 的 `caveats` 一併告知模型，要求它轉達：

- 托育機構資料只涵蓋 21 個行政區，其餘 8 區沒有統計。
- `childcare_facilities` 是機構數量，**不是可收托人數**。容額要靠私立托嬰機構
  名冊的 `person` 欄位，那份還沒進快照。
- `childcare_pressure` 是以機構數推估的壓力指標，不等於容額缺口。
- `現住人口之年齡分配`（`8308ab58`）原始欄位名是 `percent2`~`percent33`，
  對應哪個年齡層**尚未向來源確認**。目前一律使用組員已整理好的
  `新北市20至34歲人數.csv`，不要直接改用該 API 的原始欄位。

## 管理後台

網址 `/#/admin`，刻意不放進前台選單。三個分頁：知識庫文件（上傳／刪除／同步）、
開放資料（手動更新、各表時點）、帳號管理。

### 建立第一個管理員

後台**沒有註冊功能**，第一個帳號只能從伺服器建立。任何對外的註冊入口都等於讓陌生人
拿到上傳知識庫檔案的權限，而知識庫的內容會餵給 AI。

```bash
cd /home/ubuntu/202609-new-taipei-youth-living-circle-test
docker compose run --rm chat python scripts/create_admin.py
```

會互動詢問帳號與密碼（輸入時不顯示，也不會進 shell 歷史）。之後新增帳號直接在後台
的「帳號管理」操作即可，不需要再用指令。

其他救援用的指令：

```bash
docker compose run --rm chat python scripts/create_admin.py --list
docker compose run --rm chat python scripts/create_admin.py --unlock <帳號>
docker compose run --rm chat python scripts/create_admin.py --reset-password <帳號>
```

`--unlock` 用在連續輸錯被鎖 15 分鐘、不想等的時候；`--reset-password` 是忘記唯一
管理員密碼時的唯一救援路徑。刻意不提供 `--password` 這種參數：密碼會留在 shell
歷史和行程列表裡。

### 角色

| 角色 | 可以做 |
| --- | --- |
| `admin` | 全部，含帳號管理與刪除知識庫檔案 |
| `editor` | 上傳知識庫檔案、觸發同步、手動更新開放資料 |

系統會保留至少一個可用的管理員：最後一個 admin 無法被停用、降級或刪除，
否則後台會變成沒有人進得去、只能 SSH 改 JSON。

### 驗證怎麼實作的

| 項目 | 做法 | 理由 |
| --- | --- | --- |
| 密碼雜湊 | PBKDF2-HMAC-SHA256，600,000 疊代 | OWASP 對 PBKDF2-SHA256 的建議值；標準庫即可，不用 C extension |
| 比對 | `hmac.compare_digest` | 一般 `==` 會提前 return，洩漏前綴長度 |
| 工作階段 | 伺服器端，cookie 只放隨機 token，**存的是 token 的 SHA-256** | 帳號檔被讀走也無法直接登入 |
| Cookie | HttpOnly + SameSite=Strict | JS 讀不到；跨站請求不帶 cookie |
| CSRF | 改狀態的請求要帶 `X-CSRF-Token` | SameSite 之外的第二道 |
| 帳號列舉 | 帳號不存在時也跑一次假雜湊，訊息與密碼錯誤相同 | 否則用回應時間差就能掃出帳號 |
| 鎖定 | 連續失敗 5 次鎖 15 分鐘 | 擋自動化猜密碼 |
| 網路層 | nginx 對 `/api/admin/login` 限 10 req/min | PBKDF2 的成本對防守方也一樣貴，先在網路層擋掉 |
| 改密碼／停用 | 立即撤銷該帳號所有工作階段 | 改密碼的常見原因就是懷疑外洩 |

帳號存在 `/data/admin/users.json`（權限 0600，原子寫入）。這是單容器的設計；
要跑多個複本就得換成真的資料庫，JSON 檔會有寫入競爭。

### 上傳限制

副檔名白名單 `.pdf .csv .txt .md .docx .xlsx .json`，預設上限 20 MB
（`KB_MAX_UPLOAD_MB`）。刻意不放行 `.html`／`.svg`：那些會被當成含腳本的內容，
而且最終會進到模型的上下文。檔名不接受路徑分隔符號，也不做默默改名 —— 傳
`a/b.pdf` 會被拒絕而不是悄悄變成 `b.pdf`。

上傳只是把檔案放進 S3，**還要執行「同步知識庫」**（`StartIngestionJob`）才會被檢索
到。後台會顯示同步進度與掃描／索引／失敗份數。

### 還沒處理的安全性問題

**站台目前是純 HTTP，這是後台最大的問題。** 密碼和工作階段 cookie 都會以明文
在網路上傳輸，同網段的人可以直接攔截後冒用身分。`ADMIN_COOKIE_SECURE` 預設是
`false`，因為設 `true` 在 HTTP 下 cookie 根本送不出去 —— 這個預設值是為了讓它能跑，
不是因為安全。

**上 HTTPS 之後請立刻把 `ADMIN_COOKIE_SECURE` 設為 `true`。** 在那之前，後台
只適合在受信任的網路裡使用（例如透過 SSH 通道連本機 port）。

`/api/chat` 沒有身分驗證（這是刻意的，前台要能匿名使用），任何能連到站的人都能提問，
而每次提問都產生 Bedrock 費用。目前只有 nginx 每 IP 限流（30 req/min）與訊息長度上限。
這擋得住手滑和輕度濫用，擋不住有心人；規模化對外前建議把限流搬到 CloudFront／WAF。

## 本機開發

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

沒有 AWS 憑證也起得來：`/api/health` 正常，`/api/chat` 會回一個 `error` 事件，
前端收到後會自動退回本機情境回覆，聊天室不會卡住。
