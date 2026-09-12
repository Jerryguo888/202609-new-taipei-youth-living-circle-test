<script setup>
import { appState } from "../store/appState.js";

/* [本次修正：public/ 底下的圖檔不在 Vite 模組圖裡，用跟 CSV 一樣的
   document.baseURI 相對解析，部署到 GitHub Pages 子路徑時才不會抓錯路徑] */
const heroImageUrl = new URL("assets/new-taipei-living-circle-hero.png", document.baseURI).href;
</script>

<template>
  <!-- ===== [本次改版：首頁只留一個進入地圖的按鈕] ===== -->
  <section class="view home-view">
    <div class="home-launch" :style="{ backgroundImage: 'url(' + heroImageUrl + ')' }">
      <div class="home-copy">
        <!-- <div class="home-kicker"><i></i>NEW TAIPEI · YOUTH FUTURES</div> -->
        <h1 class="home-title">看見青年<span>讓城市先準備</span></h1>
        <p class="home-description">
          預測青年未來 1～3 年往哪裡移動與成家，提前看見公共服務缺口，並結合 AI Agent 獲得進一步的資訊。
        </p>
        <div class="home-actions">
          <button class="home-launch-button" @click="appState.go('combined')">進入整合地圖 <span>→</span></button>
        </div>
      </div>
    </div>
  </section>
</template>
