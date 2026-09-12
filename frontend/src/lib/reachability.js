import { MODEL } from "./model.js";
import { haversineKm, normalizeStopName, normalizeMetroStationName } from "./csvUtil.js";
import {
  transitNodes,
  transitGraph,
  metroHeadwaySchedules,
  metroTransferMinutes,
  ensureOriginSeedIndex,
} from "./network.js";

/* [本次修正：把步行可達的同名對向站牌視為同一個起點群組]
   公車站序仍維持單向，僅補足人在起點可過街搭乘另一方向的真實行為。 */
export function originBoardingSeeds(startId) {
  const start = transitNodes.get(startId);
  if (!start) return [];
  if (start.mode === "metro") return [{ nodeId: start.id, time: 0 }];
  const normalized = normalizeStopName(start.name);
  const seeds = [{ nodeId: start.id, time: 0 }];
  const originSeedIndex = ensureOriginSeedIndex();
  (originSeedIndex.get(normalized) || []).forEach(function (node) {
    if (node.id === start.id || normalizeStopName(node.name) !== normalized) return;
    const distanceKm = haversineKm(start.lat, start.lon, node.lat, node.lon);
    if (distanceKm <= .28) {
      seeds.push({ nodeId: node.id, time: Math.max(.35, distanceKm / 4.5 * 60) });
    }
  });
  return seeds;
}

export class MinHeap {
  constructor() { this.items = []; }
  push(item) {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent].cost <= item.cost) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }
  pop() {
    if (!this.items.length) return null;
    const root = this.items[0];
    const end = this.items.pop();
    if (this.items.length && end) {
      let index = 0;
      while (true) {
        let child = index * 2 + 1;
        if (child >= this.items.length) break;
        if (child + 1 < this.items.length && this.items[child + 1].cost < this.items[child].cost) child += 1;
        if (this.items[child].cost >= end.cost) break;
        this.items[index] = this.items[child];
        index = child;
      }
      this.items[index] = end;
    }
    return root;
  }
  get size() { return this.items.length; }
}

/* [本次調整：原版經由全域 appVm.departureTime 讀取出發時間；為了讓這個模組不用
   反過來 import 共用狀態（避免跟 store 互相 import 造成循環依賴），改成用參數傳入，
   行為完全相同，只是呼叫端要自己帶 departureTime 進來。] */
export function edgeWait(edge, elapsedMinutes, departureTime) {
  const hour = Number((departureTime || "08:00").split(":")[0]);
  const peak = (hour >= 7 && hour < 10) || (hour >= 17 && hour < 20);
  if (edge.mode === "walk") return 0;
  if (edge.mode === "metro") {
    const time = (minutesOfDayLocal(departureTime || "08:00") + Number(elapsedMinutes || 0)) % 1440;
    const schedules = metroHeadwaySchedules.get(edge.lineId) || [];
    const active = schedules.find(function (item) {
      return time >= item.start && time < item.end;
    });
    const fallback = peak ? MODEL.defaultMetroPeakHeadway : MODEL.defaultMetroOffPeakHeadway;
    const headway = active ? active.headway : fallback;
    return Math.min(MODEL.maxMetroWaitingMinutes, Math.max(.75, headway / 2));
  }
  const headway = peak ? edge.peakHeadway : edge.offPeakHeadway;
  return Math.min(MODEL.maxWaitingMinutes, Math.max(1, headway / 2));
}

function minutesOfDayLocal(value) {
  const parts = String(value || "00:00").split(":").map(Number);
  return (Number.isFinite(parts[0]) ? parts[0] : 0) * 60 + (Number.isFinite(parts[1]) ? parts[1] : 0);
}

export function transferCost(nodeId, previousMode, nextMode) {
  if (previousMode === "metro" && nextMode === "metro") {
    const node = transitNodes.get(nodeId);
    return metroTransferMinutes.get(normalizeMetroStationName(node ? node.name : "")) || MODEL.transferMinutes;
  }
  return MODEL.transferMinutes;
}

export function computeReachability(startId, maxMinutes, departureTime) {
  const heap = new MinHeap();
  const distances = new Map();
  const predecessor = new Map();
  const bestByNode = new Map();
  const seeds = originBoardingSeeds(startId);
  seeds.forEach(function (seed) {
    const stateKey = seed.nodeId + "|@start";
    distances.set(stateKey, seed.time);
    bestByNode.set(seed.nodeId, { nodeId: seed.nodeId, time: seed.time, stateKey: stateKey, routeId: null, mode: "start" });
    heap.push({ nodeId: seed.nodeId, routeId: "@start", mode: "start", stateKey: stateKey, cost: seed.time });
  });

  while (heap.size) {
    const state = heap.pop();
    if (!state || state.cost !== distances.get(state.stateKey) || state.cost > maxMinutes) continue;
    const edges = transitGraph.get(state.nodeId) || [];
    edges.forEach(function (edge) {
      const isWalking = edge.mode === "walk";
      const nextRouteId = isWalking ? "@walk" : edge.routeId;
      const changesRoute = !isWalking && state.routeId !== edge.routeId;
      const wait = changesRoute ? edgeWait(edge, state.cost, departureTime) : 0;
      const transfer = changesRoute && state.routeId !== "@start" && state.routeId !== "@walk"
        ? transferCost(state.nodeId, state.mode, edge.mode)
        : 0;
      const nextCost = state.cost + wait + transfer + edge.travelMinutes;
      if (nextCost > maxMinutes) return;
      const nextKey = edge.to + "|" + nextRouteId;
      if (nextCost + 1e-9 >= (distances.get(nextKey) ?? Infinity)) return;
      distances.set(nextKey, nextCost);
      predecessor.set(nextKey, { previous: state.stateKey, edge: edge });
      heap.push({ nodeId: edge.to, routeId: nextRouteId, mode: edge.mode, stateKey: nextKey, cost: nextCost });
      const currentBest = bestByNode.get(edge.to);
      if (!currentBest || nextCost < currentBest.time) {
        bestByNode.set(edge.to, {
          nodeId: edge.to,
          time: nextCost,
          stateKey: nextKey,
          routeId: edge.routeId,
          mode: edge.mode,
        });
      }
    });
  }

  const reached = Array.from(bestByNode.values()).sort(function (a, b) { return a.time - b.time; });
  const routeIds = new Set();
  const busRouteIds = new Set();
  const metroLineIds = new Set();
  predecessor.forEach(function (step) {
    if (!step.edge || !step.edge.routeId) return;
    routeIds.add(step.edge.routeId);
    if (step.edge.mode === "bus") busRouteIds.add(step.edge.routeId);
    if (step.edge.mode === "metro" && step.edge.lineId) metroLineIds.add(step.edge.lineId);
  });
  const start = transitNodes.get(startId);
  let farthestKm = 0;
  reached.forEach(function (item) {
    const node = transitNodes.get(item.nodeId);
    if (node && start) farthestKm = Math.max(farthestKm, haversineKm(start.lat, start.lon, node.lat, node.lon));
  });
  return {
    startId: startId,
    maxMinutes: maxMinutes,
    reached: reached,
    routeIds: routeIds,
    busRouteIds: busRouteIds,
    metroLineIds: metroLineIds,
    farthestKm: farthestKm,
    predecessor: predecessor,
  };
}

/* [2026-09-11 效能修正：以各行政區分層抽樣估算平均可達站數。
   原版逐一運算 8,000 多站會讓 WebGL 長時間無法回應；每區均勻取最多 8 站，
   仍保留行政區層級比較用途，且不更動組員原始 3d_map 檔案。] */
let transitReachCache = null;
let transitReachCachePromise = null;
let districtStationTotals = null;
let districtReachSampleCounts = null;

export function ensureTransitReachCache(onProgress, departureTime) {
  if (transitReachCache) return Promise.resolve(transitReachCache);
  if (transitReachCachePromise) return transitReachCachePromise;
  transitReachCachePromise = new Promise(function (resolve) {
    const cache = new Map();
    const totals = new Map();
    const nodesByDistrict = new Map();
    transitNodes.forEach(function (node) {
      totals.set(node.district, (totals.get(node.district) || 0) + 1);
      if (!nodesByDistrict.has(node.district)) nodesByDistrict.set(node.district, []);
      nodesByDistrict.get(node.district).push(node.id);
    });
    const ids = [];
    const sampleCounts = new Map();
    nodesByDistrict.forEach(function (nodeIds, district) {
      const take = Math.min(8, nodeIds.length);
      const selected = [];
      for (let i = 0; i < take; i += 1) {
        const index = take === 1 ? 0 : Math.round(i * (nodeIds.length - 1) / (take - 1));
        if (!selected.includes(nodeIds[index])) selected.push(nodeIds[index]);
      }
      selected.forEach(function (id) { ids.push(id); });
      sampleCounts.set(district, selected.length);
    });
    let index = 0;
    function step() {
      const chunkEnd = Math.min(index + 4, ids.length);
      for (; index < chunkEnd; index++) {
        const id = ids[index];
        cache.set(id, computeReachability(id, 30, departureTime).reached.length);
      }
      if (onProgress) onProgress(index, ids.length);
      if (index < ids.length) {
        setTimeout(step, 0);
      } else {
        transitReachCache = cache;
        districtStationTotals = totals;
        districtReachSampleCounts = sampleCounts;
        resolve(cache);
      }
    }
    step();
  });
  return transitReachCachePromise;
}

/* [本次新增：把每個交通節點的 30 分鐘可達站數平均到行政區層級，
   抽出成獨立函式，供「交通可及性」疊圖分數與資源缺口頁的「交通稀缺率」
   長條圖共用同一份原始平均可達站數，不用各自重算一次] */
export function buildDistrictReachAverages() {
  const reachSumByDistrict = new Map();
  transitNodes.forEach(function (node) {
    const reach = transitReachCache.get(node.id);
    if (reach === undefined) return;
    reachSumByDistrict.set(node.district, (reachSumByDistrict.get(node.district) || 0) + reach);
  });
  const averages = new Map();
  reachSumByDistrict.forEach(function (reachSum, district) {
    const sampleCount = districtReachSampleCounts.get(district);
    if (!sampleCount) return;
    averages.set(district, reachSum / sampleCount);
  });
  return averages;
}

/* 套用「可達站數 ÷ 區內站數 × 區內青年人口」算出每個行政區單一分數，
   供 3D 人口地圖疊加為第三段柱狀（不再逐站繪製） */
export function buildDistrictTransitScores(year, popByYearRef) {
  const youthByDistrict = new Map();
  (popByYearRef[year] || []).forEach(function (row) {
    youthByDistrict.set(row.area, row.a1 + row.a2);
  });
  const averages = buildDistrictReachAverages();
  const scores = new Map();
  averages.forEach(function (avgReach, district) {
    const totalStations = districtStationTotals.get(district);
    if (!totalStations) return;
    const youthPop = youthByDistrict.get(district) || 0;
    scores.set(district, (avgReach / totalStations) * youthPop);
  });
  return scores;
}
