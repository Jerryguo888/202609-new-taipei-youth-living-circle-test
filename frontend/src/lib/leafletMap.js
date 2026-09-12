import L from "leaflet";
import { escapeHTML, haversineKm } from "./csvUtil.js";
import {
  transitNodes,
  transitRouteMeta,
  transitRouteGroups,
  metroStations,
  metroRoutes,
  metroLineMeta,
  searchableNodes,
} from "./network.js";

/* [本次移植：原本直接呼叫全域 appVm 的地方，改成呼叫由外部（appState store）
   註冊進來的 controller，避免這個模組要反過來 import store 造成循環依賴。
   controller 需要提供：chooseStop(id, moveMap)、animationSpeed、animationClock、
   selectedRouteId/selectedRouteInfo/selectedMetroLineId/selectedMetroLineInfo。] */
let controller = null;
export function setLeafletController(nextController) {
  controller = nextController;
}

export let leafletMap = null;
let canvasRenderer = null;
let svgRenderer = null;
let baseStopsLayer = null;
let reachableLayer = null;
let routeLayer = null;
let selectedBusRouteLayer = null;
let selectedMetroLineLayer = null;
let metroLineLayer = null;
let metroStationLayer = null;
let hullLayer = null;
let originLayer = null;
let animationTimer = null;
let stopLayerEventsBound = false;

/* ===== [改版保留：Leaflet 地圖繪製開始] ===== */
export function initLeaflet() {
  if (leafletMap) {
    setTimeout(function () { leafletMap.invalidateSize(); }, 0);
    return;
  }
  canvasRenderer = L.canvas({ padding: .4, tolerance: 12 });
  svgRenderer = L.svg({ padding: .4 });
  leafletMap = L.map("transit-map", {
    center: [25.012, 121.47],
    zoom: 11,
    minZoom: 9,
    maxZoom: 18,
    preferCanvas: true,
    renderer: canvasRenderer,
    zoomControl: false,
  });
  L.control.zoom({ position: "topright" }).addTo(leafletMap);
  /* [2026-09-11 改版：使用可直接讀取的 OSM 圖磚，再由 CSS 轉為黑灰底] */
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(leafletMap);
  leafletMap.createPane("coveragePane").style.zIndex = 430;
  leafletMap.createPane("metroLinesPane").style.zIndex = 520;
  leafletMap.createPane("busStopsPane").style.zIndex = 600;
  leafletMap.createPane("metroStationsPane").style.zIndex = 620;
  leafletMap.createPane("resultPane").style.zIndex = 640;
  leafletMap.createPane("originPane").style.zIndex = 650;
  metroLineLayer = L.layerGroup().addTo(leafletMap);
  metroStationLayer = L.layerGroup().addTo(leafletMap);
  baseStopsLayer = L.layerGroup().addTo(leafletMap);
  reachableLayer = L.layerGroup().addTo(leafletMap);
  routeLayer = L.layerGroup().addTo(leafletMap);
  selectedBusRouteLayer = L.layerGroup().addTo(leafletMap);
  selectedMetroLineLayer = L.layerGroup().addTo(leafletMap);
  hullLayer = L.layerGroup().addTo(leafletMap);
  originLayer = L.layerGroup().addTo(leafletMap);
}

/* [2026-09-11 修正：以 HTML 按鈕當點位熱區，不讓 Canvas 或地圖拖曳層搶走點擊] */
export function makeClickableStopMarker(lat, lon, options) {
  const dotSize = Math.max(12, Math.round(options.radius * 2));
  const hitSize = Math.max(24, dotSize + 8);
  return L.marker([lat, lon], {
    pane: options.pane,
    interactive: true,
    keyboard: false,
    bubblingMouseEvents: false,
    icon: L.divIcon({
      className: "transit-stop-marker " + (options.className || ""),
      html: "<button type=\"button\" class=\"transit-stop-hit\"" +
        " style=\"--dot-size:" + dotSize + "px;--dot-color:" + escapeHTML(options.color || "#7a8582") +
        ";--dot-border:" + (options.border || 1.5) + "px\" aria-label=\"" + escapeHTML(options.label) + "\"></button>",
      iconSize: [hitSize, hitSize],
      iconAnchor: [hitSize / 2, hitSize / 2],
    }),
  });
}

export function addClickableStopMarker(marker, activate, layer) {
  marker.addTo(layer);
  const button = marker.getElement() && marker.getElement().querySelector(".transit-stop-hit");
  if (!button) return;
  ["pointerdown", "mousedown", "touchstart", "dblclick"].forEach(function (eventName) {
    button.addEventListener(eventName, function (event) { event.stopPropagation(); }, { passive: eventName === "touchstart" });
  });
  button.addEventListener("click", function (event) {
    event.preventDefault();
    event.stopPropagation();
    activate();
  });
}

/* [本次改版：捷運站可點選為起點，點位放大並置於公車站上層] */
export function renderMetroReference() {
  if (!leafletMap || !metroLineLayer || !metroStationLayer) return;
  metroLineLayer.clearLayers();
  metroStationLayer.clearLayers();

  metroRoutes.forEach(function (route) {
    const points = route.stations.map(function (station) { return [station.lat, station.lon]; });
    L.polyline(points, {
      pane: "metroLinesPane",
      color: route.color,
      weight: 5,
      opacity: .82,
      interactive: true,
    }).bindTooltip("捷運・" + route.name, { sticky: true, opacity: .96 }).addTo(metroLineLayer);
  });

  metroStations.forEach(function (station) {
    const colors = Array.from(station.lines).map(function (lineId) {
      const route = metroRoutes.find(function (item) { return item.lineId === lineId; });
      return route ? route.color : "#287b50";
    });
    const marker = makeClickableStopMarker(station.lat, station.lon, {
      pane: "metroStationsPane",
      radius: station.lines.size > 1 ? 9.5 : 8,
      color: colors[0] || "#287b50",
      border: 2.5,
      className: "metro-stop-marker",
      label: "選擇捷運站：" + station.name,
    });
    marker.bindTooltip("捷運・" + station.name + "（點擊設為起點）", { direction: "top", opacity: .96 });
    addClickableStopMarker(marker, function () { controller.chooseStop(station.nodeId, true); }, metroStationLayer);
  });
}

/* [本次修正：站點依縮放層級做畫面網格聚合]
   舊版一次畫 8,746 點，縮小時大量重疊；現在低縮放顯示群組，放大後才顯示單站。 */
export function renderBaseStops() {
  if (!leafletMap || !baseStopsLayer || !searchableNodes.length) return;
  baseStopsLayer.clearLayers();
  const zoom = leafletMap.getZoom();
  const bounds = leafletMap.getBounds().pad(.18);
  const visibleNodes = searchableNodes.filter(function (node) {
    return bounds.contains([node.lat, node.lon]);
  });

  if (zoom >= 13) {
    visibleNodes.forEach(function (node) {
      const marker = makeClickableStopMarker(node.lat, node.lon, {
        pane: "busStopsPane",
        radius: 5.8,
        color: "#7a8582",
        border: 1.4,
        className: "bus-stop-marker",
        label: "選擇公車站：" + node.name,
      });
      marker.bindTooltip(node.name + "・" + node.district + "（點擊設為起點）", { direction: "top", opacity: .94 });
      addClickableStopMarker(marker, function () { controller.chooseStop(node.id, true); }, baseStopsLayer);
    });
    return;
  }

  const cellSize = zoom <= 10 ? 76 : (zoom === 11 ? 58 : 42);
  const buckets = new Map();
  visibleNodes.forEach(function (node) {
    const point = leafletMap.latLngToContainerPoint([node.lat, node.lon]);
    const key = Math.floor(point.x / cellSize) + "|" + Math.floor(point.y / cellSize);
    if (!buckets.has(key)) buckets.set(key, { lat: 0, lon: 0, nodes: [] });
    const bucket = buckets.get(key);
    bucket.lat += node.lat;
    bucket.lon += node.lon;
    bucket.nodes.push(node);
  });

  buckets.forEach(function (bucket) {
    const count = bucket.nodes.length;
    const lat = bucket.lat / count;
    const lon = bucket.lon / count;
    const marker = makeClickableStopMarker(lat, lon, {
      pane: "busStopsPane",
      radius: Math.min(16, 6 + Math.sqrt(count) * .9),
      color: "#7a8582",
      border: 1.5,
      className: "bus-stop-marker",
      label: count === 1
        ? "選擇公車站：" + bucket.nodes[0].name
        : "放大公車站群組（" + count + " 站）",
    });
    if (count === 1) {
      marker.bindTooltip(bucket.nodes[0].name + "・" + bucket.nodes[0].district, { direction: "top", opacity: .94 });
      addClickableStopMarker(marker, function () { controller.chooseStop(bucket.nodes[0].id, true); }, baseStopsLayer);
    } else {
      marker.bindTooltip(count.toLocaleString() + " 個站位・點擊放大", { direction: "top", opacity: .94 });
      addClickableStopMarker(marker, function () {
        leafletMap.flyTo([lat, lon], Math.min(14, zoom + 3), { duration: .55 });
      }, baseStopsLayer);
    }
  });
}

export function bindStopLayerEvents() {
  if (stopLayerEventsBound) return;
  leafletMap.on("moveend zoomend", renderBaseStops);
  stopLayerEventsBound = true;
}

export function drawOrigin(node) {
  originLayer.clearLayers();
  L.circleMarker([node.lat, node.lon], {
    pane: "originPane",
    radius: 17,
    color: "#e16755",
    weight: 2.5,
    fillColor: "#e16755",
    fillOpacity: .16,
    className: "origin-pulse",
  }).addTo(originLayer);
  L.circleMarker([node.lat, node.lon], {
    pane: "originPane",
    radius: 7,
    color: "#ffffff",
    weight: 2,
    fillColor: "#e16755",
    fillOpacity: 1,
  }).bindTooltip("出發：" + node.name).addTo(originLayer);
}

export function resetMapResults() {
  if (animationTimer) clearTimeout(animationTimer);
  animationTimer = null;
  if (reachableLayer) reachableLayer.clearLayers();
  if (routeLayer) routeLayer.clearLayers();
  if (selectedBusRouteLayer) selectedBusRouteLayer.clearLayers();
  if (selectedMetroLineLayer) selectedMetroLineLayer.clearLayers();
  if (hullLayer) hullLayer.clearLayers();
  if (controller) {
    controller.selectedRouteId = null;
    controller.selectedRouteInfo = null;
    controller.selectedMetroLineId = null;
    controller.selectedMetroLineInfo = null;
    controller.animationClock = "00:00";
  }
}

export function convexHull(points) {
  if (points.length < 3) return points;
  const sorted = points.slice().sort(function (a, b) {
    return a[1] === b[1] ? a[0] - b[0] : a[1] - b[1];
  });
  function cross(o, a, b) {
    return (a[1] - o[1]) * (b[0] - o[0]) - (a[0] - o[0]) * (b[1] - o[1]);
  }
  const lower = [];
  sorted.forEach(function (point) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  });
  const upper = [];
  sorted.slice().reverse().forEach(function (point) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  });
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export function drawResultContext(result) {
  const points = result.reached.map(function (item) {
    const node = transitNodes.get(item.nodeId);
    return node ? [node.lat, node.lon] : null;
  }).filter(Boolean);
  const hull = convexHull(points);
  if (hull.length >= 3) {
    L.polygon(hull, {
      pane: "coveragePane",
      color: "#2fae9c",
      weight: 1.5,
      opacity: .7,
      fillColor: "#87cbb7",
      fillOpacity: .13,
      dashArray: "5 7",
    }).addTo(hullLayer);
  }

  const segments = { bus: [], metro: [], walk: [] };
  const seen = new Set();
  result.reached.slice(1, 700).forEach(function (item) {
    const step = result.predecessor.get(item.stateKey);
    if (!step) return;
    const a = transitNodes.get(step.edge.from);
    const b = transitNodes.get(step.edge.to);
    const key = step.edge.from + "|" + step.edge.to + "|" + step.edge.routeId;
    if (!a || !b || seen.has(key)) return;
    seen.add(key);
    segments[step.edge.mode || "bus"].push([[a.lat, a.lon], [b.lat, b.lon]]);
  });
  if (segments.bus.length) L.polyline(segments.bus, {
    renderer: svgRenderer, color: "#18572f", weight: 2, opacity: .56,
    dashArray: "7 8", className: "route-flow", interactive: false,
  }).addTo(routeLayer);
  if (segments.metro.length) L.polyline(segments.metro, {
    renderer: svgRenderer, color: "#0a59ae", weight: 3.5, opacity: .72,
    className: "route-flow", interactive: false,
  }).addTo(routeLayer);
  if (segments.walk.length) L.polyline(segments.walk, {
    renderer: svgRenderer, color: "#72817d", weight: 1.5, opacity: .55,
    dashArray: "2 7", interactive: false,
  }).addTo(routeLayer);

  /* [本次修正：視窗以起點對稱置中，避免可達圖看起來只偏向單側]
     真正可達範圍仍依公車站序，不用假圓形覆蓋取代交通網路。 */
  const start = transitNodes.get(result.startId);
  if (start && points.length > 1) {
    let latDelta = .006;
    let lonDelta = .008;
    points.forEach(function (point) {
      latDelta = Math.max(latDelta, Math.abs(point[0] - start.lat));
      lonDelta = Math.max(lonDelta, Math.abs(point[1] - start.lon));
    });
    leafletMap.fitBounds([
      [start.lat - latDelta * 1.12, start.lon - lonDelta * 1.12],
      [start.lat + latDelta * 1.12, start.lon + lonDelta * 1.12],
    ], { padding: [46, 46], maxZoom: 14, animate: true, duration: .65 });
  }
}

export function addReachableNode(item, result) {
  if (item.nodeId === result.startId) return;
  const node = transitNodes.get(item.nodeId);
  const start = transitNodes.get(result.startId);
  if (!node || !start) return;
  const ratio = Math.min(1, item.time / result.maxMinutes);
  const color = ratio < .58 ? "#2fae9c" : ratio < .84 ? "#f2c94c" : "#e98067";
  const directKm = haversineKm(start.lat, start.lon, node.lat, node.lon);
  L.circleMarker([node.lat, node.lon], {
    pane: "resultPane",
    radius: node.mode === "metro" ? 8.5 : (item.time > result.maxMinutes * .8 ? 6.5 : 5.5),
    color: node.mode === "metro" ? "#0a59ae" : "#ffffff",
    weight: node.mode === "metro" ? 2.2 : 1.2,
    fillColor: color,
    fillOpacity: .95,
  }).bindPopup(
    "<strong>" + escapeHTML(node.name) + "</strong><br>" +
    "預估抵達：" + item.time.toFixed(1) + " 分鐘<br>" +
    "直線距離：" + directKm.toFixed(2) + " 公里<br>" +
    "節點類型：" + (node.mode === "metro" ? "捷運站" : "公車站") + "<br>" +
    "抵達路線：" + escapeHTML(item.routeId ? item.routeId.replace(/^MRT:/, "捷運 ") : "步行／起點")
  ).addTo(reachableLayer);
}

export function busRouteSummary(routeId) {
  const meta = transitRouteMeta.get(routeId) || {};
  return {
    id: routeId,
    name: meta.namezh || meta.pathattributename || routeId,
    provider: meta.providername || "公車業者",
    departure: meta.departurezh || "起點",
    destination: meta.destinationzh || "終點",
  };
}

export function listReachableBusRoutes(routeIds) {
  return Array.from(routeIds).map(busRouteSummary).sort(function (a, b) {
    return a.name.localeCompare(b.name, "zh-Hant", { numeric: true });
  });
}

export function metroLineSummary(lineId) {
  const meta = metroLineMeta.get(lineId) || {};
  const stations = metroStations.filter(function (station) { return station.lines.has(lineId); });
  return {
    id: lineId,
    name: meta.name || lineId,
    color: meta.color || "#0a59ae",
    stationCount: stations.length,
  };
}

export function listReachableMetroLines(lineIds) {
  return Array.from(lineIds).map(metroLineSummary).sort(function (a, b) {
    return a.name.localeCompare(b.name, "zh-Hant");
  });
}

/* [本次新增：點選公車名稱後畫出該路線所有官方站序方向] */
export function drawSelectedBusRoute(routeId) {
  if (!selectedBusRouteLayer) return null;
  selectedBusRouteLayer.clearLayers();
  const bounds = [];
  transitRouteGroups.forEach(function (sequence, groupKey) {
    if (!groupKey.startsWith(routeId + "|")) return;
    const points = sequence.map(function (item) {
      const node = transitNodes.get(item.nodeId);
      return node ? [node.lat, node.lon] : null;
    }).filter(Boolean);
    if (points.length < 2) return;
    points.forEach(function (point) { bounds.push(point); });
    L.polyline(points, {
      renderer: svgRenderer,
      color: "#0a59ae",
      weight: 5,
      opacity: .9,
    }).bindTooltip("公車・" + busRouteSummary(routeId).name, { sticky: true }).addTo(selectedBusRouteLayer);
  });
  if (bounds.length > 1) leafletMap.fitBounds(bounds, { padding: [42, 42], maxZoom: 14, animate: true });
  return busRouteSummary(routeId);
}

/* [本次改版新增：捷運路線選取與公車相同，可單獨檢視全線] */
export function drawSelectedMetroLine(lineId) {
  if (!selectedMetroLineLayer) return null;
  selectedMetroLineLayer.clearLayers();
  const bounds = [];
  const summary = metroLineSummary(lineId);
  metroRoutes.filter(function (route) { return route.lineId === lineId; }).forEach(function (route) {
    const points = route.stations.map(function (station) { return [station.lat, station.lon]; });
    if (points.length < 2) return;
    points.forEach(function (point) { bounds.push(point); });
    L.polyline(points, {
      pane: "metroLinesPane",
      color: summary.color,
      weight: 8,
      opacity: .96,
    }).bindTooltip("捷運・" + summary.name, { sticky: true }).addTo(selectedMetroLineLayer);
  });
  if (bounds.length > 1) leafletMap.fitBounds(bounds, { padding: [42, 42], maxZoom: 14, animate: true });
  return summary;
}

export function focusNodeCollection(stops, maxZoom) {
  if (!leafletMap || !stops || !stops.length) return;
  const points = stops.map(function (stop) {
    const node = transitNodes.get(stop.id);
    return node ? [node.lat, node.lon] : null;
  }).filter(Boolean);
  if (points.length === 1) {
    leafletMap.flyTo(points[0], maxZoom || 14, { duration: .55 });
  } else if (points.length > 1) {
    leafletMap.fitBounds(points, { padding: [38, 38], maxZoom: maxZoom || 14, animate: true, duration: .55 });
  }
}

export function animateResult(result) {
  resetMapResults();
  drawResultContext(result);
  let elapsed = 0;
  let index = 0;
  const tickMs = 170 / controller.animationSpeed;
  function tick() {
    controller.animationClock = String(Math.floor(elapsed)).padStart(2, "0") + ":00";
    while (index < result.reached.length && result.reached[index].time <= elapsed) {
      addReachableNode(result.reached[index], result);
      index += 1;
    }
    if (elapsed < result.maxMinutes) {
      elapsed += 1;
      animationTimer = setTimeout(tick, tickMs);
    } else {
      controller.animationClock = String(result.maxMinutes).padStart(2, "0") + ":00";
      animationTimer = null;
    }
  }
  tick();
}

/* [本次新增：store 需要清這三個圖層，但不該直接拿到內部圖層變數，改用小函式包裝] */
export function clearOriginLayer() {
  if (originLayer) originLayer.clearLayers();
}
export function clearSelectedBusRouteLayer() {
  if (selectedBusRouteLayer) selectedBusRouteLayer.clearLayers();
}
export function clearSelectedMetroLineLayer() {
  if (selectedMetroLineLayer) selectedMetroLineLayer.clearLayers();
}

export function nearestNode(lat, lon) {
  let best = null;
  let bestDistance = Infinity;
  transitNodes.forEach(function (node) {
    const distance = haversineKm(lat, lon, node.lat, node.lon);
    if (distance < bestDistance) {
      best = node;
      bestDistance = distance;
    }
  });
  return { node: best, distanceKm: bestDistance };
}
/* ===== [改版保留：Leaflet 地圖繪製結束] ===== */
