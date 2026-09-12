# 202609 黑客松｜新北青年生活圈

AI 青年生活圈預測與公共資源配置平台 MVP。

功能包含 3D 青年人口地圖、公共資源缺口、公車與捷運 30 分鐘可達分析、行政區／捷運路線選站、路線圖、預算模擬，以及預留 AWS 串接點的 Chatbot。

> 交通時間使用官方公車路線資料、捷運站間秒數、平日班距與轉乘步行時間估算；正式版仍需再接逐班 GTFS 與即時異常資料。

## 專案結構

```text
.
├── frontend/   Vue 3 + Vite 前端專案（實際網站原始碼都在這裡）
├── backend/    保留給未來後端使用，目前尚未實作
└── dist/       `npm run build` 產生的建置結果，不進版控，由 GitHub Actions 部署到 Pages
```

## 本機開發

```bash
cd frontend
npm install
cp .env.example .env.local   # 填入自己的 VITE_CARTO_KEY（CARTO 夜間地圖 API key）
npm run dev
```

## 建置

```bash
cd frontend
npm run build      # 產物輸出到專案根目錄的 dist/
npm run preview    # 本機預覽建置結果
```

部署到 GitHub Pages 時，CI 會用同樣的 `npm run build` 建置，並讀取 repo 的
`VITE_CARTO_KEY` secret（Settings → Secrets and variables → Actions）；
沒有設定的話，CARTO 底圖會退回免費／有浮水印的版本。
