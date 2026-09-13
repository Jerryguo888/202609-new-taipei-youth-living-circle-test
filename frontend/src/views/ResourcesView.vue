<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { appState } from "../store/appState.js";
import MortalityBarRows from "../components/MortalityBarRows.vue";
import { loadYouBikeDashboard } from "../lib/youbike.js";

/* ===== [本次改版：托育／交通稀缺率的「查看全部」改成跟死因統計一樣，
   點整張卡片跳出 modal 顯示全部區域，不再用卡片內的 <details> 展開。
   兩個分類共用同一個 <dialog>，用 activeChartKey 記住目前是哪一類。] */
const chartDialog = ref(null);
const chartTriggers = ref({});
let previousChartDialogOverflow = "";
const activeChartKey = ref(null);
const activeChart = computed(function () {
  return appState.resourceGapCharts.find(function (chart) { return chart.key === activeChartKey.value; }) || null;
});

function setChartTriggerRef(key, el) {
  if (el) chartTriggers.value[key] = el;
}

function openChartDialog(key) {
  const chart = appState.resourceGapCharts.find(function (item) { return item.key === key; });
  if (!chart || !chart.allRows.length || !chartDialog.value || chartDialog.value.open) return;
  activeChartKey.value = key;
  previousChartDialogOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  chartDialog.value.showModal();
}

function closeChartDialog() {
  if (chartDialog.value && chartDialog.value.open) chartDialog.value.close();
}

function handleChartDialogClose() {
  document.body.style.overflow = previousChartDialogOverflow;
  const key = activeChartKey.value;
  nextTick(function () {
    if (key && chartTriggers.value[key]) chartTriggers.value[key].focus();
  });
  activeChartKey.value = null;
}

function handleChartBackdropClick(event) {
  if (event.target !== chartDialog.value) return;
  const bounds = chartDialog.value.getBoundingClientRect();
  const outside = event.clientX < bounds.left || event.clientX > bounds.right
    || event.clientY < bounds.top || event.clientY > bounds.bottom;
  if (outside) closeChartDialog();
}

/* ===== [Jerry 新增：YouBike 面板狀態開始] ===== */
const youbikeLoading = ref(true);
const youbikeError = ref("");
const youbikeData = ref({
  stationCount: 0,
  totalDocks: 0,
  availableBikes: 0,
  zeroBikeStations: 0,
  allZeroDistricts: [],
  topZeroDistricts: [],
  updatedAt: "",
  isSnapshot: true,
  /* 更新頻率與資料時點，由 lib/youbike.js 的 describeFreshness 帶進來。
     先宣告 key，載入前的第一次渲染才不會存取 undefined。 */
  freshness: null,
});

const youbikeStats = computed(function () {
  return [
    { key: "stations", label: "場站數", value: youbikeData.value.stationCount, unit: "站" },
    { key: "docks", label: "總停車格", value: youbikeData.value.totalDocks, unit: "格" },
    { key: "available", label: "可借車輛", value: youbikeData.value.availableBikes, unit: "輛" },
    { key: "empty", label: "無車可借站", value: youbikeData.value.zeroBikeStations, unit: "站" },
  ];
});

/* ===== [Jerry 修正：零車「行政區排行」放大面板開始] ===== */
const zeroDistrictPanelOpen = ref(false);
const zeroDistrictPanel = ref(null);
const zeroDistrictTrigger = ref(null);

async function openZeroDistrictPanel() {
  if (youbikeLoading.value || youbikeError.value) return;
  zeroDistrictPanelOpen.value = true;
  document.body.classList.add("has-youbike-zero-panel");
  await nextTick();
  zeroDistrictPanel.value?.focus();
}

function closeZeroDistrictPanel() {
  zeroDistrictPanelOpen.value = false;
  document.body.classList.remove("has-youbike-zero-panel");
  nextTick(function () {
    zeroDistrictTrigger.value?.focus();
  });
}

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
/* ===== [Jerry 修正：零車「行政區排行」放大面板結束] ===== */

/* [保留組員最新版：青年健康指標 dialog 開關與焦點還原] */
const mortalityDialog = ref(null);
const mortalityTrigger = ref(null);
let previousBodyOverflow = "";

function openMortalityDialog() {
  if (!appState.mortalityRows.length || !mortalityDialog.value || mortalityDialog.value.open) return;
  previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  mortalityDialog.value.showModal();
}

function closeMortalityDialog() {
  if (mortalityDialog.value && mortalityDialog.value.open) mortalityDialog.value.close();
}

function handleMortalityDialogClose() {
  document.body.style.overflow = previousBodyOverflow;
  nextTick(function () {
    if (mortalityTrigger.value) mortalityTrigger.value.focus();
  });
}

function handleMortalityBackdropClick(event) {
  if (event.target !== mortalityDialog.value) return;
  const bounds = mortalityDialog.value.getBoundingClientRect();
  const outside = event.clientX < bounds.left || event.clientX > bounds.right
    || event.clientY < bounds.top || event.clientY > bounds.bottom;
  if (outside) closeMortalityDialog();
}

onBeforeUnmount(function () {
  closeZeroDistrictPanel();
  if (mortalityDialog.value && mortalityDialog.value.open) mortalityDialog.value.close();
  document.body.style.overflow = previousBodyOverflow;
  if (chartDialog.value && chartDialog.value.open) chartDialog.value.close();
  document.body.style.overflow = previousChartDialogOverflow;
});
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
      <!-- [本次改版：托育／交通稀缺率並排，死因統計排在下面，YouBike 移到整頁最右側，
           用 .resources-layout 兩欄 grid 排版；手機寬度會自動收合成單欄堆疊] -->
      <!-- [Jerry 2026-09-13 固定版面：此區只用 CSS Grid 排版，沒有拖曳／縮放行為。] -->
      <div class="resources-layout">
        <div class="resource-main-column">
          <div class="resource-chart-grid">
            <article class="resource-chart-card mortality-chart-card" v-for="chart in appState.resourceGapCharts" :key="chart.key"
                     :ref="(el) => setChartTriggerRef(chart.key, el)"
                     :class="{ 'is-disabled': !chart.allRows.length }"
                     :tabindex="chart.allRows.length ? 0 : -1"
                     :aria-disabled="!chart.allRows.length"
                     role="button" aria-haspopup="dialog" :aria-describedby="'chart-desc-' + chart.key"
                     @click="openChartDialog(chart.key)"
                     @keydown.enter="openChartDialog(chart.key)"
                     @keydown.space.prevent="openChartDialog(chart.key)">
              <div class="resource-chart-title">
                <h2>{{ chart.label }}{{ chart.metricLabel }}</h2>
                <p :id="'chart-desc-' + chart.key">{{ chart.copy }}</p>
                <!-- [2026-09-13 新增：更新頻率與資料時點。
                     只有真的走排程更新的資料才有 freshness；靜態路網那類是 null，
                     這一行就不出現，不會誤導使用者以為它也會自動更新。 -->
                <p v-if="chart.freshness && chart.freshness.isLive" class="resource-chart-freshness">
                  <span class="resource-chart-freshness-badge">{{ chart.freshness.refreshLabel }}</span>
                  <span v-if="chart.freshness.fetchedAt">資料時間 {{ chart.freshness.fetchedAt }}</span>
                </p>
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
              <!-- [本次改版：點開卡片看「所有區域」排行，改成跟死因統計一樣跳 modal，
                   不再是卡片內的 <details> 展開] -->
              <div v-if="chart.allRows.length" class="mortality-chart-footer">
                <p>{{ chart.formula }}</p>
                <span>查看全部{{ chart.allRows.length }}區</span>
              </div>
            </article>
          </div>

          <!-- [本次新增：青年健康指標獨立附加在既有托育圖表後方，不改動 resourceGaps.childcare] -->
          <section class="mortality-section" aria-labelledby="mortality-section-title">
            <article ref="mortalityTrigger" class="resource-chart-card mortality-chart-card"
                     :class="{ 'is-disabled': !appState.mortalityRows.length }"
                     :tabindex="appState.mortalityRows.length ? 0 : -1"
                     :aria-disabled="!appState.mortalityRows.length"
                     role="button" aria-haspopup="dialog" aria-describedby="mortality-chart-description"
                     @click="openMortalityDialog"
                     @keydown.enter="openMortalityDialog"
                     @keydown.space.prevent="openMortalityDialog">
              <div class="resource-chart-title">
                <div class="mortality-preview-title-row">
                  <h2>20–29歲自殺死亡占比</h2>
                  <strong v-if="appState.mortalityRows.length" class="mortality-city-summary">
                    全新北市：{{ appState.mortalityCitySummary.ratio === null
                      ? "—"
                      : appState.mortalityCitySummary.ratio.toFixed(1) + "%" }}
                    <small>（{{ appState.mortalityCitySummary.suicideDeaths }}/{{ appState.mortalityCitySummary.totalDeaths }}）</small>
                  </strong>
                </div>
                <p id="mortality-chart-description">
                  各行政區自殺死亡數占同齡全部死因死亡數的比例。
                </p>
              </div>
              <p v-if="appState.mortalityLoading" class="resource-chart-status">
                {{ appState.mortalityStatus }}
              </p>
              <p v-else-if="appState.mortalityStatus" class="resource-chart-status is-error">
                {{ appState.mortalityStatus }}
              </p>
              <MortalityBarRows :rows="appState.mortalityTop5Rows" />
              <div v-if="appState.mortalityRows.length" class="mortality-chart-footer">
                <p>占比＝自殺死亡數（代碼131）÷ 同年度20–29歲全部死因死亡數</p>
                <span>查看全部29區</span>
              </div>
            </article>
          </section>
        </div>

        <!-- ===== [Jerry 新增：YouBike 公共資源面板開始] ===== -->
        <section class="youbike-board" aria-labelledby="youbike-board-title">
          <header class="youbike-board-head">
            <div>
              <h2 id="youbike-board-title">新北公共自行車調度概況</h2>
            </div>
            <!-- [2026-09-13 改版：頻率改由資料本身帶進來（見 lib/data/liveRecords.js）。
                 原本寫死「官方資料快照／即時資料」二選一，但現在有三種來源：
                 每小時排程更新、直接打官方 API、以及還沒跑過排程時的靜態快照。 -->
            <p class="youbike-data-time">
              <template v-if="youbikeLoading">資料讀取中…</template>
              <template v-else>
                <span v-if="youbikeData.freshness" class="youbike-freshness-badge">
                  {{ youbikeData.freshness.refreshLabel }}
                </span>
                <span v-if="youbikeData.freshness && youbikeData.freshness.fetchedAt">
                  取得於 {{ youbikeData.freshness.fetchedAt }}
                </span>
                <span v-if="youbikeData.updatedAt">來源時間 {{ youbikeData.updatedAt }}</span>
              </template>
            </p>
          </header>

          <p v-if="youbikeError" class="youbike-error" role="alert">{{ youbikeError }}</p>

          <div class="youbike-stat-grid" :class="{ 'is-loading': youbikeLoading }">
            <article v-for="stat in youbikeStats" :key="stat.key" class="youbike-stat-card" :class="'is-' + stat.key">
              <p>{{ stat.label }}</p>
              <strong>{{ youbikeLoading ? "—" : stat.value.toLocaleString("zh-TW") }}</strong>
              <span class="youbike-stat-unit">{{ stat.unit }}</span>
            </article>
          </div>

          <!-- [本次改版：跟托育／交通稀缺率、死因統計一樣，點整張卡片可以查看
               所有 29 區的完整排行，不只前五區；點開的放大視窗沿用 Jerry 已經
               準備好的 .youbike-zero-panel 樣式，只是原本沒有接上任何觸發點。] -->
          <article ref="zeroDistrictTrigger" class="youbike-ranking-card mortality-chart-card"
                   :class="{ 'is-disabled': youbikeLoading || youbikeError || !youbikeData.allZeroDistricts.length }"
                   :tabindex="(youbikeLoading || youbikeError || !youbikeData.allZeroDistricts.length) ? -1 : 0"
                   :aria-disabled="youbikeLoading || youbikeError || !youbikeData.allZeroDistricts.length"
                   role="button" aria-haspopup="dialog" aria-describedby="youbike-ranking-description"
                   @click="openZeroDistrictPanel"
                   @keydown.enter="openZeroDistrictPanel"
                   @keydown.space.prevent="openZeroDistrictPanel">
            <div class="youbike-ranking-head">
              <div>
                <h3>無車可借場站數前五區</h3>
              </div>
            </div>
            <ol v-if="!youbikeLoading && youbikeData.topZeroDistricts.length" class="youbike-ranking-list">
              <li v-for="(row, index) in youbikeData.topZeroDistricts" :key="row.district">
                <!-- <span class="youbike-ranking-index">{{ String(index + 1).padStart(2, "0") }}</span> -->
                <strong>{{ row.district }}</strong>
                <span class="youbike-ranking-track" aria-hidden="true">
                  <i :style="{ width: row.widthPercent + '%' }"></i>
                </span>
                <b>{{ row.count }}<small>站</small></b>
              </li>
            </ol>
            <p v-else class="youbike-ranking-empty">{{ youbikeLoading ? "正在統計 29 區站點…" : "目前沒有排行資料" }}</p>
            <div v-if="!youbikeLoading && youbikeData.allZeroDistricts.length" class="mortality-chart-footer">
              <p id="youbike-ranking-description">無車可借場站數＝該區目前可借車輛為 0 的場站數。</p>
              <span>查看全部29區</span>
            </div>
          </article>
        </section>
        <!-- ===== [Jerry 新增：YouBike 公共資源面板結束] ===== -->

        <!-- ===== [Jerry 修正：無車可借行政區排行置中放大視窗——補上模板，
             CSS 早就準備好了但沒有任何地方 v-if 開啟過，等於是死掉的樣式] ===== -->
        <Transition name="youbike-panel">
          <div v-if="zeroDistrictPanelOpen" class="youbike-zero-backdrop" @click.self="closeZeroDistrictPanel">
            <div ref="zeroDistrictPanel" class="youbike-zero-panel" role="dialog" aria-modal="true"
                 aria-labelledby="youbike-zero-panel-title" tabindex="-1" @keydown.esc="closeZeroDistrictPanel">
              <header class="youbike-zero-panel-head">
                <div>
                  <h2 id="youbike-zero-panel-title">無車可借場站數</h2>
                  <p id="mortality-chart-description">
                    各行政區自殺死亡數占同齡全部死因死亡數的比例。
                  </p>
                </div>
                <div class="youbike-zero-panel-actions">
                  <button type="button" class="is-close" @click="closeZeroDistrictPanel">x</button>
                </div>
              </header>
              <ul class="youbike-zero-district-list">
                <li v-for="row in youbikeData.allZeroDistricts" :key="row.district" :class="{ 'is-zero': row.count === 0 }">
                  <strong>{{ row.district }}</strong>
                  <span class="youbike-zero-district-track" aria-hidden="true">
                    <i :style="{ width: row.widthPercent + '%' }"></i>
                  </span>
                  <b>{{ row.count }}<small>站</small></b>
                </li>
              </ul>
            </div>
          </div>
        </Transition>
      </div>
    </div>

    <!-- [本次改版：托育／交通稀缺率共用這一個 modal，樣式跟下面死因統計的
         mortality-dialog 完全共用同一套 CSS class，activeChart 記住目前點的是哪一類] -->
    <dialog ref="chartDialog" class="mortality-dialog"
            aria-labelledby="chart-dialog-title" aria-describedby="chart-dialog-description"
            @close="handleChartDialogClose" @click="handleChartBackdropClick">
      <section class="mortality-dialog-panel" v-if="activeChart">
        <header class="mortality-dialog-header">
          <div>
            <div class="mortality-dialog-title-row">
              <h2 id="chart-dialog-title">{{ activeChart.label }}{{ activeChart.metricLabel }}</h2>
            </div>
            <p id="chart-dialog-description">{{ activeChart.copy }}</p>
          </div>
          <button type="button" class="mortality-dialog-close" aria-label="關閉完整行政區排行"
                  @click="closeChartDialog">×</button>
        </header>
        <div class="mortality-dialog-body">
          <ul v-if="activeChart.allRows[0] && activeChart.allRows[0].segments" class="resource-chart-legend">
            <li v-for="segment in activeChart.allRows[0].segments" :key="segment.key" :class="'is-' + segment.key">
              <i></i>{{ segment.label }}
            </li>
          </ul>
          <div class="resource-chart-bars">
            <div class="resource-chart-row" v-for="row in activeChart.allRows" :key="row.area"
                 :title="row.area + '：' + activeChart.metricLabel + ' ' + row.value.toLocaleString() + activeChart.unit">
              <span class="resource-chart-label">{{ row.area }}</span>
              <span class="resource-chart-bar" :class="'is-' + activeChart.key">
                <template v-if="row.segments">
                  <i v-for="segment in row.segments" :key="segment.key"
                     :class="'is-' + segment.key" :style="{ width: segment.widthPercent + '%' }"></i>
                </template>
                <i v-else :style="{ width: row.widthPercent + '%' }"></i>
              </span>
              <strong class="resource-chart-value">{{ row.value.toLocaleString() }}<small>{{ activeChart.unit }}</small></strong>
            </div>
          </div>
          <p class="mortality-data-source">{{ activeChart.formula }}</p>
        </div>
      </section>
    </dialog>

    <!-- 使用原生 dialog 提供焦點限制、Escape 關閉與 modal semantics，不使用 Fullscreen API。 -->
    <dialog ref="mortalityDialog" class="mortality-dialog"
            aria-labelledby="mortality-dialog-title" aria-describedby="mortality-dialog-description"
            @close="handleMortalityDialogClose" @click="handleMortalityBackdropClick">
      <section class="mortality-dialog-panel">
        <header class="mortality-dialog-header">
          <div>
            <div class="mortality-dialog-title-row">
              <h2 id="mortality-dialog-title">新北市29區20–29歲自殺死亡占比</h2>
              <strong class="mortality-city-summary">
                全新北市：{{ appState.mortalityCitySummary.ratio === null
                  ? "—"
                  : appState.mortalityCitySummary.ratio.toFixed(1) + "%" }}
                <small>（{{ appState.mortalityCitySummary.suicideDeaths }}/{{ appState.mortalityCitySummary.totalDeaths }}）</small>
              </strong>
            </div>
            <p id="mortality-dialog-description">
              民國 {{ appState.mortalityYear }} 年，依比例由高到低排序；括號顯示自殺死亡數／全部死亡數。
            </p>
          </div>
          <button type="button" class="mortality-dialog-close" aria-label="關閉完整行政區排行"
                  @click="closeMortalityDialog">×</button>
        </header>
        <div class="mortality-dialog-body">
          <div class="mortality-dialog-note">
            <strong>判讀提醒</strong>
            <span>「樣本少」代表該區當年度同齡死亡總數少於5人，比例容易大幅波動，不宜單獨作為資源配置結論。</span>
          </div>
          <MortalityBarRows :rows="appState.mortalityRows" show-rank />
          <p class="mortality-data-source">
            資料來源：新北市死因統計97-114.csv；年齡代碼3；自殺死因代碼131。
          </p>
        </div>
      </section>
    </dialog>
  </section>
</template>
