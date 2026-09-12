<script setup>
import { nextTick, onBeforeUnmount, ref } from "vue";
import { appState } from "../store/appState.js";
import MortalityBarRows from "../components/MortalityBarRows.vue";

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
  if (mortalityDialog.value && mortalityDialog.value.open) mortalityDialog.value.close();
  document.body.style.overflow = previousBodyOverflow;
});
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
