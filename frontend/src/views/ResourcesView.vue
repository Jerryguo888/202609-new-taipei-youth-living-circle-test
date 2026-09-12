<script setup>
import { appState } from "../store/appState.js";
</script>

<template>
  <!-- ===== [改版新增：公共資源缺口頁] =====
       [本次改版：學校／停車兩張圖依需求刪除，只保留托育稀缺率長條疊圖。] -->
  <section class="view module">
    <div class="module-hero green">
      <div>
        <p class="section-kicker" style="color:#b8f0d0">Capacity & Demand</p>
        <h1>公共資源負擔力</h1>
      </div>
      <p>用預測需求減去既有容量，將托育壓力轉成市府能直接採取行動的風險訊號。</p>
    </div>
    <div class="module-body">
      <div class="toolbar">
        <span><strong>生活圈稀缺率 Top 5</strong></span>
        <span class="info-tag">依稀缺率排序・僅顯示前五名</span>
      </div>
      <div class="resource-chart-grid">
        <article class="resource-chart-card" v-for="chart in appState.resourceGapCharts" :key="chart.key">
          <div class="resource-chart-title">
            <h2>{{ chart.label }}{{ chart.metricLabel }}</h2>
            <p>{{ chart.copy }}</p>
          </div>
          <ul v-if="chart.rows[0] && chart.rows[0].segments" class="resource-chart-legend">
            <li v-for="segment in chart.rows[0].segments" :key="segment.key" :class="'is-' + segment.key">
              <i></i>{{ segment.label }}
            </li>
          </ul>
          <p v-if="chart.key === 'childcare' && appState.childcareGapLoading" class="resource-chart-status">
            {{ appState.childcareGapStatus }}
          </p>
          <p v-else-if="chart.key === 'childcare' && appState.childcareGapStatus" class="resource-chart-status is-error">
            {{ appState.childcareGapStatus }}
          </p>
          <div class="resource-chart-bars">
            <div class="resource-chart-row" v-for="row in chart.rows" :key="row.area"
                 :title="row.area + '：' + chart.metricLabel + ' ' + row.value.toLocaleString() + chart.unit">
              <span class="resource-chart-label">{{ row.area }}</span>
              <span class="resource-chart-bar" :class="'is-' + chart.key">
                <template v-if="row.segments">
                  <i v-for="segment in row.segments" :key="segment.key"
                     :class="'is-' + segment.key" :style="{ width: segment.widthPercent + '%' }"></i>
                </template>
                <i v-else :style="{ width: row.widthPercent + '%' }"></i>
              </span>
              <strong class="resource-chart-value">{{ row.value.toLocaleString() }}<small>{{ chart.unit }}</small></strong>
            </div>
          </div>
        </article>
      </div>
    </div>
  </section>
</template>
