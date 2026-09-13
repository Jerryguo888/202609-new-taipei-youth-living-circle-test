import { DATA_FILES } from "./data/dataFiles.js";
import { describeFreshness, formatSourceStamp, loadLiveRecords } from "./data/liveRecords.js";

/* [Jerry 修正：固定補齊新北29區，沒有零車站點的行政區也必須顯示 0 站。] */
const NEW_TAIPEI_DISTRICTS = [
  "板橋區", "三重區", "中和區", "永和區", "新莊區", "新店區", "樹林區", "鶯歌區", "三峽區",
  "淡水區", "汐止區", "瑞芳區", "土城區", "蘆洲區", "五股區", "泰山區", "林口區", "深坑區",
  "石碇區", "坪林區", "三芝區", "石門區", "八里區", "平溪區", "雙溪區", "貢寮區", "金山區",
  "萬里區", "烏來區",
];

/* ===== [Jerry 新增：YouBike 公共資源統計開始] =====
   預設讀取 repo 內的新北市政府官方資料快照，確保 GitHub Pages 在 HTTPS 下可用。
   比賽部署 AWS 後，只要設定 VITE_YOUBIKE_API_URL，即可改讀相同欄位格式的即時 API；
   同時相容組員目前的 { updatedAt, stations } 回傳格式。 */

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/* 同時吃兩種欄位名：
     sno/sna/sarea/ar/tot_quantity/sbi_quantity/mday  YouBike 官方 API 原始欄位
     station_id/name/district/address/docks/available/updated  我們正規化後的欄位
   這樣同一個函式可以處理靜態快照、/live/ 的資料、以及直接打官方 API 三種來源。 */
function normalizeStation(row) {
  return {
    id: String(row.sno || row.station_id || row.id || ""),
    name: String(row.sna || row.name || "未命名場站").replace(/^YouBike2\.0_/, ""),
    district: String(row.sarea || row.district || "未分類"),
    address: String(row.ar || row.address || "地址未提供"),
    docks: asNumber(row.tot_quantity ?? row.tot ?? row.total ?? row.docks),
    available: asNumber(row.sbi_quantity ?? row.sbi ?? row.available),
    updatedAt: row.mday || row.updated || row.updatedAt || "",
  };
}

function summarize(stations, payloadUpdatedAt, isSnapshot, freshness) {
  const zeroByDistrict = new Map();
  let totalDocks = 0;
  let availableBikes = 0;
  let zeroBikeStations = 0;

  stations.forEach(function (station) {
    totalDocks += station.docks;
    availableBikes += station.available;
    if (station.available === 0) {
      zeroBikeStations += 1;
      zeroByDistrict.set(station.district, (zeroByDistrict.get(station.district) || 0) + 1);
    }
  });

  /* [Jerry 修正：放大內容是完整29區排行，不省略 count=0 的行政區。] */
  const districtOrder = new Map(NEW_TAIPEI_DISTRICTS.map(function (district, index) {
    return [district, index];
  }));
  const allZeroDistricts = NEW_TAIPEI_DISTRICTS.map(function (district) {
    return { district, count: zeroByDistrict.get(district) || 0 };
  }).sort(function (a, b) {
    return b.count - a.count || districtOrder.get(a.district) - districtOrder.get(b.district);
  });
  const maxZeroCount = allZeroDistricts.length ? allZeroDistricts[0].count : 0;
  const rankedZeroDistricts = allZeroDistricts.map(function (row) {
    return {
      ...row,
      widthPercent: maxZeroCount ? Math.round((row.count / maxZeroCount) * 100) : 0,
    };
  });

  return {
    stationCount: stations.length,
    totalDocks,
    availableBikes,
    zeroBikeStations,
    allZeroDistricts: rankedZeroDistricts,
    topZeroDistricts: rankedZeroDistricts.slice(0, 5),
    updatedAt: formatSourceStamp(payloadUpdatedAt || stations[0]?.updatedAt),
    isSnapshot,
    freshness: freshness || null,
  };
}

export async function loadYouBikeDashboard() {
  /* 三種來源，依序嘗試：
       1. VITE_YOUBIKE_API_URL   明確指定時優先（例如直接打官方即時 API）
       2. /live/youbike_stations.json  每小時排程更新的那一份
       3. 靜態快照                     全新部署、排程還沒跑過時的退路 */
  const configuredApi = String(import.meta.env.VITE_YOUBIKE_API_URL || "").trim();

  if (!configuredApi) {
    const live = await loadLiveRecords("youbike_stations");
    if (live) {
      const stations = live.rows.map(normalizeStation);
      return summarize(stations, "", false, describeFreshness(live));
    }
  }

  const sourceUrl = configuredApi || new URL(DATA_FILES.youbikeSnapshot, document.baseURI).href;
  const response = await fetch(sourceUrl, { cache: configuredApi ? "no-store" : "default" });
  if (!response.ok) throw new Error(`YouBike 資料讀取失敗（HTTP ${response.status}）`);

  const payload = await response.json();
  const rows = Array.isArray(payload) ? payload : payload.stations || payload.rows;
  if (!Array.isArray(rows) || !rows.length) throw new Error("YouBike 資料沒有可用站點");
  const stations = rows.map(normalizeStation);
  return summarize(
    stations,
    Array.isArray(payload) ? "" : payload.updatedAt,
    !configuredApi,
    describeFreshness(null, configuredApi ? "即時" : "隨版本更新"),
  );
}

/* ===== [Jerry 新增：YouBike 公共資源統計結束] ===== */
