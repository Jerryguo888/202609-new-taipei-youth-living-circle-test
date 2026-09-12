/* [本次移植：CSV 路徑集中管理，未來要換成後端 API 只需要改這個檔案] */
export const DATA_FILES = {
  stops: "data/raw/ntpc_bus_stops_full.csv",
  routes: "data/raw/ntpc_bus_routes_full.csv",
  /* 臺北市資料大平臺官方捷運站點、路線站序與路線色彩 */
  metroStations: "data/raw/taipei_metro_stations.csv",
  metroRouteStations: "data/raw/taipei_metro_route_stations.csv",
  metroLines: "data/raw/taipei_metro_lines.csv",
  /* 官方捷運站間秒數、轉乘步行與班距 */
  metroTravelTimes: "data/raw/taipei_metro_travel_times.csv",
  metroTransferWalk: "data/raw/taipei_metro_transfer_walk.csv",
  metroHeadways: "data/raw/taipei_metro_headways.csv",
  /* TDX 新北環狀線站點、站序、路線與班距 */
  ntmcMetroStations: "data/raw/ntmc_metro_stations.csv",
  ntmcMetroRouteStations: "data/raw/ntmc_metro_route_stations.csv",
  ntmcMetroLines: "data/raw/ntmc_metro_lines.csv",
  ntmcMetroHeadways: "data/raw/ntmc_metro_headways.csv",
  /* 唯讀使用組員既有的 29 區座標檔，不修改來源 */
  districts: "data/3d_map/新北市行政區經緯度.csv",
  /* [本次移植：3D 人口地圖三份 CSV，原本寫死在 mapLibreMap.js 裡，集中到這裡方便未來換 API] */
  populationDistricts: "data/3d_map/新北市行政區.csv",
  populationDistrictLocations: "data/3d_map/新北市行政區經緯度.csv",
  populationYouthCounts: "data/3d_map/新北市20至34歲人數.csv",
  /* [本次新增：托育機構數量統計，用來跟青年人口交叉估算托育資源缺口] */
  childcareInstitutions: "data/raw/新北市托嬰機構數量統計.csv",
  /* [Jerry 保留：官方 YouBike2.0 全市站點快照；GitHub Pages 不直連 HTTP 私人主機，
     不可被其他資料源設定覆蓋] */
  youbikeSnapshot: "data/raw/ntpc_youbike_realtime.json",
  /* [本次新增：各行政區死因統計，用來計算20~29歲自殺死亡占同齡全部死亡的比例] */
  mortalityStatistics: "data/raw/新北市死因統計97-114.csv",
};
