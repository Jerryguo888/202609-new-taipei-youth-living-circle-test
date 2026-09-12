<script setup>
import { ref } from "vue";
import { appState } from "../store/appState.js";

/* [Jerry 2026-09-12 新增：整合地圖控制欄可整體滑入／收回左側。]
   只管理介面開關，不改動地圖、人口或 30 分鐘交通計算狀態。 */
const mapControlsOpen = ref(true);

function handleAgeGroupChange(age, event) {
  appState.toggleAgeGroup(age, event.target.checked);
}

/* [Jerry 2026-09-13 新增：公車站與捷運站使用各自的圖層開關。] */
function handleTransitLayerChange(mode, event) {
  appState.toggleTransitLayer(mode, event.target.checked);
}
</script>

<template>
  <!-- ===== [本次改版：3D人口／30分鐘交通／預算模擬／青年熱區都刪掉了，
       整合地圖是唯一的地圖畫面，一律全螢幕顯示，不再需要 map3d 的條件判斷] ===== -->
  <section id="combined-population" class="view module combined-part is-fullscreen-map">
    <div class="module-body legacy-map-body">
      <div class="legacy-map-shell">
        <!-- [本次移植：以下容器由新頁面內的 MapLibre 程式直接繪製，不使用 iframe] -->
        <div class="population-3d-stage with-transit">
          <div id="population-3d-map" aria-label="新北市青年人口 3D 地圖"></div>
          <div id="population-3d-tooltip" class="population-3d-tooltip"></div>
          <div id="population-3d-status" class="population-3d-status">歷年人口資料載入中…</div>

          <!-- ===== [Jerry 2026-09-12 改版：左側地圖控制抽屜開始] =====
               圖例與交通分析包在同一個深色大面板；整欄可滑入／收回，
               子區塊依內容高度排列，收合時不再平均分攤剩餘高度。 -->
          <div class="map-control-drawer" :class="{ 'is-open': mapControlsOpen }">
            <aside id="map-control-panel" class="map-side-panel" aria-label="地圖顯示與交通分析控制"
                   :aria-hidden="!mapControlsOpen" :inert="!mapControlsOpen">
              <header class="map-side-panel-head">
                <strong>地圖控制</strong>
              </header>

              <div class="map-side-panel-sections">
                <details class="side-section" open>
                  <summary>圖例</summary>
                  <div class="side-section-body">
                    <label class="legend-row" v-for="(age, index) in appState.legendAgeGroups" :key="age">
                      <input type="checkbox" class="legend-checkbox"
                             :checked="appState.selectedAgeGroups.includes(age)"
                             @change="handleAgeGroupChange(age, $event)">
                      <span class="swatch" :style="{ background: appState.legendColors[index] }"></span>{{ age }}
                    </label>
                    <!-- ===== [Jerry 2026-09-13 改版：交通標點獨立開關開始] ===== -->
                    <fieldset class="transit-legend-group">
                      <legend>交通標點</legend>
                      <div class="transit-legend-options">
                        <label class="legend-row is-transit">
                          <input type="checkbox" class="legend-checkbox" :checked="appState.showBusStops"
                                 @change="handleTransitLayerChange('bus', $event)">
                          <span class="swatch is-bus" aria-hidden="true"></span>公車站
                        </label>
                        <label class="legend-row is-transit">
                          <input type="checkbox" class="legend-checkbox" :checked="appState.showMetroStops"
                                 @change="handleTransitLayerChange('metro', $event)">
                          <span class="swatch is-metro" aria-hidden="true"></span>捷運站
                        </label>
                      </div>
                    </fieldset>
                    <!-- ===== [Jerry 2026-09-13 改版：交通標點獨立開關結束] ===== -->
                  </div>
                </details>

                <details class="side-section" open>
                  <summary>30 分鐘交通分析</summary>
                  <div class="side-section-body">
                <div class="integrated-mode-tabs">
                  <button type="button" :class="{ active: appState.stopMode === 'bus' }"
                          :aria-pressed="appState.stopMode === 'bus'"
                          @click="appState.selectStopMode('bus')">公車站</button>
                  <button type="button" :class="{ active: appState.stopMode === 'metro' }"
                          :aria-pressed="appState.stopMode === 'metro'"
                          @click="appState.selectStopMode('metro')">捷運站</button>
                </div>

                <template v-if="appState.stopMode === 'bus'">
                  <label class="integrated-field">
                    <span>行政區</span>
                    <select v-model="appState.activeDistrict" @change="appState.selectDistrict(appState.activeDistrict)" :disabled="!appState.transitLoaded">
                      <option v-for="group in appState.stationGroups" :key="group.name" :value="group.name">{{ group.name }}（{{ group.stops.length }}）</option>
                    </select>
                  </label>
                  <label class="integrated-field">
                    <span>出發公車站</span>
                    <select v-model="appState.selectedStartId" @change="appState.chooseStop(appState.selectedStartId, true)" :disabled="!appState.transitLoaded">
                      <option :value="null" disabled>請選擇站位</option>
                      <option v-for="stop in appState.activeDistrictStops" :key="stop.id" :value="stop.id">{{ stop.name }}（{{ stop.routeCount }} 路線）</option>
                    </select>
                  </label>
                </template>

                <template v-else>
                  <label class="integrated-field">
                    <span>捷運路線</span>
                    <select v-model="appState.activeMetroLine" @change="appState.selectMetroLine(appState.activeMetroLine)" :disabled="!appState.transitLoaded">
                      <option v-for="group in appState.metroGroups" :key="group.id" :value="group.id">{{ group.name }}（{{ group.stops.length }} 站）</option>
                    </select>
                  </label>
                  <label class="integrated-field">
                    <span>出發捷運站</span>
                    <select v-model="appState.selectedStartId" @change="appState.chooseStop(appState.selectedStartId, true)" :disabled="!appState.transitLoaded">
                      <option :value="null" disabled>請選擇捷運站</option>
                      <option v-for="stop in appState.activeMetroStops" :key="stop.id" :value="stop.id">{{ stop.name }}（{{ stop.lineNames }}）</option>
                    </select>
                  </label>
                </template>

                <div class="integrated-field-row">
                  <label class="integrated-field"><span>出發時間</span><input type="time" v-model="appState.departureTime"></label>
                  <label class="integrated-field"><span>動畫速度</span><select v-model.number="appState.animationSpeed"><option :value="1">1×</option><option :value="2">2×</option><option :value="4">4×</option></select></label>
                </div>
                <div class="integrated-minute-row"><span>可達時間上限</span><strong>{{ appState.minuteLimit }} 分</strong></div>
                <input type="range" min="10" max="60" step="5" v-model.number="appState.minuteLimit">
                <button class="integrated-run" :disabled="appState.transitLoading || !appState.selectedStartId" @click="appState.runReachability">計算可達範圍</button>
                <div class="integrated-metrics">
                  <div><strong>{{ appState.metrics.stops }}</strong><span>站位</span></div>
                  <div><strong>{{ appState.metrics.routes }}</strong><span>路線</span></div>
                  <div><strong>{{ appState.metrics.distance }}</strong><span>最遠距離</span></div>
                  <div><strong>{{ appState.metrics.wait }}</strong><span>起始候車</span></div>
                </div>
                <p class="integrated-model-note">已納入平均候車、站間行駛、停靠、步行轉乘與轉乘候車；目前為規劃估算。</p>
                <!-- [Jerry 2026-09-13 新增：清除本次 30 分鐘結果並停止動畫，
                     回到人口柱與基礎交通標點的初始顯示。] -->
                <button type="button" class="map-clear-button" :disabled="!appState.reachabilityActive"
                        @click="appState.clearReachability">清空結果</button>
                <button class="map-reset-button" @click="appState.resetPopulationMapView">回到新北全區</button>
                  </div>
                </details>
              </div>
            </aside>

            <button type="button" class="map-control-drawer-toggle"
                    :aria-expanded="mapControlsOpen" aria-controls="map-control-panel"
                    :aria-label="mapControlsOpen ? '收起地圖控制欄' : '展開地圖控制欄'"
                    @click="mapControlsOpen = !mapControlsOpen">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m15 18-6-6 6-6"></path>
              </svg>
              <span>{{ mapControlsOpen ? "收起" : "工具" }}</span>
            </button>
          </div>
          <!-- ===== [Jerry 2026-09-12 改版：左側地圖控制抽屜結束] ===== -->
        </div>
      </div>
    </div>
  </section>
</template>
