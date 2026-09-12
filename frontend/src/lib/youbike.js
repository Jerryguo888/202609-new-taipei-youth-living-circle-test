import { DATA_FILES } from "./data/dataFiles.js";

/* ===== [Jerry 新增：YouBike 公共資源統計開始] =====
   預設讀取 repo 內的新北市政府官方資料快照，確保 GitHub Pages 在 HTTPS 下可用。
   比賽部署 AWS 後，只要設定 VITE_YOUBIKE_API_URL，即可改讀相同欄位格式的即時 API；
   同時相容組員目前的 { updatedAt, stations } 回傳格式。 */

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeStation(row) {
  return {
    id: String(row.sno || row.id || ""),
    name: String(row.sna || row.name || "未命名場站").replace(/^YouBike2\.0_/, ""),
    district: String(row.sarea || row.district || "未分類"),
    address: String(row.ar || row.address || "地址未提供"),
    docks: asNumber(row.tot_quantity ?? row.tot ?? row.total),
    available: asNumber(row.sbi_quantity ?? row.sbi ?? row.available),
    updatedAt: row.mday || row.updatedAt || "",
  };
}

function parseOfficialTime(value) {
  const text = String(value || "");
  const match = text.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!match) return text;
  return `${match[1]}/${match[2]}/${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
}

function summarize(stations, payloadUpdatedAt, isSnapshot) {
  const zeroByDistrict = new Map();
  const zeroStations = [];
  let totalDocks = 0;
  let availableBikes = 0;
  let zeroBikeStations = 0;

  stations.forEach(function (station) {
    totalDocks += station.docks;
    availableBikes += station.available;
    if (station.available === 0) {
      zeroBikeStations += 1;
      zeroStations.push(station);
      zeroByDistrict.set(station.district, (zeroByDistrict.get(station.district) || 0) + 1);
    }
  });

  zeroStations.sort(function (a, b) {
    return a.district.localeCompare(b.district, "zh-Hant") || a.name.localeCompare(b.name, "zh-Hant");
  });

  const topZeroDistricts = Array.from(zeroByDistrict, function ([district, count]) {
    return { district, count };
  }).sort(function (a, b) {
    return b.count - a.count || a.district.localeCompare(b.district, "zh-Hant");
  }).slice(0, 5);
  const maxZeroCount = topZeroDistricts.length ? topZeroDistricts[0].count : 0;

  return {
    stationCount: stations.length,
    totalDocks,
    availableBikes,
    zeroBikeStations,
    /* [Jerry 新增：供右側可捲動面板列出全部零車站名稱與地址] */
    zeroStations,
    topZeroDistricts: topZeroDistricts.map(function (row) {
      return {
        ...row,
        widthPercent: maxZeroCount ? Math.round((row.count / maxZeroCount) * 100) : 0,
      };
    }),
    updatedAt: parseOfficialTime(payloadUpdatedAt || stations[0]?.updatedAt),
    isSnapshot,
  };
}

export async function loadYouBikeDashboard() {
  const configuredApi = String(import.meta.env.VITE_YOUBIKE_API_URL || "").trim();
  const sourceUrl = configuredApi || new URL(DATA_FILES.youbikeSnapshot, document.baseURI).href;
  const response = await fetch(sourceUrl, { cache: configuredApi ? "no-store" : "default" });
  if (!response.ok) throw new Error(`YouBike 資料讀取失敗（HTTP ${response.status}）`);

  const payload = await response.json();
  const rows = Array.isArray(payload) ? payload : payload.stations;
  if (!Array.isArray(rows) || !rows.length) throw new Error("YouBike 資料沒有可用站點");
  const stations = rows.map(normalizeStation);
  return summarize(stations, Array.isArray(payload) ? "" : payload.updatedAt, !configuredApi);
}

/* ===== [Jerry 新增：YouBike 公共資源統計結束] ===== */
