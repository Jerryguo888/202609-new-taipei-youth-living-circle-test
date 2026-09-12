import { DATA_FILES } from "./data/dataFiles.js";
import { fetchCsvResponse, parseCSV } from "./data/fetchCsv.js";
import { MODEL } from "./model.js";
import {
  haversineKm,
  parseHeadway,
  cleanOfficialField,
  localizedName,
  parseMetroStationSequence,
  normalizeMetroStationName,
  minutesOfDay,
  normalizeStopName,
} from "./csvUtil.js";

/* ===== [改版保留：官方公車資料與演算法核心 - 交通節點圖狀態] ===== */
export let transitNodes = new Map();
export let transitGraph = new Map();
export let transitRouteMeta = new Map();
export let transitRouteGroups = new Map();
export let metroStations = [];
export let metroRoutes = [];
export let searchableMetroNodes = [];
export let metroLineMeta = new Map();
export let metroHeadwaySchedules = new Map();
export let metroTransferMinutes = new Map();
export let searchableNodes = [];
export let districtCenters = [];

let originSeedIndex = null;

/* [本次移植：originBoardingSeeds 用的同名站索引，網路重建時要跟著失效重算] */
export function ensureOriginSeedIndex() {
  if (!originSeedIndex) {
    originSeedIndex = new Map();
    searchableNodes.forEach(function (node) {
      const key = normalizeStopName(node.name);
      if (!originSeedIndex.has(key)) originSeedIndex.set(key, []);
      originSeedIndex.get(key).push(node);
    });
  }
  return originSeedIndex;
}

/* [本次新增：站位行政區分組]
   優先讀取站址中的 29 區名稱；地址缺區名時，以組員既有 29 區中心點就近推定。 */
export function prepareDistrictCenters(rows) {
  districtCenters = rows.filter(function (row) {
    return row.area && row.area !== "新北市" && Number.isFinite(Number(row.lat)) && Number.isFinite(Number(row.lon));
  }).map(function (row, index) {
    return { name: row.area, lat: Number(row.lat), lon: Number(row.lon), order: index };
  });
}

export function districtFromAddress(address) {
  const value = String(address || "").replace(/台北市/g, "臺北市");
  const district = districtCenters.find(function (item) { return value.includes(item.name); });
  if (district) return district.name;
  if (/(臺北市|桃園市|基隆市|宜蘭縣)/.test(value)) return "跨市延伸";
  return "";
}

export function nearestDistrict(lat, lon) {
  let best = null;
  let bestDistance = Infinity;
  districtCenters.forEach(function (district) {
    const distance = haversineKm(lat, lon, district.lat, district.lon);
    if (distance < bestDistance) {
      best = district;
      bestDistance = distance;
    }
  });
  return best ? best.name : "未分類";
}

export function createStationGroups() {
  const groups = new Map();
  searchableNodes.forEach(function (node) {
    if (!groups.has(node.district)) groups.set(node.district, []);
    groups.get(node.district).push({
      id: node.id,
      name: node.name,
      routeCount: node.routes.size,
    });
  });
  const order = new Map(districtCenters.map(function (item, index) { return [item.name, index]; }));
  return Array.from(groups.entries()).map(function (entry) {
    return {
      name: entry[0],
      stops: entry[1].sort(function (a, b) { return a.name.localeCompare(b.name, "zh-Hant"); }),
    };
  }).sort(function (a, b) {
    return (order.get(a.name) ?? 999) - (order.get(b.name) ?? 999) || a.name.localeCompare(b.name, "zh-Hant");
  });
}

export function addGraphEdge(fromId, edge) {
  if (!transitGraph.has(fromId)) transitGraph.set(fromId, []);
  transitGraph.get(fromId).push(edge);
}

export function buildNetwork(stopRows, routeRows, districtRows) {
  transitNodes = new Map();
  transitGraph = new Map();
  transitRouteMeta = new Map();
  transitRouteGroups = new Map();
  originSeedIndex = null;
  prepareDistrictCenters(districtRows);

  routeRows.forEach(function (row) {
    if (row.id && !transitRouteMeta.has(row.id)) transitRouteMeta.set(row.id, row);
  });

  stopRows.forEach(function (row) {
    const lat = Number(row.latitude || row.showlat);
    const lon = Number(row.longitude || row.showlon);
    const id = row.stoplocationid || row.id;
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (lat < 24.4 || lat > 25.5 || lon < 120.9 || lon > 122.2) return;

    if (!transitNodes.has(id)) {
      transitNodes.set(id, {
        id: id,
        name: row.namezh || "未命名站位",
        lat: lat,
        lon: lon,
        routes: new Set(),
        mode: "bus",
        district: "",
        districtEstimated: false,
      });
      transitGraph.set(id, []);
    }
    const node = transitNodes.get(id);
    if (row.routeid) node.routes.add(row.routeid);
    const explicitDistrict = districtFromAddress(row.address);
    if (explicitDistrict && (!node.district || explicitDistrict !== "跨市延伸")) {
      node.district = explicitDistrict;
      node.districtEstimated = false;
    }

    const groupKey = row.routeid + "|" + (row.goback || "0");
    if (!transitRouteGroups.has(groupKey)) transitRouteGroups.set(groupKey, []);
    transitRouteGroups.get(groupKey).push({
      nodeId: id,
      routeId: row.routeid,
      sequence: Number(row.seqno) || 0,
    });
  });

  transitNodes.forEach(function (node) {
    if (!node.district) {
      node.district = nearestDistrict(node.lat, node.lon);
      node.districtEstimated = true;
    }
  });

  transitRouteGroups.forEach(function (sequence) {
    sequence.sort(function (a, b) { return a.sequence - b.sequence; });
    for (let i = 0; i < sequence.length - 1; i += 1) {
      const current = sequence[i];
      const next = sequence[i + 1];
      if (current.nodeId === next.nodeId) continue;
      const a = transitNodes.get(current.nodeId);
      const b = transitNodes.get(next.nodeId);
      if (!a || !b) continue;
      const directKm = haversineKm(a.lat, a.lon, b.lat, b.lon);
      if (!Number.isFinite(directKm) || directKm > 15) continue;
      const travelMinutes = Math.max(
        .65,
        directKm * MODEL.roadDistanceFactor / MODEL.busSpeedKmh * 60 + MODEL.dwellMinutes
      );
      const meta = transitRouteMeta.get(current.routeId) || {};
      transitGraph.get(current.nodeId).push({
        from: current.nodeId,
        to: next.nodeId,
        routeId: current.routeId,
        mode: "bus",
        routeName: meta.namezh || meta.pathattributename || current.routeId,
        travelMinutes: travelMinutes,
        peakHeadway: parseHeadway(meta.peakheadway, MODEL.defaultPeakHeadway),
        offPeakHeadway: parseHeadway(meta.offpeakheadway, MODEL.defaultOffPeakHeadway),
      });
    }
  });

  searchableNodes = Array.from(transitNodes.values()).sort(function (a, b) {
    return a.name.localeCompare(b.name, "zh-Hant");
  });
}

/* ===== [改版新增：官方捷運 CSV 解析並納入 30 分鐘交通圖] ===== */
export function buildMetroLayersData(stationRows, routeStationRows, lineRows, travelRows, transferRows, headwayRows,
  ntmcStationRows, ntmcRouteRows, ntmcLineRows, ntmcHeadwayRows) {
  const stationByAlias = new Map();
  const stationByName = new Map();
  const physicalStations = [];
  metroLineMeta = new Map();
  metroHeadwaySchedules = new Map();
  metroTransferMinutes = new Map();

  lineRows.concat(ntmcLineRows).forEach(function (row) {
    const id = cleanOfficialField(row.LineID || row.lineid);
    if (!id) return;
    metroLineMeta.set(id, {
      id: id,
      name: localizedName(row.LineName || row.linename) || id,
      color: cleanOfficialField(row.LineColor || row.linecolor) || "#287b50",
    });
  });

  stationRows.forEach(function (row) {
    const aliases = cleanOfficialField(row.StationID || row.stationid).split(",").map(function (item) { return item.trim(); }).filter(Boolean);
    const position = cleanOfficialField(row.StationPosition || row.stationposition).split(",").map(Number);
    const lon = position[0];
    const lat = position[1];
    if (!aliases.length || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const station = {
      id: aliases.join(","),
      aliases: aliases,
      name: localizedName(row.StationName || row.stationname) || aliases[0],
      lat: lat,
      lon: lon,
      lines: new Set(aliases.map(function (alias) { return alias.replace(/\d.*$/, ""); })),
      district: districtFromAddress(row.StationAddress || row.stationaddress) || nearestDistrict(lat, lon),
    };
    physicalStations.push(station);
    stationByName.set(normalizeMetroStationName(station.name), station);
    aliases.forEach(function (alias) { stationByAlias.set(alias, station); });
  });

  /* TDX 補上新北環狀線；與臺北捷運同名站合併成同一轉乘節點。 */
  ntmcStationRows.forEach(function (row) {
    const alias = cleanOfficialField(row.StationID || row.stationid);
    const name = localizedName(row.StationName || row.stationname) || alias;
    const lat = Number(row.Latitude || row.latitude);
    const lon = Number(row.Longitude || row.longitude);
    if (!alias || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const key = normalizeMetroStationName(name);
    let station = stationByName.get(key);
    if (!station) {
      station = {
        id: alias,
        aliases: [],
        name: name,
        lat: lat,
        lon: lon,
        lines: new Set(),
        district: cleanOfficialField(row.District || row.district) || districtFromAddress(row.Address || row.address) || nearestDistrict(lat, lon),
      };
      physicalStations.push(station);
      stationByName.set(key, station);
    }
    if (!station.aliases.includes(alias)) station.aliases.push(alias);
    station.lines.add(alias.replace(/\d.*$/, ""));
    stationByAlias.set(alias, station);
  });

  const routes = [];
  routeStationRows.forEach(function (row) {
    if (String(row.Direction || row.direction) !== "0") return;
    const routeId = cleanOfficialField(row.RouteID || row.routeid);
    const lineId = cleanOfficialField(row.LineID || row.lineid);
    const sequence = parseMetroStationSequence(row.Stations || row.stations);
    const stations = sequence.map(function (item) { return stationByAlias.get(item.id); }).filter(Boolean);
    if (!routeId || stations.length < 2) return;
    const meta = metroLineMeta.get(lineId) || metroLineMeta.get(routeId) || {};
    routes.push({
      id: routeId,
      lineId: lineId,
      name: meta.name || lineId,
      color: meta.color || (lineId === "Y" ? "#ffdb00" : "#287b50"),
      stations: stations,
    });
  });

  const ntmcByLine = new Map();
  ntmcRouteRows.forEach(function (row) {
    const lineId = cleanOfficialField(row.LineID || row.lineid);
    const station = stationByAlias.get(cleanOfficialField(row.StationID || row.stationid));
    if (!lineId || !station) return;
    if (!ntmcByLine.has(lineId)) ntmcByLine.set(lineId, []);
    ntmcByLine.get(lineId).push({ station: station, sequence: Number(row.Sequence || row.sequence) || 0 });
  });
  ntmcByLine.forEach(function (items, lineId) {
    items.sort(function (a, b) { return a.sequence - b.sequence; });
    const meta = metroLineMeta.get(lineId) || {};
    routes.push({
      id: lineId + "-NTMC",
      lineId: lineId,
      name: meta.name || lineId,
      color: meta.color || "#fedb00",
      stations: items.map(function (item) { return item.station; }),
    });
  });

  headwayRows.forEach(function (row) {
    const lineId = cleanOfficialField(row.LineID || row.lineid);
    if (!lineId || !String(row.ServiceDays || row.servicedays).includes("平日")) return;
    const schedules = [];
    const expression = /'(\d{2}:\d{2})','(\d{2}:\d{2})',(\d+),(\d+)/g;
    let match;
    while ((match = expression.exec(String(row.Headways || row.headways || ""))) !== null) {
      schedules.push({
        start: minutesOfDay(match[1]),
        end: minutesOfDay(match[2]) || 1440,
        headway: (Number(match[3]) + Number(match[4])) / 2,
      });
    }
    if (schedules.length) metroHeadwaySchedules.set(lineId, schedules);
  });
  ntmcHeadwayRows.forEach(function (row) {
    if (cleanOfficialField(row.ServiceType || row.servicetype) !== "平日") return;
    const lineId = cleanOfficialField(row.LineID || row.lineid);
    if (!lineId) return;
    if (!metroHeadwaySchedules.has(lineId)) metroHeadwaySchedules.set(lineId, []);
    metroHeadwaySchedules.get(lineId).push({
      start: minutesOfDay(row.StartTime || row.starttime),
      end: minutesOfDay(row.EndTime || row.endtime) || 1440,
      headway: (Number(row.MinHeadwayMins || row.minheadwaymins) + Number(row.MaxHeadwayMins || row.maxheadwaymins)) / 2,
    });
  });

  transferRows.forEach(function (row) {
    const name = normalizeMetroStationName(row.station || row.Station);
    const minutes = Number(row.Time || row.time);
    if (name && Number.isFinite(minutes)) metroTransferMinutes.set(name, minutes);
  });

  physicalStations.forEach(function (station) {
    const nodeId = "metro:" + normalizeMetroStationName(station.name);
    station.nodeId = nodeId;
    const node = {
      id: nodeId,
      name: station.name,
      lat: station.lat,
      lon: station.lon,
      routes: new Set(Array.from(station.lines).map(function (lineId) { return "MRT:" + lineId; })),
      lines: new Set(station.lines),
      mode: "metro",
      district: station.district || nearestDistrict(station.lat, station.lon),
      districtEstimated: false,
    };
    transitNodes.set(nodeId, node);
    transitGraph.set(nodeId, []);
  });

  /* 官方站間行駛與停靠秒數，建立雙向捷運邊。 */
  const seenMetroEdges = new Set();
  travelRows.forEach(function (row) {
    const fromStation = stationByName.get(normalizeMetroStationName(row.stationA || row.StationA));
    const toStation = stationByName.get(normalizeMetroStationName(row.stationB || row.StationB));
    if (!fromStation || !toStation || fromStation.nodeId === toStation.nodeId) return;
    const commonLines = Array.from(fromStation.lines).filter(function (lineId) { return toStation.lines.has(lineId); });
    const lineId = commonLines[0] || Array.from(fromStation.lines)[0] || "MRT";
    const travelMinutes = Math.max(.5, (Number(row.traveltime || row.TravelTime) + Number(row.stoptime || row.StopTime || 0)) / 60);
    [[fromStation, toStation], [toStation, fromStation]].forEach(function (pair) {
      const key = pair[0].nodeId + "|" + pair[1].nodeId + "|" + lineId;
      if (seenMetroEdges.has(key)) return;
      seenMetroEdges.add(key);
      addGraphEdge(pair[0].nodeId, {
        from: pair[0].nodeId,
        to: pair[1].nodeId,
        routeId: "MRT:" + lineId,
        lineId: lineId,
        routeName: (metroLineMeta.get(lineId) || {}).name || lineId,
        mode: "metro",
        travelMinutes: travelMinutes,
      });
    });
  });

  /* 捷運出入口與附近公車站以步行邊相連，轉乘才可跨運具計算。 */
  const busNodes = searchableNodes.slice();
  physicalStations.forEach(function (station) {
    const nearby = busNodes.map(function (bus) {
      return { node: bus, distanceKm: haversineKm(station.lat, station.lon, bus.lat, bus.lon) };
    }).filter(function (item) {
      return item.distanceKm <= MODEL.maxBusMetroWalkKm;
    }).sort(function (a, b) {
      return a.distanceKm - b.distanceKm;
    }).slice(0, MODEL.maxBusLinksPerMetro);
    nearby.forEach(function (item) {
      const minutes = Math.max(1.5, item.distanceKm / MODEL.walkSpeedKmh * 60 + MODEL.stationEntryMinutes);
      addGraphEdge(station.nodeId, {
        from: station.nodeId, to: item.node.id, routeId: null, mode: "walk", travelMinutes: minutes,
      });
      addGraphEdge(item.node.id, {
        from: item.node.id, to: station.nodeId, routeId: null, mode: "walk", travelMinutes: minutes,
      });
    });
  });

  metroStations = physicalStations;
  metroRoutes = routes;
  searchableMetroNodes = physicalStations.map(function (station) { return transitNodes.get(station.nodeId); }).filter(Boolean).sort(function (a, b) {
    return a.name.localeCompare(b.name, "zh-Hant");
  });
}

export function createMetroGroups() {
  const preferredOrder = ["BR", "R", "G", "O", "BL", "Y"];
  const byLine = new Map();
  metroRoutes.forEach(function (route) {
    if (!byLine.has(route.lineId)) {
      byLine.set(route.lineId, { id: route.lineId, name: route.name, color: route.color, stops: [] });
    }
    const group = byLine.get(route.lineId);
    route.stations.forEach(function (station) {
      if (!group.stops.some(function (stop) { return stop.id === station.nodeId; })) {
        const node = transitNodes.get(station.nodeId);
        if (node) group.stops.push({
          id: node.id,
          name: node.name,
          routeCount: node.routes.size,
          lineNames: Array.from(node.lines).map(function (id) { return (metroLineMeta.get(id) || {}).name || id; }).join("、"),
        });
      }
    });
  });
  return Array.from(byLine.values()).sort(function (a, b) {
    const ai = preferredOrder.indexOf(a.id);
    const bi = preferredOrder.indexOf(b.id);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.name.localeCompare(b.name, "zh-Hant");
  });
}

/* [本次新增：抽出公車／捷運資料讀取與建圖，供 2D 選站頁與 3D 人口地圖共用] */
let networkLoadPromise = null;

export function loadNetworkCore() {
  if (networkLoadPromise) return networkLoadPromise;
  networkLoadPromise = (async function () {
    const responses = await Promise.all([
      fetchCsvResponse(DATA_FILES.stops),
      fetchCsvResponse(DATA_FILES.routes),
      fetchCsvResponse(DATA_FILES.districts),
      fetchCsvResponse(DATA_FILES.metroStations),
      fetchCsvResponse(DATA_FILES.metroRouteStations),
      fetchCsvResponse(DATA_FILES.metroLines),
      fetchCsvResponse(DATA_FILES.metroTravelTimes),
      fetchCsvResponse(DATA_FILES.metroTransferWalk),
      fetchCsvResponse(DATA_FILES.metroHeadways),
      fetchCsvResponse(DATA_FILES.ntmcMetroStations),
      fetchCsvResponse(DATA_FILES.ntmcMetroRouteStations),
      fetchCsvResponse(DATA_FILES.ntmcMetroLines),
      fetchCsvResponse(DATA_FILES.ntmcMetroHeadways),
    ]);
    if (responses.some(function (response) { return !response.ok; })) throw new Error("CSV 讀取失敗");
    const texts = await Promise.all(responses.map(function (response) { return response.text(); }));
    buildNetwork(parseCSV(texts[0]), parseCSV(texts[1]), parseCSV(texts[2]));
    buildMetroLayersData(
      parseCSV(texts[3]), parseCSV(texts[4]), parseCSV(texts[5]),
      parseCSV(texts[6]), parseCSV(texts[7]), parseCSV(texts[8]),
      parseCSV(texts[9]), parseCSV(texts[10]), parseCSV(texts[11]), parseCSV(texts[12])
    );
  })().catch(function (error) {
    networkLoadPromise = null;
    throw error;
  });
  return networkLoadPromise;
}

/* [本次移植：原本放在 leafletMap.js，但這裡只是單純算最近的交通節點，
   跟 Leaflet 完全無關，移過來後拿掉 Leaflet 地圖也不影響選預設起點] */
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
