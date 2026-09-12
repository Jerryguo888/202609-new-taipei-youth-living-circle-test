<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
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
  zeroStations: [],
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

/* ===== [Jerry 新增：全部零車站右側面板開始] ===== */
const zeroStationPanelOpen = ref(false);
const zeroStationPanelExpanded = ref(false);
const zeroStationSearch = ref("");
const zeroStationPanel = ref(null);
const zeroStationList = ref(null);

const filteredZeroStations = computed(function () {
  const keyword = zeroStationSearch.value.trim().toLocaleLowerCase("zh-Hant");
  if (!keyword) return youbikeData.value.zeroStations;
  return youbikeData.value.zeroStations.filter(function (station) {
    return [station.district, station.name, station.address].some(function (value) {
      return String(value).toLocaleLowerCase("zh-Hant").includes(keyword);
    });
  });
});

/* [Jerry 修正：清單捲到底後再搜尋時，要回到搜尋結果第一筆，不能停在舊捲動位置。] */
watch(zeroStationSearch, async function () {
  await nextTick();
  if (zeroStationList.value) zeroStationList.value.scrollTop = 0;
});

async function openZeroStationPanel() {
  if (youbikeLoading.value || youbikeError.value) return;
  zeroStationPanelOpen.value = true;
  document.body.classList.add("has-youbike-zero-panel");
  await nextTick();
  zeroStationPanel.value?.focus();
}

function closeZeroStationPanel() {
  zeroStationPanelOpen.value = false;
  zeroStationPanelExpanded.value = false;
  zeroStationSearch.value = "";
  document.body.classList.remove("has-youbike-zero-panel");
}

onBeforeUnmount(closeZeroStationPanel);
/* ===== [Jerry 新增：全部零車站右側面板結束] ===== */

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
       [本次改版：學校／停車兩張圖依需求刪除；頁面改成暗色版本，樣式集中在
       global.css 的 .resources-view 區塊；新增交通稀缺率長條圖，跟托育共用
       同一套「前五名＋點開看全部」卡片版型（appState.resourceGapCharts 這個
       getter 本來就是每一類資源各自算一份，這裡只是在 resourceGaps 多加一類，
       模板不用改）。] -->
  <section class="view module resources-view">
    <div class="resource-page-title">公共資源負擔力</div>
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
          <component v-for="stat in youbikeStats" :key="stat.key"
                     :is="stat.key === 'empty' ? 'button' : 'article'"
                     :type="stat.key === 'empty' ? 'button' : null"
                     class="youbike-stat-card"
                     :class="['is-' + stat.key, { 'is-action': stat.key === 'empty' }]"
                     :aria-haspopup="stat.key === 'empty' ? 'dialog' : null"
                     :aria-expanded="stat.key === 'empty' ? zeroStationPanelOpen : null"
                     @click="stat.key === 'empty' && openZeroStationPanel()">
            <p>{{ stat.label }}</p>
            <strong>{{ youbikeLoading ? "—" : stat.value.toLocaleString("zh-TW") }}</strong>
            <span class="youbike-stat-unit">{{ stat.unit }}</span>
            <small v-if="stat.key === 'empty'" class="youbike-stat-open-hint">查看所有地點 <b>→</b></small>
          </component>
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

      <!-- ===== [Jerry 新增：全部零車站右側可放大面板開始] ===== -->
      <Teleport to="body">
        <Transition name="youbike-panel">
          <div v-if="zeroStationPanelOpen" class="youbike-zero-backdrop" @click.self="closeZeroStationPanel">
            <aside ref="zeroStationPanel" tabindex="-1" role="dialog" aria-modal="true"
                   aria-labelledby="zero-station-panel-title" class="youbike-zero-panel"
                   :class="{ 'is-expanded': zeroStationPanelExpanded }" @keydown.esc="closeZeroStationPanel">
              <header class="youbike-zero-panel-head">
                <div>
                  <p>新北 YouBike 調度清單</p>
                  <h2 id="zero-station-panel-title">無車可借場站</h2>
                </div>
                <div class="youbike-zero-panel-actions">
                  <button type="button" @click="zeroStationPanelExpanded = !zeroStationPanelExpanded">
                    {{ zeroStationPanelExpanded ? "縮小" : "放大" }}
                  </button>
                  <button type="button" class="is-close" aria-label="關閉無車可借場站清單" @click="closeZeroStationPanel">關閉</button>
                </div>
              </header>

              <div class="youbike-zero-panel-tools">
                <label for="zero-station-search">搜尋地點</label>
                <input id="zero-station-search" v-model="zeroStationSearch" type="search"
                       placeholder="輸入行政區、站名或地址">
                <p>顯示 {{ filteredZeroStations.length.toLocaleString("zh-TW") }}／{{ youbikeData.zeroStations.length.toLocaleString("zh-TW") }} 個場站</p>
              </div>

              <ol ref="zeroStationList" class="youbike-zero-station-list">
                <li v-for="(station, index) in filteredZeroStations" :key="station.id || station.district + station.name">
                  <span class="youbike-zero-station-index">{{ String(index + 1).padStart(3, "0") }}</span>
                  <div>
                    <p><b>{{ station.district }}</b><strong>{{ station.name }}</strong></p>
                    <address>{{ station.address }}</address>
                  </div>
                </li>
              </ol>
              <p v-if="!filteredZeroStations.length" class="youbike-zero-no-result">找不到符合的地點</p>
            </aside>
          </div>
        </Transition>
      </Teleport>
      <!-- ===== [Jerry 新增：全部零車站右側可放大面板結束] ===== -->

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
          <p v-if="appState.resourceGapLoadingInfo[chart.key] && appState.resourceGapLoadingInfo[chart.key].loading"
             class="resource-chart-status">
            {{ appState.resourceGapLoadingInfo[chart.key].status }}
          </p>
          <p v-else-if="appState.resourceGapLoadingInfo[chart.key] && appState.resourceGapLoadingInfo[chart.key].status"
             class="resource-chart-status is-error">
            {{ appState.resourceGapLoadingInfo[chart.key].status }}
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
          <!-- [本次新增：點開可以看到該類別「所有區域」的排行，不只前五名] -->
          <details class="resource-chart-expand" v-if="chart.allRows.length > chart.rows.length">
            <summary>查看全部 {{ chart.allRows.length }} 區{{ chart.metricLabel }}</summary>
            <div class="resource-chart-bars resource-chart-bars-full">
              <div class="resource-chart-row" v-for="row in chart.allRows" :key="row.area"
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
          </details>
        </article>
      </div>
    </div>
  </section>
</template>
