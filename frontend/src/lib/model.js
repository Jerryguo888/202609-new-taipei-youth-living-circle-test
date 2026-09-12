/* [改版保留：交通時間模型可調參數，供 network.js 建圖與 reachability.js 可達性計算共用] */
export const MODEL = {
  busSpeedKmh: 18,
  roadDistanceFactor: 1.25,
  dwellMinutes: 0.35,
  transferMinutes: 2,
  defaultPeakHeadway: 12,
  defaultOffPeakHeadway: 18,
  maxWaitingMinutes: 10,
  walkSpeedKmh: 4.5,
  stationEntryMinutes: 1.5,
  maxBusMetroWalkKm: .45,
  maxBusLinksPerMetro: 8,
  defaultMetroPeakHeadway: 6,
  defaultMetroOffPeakHeadway: 9,
  maxMetroWaitingMinutes: 7,
};
