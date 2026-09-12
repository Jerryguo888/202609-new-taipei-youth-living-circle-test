import { createApp } from "vue";
import "./style/global.css";
import "leaflet/dist/leaflet.css";
import "maplibre-gl/dist/maplibre-gl.css";
import App from "./App.vue";
import { router } from "./router/index.js";
import { appState, ensureViewReady } from "./store/appState.js";

/* [本次改版：統一由 router 的 afterEach 驅動「依畫面初始化地圖／交通資料」，
   取代原本 go() 方法與 mounted() 各自維護一套流程的作法；不論是點導覽選單、
   瀏覽器上一頁/下一頁，還是直接輸入網址，都會走這同一條路徑。] */
router.afterEach((to) => {
  appState.activeView = to.name;
  ensureViewReady(to.name);
});

createApp(App).use(router).mount("#app");
