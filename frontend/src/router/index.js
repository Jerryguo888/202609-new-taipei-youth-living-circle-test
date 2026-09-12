import { createRouter, createWebHashHistory } from "vue-router";

/* [本次改版：原本用 location.hash 手刻路由（#home、#combined...），現在改用
   vue-router 的 hash history，網址會多一個斜線變成 #/combined，是刻意的
   格式差異（vue-router 標準寫法），不是行為缺失。] */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "home", component: () => import("../views/HomeView.vue") },
    /* [本次改版：combined／map3d 共用同一個元件檔——原本就是同一段模板用 v-show
       切換，這裡讓 vue-router 兩個路由指到同一個元件，路由切換時 Vue 會直接
       重用同一個元件實例（不會整個卸載重掛），底下的 MapLibre 地圖跟 DOM 容器
       才不會在 combined／map3d 互切時被摧毀重建。] */
    { path: "/combined", name: "combined", component: () => import("../views/PopulationMapView.vue") },
    { path: "/map3d", name: "map3d", component: () => import("../views/PopulationMapView.vue") },
    { path: "/forecast", name: "forecast", component: () => import("../views/ForecastView.vue") },
    { path: "/resources", name: "resources", component: () => import("../views/ResourcesView.vue") },
    { path: "/transit", name: "transit", component: () => import("../views/TransitView.vue") },
    { path: "/budget", name: "budget", component: () => import("../views/BudgetView.vue") },
  ],
});
