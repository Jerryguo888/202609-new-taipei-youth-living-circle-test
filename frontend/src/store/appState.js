import { reactive, nextTick } from "vue";
import { router } from "../router/index.js";
import { dataLoadHint } from "../lib/data/fetchCsv.js";
import {
  transitNodes,
  transitGraph,
  loadNetworkCore,
  createStationGroups,
  createMetroGroups,
  nearestNode,
} from "../lib/network.js";
import { computeReachability, edgeWait } from "../lib/reachability.js";
import {
  population3dMap,
  initPopulation3dMap,
  ensureIntegratedTransitLayers,
  setIntegratedTransitVisibility,
  clearIntegratedResults,
  drawIntegratedOrigin,
  focusIntegratedNodes,
  animateIntegratedResult,
  resetPopulationMapView,
  setMapController,
  AGE_GROUPS,
  AGE_GROUP_COLORS,
  redrawPopulationBars,
} from "../lib/mapLibreMap.js";
import { localChatReply, getChatReply as getChatReplyService } from "../lib/chatService.js";
import { estimateChildcareGapRows } from "../lib/resourceGaps.js";
import { estimateTransitGapRows } from "../lib/transitGap.js";
import { loadYouthSuicideShareRows } from "../lib/mortalityStats.js";

const EMPTY_METRICS = { stops: "—", routes: "—", distance: "—", wait: "—" };

/* [本次改版：3D人口／30分鐘交通／預算模擬／青年熱區各自的獨立分頁都拿掉了，
   青年熱區排行、圖例、交通分析三塊改整合進「整合地圖」左側面板，共用同一份
   reactive() 狀態，取代原本每個分頁各自的 data()。] */
export const appState = reactive({
  activeView: "home",
  navItems: [
    { id: "home", label: "系統總覽" },
    { id: "combined", label: "整合地圖" },
    { id: "resources", label: "資源缺口" },
  ],
  navMenuOpen: false,
  /* [本次改版：資源缺口頁只保留托育一張圖（學校／停車兩張圖已依需求刪除），
     rows 是「行政區 -> 稀缺率」的原始資料，圖表只取稀缺率最高的前五名。] */
  resourceGaps: {
    /* [本次改版：托育缺口改成用「新北市托嬰機構數量統計.csv」＋20~29歲青年人口
       實際估算（見 loadResourceGapData / lib/resourceGaps.js），rows 在資料
       載入完成前先留空，圖表載入狀態見 childcareGapStatus。] */
    childcare: {
      label: "托育",
      unit: "%",
      metricLabel: "稀缺率",
      copy: "各行政區公共托育稀缺率（依機構數與20~29歲青年人口推估，公立／私立分開疊圖）",
      rows: [],
    },
    /* [本次新增：交通稀缺率＝(需求標準化分數－供給標準化分數)／需求標準化分數×100，
       需求＝20~29歲青年人口、供給＝30分鐘平均可達站數，見 loadTransitGapData /
       lib/transitGap.js，rows 在資料載入完成前先留空。] */
    transit: {
      label: "交通",
      unit: "%",
      metricLabel: "稀缺率",
      copy: "各行政區交通稀缺率（需求標準化分數與供給標準化分數的落差；需求為20~29歲人口，供給為30分鐘平均可達站數）",
      rows: [],
    },
  },
  transitLoaded: false,
  transitLoading: false,
  transitStatus: "官方資料待載入",
  /* [本次新增：托育缺口改成非同步從 CSV 估算，需要自己的載入狀態旗標] */
  childcareGapLoaded: false,
  childcareGapLoading: false,
  childcareGapStatus: "托育缺口資料待載入",
  /* [整合保留：交通稀缺率與健康指標各自有獨立載入狀態，互不覆蓋] */
  transitGapLoaded: false,
  transitGapLoading: false,
  transitGapStatus: "交通稀缺率資料待載入",
  /* [本次新增：死因統計使用獨立狀態，不影響既有托育缺口資料與錯誤處理] */
  mortalityLoaded: false,
  mortalityLoading: false,
  mortalityStatus: "死因統計資料待載入",
  mortalityYear: "",
  mortalityRows: [],
  stopMode: "bus",
  stationGroups: [],
  activeDistrict: "板橋區",
  metroGroups: [],
  activeMetroLine: "BL",
  selectedStartId: null,
  departureTime: "08:00",
  animationSpeed: 2,
  minuteLimit: 30,
  animationClock: "00:00",
  metrics: { ...EMPTY_METRICS },
  /* [本次新增：地圖上的公車／捷運站點圖層可開關，預設開啟] */
  showTransitStops: true,
  /* [本次新增：3D 人口柱圖例（年齡層／可及性）選取狀態，取代原本的年份滑桿；
     ageGroups/colors 是固定常數，直接從地圖模組帶過來給左側面板畫勾選框] */
  legendAgeGroups: AGE_GROUPS,
  legendColors: AGE_GROUP_COLORS,
  selectedAgeGroups: [...AGE_GROUPS],
  chatOpen: false,
  chatInput: "",
  chatChips: ["哪裡最適合設點？", "30 分鐘怎麼算？", "幫我看預算方案"],
  chatMessages: [
    { role: "assistant", text: "嗨，我是生活圈 AI 助理。你可以問我青年熱區、30 分鐘覆蓋或預算配置。" },
  ],

  /* ===== computed（原本 Vue computed，改成 reactive() 物件上的 getter） ===== */
  get activeDistrictStops() {
    const group = this.stationGroups.find(function (item) { return item.name === this.activeDistrict; }, this);
    return group ? group.stops : [];
  },
  get activeMetroStops() {
    const group = this.metroGroups.find(function (item) { return item.id === this.activeMetroLine; }, this);
    return group ? group.stops : [];
  },
  get forecastRows() {
    return [
      { name: "林口區", score: 88 },
      { name: "土城區", score: 81 },
      { name: "新店區", score: 77 },
      { name: "三峽區", score: 72 },
      { name: "淡水區", score: 68 },
    ];
  },
  /* [本次改版：圖表預設只畫前五名，但點開「查看所有區域」要能看到完整排行，
     所以除了 rows（前五名）以外，也算一份 allRows（全部區域，一樣依數值排序），
     兩者共用同一個 maxValue（=全部區域裡的最大值＝前五名的第一筆）算長條寬度百分比，
     確保展開後的長條跟前五名的長條走同一把尺，不會展開後突然跳動比例。托育這類
     額外附帶 segments（公立／私立），畫成橫向疊圖，學校／停車維持單一色塊。] */
  get resourceGapCharts() {
    return Object.keys(this.resourceGaps).map(function (key) {
      const category = this.resourceGaps[key];
      const sorted = category.rows.slice().sort(function (a, b) { return b.value - a.value; });
      const maxValue = sorted.length ? sorted[0].value : 0;
      const mapRow = function (row) {
        const segments = row.segments
          ? row.segments.map(function (segment) {
              return {
                key: segment.key,
                label: segment.label,
                value: segment.value,
                widthPercent: maxValue ? Math.round((segment.value / maxValue) * 100) : 0,
              };
            })
          : null;
        return {
          area: row.area,
          value: row.value,
          widthPercent: maxValue ? Math.round((row.value / maxValue) * 100) : 0,
          segments: segments,
        };
      };
      return {
        key: key,
        label: category.label,
        unit: category.unit,
        metricLabel: category.metricLabel,
        copy: category.copy,
        rows: sorted.slice(0, 5).map(mapRow),
        allRows: sorted.map(mapRow),
      };
    }, this);
  },
  /* [整合修正：組員健康指標加入後仍保留托育／交通兩張卡各自的載入狀態] */
  get resourceGapLoadingInfo() {
    return {
      childcare: { loading: this.childcareGapLoading, status: this.childcareGapStatus },
      transit: { loading: this.transitGapLoading, status: this.transitGapStatus },
    };
  },
  /* [本次新增：完整排行保留在 mortalityRows，首頁卡片只取排序後前五名] */
  get mortalityTop5Rows() {
    return this.mortalityRows.slice(0, 5);
  },
  /* [本次新增：由29區資料動態加總全新北市的同齡自殺死亡占比，供放大圖表標題顯示] */
  get mortalityCitySummary() {
    const totals = this.mortalityRows.reduce(function (summary, row) {
      summary.suicideDeaths += row.suicideDeaths;
      summary.totalDeaths += row.totalDeaths;
      return summary;
    }, { suicideDeaths: 0, totalDeaths: 0 });
    return {
      suicideDeaths: totals.suicideDeaths,
      totalDeaths: totals.totalDeaths,
      ratio: totals.totalDeaths > 0
        ? Math.round((totals.suicideDeaths / totals.totalDeaths) * 1000) / 10
        : null,
    };
  },

  /* ===== methods（原本 Vue methods，行為與呼叫方式不變，只是掛在這個共用單例上） ===== */
  go(view) {
    this.navMenuOpen = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
    router.push({ name: view });
  },
  resetPopulationMapView() {
    resetPopulationMapView();
  },
  /* [本次新增：地圖上的交通標點開關，勾選框直接呼叫這個方法] */
  toggleTransitStops(visible) {
    this.showTransitStops = visible;
    setIntegratedTransitVisibility(visible);
  },
  /* [本次新增：圖例勾選框呼叫這個方法，取代原本切換年份重繪] */
  toggleAgeGroup(age, visible) {
    const index = this.selectedAgeGroups.indexOf(age);
    if (!visible) {
      if (this.selectedAgeGroups.length === 1) return; // 至少保留一項，跟原本圖例邏輯一致
      if (index >= 0) this.selectedAgeGroups.splice(index, 1);
    } else if (index < 0) {
      this.selectedAgeGroups.push(age);
    }
    redrawPopulationBars(this.selectedAgeGroups);
  },
  async loadTransit() {
    if (this.transitLoaded) {
      ensureIntegratedTransitLayers();
      return;
    }
    if (this.transitLoading) return;
    this.transitLoading = true;
    this.transitStatus = "讀取新北官方資料…";
    try {
      await loadNetworkCore();
      this.stationGroups = createStationGroups();
      this.metroGroups = createMetroGroups();
      if (!this.metroGroups.some(function (group) { return group.id === this.activeMetroLine; }, this) && this.metroGroups[0]) {
        this.activeMetroLine = this.metroGroups[0].id;
      }
      ensureIntegratedTransitLayers();
      const defaultNode = nearestNode(25.0142, 121.4639).node;
      if (defaultNode && !this.selectedStartId) this.chooseStop(defaultNode.id, false);
      this.transitLoaded = true;
    } catch (error) {
      console.error(error);
      this.transitStatus = "資料載入失敗。" + dataLoadHint();
    } finally {
      this.transitLoading = false;
      await nextTick();
      if (population3dMap) population3dMap.resize();
    }
  },
  /* [本次新增：托育缺口改成非同步估算，載入完成後直接覆蓋 resourceGaps.childcare.rows，
     resourceGapCharts 這個 getter 不用改，一樣會取前五名重新排序] */
  async loadResourceGapData() {
    if (this.childcareGapLoaded || this.childcareGapLoading) return;
    this.childcareGapLoading = true;
    this.childcareGapStatus = "讀取托嬰機構與青年人口資料…";
    try {
      const rows = await estimateChildcareGapRows();
      this.resourceGaps.childcare.rows = rows;
      this.childcareGapLoaded = true;
      this.childcareGapStatus = "";
    } catch (error) {
      console.error(error);
      this.childcareGapStatus = "資料載入失敗。" + dataLoadHint();
    } finally {
      this.childcareGapLoading = false;
    }
  },
  /* [整合保留：交通稀缺率與青年健康指標同時存在，避免合併時互相取代] */
  async loadTransitGapData() {
    if (this.transitGapLoaded || this.transitGapLoading) return;
    this.transitGapLoading = true;
    this.transitGapStatus = "讀取路網與可達性資料…";
    try {
      const rows = await estimateTransitGapRows();
      this.resourceGaps.transit.rows = rows;
      this.transitGapLoaded = true;
      this.transitGapStatus = "";
    } catch (error) {
      console.error(error);
      this.transitGapStatus = "資料載入失敗。" + dataLoadHint();
    } finally {
      this.transitGapLoading = false;
    }
  },
  /* [本次新增：死因統計獨立載入；失敗時不會清空或遮蔽既有托育圖表] */
  async loadMortalityData() {
    if (this.mortalityLoaded || this.mortalityLoading) return;
    this.mortalityLoading = true;
    this.mortalityStatus = "讀取20~29歲死因統計…";
    try {
      const result = await loadYouthSuicideShareRows();
      this.mortalityYear = result.year;
      this.mortalityRows = result.rows;
      this.mortalityLoaded = true;
      this.mortalityStatus = "";
    } catch (error) {
      console.error(error);
      this.mortalityStatus = "資料載入失敗。" + dataLoadHint();
    } finally {
      this.mortalityLoading = false;
    }
  },
  chooseStop(nodeId, moveMap) {
    const node = transitNodes.get(nodeId);
    if (!node) return;
    this.stopMode = node.mode === "metro" ? "metro" : "bus";
    if (node.mode === "metro" && node.lines && node.lines.size) {
      this.activeMetroLine = Array.from(node.lines)[0];
    } else {
      this.activeDistrict = node.district;
    }
    this.selectedStartId = nodeId;
    this.metrics = { ...EMPTY_METRICS };
    clearIntegratedResults(false);
    drawIntegratedOrigin(node, moveMap);
  },
  selectDistrict(district) {
    this.stopMode = "bus";
    this.activeDistrict = district;
    this.selectedStartId = null;
    this.metrics = { ...EMPTY_METRICS };
    clearIntegratedResults();
    focusIntegratedNodes(this.activeDistrictStops, 13);
  },
  selectMetroLine(lineId) {
    this.stopMode = "metro";
    this.activeMetroLine = lineId;
    this.selectedStartId = null;
    this.metrics = { ...EMPTY_METRICS };
    clearIntegratedResults();
    focusIntegratedNodes(this.activeMetroStops, 13);
  },
  selectStopMode(mode) {
    this.stopMode = mode;
    this.selectedStartId = null;
    this.metrics = { ...EMPTY_METRICS };
    clearIntegratedResults();
    const stops = mode === "metro" ? this.activeMetroStops : this.activeDistrictStops;
    focusIntegratedNodes(stops, 13);
  },
  runReachability() {
    if (!this.selectedStartId) return;
    const result = computeReachability(this.selectedStartId, this.minuteLimit, this.departureTime);
    const startEdges = transitGraph.get(this.selectedStartId) || [];
    const serviceEdges = startEdges.filter(function (edge) { return edge.mode !== "walk"; });
    const minWait = serviceEdges.length
      ? Math.min.apply(null, serviceEdges.map((edge) => edgeWait(edge, 0, this.departureTime)))
      : 0;
    this.metrics = {
      stops: result.reached.length.toLocaleString(),
      routes: result.routeIds.size.toLocaleString(),
      distance: result.farthestKm.toFixed(1) + " km",
      wait: minWait.toFixed(1) + " 分",
    };
    animateIntegratedResult(result);
  },
  localChatReply(text) {
    return localChatReply(text);
  },
  async getChatReply(text) {
    return getChatReplyService(text, {
      activeView: this.activeView,
      minuteLimit: this.minuteLimit,
    });
  },
  async sendChat(messagesEl) {
    const text = this.chatInput.trim();
    if (!text) return;
    this.chatMessages.push({ role: "user", text: text });
    this.chatInput = "";
    let answer;
    try {
      answer = await this.getChatReply(text);
    } catch (error) {
      answer = "雲端服務目前未開放，我先使用本機情境回覆。";
    }
    this.chatMessages.push({ role: "assistant", text: answer });
    await nextTick();
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  },
});

/* [本次改版：把地圖模組會回呼的 controller 指向這個共用單例，取代原本的全域 appVm，
   只需要在應用程式啟動時設定一次] */
setMapController(appState);

/* [本次改版：3D人口／30分鐘交通／預算模擬／青年熱區都刪掉了，整合地圖是唯一
   需要初始化地圖／交通資料的畫面，其餘畫面不需要任何動作。] */
export async function ensureViewReady(view) {
  await nextTick();
  if (view === "combined") {
    initPopulation3dMap();
    await appState.loadTransit();
    ensureIntegratedTransitLayers();
    setIntegratedTransitVisibility(appState.showTransitStops);
  } else if (view === "resources") {
    /* [整合修正：三種資料並行載入，任一功能不會阻塞或覆蓋另外兩種] */
    await Promise.all([
      appState.loadResourceGapData(),
      appState.loadTransitGapData(),
      appState.loadMortalityData(),
    ]);
  }
}
