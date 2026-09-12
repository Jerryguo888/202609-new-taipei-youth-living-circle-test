<script setup>
import { appState } from "../store/appState.js";

function handleAgeGroupChange(age, event) {
  appState.toggleAgeGroup(age, event.target.checked);
}

function handleTransitStopsChange(event) {
  appState.toggleTransitStops(event.target.checked);
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

          <!-- [本次改版：青年熱區排行、圖例、交通分析整合成左側同一面板，
               各自可收合，取代原本圖例／年份面板／交通面板三個各自浮動的區塊] -->
          <div class="map-side-panel">
            <details class="side-section" open>
              <summary>圖例</summary>
              <div class="side-section-body">
                <label class="legend-row" v-for="(age, index) in appState.legendAgeGroups" :key="age">
                  <input type="checkbox" class="legend-checkbox"
                         :checked="appState.selectedAgeGroups.includes(age)"
                         @change="handleAgeGroupChange(age, $event)">
                  <span class="swatch" :style="{ background: appState.legendColors[index] }"></span>{{ age }}
                </label>
                <!-- [本次新增：交通標點開關，取代原本一直顯示的公車／捷運站點] -->
                <label class="legend-row">
                  <input type="checkbox" class="legend-checkbox" :checked="appState.showTransitStops"
                         @change="handleTransitStopsChange($event)">
                  <span class="swatch" style="background:#899390"></span>交通標點
                </label>
              </div>
            </details>

            <details class="side-section" open>
              <summary>青年熱區排行</summary>
              <div class="side-section-body">
                <div class="forecast-list">
                  <div class="forecast-row" v-for="row in appState.forecastRows" :key="row.name">
                    <span>{{ row.name }}</span>
                    <span class="forecast-bar"><i :style="{ width: row.score + '%' }"></i></span>
                    <strong>{{ row.score }}</strong>
                  </div>
                </div>
              </div>
            </details>

            <details class="side-section" open>
              <summary>30 分鐘交通分析</summary>
              <div class="side-section-body">
                <div class="integrated-mode-tabs">
                  <button :class="{ active: appState.stopMode === 'bus' }" @click="appState.selectStopMode('bus')">公車站</button>
                  <button :class="{ active: appState.stopMode === 'metro' }" @click="appState.selectStopMode('metro')">捷運站</button>
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
                <button class="map-reset-button" @click="appState.resetPopulationMapView">回到新北全區</button>
              </div>
            </details>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
