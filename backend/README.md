# Backend（尚未實作）

這個資料夾先保留給未來的後端服務，這次遷移只把前端改成 Vue + Vite 專案，
後端本身還沒有實作。

## 之後要接後端時，從這裡開始

- 所有 CSV 資料的路徑集中在 [`frontend/src/lib/data/dataFiles.js`](../frontend/src/lib/data/dataFiles.js)，
  之後要換成打後端 API，只需要把這個檔案裡的相對路徑改成 API 網址即可，
  呼叫端（`frontend/src/lib/network.js`、`frontend/src/lib/mapLibreMap.js`）不用改。
- 實際發 request 的地方是 [`frontend/src/lib/data/fetchCsv.js`](../frontend/src/lib/data/fetchCsv.js)
  的 `fetchCsvResponse`，含重試機制；換成打 API 時可以在這裡調整成呼叫 JSON API
  而不是抓 CSV 文字檔。
- AI 聊天功能已經預留好串接點：[`frontend/src/lib/chatService.js`](../frontend/src/lib/chatService.js)
  的 `CHAT_SERVICE`（目前 `enabled: false`）。原本規劃的串接路徑是
  Vue → API Gateway → Lambda → Amazon Bedrock；認證建議用 Cognito JWT，
  不要把任何 AWS 憑證寫進前端程式碼。
