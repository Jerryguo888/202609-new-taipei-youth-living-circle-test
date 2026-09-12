import { DATA_FILES } from "./data/dataFiles.js";
import { loadPopulationCsv } from "./data/fetchCsv.js";

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

export async function estimateChildcareGapRows() {
  const [institutionRows, populationRows] = await Promise.all([
    loadPopulationCsv(DATA_FILES.childcareInstitutions),
    loadPopulationCsv(DATA_FILES.populationYouthCounts),
  ]);

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

  return rows;
}
