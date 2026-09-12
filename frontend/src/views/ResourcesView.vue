<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { appState } from "../store/appState.js";
import MortalityBarRows from "../components/MortalityBarRows.vue";
import { loadYouBikeDashboard } from "../lib/youbike.js";

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
const zeroDistrictPanelExpanded = ref(false);
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
  zeroDistrictPanelExpanded.value = false;
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
          <article v-for="stat in youbikeStats" :key="stat.key"
                     class="youbike-stat-card"
                     :class="'is-' + stat.key">
            <p>{{ stat.label }}</p>
            <strong>{{ youbikeLoading ? "—" : stat.value.toLocaleString("zh-TW") }}</strong>
            <span class="youbike-stat-unit">{{ stat.unit }}</span>
          </article>
        </div>

        <!-- [Jerry 修正：點擊的是行政區 Top 5 排行卡，不是上方「無車可借站」數字卡。] -->
        <button ref="zeroDistrictTrigger" type="button" class="youbike-ranking-card is-action"
                aria-haspopup="dialog" :aria-expanded="zeroDistrictPanelOpen"
                @click="openZeroDistrictPanel">
          <div class="youbike-ranking-head">
            <div>
              <p>調度優先觀察</p>
              <h3>無車可借場站數前五區</h3>
            </div>
            <span>可借車輛 = 0 · 查看完整排行 ↗</span>
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
        </button>
      </section>
      <!-- ===== [Jerry 新增：YouBike 公共資源面板結束] ===== -->

      <!-- ===== [Jerry 修正：行政區零車站排行右側可放大面板開始] ===== -->
      <Teleport to="body">
        <Transition name="youbike-panel">
          <div v-if="zeroDistrictPanelOpen" class="youbike-zero-backdrop" @click.self="closeZeroDistrictPanel">
            <aside ref="zeroDistrictPanel" tabindex="-1" role="dialog" aria-modal="true"
                   aria-labelledby="zero-district-panel-title" class="youbike-zero-panel"
                   :class="{ 'is-expanded': zeroDistrictPanelExpanded }" @keydown.esc="closeZeroDistrictPanel">
              <header class="youbike-zero-panel-head">
                <div>
                  <p>新北 YouBike 行政區統計</p>
                  <h2 id="zero-district-panel-title">無車可借場站排行</h2>
                </div>
                <div class="youbike-zero-panel-actions">
                  <button type="button" @click="zeroDistrictPanelExpanded = !zeroDistrictPanelExpanded">
                    {{ zeroDistrictPanelExpanded ? "縮小" : "放大" }}
                  </button>
                  <button type="button" class="is-close" aria-label="關閉無車可借行政區排行" @click="closeZeroDistrictPanel">關閉</button>
                </div>
              </header>

              <div class="youbike-zero-panel-tools">
                <strong>0 台可借場站最多的行政區</strong>
                <p>共 {{ youbikeData.allZeroDistricts.length }} 區、{{ youbikeData.zeroBikeStations.toLocaleString("zh-TW") }} 個場站</p>
              </div>

              <ol class="youbike-zero-district-list">
                <li v-for="(row, index) in youbikeData.allZeroDistricts" :key="row.district">
                  <span class="youbike-zero-district-rank">{{ String(index + 1).padStart(2, "0") }}</span>
                  <strong>{{ row.district }}</strong>
                  <span class="youbike-zero-district-track" aria-hidden="true">
                    <i :style="{ width: row.widthPercent + '%' }"></i>
                  </span>
                  <b>{{ row.count }}<small>站</small></b>
                </li>
              </ol>
            </aside>
          </div>
        </Transition>
      </Teleport>
      <!-- ===== [Jerry 修正：行政區零車站排行右側可放大面板結束] ===== -->

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

      <!-- [本次新增：青年健康指標獨立附加在既有托育圖表後方，不改動 resourceGaps.childcare] -->
      <section class="mortality-section" aria-labelledby="mortality-section-title">
        <div class="toolbar mortality-toolbar">
          <span><strong id="mortality-section-title">青年健康指標 Top 5</strong></span>
          <span class="info-tag">民國 {{ appState.mortalityYear || "—" }} 年・20–29歲</span>
        </div>
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
              各行政區自殺死亡數占同齡全部死因死亡數的比例；點擊圖表查看全部29區。
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

    <!-- 使用原生 dialog 提供焦點限制、Escape 關閉與 modal semantics，不使用 Fullscreen API。 -->
    <dialog ref="mortalityDialog" class="mortality-dialog"
            aria-labelledby="mortality-dialog-title" aria-describedby="mortality-dialog-description"
            @close="handleMortalityDialogClose" @click="handleMortalityBackdropClick">
      <section class="mortality-dialog-panel">
        <header class="mortality-dialog-header">
          <div>
            <p class="section-kicker">Youth Health Indicator</p>
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
