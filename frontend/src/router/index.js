import { createRouter, createWebHashHistory } from "vue-router";

/* [本次改版：原本用 location.hash 手刻路由（#home、#combined...），現在改用
   vue-router 的 hash history，網址會多一個斜線變成 #/combined，是刻意的
   格式差異（vue-router 標準寫法），不是行為缺失。]
   [本次改版：3D人口／30分鐘交通／預算模擬／青年熱區都刪掉了，青年熱區排行、
   圖例、交通分析改整合進 PopulationMapView 左側面板，不再需要各自的路由。] */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "home", component: () => import("../views/HomeView.vue") },
    { path: "/combined", name: "combined", component: () => import("../views/PopulationMapView.vue") },
    { path: "/resources", name: "resources", component: () => import("../views/ResourcesView.vue") },
    /* [本次改版：3D人口／30分鐘交通／預算模擬／青年熱區被刪掉了，舊書籤網址
       （#/map3d、#/transit、#/budget、#/forecast）不要留白頁，導回首頁。] */
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});
