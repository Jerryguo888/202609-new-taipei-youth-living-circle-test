<script setup>
import { computed, onMounted, ref } from "vue";
import { appState } from "../store/appState.js";
import { loadYouBikeDashboard } from "../lib/youbike.js";

/* ===== [Jerry 新增：YouBike 面板狀態開始] ===== */
const youbikeLoading = ref(true);
const youbikeError = ref("");
const youbikeData = ref({
  stationCount: 0,
  totalDocks: 0,
  availableBikes: 0,
  zeroBikeStations: 0,
  topZeroDistricts: [],
  updatedAt: "",
  isSnapshot: true,
});

const youbikeStats = computed(function () {
  return [
    { key: "stations", label: "場站數", value: youbikeData.value.stationCount, unit: "站" },
    { key: "docks", label: "總停車格", value: youbikeData.value.totalDocks, unit: "格" },
    { key: "available", label: "可借車輛", value: youbikeData.value.availableBikes, unit: "輛" },
    { key: "empty", label: "無車可借站", value: youbikeData.value.zeroBikeStations, unit: "站" },
  ];
});

onMounted(async function () {
  try {
    youbikeData.value = await loadYouBikeDashboard();
  } catch (error) {
    console.error(error);
    youbikeError.value = "YouBike 資料暫時無法讀取，請重新整理頁面。";
  } finally {
    youbikeLoading.value = false;
  }
});
/* ===== [Jerry 新增：YouBike 面板狀態結束] ===== */
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
      <!-- ===== [Jerry 新增：YouBike 公共資源面板開始] ===== -->
      <section class="youbike-board" aria-labelledby="youbike-board-title">
        <header class="youbike-board-head">
          <div>
            <p class="youbike-wordmark" aria-label="YouBike">you<span>bike</span></p>
            <h2 id="youbike-board-title">新北公共自行車調度概況</h2>
          </div>
          <p class="youbike-data-time">
            {{ youbikeLoading ? "資料讀取中…" : (youbikeData.isSnapshot ? "官方資料快照" : "即時資料") }}
            <span v-if="!youbikeLoading && youbikeData.updatedAt">{{ youbikeData.updatedAt }}</span>
          </p>
        </header>

        <p v-if="youbikeError" class="youbike-error" role="alert">{{ youbikeError }}</p>

        <div class="youbike-stat-grid" :class="{ 'is-loading': youbikeLoading }">
          <article v-for="stat in youbikeStats" :key="stat.key" class="youbike-stat-card" :class="'is-' + stat.key">
            <p>{{ stat.label }}</p>
            <strong>{{ youbikeLoading ? "—" : stat.value.toLocaleString("zh-TW") }}</strong>
            <span>{{ stat.unit }}</span>
          </article>
        </div>

        <article class="youbike-ranking-card">
          <div class="youbike-ranking-head">
            <div>
              <p>調度優先觀察</p>
              <h3>無車可借場站數前五區</h3>
            </div>
            <span>可借車輛 = 0</span>
          </div>
          <ol v-if="!youbikeLoading && youbikeData.topZeroDistricts.length" class="youbike-ranking-list">
            <li v-for="(row, index) in youbikeData.topZeroDistricts" :key="row.district">
              <span class="youbike-ranking-index">{{ String(index + 1).padStart(2, "0") }}</span>
              <strong>{{ row.district }}</strong>
              <span class="youbike-ranking-track" aria-hidden="true">
                <i :style="{ width: row.widthPercent + '%' }"></i>
              </span>
              <b>{{ row.count }}<small>站</small></b>
            </li>
          </ol>
          <p v-else class="youbike-ranking-empty">{{ youbikeLoading ? "正在統計 29 區站點…" : "目前沒有排行資料" }}</p>
        </article>
      </section>
      <!-- ===== [Jerry 新增：YouBike 公共資源面板結束] ===== -->

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
