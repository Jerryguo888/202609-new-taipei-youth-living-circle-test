import { DATA_FILES } from "./data/dataFiles.js";
import { loadPopulationCsv } from "./data/fetchCsv.js";
import { loadNetworkCore } from "./network.js";
import { ensureTransitReachCache, buildDistrictReachAverages } from "./reachability.js";

/* [本次新增：交通稀缺率]
   需缺率(%) = (需求標準化分數 − 供給標準化分數) / 需求標準化分數 × 100
   1. 需求＝20~29 歲青年人口（跟托育缺口同一套需求代理指標，全站一致）。
   2. 供給＝該區交通站點 30 分鐘內平均可達站數（既有「交通可及性」疊圖用的
      原始平均可達站數，見 reachability.js 的 buildDistrictReachAverages，
      這裡直接重用，不用另外重算一次可達性）。
   3. 需求、供給分別在有資料的行政區之間做 min-max 標準化到 0~1，
      再代入上面的公式；分子 <=0（供給已經跟得上或超過需求）不算稀缺，設為 0。
   4. min-max 標準化下，需求最低的那一區標準化分數必為 0，會讓分母變 0、
      算不出百分比，這種情況直接跳過該區（無法定義比例）。 */
export async function estimateTransitGapRows() {
  await loadNetworkCore();
  await ensureTransitReachCache(null, "08:00");

  const populationRows = await loadPopulationCsv(DATA_FILES.populationYouthCounts);
  const years = Array.from(new Set(populationRows.map(function (row) { return row.year; })))
    .sort(function (a, b) { return Number(a) - Number(b); });
  const latestYear = years[years.length - 1];

  const youthByArea = new Map();
  populationRows.forEach(function (row) {
    if (row.year !== latestYear || !row.area || row.area === "新北市") return;
    youthByArea.set(row.area, Number(row["age20~29"]) || 0);
  });

  const avgReachByArea = buildDistrictReachAverages();
  const areas = Array.from(youthByArea.keys()).filter(function (area) {
    return avgReachByArea.has(area);
  });
  if (!areas.length) return [];

  const demandValues = areas.map(function (area) { return youthByArea.get(area); });
  const supplyValues = areas.map(function (area) { return avgReachByArea.get(area); });
  const demandMin = Math.min.apply(null, demandValues);
  const demandMax = Math.max.apply(null, demandValues);
  const supplyMin = Math.min.apply(null, supplyValues);
  const supplyMax = Math.max.apply(null, supplyValues);
  const demandRange = demandMax - demandMin;
  const supplyRange = supplyMax - supplyMin;

  const rows = [];
  areas.forEach(function (area) {
    const demandNorm = demandRange > 0 ? (youthByArea.get(area) - demandMin) / demandRange : 0;
    if (demandNorm <= 0) return;
    const supplyNorm = supplyRange > 0 ? (avgReachByArea.get(area) - supplyMin) / supplyRange : 0;
    const rate = Math.max(0, ((demandNorm - supplyNorm) / demandNorm) * 100);
    rows.push({ area: area, value: Math.round(rate * 10) / 10 });
  });

  return rows;
}
