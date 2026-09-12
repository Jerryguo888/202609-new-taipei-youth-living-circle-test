<script setup>
import { appState } from "../store/appState.js";
</script>

<template>
  <!-- ===== [原本 30 分鐘 Leaflet 分頁完整保留；整合頁不再重複第二張圖] ===== -->
  <section id="combined-transit" class="view module combined-part">
    <div class="transit-layout">
      <aside class="transit-sidebar">
        <p class="section-kicker">交通分析</p>
        <h1>30 分鐘交通圈</h1>
        <p>選擇公車或捷運站，查看 30 分鐘內可到達的站點與路線。</p>

        <div class="control-block">
          <!-- [本次改版新增：公車／捷運共用選站流程] -->
          <div class="transit-mode-tabs" role="tablist" aria-label="交通工具">
            <button class="transit-mode-button" :class="{ active: appState.stopMode === 'bus' }"
                    @click="appState.selectStopMode('bus')">公車站</button>
            <button class="transit-mode-button" :class="{ active: appState.stopMode === 'metro' }"
                    @click="appState.selectStopMode('metro')">捷運站</button>
          </div>
          <label class="control-label" for="stop-search">出發交通節點</label>
          <div class="search-holder">
            <input id="stop-search" class="field" type="search" autocomplete="off"
                   v-model="appState.stopQuery" @input="appState.findStops" @focus="appState.findStops"
                   :placeholder="appState.searchPlaceholder">
            <div class="suggestions" v-if="appState.stopSuggestions.length">
              <button class="suggestion" v-for="stop in appState.stopSuggestions" :key="stop.id"
                      @click="appState.chooseStop(stop.id)">
                {{ stop.name }}<small>{{ stop.kindLabel }}・{{ stop.routeCount }} 條路線</small>
              </button>
            </div>
          </div>
          <!-- [本次新增：行政區橫向籤＋單區站位選單，避免 8,746 站一路拉到底] -->
          <div class="station-picker" v-if="appState.stopMode === 'bus'">
            <label class="control-label" for="station-select">依行政區瀏覽站位</label>
            <div class="district-tabs" role="tablist" aria-label="行政區">
              <button v-for="group in appState.stationGroups" :key="group.name" class="district-tab"
                      :class="{ active: appState.activeDistrict === group.name }"
                      @click="appState.selectDistrict(group.name)">
                {{ group.name }}<small>{{ group.stops.length }}</small>
              </button>
            </div>
            <select id="station-select" v-model="appState.selectedStartId" @change="appState.chooseStop(appState.selectedStartId, true)"
                    :disabled="!appState.transitLoaded">
              <option :value="null" disabled>請選擇 {{ appState.activeDistrict }} 的站位</option>
              <option v-for="stop in appState.activeDistrictStops" :key="stop.id" :value="stop.id">
                {{ stop.name }}（{{ stop.routeCount }} 路線）
              </option>
            </select>
          </div>

          <!-- [本次改版新增：捷運依路線橫向瀏覽，站點可直接作為起點] -->
          <div class="station-picker" v-else>
            <label class="control-label" for="metro-station-select">依路線瀏覽捷運站</label>
            <div class="district-tabs" role="tablist" aria-label="捷運路線">
              <button v-for="group in appState.metroGroups" :key="group.id" class="district-tab metro-tab"
                      :class="{ active: appState.activeMetroLine === group.id }"
                      :style="{ '--line-color': group.color }"
                      @click="appState.selectMetroLine(group.id)">
                <i :style="{ background: group.color }"></i>{{ group.name }}<small>{{ group.stops.length }}</small>
              </button>
            </div>
            <select id="metro-station-select" v-model="appState.selectedStartId" @change="appState.chooseStop(appState.selectedStartId, true)"
                    :disabled="!appState.transitLoaded">
              <option :value="null" disabled>請選擇捷運站</option>
              <option v-for="stop in appState.activeMetroStops" :key="stop.id" :value="stop.id">
                {{ stop.name }}（{{ stop.lineNames }}）
              </option>
            </select>
          </div>

          <p class="transit-model-note">包含平均候車、站間行駛、停靠、步行轉乘與轉乘候車時間。</p>

          <div class="control-pair">
            <label><span class="control-label">出發時間</span><input type="time" v-model="appState.departureTime"></label>
            <label><span class="control-label">動畫速度</span>
              <select v-model.number="appState.animationSpeed"><option :value="1">1×</option><option :value="2">2×</option><option :value="4">4×</option></select>
            </label>
          </div>

          <div class="range-line">
            <span class="control-label">可達時間上限</span>
            <strong>{{ appState.minuteLimit }} 分</strong>
          </div>
          <input type="range" min="10" max="60" step="5" v-model.number="appState.minuteLimit">

          <button class="action-button" :disabled="appState.transitLoading || !appState.selectedStartId" @click="appState.runReachability">
            計算 30 分鐘範圍
          </button>
        </div>

        <div class="control-block">
          <span class="control-label">分析結果</span>
          <div class="metric-grid">
            <div class="metric"><strong>{{ appState.metrics.stops }}</strong><span>可達站位</span></div>
            <div class="metric"><strong>{{ appState.metrics.routes }}</strong><span>涵蓋路線</span></div>
            <div class="metric"><strong>{{ appState.metrics.distance }}</strong><span>最遠直線距離</span></div>
            <div class="metric"><strong>{{ appState.metrics.wait }}</strong><span>起始候車</span></div>
          </div>

          <!-- [本次新增：列出本次可達的公車，點一下即在地圖顯示完整路線] -->
          <div class="result-routes" v-if="appState.resultRoutes.length">
            <span class="control-label">可搭公車・點選查看路線圖</span>
            <div class="result-route-list">
              <button v-for="route in appState.resultRoutes" :key="route.id" class="result-route-chip"
                      :class="{ active: appState.selectedRouteId === route.id }"
                      @click="appState.focusBusRoute(route.id)">{{ route.name }}</button>
            </div>
            <div class="selected-route-card" v-if="appState.selectedRouteInfo">
              <strong>{{ appState.selectedRouteInfo.name }}｜{{ appState.selectedRouteInfo.provider }}</strong>
              <span>{{ appState.selectedRouteInfo.departure }} → {{ appState.selectedRouteInfo.destination }}</span>
              <button class="route-clear" @click="appState.clearBusRoute">清除單一路線圖</button>
            </div>
          </div>

          <!-- [本次改版新增：可達捷運路線清單，操作方式與公車一致] -->
          <div class="result-routes" v-if="appState.resultMetroLines.length">
            <span class="control-label">可搭捷運・點選查看路線圖</span>
            <div class="result-route-list">
              <button v-for="line in appState.resultMetroLines" :key="line.id" class="result-route-chip"
                      :class="{ active: appState.selectedMetroLineId === line.id }"
                      @click="appState.focusMetroLine(line.id)">{{ line.name }}</button>
            </div>
            <div class="selected-route-card metro" v-if="appState.selectedMetroLineInfo">
              <strong>{{ appState.selectedMetroLineInfo.name }}</strong>
              <span>本頁資料含 {{ appState.selectedMetroLineInfo.stationCount }} 個站點</span>
              <button class="route-clear" @click="appState.clearMetroLine">清除單一路線圖</button>
            </div>
          </div>
        </div>
      </aside>

      <div class="map-wrap">
        <div id="transit-map"></div>
        <div class="map-clock"><small>模擬經過時間</small><strong>{{ appState.animationClock }}</strong></div>
        <div class="map-data-badge">{{ appState.transitStatus }}</div>
        <div class="map-legend">
          <div><i style="background:#70847e"></i>公車站（點擊選站）</div>
          <div><i style="background:#2fae9c"></i>較快可達</div>
          <div><i style="background:#f2c94c"></i>接近上限</div>
          <div><i style="background:#e16755"></i>出發節點</div>
          <div><i style="background:#0a59ae"></i>捷運站／路線（點擊選站）</div>
        </div>
        <div class="map-loading" v-if="appState.transitLoading">
          <div class="loader">
            <strong>正在建立新北市交通網路</strong>
            <div class="loader-line"></div>
            <p style="color:#58716a;font-size:.8rem">解析官方公車與捷運站線資料</p>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
