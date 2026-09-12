<script setup>
import { appState } from "../store/appState.js";
</script>

<template>
  <!-- ===== [改版新增：青年熱區預測頁] ===== -->
  <section class="view module">
    <div class="module-hero">
      <div>
        <p class="section-kicker">Youth Forecast</p>
        <h1>青年與成家熱區</h1>
      </div>
      <p>把人口遷徙、住宅供給與成家訊號放在一起，提前辨識未來 1～3 年需求升溫的生活圈。</p>
    </div>
    <div class="module-body">
      <div class="toolbar">
        <span><strong>資料基準：2026</strong></span>
        <span class="info-tag">MVP 概念分數・待串官方資料</span>
      </div>
      <div class="dashboard-grid">
        <article class="panel">
          <div class="panel-title">
            <div><h2>青年需求成長排行</h2><p>綜合青年人口、住宅與成家訊號</p></div>
            <strong>2026</strong>
          </div>
          <div class="forecast-list">
            <div class="forecast-row" v-for="row in appState.forecastRows" :key="row.name">
              <span>{{ row.name }}</span>
              <span class="forecast-bar"><i :style="{ width: row.score + '%' }"></i></span>
              <strong>{{ row.score }}</strong>
            </div>
          </div>
        </article>
        <aside>
          <div class="big-number">
            <span>最高需求風險分數</span>
            <strong>{{ appState.forecastRows[0].score }}</strong>
            <div>{{ appState.forecastRows[0].name }}・住宅與青年移入同步升溫</div>
          </div>
          <div class="signal-list">
            <div class="signal"><span>青年移入</span><strong>上升</strong></div>
            <div class="signal"><span>新建住宅</span><strong>高</strong></div>
            <div class="signal"><span>成家訊號</span><strong>升溫</strong></div>
          </div>
        </aside>
      </div>
    </div>
  </section>
</template>
