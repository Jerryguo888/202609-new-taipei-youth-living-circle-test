import { DATA_FILES } from "./data/dataFiles.js";
import { loadPopulationCsv } from "./data/fetchCsv.js";
import { describeFreshness, loadLiveRecords } from "./data/liveRecords.js";

/* [本次改版：圖表點開後要能看到「所有區域」的稀缺率，不能只回傳稀缺的區，
   所以這裡改成回傳資料集裡每一區的稀缺率（含 0% 已達平均水準的區），
   排行前五名的篩選交給 appState.js 的 resourceGapCharts 處理。]
   托育資源稀缺改成公私立分開估算，並且輸出「稀缺率」而不是缺口席次。
   方法（MVP 概念估算，非官方精確值）：
   1. 用「新北市托嬰機構數量統計.csv」拆出每區「公共托育中心」與「私立托嬰機構」
      兩類機構數；用「新北市20至34歲人數.csv」最新一年的 20~29 歲人口當作
      生養／托育需求的代理指標。
   2. 分別算出全新北市「公立機構數 ÷ 20~29歲人口」與「私立機構數 ÷ 20~29歲人口」
      的平均比例，當作各自合理服務水準的基準。
   3. 每一區各自「照全市平均比例應該要有的機構數」減去「實際機構數」，
      得出公立、私立各自的機構數缺口；缺口 <=0 代表該類別已達或超過全市平均，
      不算稀缺（設為 0，不會出現負的稀缺率）。
   4. 用「該區應有機構總數（公立+私立）」當共同分母，把公立、私立缺口
      各自換算成佔應有總量的百分比，兩者相加即為該區的整體「稀缺率」，
      可以直接疊圖並排前五名。 */
const TYPES = [
  { key: "public", column: "公共托育中心" },
  { key: "private", column: "私立托嬰機構" },
];

/* 把 API 抓來的逐筆名冊彙總成跟靜態 CSV 一樣的形狀。

   名冊是一列一間機構（391 筆），CSV 是一列一個行政區（21 列）。下面的計算需要
   後者，所以在這裡分組計數。

   `kind` 的值是「公共托育中心」或「私立托嬰機構」（見 backend 的
   normalise_childcare_public／_private），所以用「公共」兩字判斷類別。
   我驗證過這樣分組出來的數字跟靜態 CSV 的 21 個行政區完全一致。 */
function summariseRoster(rows) {
  const byArea = new Map();
  rows.forEach(function (row) {
    const area = row.district;
    if (!area) return;
    if (!byArea.has(area)) byArea.set(area, { area: area, 公共托育中心: 0, 私立托嬰機構: 0 });
    const bucket = byArea.get(area);
    if (String(row.kind || "").includes("公共")) bucket["公共托育中心"] += 1;
    else bucket["私立托嬰機構"] += 1;
  });
  return Array.from(byArea.values());
}

export async function estimateChildcareGapRows() {
  /* 托育機構名冊優先讀每月更新的那一份，沒有才退回靜態 CSV。
     青年人口（分母）目前沒有對應的 API 抓取，所以一律讀 CSV —— 也就是
     分子會月更、分母不會。人口變化慢，實務上影響很小，但這是已知落差。 */
  const liveRoster = await loadLiveRecords("childcare_facilities");
  const [csvInstitutionRows, populationRows] = await Promise.all([
    liveRoster ? Promise.resolve(null) : loadPopulationCsv(DATA_FILES.childcareInstitutions),
    loadPopulationCsv(DATA_FILES.populationYouthCounts),
  ]);
  const institutionRows = liveRoster
    ? summariseRoster(liveRoster.rows)
    : csvInstitutionRows;
  const freshness = describeFreshness(liveRoster, "隨版本更新");

  const institutionsByArea = new Map();
  institutionRows.forEach(function (row) {
    if (!row.area || row.area === "新北市") return;
    const counts = {};
    TYPES.forEach(function (type) {
      const count = Number(row[type.column]);
      counts[type.key] = Number.isFinite(count) ? count : 0;
    });
    institutionsByArea.set(row.area, counts);
  });

  const years = Array.from(new Set(populationRows.map(function (row) { return row.year; })))
    .sort(function (a, b) { return Number(a) - Number(b); });
  const latestYear = years[years.length - 1];

  const youthByArea = new Map();
  populationRows.forEach(function (row) {
    if (row.year !== latestYear || !row.area || row.area === "新北市") return;
    youthByArea.set(row.area, Number(row["age20~29"]) || 0);
  });

  /* 全市平均「各類機構數 ÷ 20~29 歲人口」比例，分別當作公立／私立的服務水準基準線 */
  let totalYouth = 0;
  const totalByType = { public: 0, private: 0 };
  institutionsByArea.forEach(function (counts, area) {
    const youth = youthByArea.get(area);
    if (!youth) return;
    totalYouth += youth;
    TYPES.forEach(function (type) {
      totalByType[type.key] += counts[type.key];
    });
  });
  const cityRatioByType = {};
  TYPES.forEach(function (type) {
    cityRatioByType[type.key] = totalYouth > 0 ? totalByType[type.key] / totalYouth : 0;
  });

  const rows = [];
  institutionsByArea.forEach(function (counts, area) {
    const youth = youthByArea.get(area) || 0;
    const expectedByType = {};
    let expectedTotal = 0;
    TYPES.forEach(function (type) {
      expectedByType[type.key] = cityRatioByType[type.key] * youth;
      expectedTotal += expectedByType[type.key];
    });
    if (expectedTotal <= 0) return;

    const gapByType = {};
    TYPES.forEach(function (type) {
      /* 缺口 <=0 代表該類別已達或超過全市平均水準，不算稀缺，設為 0 */
      gapByType[type.key] = Math.max(0, expectedByType[type.key] - counts[type.key]);
    });

    const publicRate = (gapByType.public / expectedTotal) * 100;
    const privateRate = (gapByType.private / expectedTotal) * 100;
    const scarcityRate = publicRate + privateRate;
    /* 稀缺率 0% 代表已達或超過全市平均水準，仍然保留這筆資料，
       這樣點開「所有區域」清單時才看得到完整 20 區，不會只看到有缺口的區。 */

    rows.push({
      area: area,
      value: Math.round(scarcityRate * 10) / 10,
      segments: [
        { key: "public", label: "公立", value: Math.round(publicRate * 10) / 10 },
        { key: "private", label: "私立", value: Math.round(privateRate * 10) / 10 },
      ],
    });
  });

  /* 回傳物件而不是只有 rows，讓畫面能顯示這批數字是什麼時候的、多久更新一次。
     少了這個，使用者沒辦法判斷看到的是每月更新的資料還是隨版本走的舊值。 */
  return { rows: rows, freshness: freshness };
}
