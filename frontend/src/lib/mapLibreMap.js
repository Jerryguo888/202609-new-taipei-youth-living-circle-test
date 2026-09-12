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
   animationSpeed、animationClock、showTransitStops。] */
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

export let population3dMap = null;
let population3dLoading = false;
export let population3dBaseReady = false;
export let population3dBounds = null;
let integratedTransitReady = false;
let popByYearRef = {};

/* [本次改版：拿掉年份滑桿，圖例的年齡層／可及性選取狀態改由這裡集中管理，
   供 Vue 左側面板讀取／勾選；顏色與標籤是固定常數，地圖畫好後才會有 redrawBars] */
export const AGE_GROUPS = ["20~29歲", "30~34歲", "交通可及性"];
export const AGE_GROUP_COLORS = ["#24d7ff", "#ff4f9a", "#ffd447"];
let redrawBars = null;

export function redrawPopulationBars(selectedAges) {
  if (redrawBars) redrawBars(selectedAges);
}

/* [2026-09-11 新增：整合頁交通圖層清單；切回原 3D 分頁時只隱藏，不更動組員資料] */
const INTEGRATED_TRANSIT_LAYER_IDS = [
  "integrated-metro-lines",
  "integrated-result-lines",
  "integrated-bus-clusters",
  "integrated-bus-cluster-count",
  "integrated-bus-cluster-hit",
  "integrated-bus-stops",
  "integrated-bus-stop-hit",
  "integrated-result-points",
  "integrated-metro-stations",
  "integrated-origin-glow",
  "integrated-origin",
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

export function setIntegratedTransitVisibility(visible) {
  if (!population3dMap || !integratedTransitReady) return;
  INTEGRATED_TRANSIT_LAYER_IDS.forEach(function (layerId) {
    if (population3dMap.getLayer(layerId)) {
      population3dMap.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
    }
  });
  const mapElement = document.getElementById("population-3d-map");
  if (mapElement) mapElement.dataset.transitLayers = visible ? "visible" : "hidden";
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
    setIntegratedTransitVisibility(controller ? controller.showTransitStops : true);
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
  setIntegratedTransitVisibility(controller ? controller.showTransitStops : true);
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

export function clearIntegratedResults(clearOrigin) {
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
  clearIntegratedResults(false);
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

export function resetPopulationMapView() {
  if (!population3dMap || !population3dBounds) return;
  /* 先還原俯角與方位，再依同一鏡位計算完整 bounds；避免第二段動畫蓋掉縮放。 */
  population3dMap.jumpTo({ pitch: 55, bearing: -10 });
  population3dMap.fitBounds(population3dBounds, {
    padding: window.innerWidth <= 820 ? 34 : 70,
    duration: 650,
    maxZoom: 10,
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
      setIntegratedTransitVisibility(controller ? controller.showTransitStops : true);
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
      center: [121.56, 25.04],
      zoom: 8.6,
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
      population3dMap.fitBounds(bounds, {
        padding: window.innerWidth <= 820 ? 34 : 70,
        duration: 0,
        maxZoom: 10,
      });
      population3dMap.setPitch(55);
      population3dMap.setBearing(-10);

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
