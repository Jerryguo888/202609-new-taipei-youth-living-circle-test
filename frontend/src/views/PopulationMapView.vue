<script setup>
import { appState } from "../store/appState.js";
</script>

<template>
  <!-- ===== [組員原始 3D 分頁保留；整合頁僅額外顯示同一份內容] ===== -->
  <section id="combined-population" class="view module combined-part"
           :class="{ 'is-fullscreen-map': appState.activeView === 'combined' }">
    <div class="module-body legacy-map-body">
      <div class="legacy-map-shell">
        <div class="legacy-map-toolbar">
          <div><strong>新北市 20～34 歲人口分布</strong><span>可旋轉、縮放並切換原資料年份與年齡層</span></div>
          <div class="legacy-map-actions">
            <span class="legacy-map-badge">{{ appState.activeView === 'combined' ? '3D 人口 × 30 分鐘交通' : '組員既有成果' }}</span>
            <!-- [2026-09-11 新增：一鍵回到新北全區的原始鏡位] -->
            <button class="map-reset-button" @click="appState.resetPopulationMapView">回到新北全區</button>
          </div>
        </div>
        <!-- [本次移植：以下容器由新頁面內的 MapLibre 程式直接繪製，不使用 iframe] -->
        <div class="population-3d-stage" :class="{ 'with-transit': appState.activeView === 'combined' }">
          <div id="population-3d-map" aria-label="新北市青年人口 3D 地圖"></div>
          <div id="population-3d-legend" class="population-3d-legend" hidden>
            <h3>年齡層</h3>
            <div id="population-3d-legend-rows"></div>
          </div>
          <div id="population-3d-year-panel" class="population-3d-year-panel" hidden>
            <span>資料年份</span>
            <div class="population-3d-year-row">
              <input type="range" id="population-3d-year-slider" min="0" max="0" step="1" value="0">
              <strong id="population-3d-year-label">—</strong>
            </div>
          </div>
          <div id="population-3d-tooltip" class="population-3d-tooltip"></div>
          <div id="population-3d-status" class="population-3d-status">歷年人口資料載入中…</div>

          <!-- [2026-09-11 新增：整合頁直接在同一張 3D 圖操作交通，不再放第二張 Leaflet 圖] -->
          <details class="integrated-transit-panel" v-if="appState.activeView === 'combined'" open>
            <summary>30 分鐘交通分析</summary>
            <div class="integrated-transit-body">
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
  </section>
</template>
