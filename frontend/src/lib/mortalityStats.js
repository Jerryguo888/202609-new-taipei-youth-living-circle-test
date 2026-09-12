import { DATA_FILES } from "./data/dataFiles.js";
import { loadPopulationCsv } from "./data/fetchCsv.js";

const TARGET_AGE_CODE = "3";
const SUICIDE_CAUSE_CODE = "131";

function districtName(value) {
  return String(value || "").replace(/^新北市/, "").trim();
}

function compareMortalityRows(a, b) {
  if (a.ratio === null && b.ratio !== null) return 1;
  if (a.ratio !== null && b.ratio === null) return -1;
  if (a.ratio !== b.ratio) return (b.ratio || 0) - (a.ratio || 0);
  if (a.totalDeaths !== b.totalDeaths) return b.totalDeaths - a.totalDeaths;
  return a.area.localeCompare(b.area, "zh-Hant");
}

/*
 * 將官方逐筆死因資料整理成最新年度的行政區排行。
 * 分子、分母都限定20~29歲；男女資料相加，分母為該年齡層全部死因死亡數。
 */
export function buildYouthSuicideShareRows(sourceRows) {
  let latestYear = null;
  sourceRows.forEach(function (row) {
    const year = Number(row["年度"]);
    if (Number.isFinite(year) && (latestYear === null || year > latestYear)) latestYear = year;
  });
  if (latestYear === null) throw new Error("死因統計缺少可辨識的年度資料");

  const byArea = new Map();
  sourceRows.forEach(function (row) {
    if (Number(row["年度"]) !== latestYear) return;
    const area = districtName(row["縣市鄉鎮"]);
    if (area && !byArea.has(area)) {
      byArea.set(area, { area: area, suicideDeaths: 0, totalDeaths: 0 });
    }
  });

  sourceRows.forEach(function (row) {
    if (Number(row["年度"]) !== latestYear || String(row["年齡代碼"]) !== TARGET_AGE_CODE) return;
    const area = districtName(row["縣市鄉鎮"]);
    const target = byArea.get(area);
    if (!target) return;
    const deaths = Number(row["死亡數"]);
    if (!Number.isFinite(deaths) || deaths < 0) return;
    target.totalDeaths += deaths;
    if (String(row["死因代碼"]).padStart(3, "0") === SUICIDE_CAUSE_CODE) {
      target.suicideDeaths += deaths;
    }
  });

  const rows = Array.from(byArea.values()).map(function (row) {
    const ratio = row.totalDeaths > 0
      ? Math.round((row.suicideDeaths / row.totalDeaths) * 1000) / 10
      : null;
    return {
      area: row.area,
      suicideDeaths: row.suicideDeaths,
      totalDeaths: row.totalDeaths,
      ratio: ratio,
      isLowSample: row.totalDeaths > 0 && row.totalDeaths < 5,
      year: String(latestYear),
    };
  }).sort(compareMortalityRows);

  return { year: String(latestYear), rows: rows };
}

export async function loadYouthSuicideShareRows() {
  const sourceRows = await loadPopulationCsv(DATA_FILES.mortalityStatistics);
  return buildYouthSuicideShareRows(sourceRows);
}
