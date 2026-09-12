import maplibregl from "maplibre-gl";
import { DATA_FILES } from "./data/dataFiles.js";
import { loadPopulationCsv, dataLoadHint } from "./data/fetchCsv.js";
import {
  transitNodes,
  searchableNodes,
  searchableMetroNodes,
  metroRoutes,
  metroLineMeta,
} from "./network.js";
import { loadNetworkCore } from "./network.js";
import { ensureTransitReachCache, buildDistrictTransitScores } from "./reachability.js";

/* [本次移植：原本直接呼叫全域 appVm 的地方，改成呼叫由外部（appState store）
   註冊進來的 controller，避免這個模組要反過來 import store 造成循環依賴。
   controller 需要提供：selectedStartId、chooseStop(id, moveMap)、
   animationSpeed、animationClock、showBusStops、showMetroStops。] */
let controller = null;
export function setMapController(nextController) {
  controller = nextController;
}

/* [2026-09-12 新增：把可視範圍鎖在新北市，避免使用者拖到台灣以外的地方]

   數字是從本專案實際會畫出來的點位反推的（新北公車站牌 33,109 站、新北捷運、
   台北捷運、行政區中心點），四個極值剛好對上新北的地理極點：
     西 121.285（林口）  東 122.002（貢寮三貂角）
     南 24.836（烏來一帶）  北 25.298（石門富貴角）
   再各往外留約 0.1 度的緩衝，理由有三：
     1. 烏來區行政範圍往南延伸到約 24.67，但那一帶山區沒有任何資料點；
     2. pitch 55 的傾斜視角實際看到的地面範圍比正射時大，緩衝可以避免
        MapLibre 為了把畫面壓進 maxBounds 而強制拉近；
     3. 台北市與基隆被新北包圍，這個框本來就完整涵蓋，捷運資料不會被切掉。
   MapLibre 的 maxBounds 只支援矩形，所以這是「外接矩形」而不是實際市界輪廓。 */
export const NEW_TAIPEI_MAX_BOUNDS = [
  [121.20, 24.62], // 西南
  [122.10, 25.40], // 東北
];

/* 整個新北在 1200px 寬的畫面約 z10 就裝得下，手機窄畫面 fitBounds 會算到約
   z8.7，所以下限取 8：夠低不會擋住 fitBounds，又不會讓使用者縮到看見全世界。 */
export const NEW_TAIPEI_MIN_ZOOM = 8;

/* [本次新增：地圖預設鏡位改成定位在板橋區，不再是套整個新北市 bounds 的置中。
   座標沿用 appState.js 選預設起點站時已經在用的板橋座標，全站統一同一個點。
   [實測修正：原本用 zoom 10（跟以前 fitBounds 整個新北市時差不多的縮放），
   但板橋離 NEW_TAIPEI_MAX_BOUNDS 的西邊界（121.20）不夠遠——在寬螢幕、
   pitch 55 的鏡位下，以 zoom 10 置中板橋所需要看到的西側範圍會超出
   maxBounds，MapLibre 會自動把 center 往東修正，修正後的座標跟請求的完全
   不同（而且修正量會隨畫面寬度變動，不可預期）。這對「置中板橋」跟「再往
   右挪一點」兩件事都造成很怪的連鎖效應，實測甚至出現鏡位暴衝、跳到宜蘭
   外海的離譜結果。改成 zoom 11：可視範圍縮小，板橋到西邊界就有足夠空間，
   不會再觸發 maxBounds 修正，置中跟位移才會照預期運作。] */
const BANQIAO_CENTER = [121.4639, 25.0142];
const BANQIAO_DEFAULT_ZOOM = 11;

/* 左側面板（青年熱區排行／圖例／交通分析）浮在地圖左側，寬度是容器的 30%，
   如果直接把板橋設成畫面正中央，視覺上會偏左（被面板蓋住一塊）。
   [實測修正：CameraOptions.padding／AnimationOptions.offset 這兩個 MapLibre
   內建的位移選項，語意上都應該能把 center 移到畫面非正中央的位置，但只要
   前面提到的 maxBounds 修正一起發生，兩者都會算歪（因為它們是在「MapLibre
   已經因為 maxBounds 修正過一次 center」之後才疊加位移，兩次修正互相干擾）。
   改成完全不依賴這兩個選項：先把板橋設成畫面正中央（zoom 11 之後這一步
   本身就很單純可靠），再用 project()／unproject() 自己算出「要把哪個地理
   座標放在正中央，才能讓板橋落在正中央往右挪一段距離的位置」，最後只是
   一般的 center 改變（沒有 offset／padding）——這條路徑跟使用者拖曳地圖是
   同一套邏輯。手機版面板會變成幾乎全寬的收合選單，不適用同一招，直接
   當作沒有側欄。 */
function getBanqiaoSidePanelShiftX() {
  if (window.innerWidth <= 820) return 0;
  const panel = document.querySelector(".map-side-panel");
  const panelWidth = panel ? panel.getBoundingClientRect().width : 0;
  return panelWidth ? panelWidth / 2 + 8 : 0;
}

/* [本次改版：算出「板橋往右挪一段距離」實際對應的地理座標，內部會暫時
   把鏡位跳到板橋（不套任何位移）算完 project／unproject 後再跳回呼叫前
   的原始鏡位——因為是同步、瞬間跳兩次，畫面根本來不及重繪，使用者不會
   看到中間這一格，呼叫端拿到座標後再自己接一次平滑的 easeTo 到最終位置，
   zoom／pitch／bearing 一樣會平滑過渡，不會有「先瞬間跳定位、只有最後
   一小段位移用動畫」的割裂感。] */
function computeBanqiaoShiftedCenter(map) {
  const shiftX = getBanqiaoSidePanelShiftX();
  if (!shiftX) return BANQIAO_CENTER;
  const original = { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
  map.jumpTo({ center: BANQIAO_CENTER, zoom: BANQIAO_DEFAULT_ZOOM, pitch: 55, bearing: -10 });
  const screenPoint = map.project(BANQIAO_CENTER);
  const shifted = map.unproject([screenPoint.x - shiftX, screenPoint.y]);
  map.jumpTo(original);
  return [shifted.lng, shifted.lat];
}

export let population3dMap = null;
let population3dLoading = false;
export let population3dBaseReady = false;
export let population3dBounds = null;
let integratedTransitReady = false;
let integratedAnimationFocus = false;
let popByYearRef = {};

/* [本次改版：拿掉年份滑桿，圖例的年齡層／可及性選取狀態改由這裡集中管理，
   供 Vue 左側面板讀取／勾選；顏色與標籤是固定常數，地圖畫好後才會有 redrawBars] */
export const AGE_GROUPS = ["20~29歲", "30~34歲", "交通可及性"];
export const AGE_GROUP_COLORS = ["#24d7ff", "#ff4f9a", "#ffd447"];
let redrawBars = null;

export function redrawPopulationBars(selectedAges) {
  /* 動畫期間來源資料也保持空白，避免只靠 visibility 時被圖例重繪帶回最後一根柱。 */
  if (redrawBars) redrawBars(integratedAnimationFocus ? [] : selectedAges);
}

/* [Jerry 2026-09-13 改版：基礎公車／捷運圖層分組，30 分鐘結果維持獨立。]
   圖例開關只控制站點與捷運線，不會誤把已計算的可達結果或起點一起關掉。 */
const INTEGRATED_BUS_LAYER_IDS = [
  "integrated-bus-clusters",
  "integrated-bus-cluster-count",
  "integrated-bus-cluster-hit",
  "integrated-bus-stops",
  "integrated-bus-stop-hit",
];
const INTEGRATED_METRO_LAYER_IDS = [
  "integrated-metro-lines",
  "integrated-metro-stations",
];
const INTEGRATED_ANALYSIS_LAYER_IDS = [
  "integrated-result-lines",
  "integrated-result-points",
  "integrated-origin-glow",
  "integrated-origin",
];
const INTEGRATED_TRANSIT_LAYER_IDS = [
  ...INTEGRATED_BUS_LAYER_IDS,
  ...INTEGRATED_METRO_LAYER_IDS,
  ...INTEGRATED_ANALYSIS_LAYER_IDS,
];
const INTEGRATED_CONTEXT_LAYER_IDS = [
  "pop-bars-layer",
  "district-label-layer",
];

/* ===== [2026-09-11 新增：3D 人口圖上的公車／捷運／30 分鐘路網開始] ===== */
function emptyFeatureCollection() {
  return { type: "FeatureCollection", features: [] };
}

function setIntegratedSourceData(sourceId, data) {
  if (!population3dMap) return;
  const source = population3dMap.getSource(sourceId);
  if (source) source.setData(data || emptyFeatureCollection());
}

function integratedBaseCollections() {
  const busFeatures = searchableNodes.map(function (node) {
    return {
      type: "Feature",
      properties: { id: node.id, name: node.name, district: node.district },
      geometry: { type: "Point", coordinates: [node.lon, node.lat] },
    };
  });
  const metroLineFeatures = [];
  metroRoutes.forEach(function (route) {
    const coordinates = route.stations.map(function (station) { return [station.lon, station.lat]; });
    if (coordinates.length < 2) return;
    metroLineFeatures.push({
      type: "Feature",
      properties: { lineId: route.lineId, name: route.name, color: route.color || "#4cc9ff" },
      geometry: { type: "LineString", coordinates: coordinates },
    });
  });
  const metroFeatures = searchableMetroNodes.map(function (node) {
    const lineIds = Array.from(node.lines || []);
    const line = metroLineMeta.get(lineIds[0]) || {};
    return {
      type: "Feature",
      properties: {
        id: node.id,
        name: node.name,
        lines: lineIds.map(function (id) { return (metroLineMeta.get(id) || {}).name || id; }).join("、"),
        color: line.color || "#4cc9ff",
      },
      geometry: { type: "Point", coordinates: [node.lon, node.lat] },
    };
  });
  return {
    bus: { type: "FeatureCollection", features: busFeatures },
    metroLines: { type: "FeatureCollection", features: metroLineFeatures },
    metroStations: { type: "FeatureCollection", features: metroFeatures },
  };
}

function setIntegratedLayerGroupVisibility(layerIds, visible) {
  layerIds.forEach(function (layerId) {
    if (population3dMap.getLayer(layerId)) {
      population3dMap.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
    }
  });
}

export function setIntegratedTransitVisibility(busVisible, metroVisible) {
  if (!population3dMap || !integratedTransitReady) return;
  /* 動畫專注模式優先於圖例勾選，避免計算途中把大量灰點重新顯示出來。 */
  const showBus = !integratedAnimationFocus && busVisible !== false;
  const showMetro = !integratedAnimationFocus && metroVisible !== false;
  setIntegratedLayerGroupVisibility(INTEGRATED_BUS_LAYER_IDS, showBus);
  setIntegratedLayerGroupVisibility(INTEGRATED_METRO_LAYER_IDS, showMetro);
  const mapElement = document.getElementById("population-3d-map");
  if (mapElement) {
    mapElement.dataset.busStops = showBus ? "visible" : "hidden";
    mapElement.dataset.metroStops = showMetro ? "visible" : "hidden";
    mapElement.dataset.transitLayers = showBus && showMetro
      ? "visible"
      : showBus || showMetro ? "partial" : "hidden";
  }
}

/* [Jerry 2026-09-13 新增：30 分鐘動畫專注模式]
   開始計算時隱藏人口柱、行政區文字及全部基礎交通標點，只留下底圖、起點、
   可達路線與逐分鐘跑點；重新選站或重設鏡位時再依原圖例狀態恢復。 */
export function setIntegratedAnimationFocus(active) {
  integratedAnimationFocus = active === true;
  if (!population3dMap) return;
  /* 除了隱藏圖層，也清空柱狀來源；離開專注模式時再依目前勾選狀態重建。 */
  if (redrawBars) {
    const selectedAges = controller && Array.isArray(controller.selectedAgeGroups)
      ? controller.selectedAgeGroups
      : AGE_GROUPS;
    redrawBars(integratedAnimationFocus ? [] : selectedAges);
  }
  setIntegratedLayerGroupVisibility(INTEGRATED_CONTEXT_LAYER_IDS, !integratedAnimationFocus);
  setIntegratedTransitVisibility(
    controller ? controller.showBusStops : true,
    controller ? controller.showMetroStops : true,
  );
  const mapElement = document.getElementById("population-3d-map");
  if (mapElement) mapElement.dataset.animationFocus = integratedAnimationFocus ? "active" : "inactive";
}

function bindIntegratedPointerLayer(layerId) {
  population3dMap.on("mouseenter", layerId, function () { population3dMap.getCanvas().style.cursor = "pointer"; });
  population3dMap.on("mouseleave", layerId, function () { population3dMap.getCanvas().style.cursor = ""; });
}

export function ensureIntegratedTransitLayers() {
  const diagnosticElement = document.getElementById("population-3d-map");
  if (diagnosticElement) diagnosticElement.dataset.transitLayerAttempt = [
    population3dMap ? "map" : "no-map",
    population3dBaseReady ? "base-ready" : "base-waiting",
    "nodes-" + transitNodes.size,
  ].join("|");
  if (!population3dMap || !population3dBaseReady || !transitNodes.size) return;
  if (integratedTransitReady) {
    setIntegratedTransitVisibility(
      controller ? controller.showBusStops : true,
      controller ? controller.showMetroStops : true,
    );
    return;
  }

  /* [本次修正：交通站點圖層一律插在人口柱之前，柱狀圖與行政區文字才不會被站點蓋住] */
  const beforeLayerId = population3dMap.getLayer("pop-bars-layer") ? "pop-bars-layer" : undefined;

  const base = integratedBaseCollections();
  population3dMap.addSource("integrated-bus-source", {
    type: "geojson",
    data: base.bus,
    cluster: true,
    clusterMaxZoom: 13,
    clusterRadius: 34,
  });
  population3dMap.addSource("integrated-metro-line-source", { type: "geojson", data: base.metroLines });
  population3dMap.addSource("integrated-metro-station-source", { type: "geojson", data: base.metroStations });
  population3dMap.addSource("integrated-result-line-source", { type: "geojson", data: emptyFeatureCollection() });
  population3dMap.addSource("integrated-result-point-source", { type: "geojson", data: emptyFeatureCollection() });
  population3dMap.addSource("integrated-origin-source", { type: "geojson", data: emptyFeatureCollection() });

  population3dMap.addLayer({
    id: "integrated-metro-lines",
    type: "line",
    source: "integrated-metro-line-source",
    paint: {
      "line-color": ["get", "color"],
      "line-width": ["interpolate", ["linear"], ["zoom"], 8, 2.2, 13, 5.5],
      "line-opacity": .88,
    },
  }, beforeLayerId);
  population3dMap.addLayer({
    id: "integrated-result-lines",
    type: "line",
    source: "integrated-result-line-source",
    paint: {
      "line-color": ["get", "color"],
      "line-width": ["case", ["==", ["get", "mode"], "metro"], 5, 2.8],
      "line-opacity": .94,
    },
  }, beforeLayerId);
  population3dMap.addLayer({
    id: "integrated-bus-clusters",
    type: "circle",
    source: "integrated-bus-source",
    filter: ["has", "point_count"],
    paint: {
      "circle-color": "#66716f",
      "circle-radius": ["step", ["get", "point_count"], 13, 30, 16, 100, 20],
      "circle-stroke-color": "#e5e9e7",
      "circle-stroke-width": 1.5,
      "circle-opacity": .9,
    },
  }, beforeLayerId);
  population3dMap.addLayer({
    id: "integrated-bus-cluster-count",
    type: "symbol",
    source: "integrated-bus-source",
    filter: ["has", "point_count"],
    layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 10 },
    paint: { "text-color": "#ffffff" },
  }, beforeLayerId);
  /* [2026-09-11 修正：群組點保留原尺寸，另外加大透明熱區避免旋轉地圖時點不到] */
  population3dMap.addLayer({
    id: "integrated-bus-cluster-hit",
    type: "circle",
    source: "integrated-bus-source",
    filter: ["has", "point_count"],
    paint: {
      "circle-color": "#000000",
      "circle-radius": ["step", ["get", "point_count"], 20, 30, 23, 100, 27],
      "circle-opacity": .01,
    },
  }, beforeLayerId);
  population3dMap.addLayer({
    id: "integrated-bus-stops",
    type: "circle",
    source: "integrated-bus-source",
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": "#899390",
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 3.5, 14, 6],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.4,
      "circle-opacity": .94,
    },
  }, beforeLayerId);
  /* [2026-09-11 修正：灰色站點視覺維持 3.5～6px，但滑鼠／觸控可按範圍擴為 12～15px] */
  population3dMap.addLayer({
    id: "integrated-bus-stop-hit",
    type: "circle",
    source: "integrated-bus-source",
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": "#000000",
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 12, 14, 15],
      "circle-opacity": .01,
    },
  }, beforeLayerId);
  population3dMap.addLayer({
    id: "integrated-result-points",
    type: "circle",
    source: "integrated-result-point-source",
    paint: {
      "circle-color": ["interpolate", ["linear"], ["get", "minutes"], 0, "#35ead0", 20, "#ffe05d", 30, "#ff7c69", 60, "#ef4f67"],
      "circle-radius": ["case", ["==", ["get", "mode"], "metro"], 7.5, 5],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.5,
      "circle-opacity": .98,
    },
  }, beforeLayerId);
  population3dMap.addLayer({
    id: "integrated-metro-stations",
    type: "circle",
    source: "integrated-metro-station-source",
    paint: {
      "circle-color": ["get", "color"],
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 4.5, 13, 7.5],
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2,
      "circle-opacity": .98,
    },
  }, beforeLayerId);
  population3dMap.addLayer({
    id: "integrated-origin-glow",
    type: "circle",
    source: "integrated-origin-source",
    paint: { "circle-color": "#ff574b", "circle-radius": 18, "circle-opacity": .22 },
  }, beforeLayerId);
  population3dMap.addLayer({
    id: "integrated-origin",
    type: "circle",
    source: "integrated-origin-source",
    paint: {
      "circle-color": "#ff574b",
      "circle-radius": 7,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 2.2,
    },
  }, beforeLayerId);

  integratedTransitReady = true;
  const mapElement = document.getElementById("population-3d-map");
  if (mapElement) mapElement.dataset.transitLayerCount = String(INTEGRATED_TRANSIT_LAYER_IDS.length);
  setIntegratedTransitVisibility(
    controller ? controller.showBusStops : true,
    controller ? controller.showMetroStops : true,
  );
  if (controller && controller.selectedStartId) drawIntegratedOrigin(transitNodes.get(controller.selectedStartId), false);

  population3dMap.on("click", "integrated-bus-cluster-hit", function (event) {
    const feature = event.features && event.features[0];
    const source = population3dMap.getSource("integrated-bus-source");
    if (!feature || !source) return;
    Promise.resolve(source.getClusterExpansionZoom(feature.properties.cluster_id)).then(function (zoom) {
      population3dMap.easeTo({ center: feature.geometry.coordinates, zoom: zoom, duration: 550 });
    });
  });
  population3dMap.on("click", "integrated-bus-stop-hit", function (event) {
    const feature = event.features && event.features[0];
    if (feature && controller) controller.chooseStop(feature.properties.id, true);
  });
  population3dMap.on("click", "integrated-metro-stations", function (event) {
    const feature = event.features && event.features[0];
    if (feature && controller) controller.chooseStop(feature.properties.id, true);
  });
  population3dMap.on("click", "integrated-result-points", function (event) {
    const feature = event.features && event.features[0];
    if (feature && controller) controller.chooseStop(feature.properties.id, true);
  });
  ["integrated-bus-cluster-hit", "integrated-bus-stop-hit", "integrated-metro-stations", "integrated-result-points"].forEach(bindIntegratedPointerLayer);
}

export function clearIntegratedResults(clearOrigin, restoreContext) {
  if (restoreContext !== false) setIntegratedAnimationFocus(false);
  setIntegratedSourceData("integrated-result-line-source", emptyFeatureCollection());
  setIntegratedSourceData("integrated-result-point-source", emptyFeatureCollection());
  if (clearOrigin !== false) setIntegratedSourceData("integrated-origin-source", emptyFeatureCollection());
}

export function drawIntegratedOrigin(node, moveMap) {
  if (!integratedTransitReady || !node) return;
  setIntegratedSourceData("integrated-origin-source", {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { id: node.id, name: node.name },
      geometry: { type: "Point", coordinates: [node.lon, node.lat] },
    }],
  });
  if (moveMap !== false) {
    population3dMap.easeTo({
      center: [node.lon, node.lat],
      zoom: Math.max(population3dMap.getZoom(), 12.5),
      pitch: 55,
      duration: 650,
    });
  }
}

export function focusIntegratedNodes(stops, maxZoom) {
  if (!population3dMap || !stops || !stops.length) return;
  const nodes = stops.map(function (stop) { return transitNodes.get(stop.id); }).filter(Boolean);
  if (nodes.length === 1) {
    population3dMap.easeTo({ center: [nodes[0].lon, nodes[0].lat], zoom: maxZoom || 13, pitch: 55, duration: 550 });
    return;
  }
  if (nodes.length > 1) {
    const bounds = new maplibregl.LngLatBounds();
    nodes.forEach(function (node) { bounds.extend([node.lon, node.lat]); });
    population3dMap.fitBounds(bounds, { padding: 70, maxZoom: maxZoom || 13, duration: 550 });
  }
}

function integratedResultCollections(result) {
  const lines = [];
  const points = [];
  const seen = new Set();
  result.reached.forEach(function (item, index) {
    const node = transitNodes.get(item.nodeId);
    if (!node) return;
    points.push({
      type: "Feature",
      properties: { id: node.id, name: node.name, minutes: item.time, mode: node.mode },
      geometry: { type: "Point", coordinates: [node.lon, node.lat] },
    });
    if (!index) return;
    const step = result.predecessor.get(item.stateKey);
    if (!step) return;
    const from = transitNodes.get(step.edge.from);
    const to = transitNodes.get(step.edge.to);
    const key = step.edge.from + "|" + step.edge.to + "|" + step.edge.routeId;
    if (!from || !to || seen.has(key)) return;
    seen.add(key);
    const lineColor = step.edge.mode === "metro"
      ? ((metroLineMeta.get(step.edge.lineId) || {}).color || "#4cc9ff")
      : step.edge.mode === "walk" ? "#aeb8b5" : "#28e0c3";
    lines.push({
      type: "Feature",
      properties: { mode: step.edge.mode || "bus", color: lineColor },
      geometry: { type: "LineString", coordinates: [[from.lon, from.lat], [to.lon, to.lat]] },
    });
  });
  return {
    lines: { type: "FeatureCollection", features: lines },
    points: { type: "FeatureCollection", features: points },
  };
}

let animateIntegratedTimer = null;

export function animateIntegratedResult(result) {
  if (!integratedTransitReady) return;
  clearIntegratedResults(false, false);
  setIntegratedAnimationFocus(true);
  const collections = integratedResultCollections(result);
  setIntegratedSourceData("integrated-result-line-source", collections.lines);
  const start = transitNodes.get(result.startId);
  drawIntegratedOrigin(start, false);

  if (start && result.reached.length > 1) {
    let latDelta = .006;
    let lonDelta = .008;
    result.reached.forEach(function (item) {
      const node = transitNodes.get(item.nodeId);
      if (!node) return;
      latDelta = Math.max(latDelta, Math.abs(node.lat - start.lat));
      lonDelta = Math.max(lonDelta, Math.abs(node.lon - start.lon));
    });
    population3dMap.fitBounds([
      [start.lon - lonDelta * 1.12, start.lat - latDelta * 1.12],
      [start.lon + lonDelta * 1.12, start.lat + latDelta * 1.12],
    ], { padding: window.innerWidth <= 820 ? 34 : 82, maxZoom: 13, duration: 650 });
  }

  let elapsed = 0;
  const tickMs = 170 / controller.animationSpeed;
  function tick() {
    controller.animationClock = String(Math.floor(elapsed)).padStart(2, "0") + ":00";
    setIntegratedSourceData("integrated-result-point-source", {
      type: "FeatureCollection",
      features: collections.points.features.filter(function (feature) { return feature.properties.minutes <= elapsed; }),
    });
    if (elapsed < result.maxMinutes) {
      elapsed += 1;
      animateIntegratedTimer = setTimeout(tick, tickMs);
    } else {
      animateIntegratedTimer = null;
    }
  }
  tick();
}
/* ===== [2026-09-11 新增：3D 人口圖上的公車／捷運／30 分鐘路網結束] ===== */

/* [本次改版：重置鏡位改成回到板橋區定位（跟預設鏡位一致），不再是套整個
   新北市 bounds 置中——這樣使用者拖走／縮放後按重置，會回到跟剛進頁面
   時同一個板橋定位，而不是每次都跳回城市置中。] */
export function resetPopulationMapView() {
  if (!population3dMap) return;
  setIntegratedAnimationFocus(false);
  population3dMap.easeTo({
    center: computeBanqiaoShiftedCenter(population3dMap),
    zoom: BANQIAO_DEFAULT_ZOOM,
    pitch: 55,
    bearing: -10,
    duration: 650,
  });
}

/* ===== [本次移植：組員 3D 人口地圖核心開始] =====
   複製原 3d_map 的資料交叉比對與立體堆疊；來源檔案保持唯讀，僅將容器與
   控制項改成目前網站的視覺樣式。
   [本次改版：拿掉年份滑桿，固定用最新一年的資料；圖例改由 Vue 左側面板
   渲染，這裡只保留「計算選取狀態→重繪柱狀圖」的邏輯，透過 redrawBars
   讓外部的 redrawPopulationBars() 呼叫。] */
export async function initPopulation3dMap() {
  if (population3dMap) {
    setTimeout(function () {
      population3dMap.resize();
      setIntegratedTransitVisibility(
        controller ? controller.showBusStops : true,
        controller ? controller.showMetroStops : true,
      );
    }, 0);
    return;
  }
  if (population3dLoading) return;
  population3dLoading = true;

  const status = document.getElementById("population-3d-status");
  const tooltip = document.getElementById("population-3d-tooltip");
  if (!status || !tooltip) {
    population3dLoading = false;
    return;
  }

  status.hidden = false;
  status.classList.remove("error");
  status.textContent = "歷年人口資料載入中…";

  try {
    const data = await Promise.all([
      loadPopulationCsv(DATA_FILES.populationDistricts),
      loadPopulationCsv(DATA_FILES.populationDistrictLocations),
      loadPopulationCsv(DATA_FILES.populationYouthCounts),
    ]);
    const validAreas = new Set(data[0].map(function (row) { return row.area; }).filter(function (area) { return area !== "新北市"; }));
    const locMap = new Map();
    data[1].forEach(function (row) {
      locMap.set(row.area, { lat: Number(row.lat), lon: Number(row.lon) });
    });

    const popByYear = {};
    data[2].forEach(function (row) {
      if (!validAreas.has(row.area)) return;
      const loc = locMap.get(row.area);
      if (!loc) return;
      if (!popByYear[row.year]) popByYear[row.year] = [];
      popByYear[row.year].push({
        area: row.area,
        lat: loc.lat,
        lon: loc.lon,
        a1: Number(row["age20~29"]),
        a2: Number(row["age30~34"]),
      });
    });

    popByYearRef = popByYear;
    const years = Object.keys(popByYear).sort(function (a, b) { return Number(a) - Number(b); });
    if (!years.length) throw new Error("CSV 交叉比對後沒有可顯示資料");
    /* 拿掉年份滑桿後固定顯示最新一年的資料 */
    const currentYear = years[years.length - 1];

    const selectedAges = new Set(AGE_GROUPS);
    let maxTotal = 0;
    popByYear[currentYear].forEach(function (row) { maxTotal = Math.max(maxTotal, row.a1 + row.a2); });
    const scale = 5000 / maxTotal;
    const half = .004;
    /* [本次新增：交通可及性分數換算高度用的獨立比例尺，等交通資料算完才會有值；
       算好前這根柱子不會出現，算好後會重新繪製] */
    let transitScale = 0;
    let transitScores = null;
    /* [本次改版：交通可及性是「比率 × 人口」的複合分數，跟人口柱的「人數」單位不同，
       改成畫在人口柱右側的獨立柱子，不再疊加，避免總高度混合兩種不同單位] */
    const transitHalf = half;
    const transitOffsetLon = half + transitHalf + .0015;

    function squareRing(lon, lat, sizeHalf) {
      return [[
        [lon - sizeHalf, lat - sizeHalf],
        [lon + sizeHalf, lat - sizeHalf],
        [lon + sizeHalf, lat + sizeHalf],
        [lon - sizeHalf, lat + sizeHalf],
        [lon - sizeHalf, lat - sizeHalf],
      ]];
    }

    function buildBarFeatures() {
      const features = [];
      popByYear[currentYear].forEach(function (row) {
        let heightSoFar = 0;
        [[AGE_GROUPS[0], row.a1, row.a1 * scale], [AGE_GROUPS[1], row.a2, row.a2 * scale]].forEach(function (entry, index) {
          const label = entry[0], rawValue = entry[1], height = entry[2];
          if (!selectedAges.has(label)) return;
          const base = heightSoFar;
          heightSoFar += height;
          features.push({
            type: "Feature",
            properties: {
              district: row.area,
              age: label,
              value: rawValue,
              base: base,
              top: heightSoFar,
              color: AGE_GROUP_COLORS[index],
            },
            geometry: { type: "Polygon", coordinates: squareRing(row.lon, row.lat, half) },
          });
        });

        if (transitScores && selectedAges.has(AGE_GROUPS[2])) {
          const rawScore = transitScores.get(row.area) || 0;
          features.push({
            type: "Feature",
            properties: {
              district: row.area,
              age: AGE_GROUPS[2],
              value: Math.round(rawScore),
              base: 0,
              top: rawScore * transitScale,
              color: AGE_GROUP_COLORS[2],
            },
            geometry: { type: "Polygon", coordinates: squareRing(row.lon + transitOffsetLon, row.lat, transitHalf) },
          });
        }
      });
      return { type: "FeatureCollection", features: features };
    }

    function buildLabelFeatures() {
      return {
        type: "FeatureCollection",
        features: popByYear[currentYear].map(function (row) {
          return {
            type: "Feature",
            properties: { name: row.area },
            geometry: { type: "Point", coordinates: [row.lon, row.lat] },
          };
        }),
      };
    }

    const bounds = new maplibregl.LngLatBounds();
    popByYear[currentYear].forEach(function (row) { bounds.extend([row.lon, row.lat]); });
    population3dBounds = bounds;

    /* [夜晚模式：改用 CARTO Dark Matter 底圖，帶 API key 才不會有浮水印。
       key 放在 gitignore 的 .env.local，不會被推上 GitHub。] */
    const cartoKey = import.meta.env.VITE_CARTO_KEY;
    const cartoKeyParam = cartoKey ? "?key=" + encodeURIComponent(cartoKey) : "";
    population3dMap = new maplibregl.Map({
      container: "population-3d-map",
      style: {
        version: 8,
        glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
        sources: {
          "carto-dark": {
            type: "raster",
            tiles: [
              "https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png" + cartoKeyParam,
            ],
            tileSize: 256,
            attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
          },
        },
        layers: [{
          id: "carto-dark-layer",
          type: "raster",
          source: "carto-dark",
          paint: {
            "raster-brightness-max": .85,
          },
        }],
      },
      center: BANQIAO_CENTER,
      zoom: BANQIAO_DEFAULT_ZOOM,
      pitch: 55,
      bearing: -10,
      antialias: true,
      /* [2026-09-12 新增：鎖定在新北市範圍內] */
      maxBounds: NEW_TAIPEI_MAX_BOUNDS,
      minZoom: NEW_TAIPEI_MIN_ZOOM,
    });
    population3dMap.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

    function redraw() {
      const source = population3dMap.getSource("pop-bars");
      if (source) source.setData(buildBarFeatures());
    }

    /* [本次改版：讓 Vue 左側面板的圖例勾選能觸發重繪，取代原本的年份切換] */
    redrawBars = function (nextSelectedAges) {
      selectedAges.clear();
      (nextSelectedAges || []).forEach(function (age) { selectedAges.add(age); });
      redraw();
    };

    population3dMap.on("load", function () {
      population3dBaseReady = true;
      status.hidden = true;
      population3dMap.addSource("pop-bars", { type: "geojson", data: buildBarFeatures() });
      population3dMap.addLayer({
        id: "pop-bars-layer",
        type: "fill-extrusion",
        source: "pop-bars",
        paint: {
          "fill-extrusion-color": ["get", "color"],
          "fill-extrusion-base": ["get", "base"],
          "fill-extrusion-height": ["get", "top"],
          "fill-extrusion-opacity": .9,
        },
      });
      population3dMap.addSource("district-labels", { type: "geojson", data: buildLabelFeatures() });
      population3dMap.addLayer({
        id: "district-label-layer",
        type: "symbol",
        source: "district-labels",
        layout: {
          "text-field": ["get", "name"],
          "text-size": 12,
          "text-offset": [0, -6],
          "text-anchor": "bottom",
        },
        paint: {
          "text-color": "#f5f5f5",
          "text-halo-color": "#000000",
          "text-halo-width": 1.5,
        },
      });
      /* [本次改版：預設鏡位改成定位在板橋區，不再套用整個新北市 bounds
         （這樣才不會每次載入或按重置都跳回城市置中，蓋掉板橋定位）] */
      population3dMap.jumpTo({
        center: computeBanqiaoShiftedCenter(population3dMap),
        zoom: BANQIAO_DEFAULT_ZOOM,
        pitch: 55,
        bearing: -10,
      });

      /* [2026-09-11 新增：若交通網路已完成，立刻疊到這張 3D 圖] */
      ensureIntegratedTransitLayers();

      /* [本次新增：每站 30 分鐘可達站數 ÷ 行政區站數 × 行政區青年人口，
         疊加為柱狀圖第三段，直接堆在 20~29 歲、30~34 歲上面] */
      loadNetworkCore().then(function () {
        ensureIntegratedTransitLayers();
        status.hidden = false;
        status.classList.remove("error");
        status.textContent = "計算交通節點可及性中…";
        return ensureTransitReachCache(function (done, total) {
          status.textContent = "計算交通節點可及性中…" + done.toLocaleString() + " / " + total.toLocaleString();
        }, controller ? controller.departureTime : "08:00");
      }).then(function () {
        transitScores = buildDistrictTransitScores(currentYear, popByYearRef);
        let maxTransitScore = 0;
        transitScores.forEach(function (score) { maxTransitScore = Math.max(maxTransitScore, score); });
        transitScale = maxTransitScore > 0 ? 5000 / maxTransitScore : 0;
        status.hidden = true;
        redraw();
      }).catch(function (error) {
        console.error(error);
        status.hidden = false;
        status.classList.add("error");
        status.textContent = "交通節點可及性計算失敗：" + error.message + "。" + dataLoadHint();
      });
    });

    population3dMap.on("mousemove", "pop-bars-layer", function (event) {
      population3dMap.getCanvas().style.cursor = "pointer";
      const feature = event.features[0];
      tooltip.style.display = "block";
      tooltip.style.left = event.point.x + 12 + "px";
      tooltip.style.top = event.point.y + 12 + "px";
      const unit = feature.properties.age === "交通可及性" ? "（加權分數）" : " 人";
      tooltip.innerHTML = "<b>" + feature.properties.district + "</b>（" + currentYear + " 年）<br>" +
        feature.properties.age + "：" + Number(feature.properties.value).toLocaleString() + unit;
    });
    population3dMap.on("mouseleave", "pop-bars-layer", function () {
      population3dMap.getCanvas().style.cursor = "";
      tooltip.style.display = "none";
    });
  } catch (error) {
    console.error(error);
    status.classList.add("error");
    status.textContent = "3D 地圖載入失敗：" + error.message + "。" + dataLoadHint();
  } finally {
    population3dLoading = false;
  }
}
/* ===== [本次移植：組員 3D 人口地圖核心結束] ===== */
