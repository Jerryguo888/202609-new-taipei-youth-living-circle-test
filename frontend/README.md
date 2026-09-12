# 新北青年生活圈｜前端

Vue 3 + Vite 單頁應用。原本是一支 4000 多行的靜態 HTML（Vue 用 CDN 載入），
這次拆成模組化的元件與函式庫，細節見 repo 根目錄的 `README.md`。

## 目錄結構

```text
src/
├── main.js              應用進入點
├── App.vue              整體外殼：懸浮選單、路由畫面、AI 對話框
├── router/               vue-router 設定（hash history）
├── store/appState.js     共用狀態單例（取代原本的全域 Vue app 實例）
├── views/                7 個分頁對應的畫面元件
├── components/           NavOrb（懸浮選單）、ChatWidget（AI 對話框）
├── lib/                  跟 Vue 無關的邏輯：CSV 解析、交通圖建置、
│                         可達性演算法、Leaflet／MapLibre 繪圖
└── style/global.css      全站共用樣式（沿用原本的視覺設計）
```

## 開發

```bash
npm install
cp .env.example .env.local   # 填入 VITE_CARTO_KEY 才會有夜間地圖底圖、且無浮水印
npm run dev
```

## 建置 / 預覽

```bash
npm run build     # 輸出到 ../dist（給 GitHub Pages 用）
npm run preview
```
