import { reactive, nextTick } from "vue";
import { router } from "../router/index.js";
import { dataLoadHint } from "../lib/data/fetchCsv.js";
import {
  transitNodes,
  transitGraph,
  metroStations,
  searchableNodes,
  searchableMetroNodes,
  loadNetworkCore,
  createStationGroups,
  createMetroGroups,
} from "../lib/network.js";
import { computeReachability, edgeWait } from "../lib/reachability.js";
import {
  leafletMap,
  initLeaflet,
  bindStopLayerEvents,
  renderMetroReference,
  renderBaseStops,
  drawOrigin,
  resetMapResults,
  nearestNode,
  focusNodeCollection,
  animateResult,
  drawSelectedBusRoute,
  drawSelectedMetroLine,
  listReachableBusRoutes,
  listReachableMetroLines,
  clearOriginLayer,
  clearSelectedBusRouteLayer,
  clearSelectedMetroLineLayer,
  setLeafletController,
} from "../lib/leafletMap.js";
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
} from "../lib/mapLibreMap.js";
import { localChatReply, getChatReply as getChatReplyService } from "../lib/chatService.js";

const EMPTY_METRICS = { stops: "—", routes: "—", distance: "—", wait: "—" };

/* [本次改版：原本整個網站只有一個 Vue app 實例，所有分頁共用同一份 data()/methods。
   拆成多個路由元件後，選站、出發時間、可達結果這些狀態仍要跨「30 分鐘交通」與
   「整合地圖」共用（在其中一頁選站，切到另一頁要看得到同一個選擇），
   所以改成一個模組級的 reactive() 單例，取代原本的 appVm，而不是各自元件的 data()。] */
export const appState = reactive({
  activeView: "home",
  navItems: [
    { id: "home", label: "系統總覽" },
    { id: "combined", label: "整合地圖" },
    { id: "map3d", label: "3D 人口" },
    { id: "forecast", label: "青年熱區" },
    { id: "resources", label: "資源缺口" },
    { id: "transit", label: "30 分鐘交通" },
    { id: "budget", label: "預算模擬" },
  ],
  navMenuOpen: false,
  resourceType: "all",
  gapItems: [
    { area: "林口區", type: "childcare", name: "托育", gap: "缺口 420 席", label: "HIGH DEMAND", level: "risk", copy: "青年家庭與住宅供給同步增長，建議優先盤點公共托育量能。" },
    { area: "土城區", type: "school", name: "學校", gap: "缺口 12 班", label: "WATCH", level: "warn", copy: "未來學童數可能接近既有班級容量，需提早規劃彈性教室。" },
    { area: "新店區", type: "parking", name: "停車", gap: "餘裕 8%", label: "STABLE", level: "", copy: "整體仍有容量，但央北生活圈尖峰需求需獨立觀察。" },
    { area: "三峽區", type: "childcare", name: "托育", gap: "缺口 260 席", label: "WATCH", level: "warn", copy: "新建住宅帶動家庭人口，建議配置巡迴育兒服務。" },
    { area: "淡水區", type: "parking", name: "停車", gap: "缺口 680 格", label: "HIGH DEMAND", level: "risk", copy: "住宅人口與觀光尖峰重疊，需拆分平假日情境。" },
    { area: "板橋區", type: "school", name: "學校", gap: "餘裕 14 班", label: "STABLE", level: "", copy: "整體容量尚可，部分新興生活圈仍需持續監測。" },
  ],
  budget: { fixed: 2, popup: 3, mobile: 1, staff: 8 },
  transitLoaded: false,
  transitLoading: false,
  transitStatus: "官方資料待載入",
  stopMode: "bus",
  stopQuery: "",
  stopSuggestions: [],
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
  resultRoutes: [],
  selectedRouteId: null,
  selectedRouteInfo: null,
  resultMetroLines: [],
  selectedMetroLineId: null,
  selectedMetroLineInfo: null,
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
  get searchPlaceholder() {
    return this.stopMode === "metro" ? "輸入捷運站名，例如：板橋" : "輸入公車站名，例如：板橋車站";
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
  get filteredGaps() {
    if (this.resourceType === "all") return this.gapItems;
    return this.gapItems.filter(function (item) { return item.type === this.resourceType; }, this);
  },
  get annualCost() {
    return this.budget.fixed * 420 + this.budget.popup * 90 + this.budget.mobile * 260 + this.budget.staff * 72;
  },
  get coverageRate() {
    return Math.min(96, Math.round(72 + this.budget.fixed * 6.5 + this.budget.popup * 2 + this.budget.mobile * 3.5 + this.budget.staff * .4));
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
  async loadTransit() {
    if (this.transitLoaded) {
      if (leafletMap && this.activeView === "transit") {
        bindStopLayerEvents();
        renderMetroReference();
        renderBaseStops();
        if (this.selectedStartId) drawOrigin(transitNodes.get(this.selectedStartId));
      }
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
      if (leafletMap && this.activeView === "transit") {
        bindStopLayerEvents();
        renderMetroReference();
        renderBaseStops();
      }
      ensureIntegratedTransitLayers();
      const defaultNode = nearestNode(25.0142, 121.4639).node;
      if (defaultNode && !this.selectedStartId) this.chooseStop(defaultNode.id, false);
      this.transitLoaded = true;
      this.transitStatus = "公車 " + searchableNodes.length.toLocaleString() + " 站・捷運 " + metroStations.length + " 站";
    } catch (error) {
      console.error(error);
      this.transitStatus = "資料載入失敗。" + dataLoadHint();
    } finally {
      this.transitLoading = false;
      await nextTick();
      if (leafletMap && this.activeView === "transit") leafletMap.invalidateSize();
      if (population3dMap && this.activeView === "combined") population3dMap.resize();
    }
  },
  findStops() {
    const query = this.stopQuery.trim().toLowerCase();
    if (!query || !this.transitLoaded) {
      this.stopSuggestions = [];
      return;
    }
    const source = this.stopMode === "metro" ? searchableMetroNodes : searchableNodes;
    this.stopSuggestions = source.filter(function (node) {
      return node.name.toLowerCase().includes(query);
    }).slice(0, 8).map(function (node) {
      return {
        id: node.id,
        name: node.name,
        routeCount: node.routes.size,
        kindLabel: node.mode === "metro" ? "捷運站" : "公車站",
      };
    });
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
    this.stopQuery = node.name;
    this.stopSuggestions = [];
    this.metrics = { ...EMPTY_METRICS };
    this.resultRoutes = [];
    this.resultMetroLines = [];
    resetMapResults();
    clearIntegratedResults(false);
    if (leafletMap && this.activeView === "transit") {
      drawOrigin(node);
      if (moveMap !== false) leafletMap.flyTo([node.lat, node.lon], Math.max(leafletMap.getZoom(), 13), { duration: .65 });
    }
    if (population3dMap && this.activeView === "combined") drawIntegratedOrigin(node, moveMap);
  },
  selectDistrict(district) {
    this.stopMode = "bus";
    this.activeDistrict = district;
    this.selectedStartId = null;
    this.stopQuery = "";
    this.stopSuggestions = [];
    this.metrics = { ...EMPTY_METRICS };
    this.resultRoutes = [];
    this.resultMetroLines = [];
    resetMapResults();
    clearIntegratedResults();
    clearOriginLayer();
    if (this.activeView === "combined") focusIntegratedNodes(this.activeDistrictStops, 13);
    else focusNodeCollection(this.activeDistrictStops, 13);
  },
  selectMetroLine(lineId) {
    this.stopMode = "metro";
    this.activeMetroLine = lineId;
    this.selectedStartId = null;
    this.stopQuery = "";
    this.stopSuggestions = [];
    this.metrics = { ...EMPTY_METRICS };
    this.resultRoutes = [];
    this.resultMetroLines = [];
    resetMapResults();
    clearIntegratedResults();
    clearOriginLayer();
    if (this.activeView === "combined") focusIntegratedNodes(this.activeMetroStops, 13);
    else focusNodeCollection(this.activeMetroStops, 13);
  },
  selectStopMode(mode) {
    this.stopMode = mode;
    this.selectedStartId = null;
    this.stopQuery = "";
    this.stopSuggestions = [];
    this.metrics = { ...EMPTY_METRICS };
    this.resultRoutes = [];
    this.resultMetroLines = [];
    resetMapResults();
    clearIntegratedResults();
    clearOriginLayer();
    const stops = mode === "metro" ? this.activeMetroStops : this.activeDistrictStops;
    if (this.activeView === "combined") focusIntegratedNodes(stops, 13);
    else focusNodeCollection(stops, 13);
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
    this.resultRoutes = listReachableBusRoutes(result.busRouteIds);
    this.resultMetroLines = listReachableMetroLines(result.metroLineIds);
    if (this.activeView === "combined") animateIntegratedResult(result);
    else animateResult(result);
  },
  focusBusRoute(routeId) {
    this.clearMetroLine();
    this.selectedRouteId = routeId;
    this.selectedRouteInfo = drawSelectedBusRoute(routeId);
  },
  clearBusRoute() {
    this.selectedRouteId = null;
    this.selectedRouteInfo = null;
    clearSelectedBusRouteLayer();
  },
  focusMetroLine(lineId) {
    this.clearBusRoute();
    this.selectedMetroLineId = lineId;
    this.selectedMetroLineInfo = drawSelectedMetroLine(lineId);
  },
  clearMetroLine() {
    this.selectedMetroLineId = null;
    this.selectedMetroLineInfo = null;
    clearSelectedMetroLineLayer();
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
setLeafletController(appState);
setMapController(appState);

/* [本次改版：原本 go()／mounted()／hashchange 監聽各自寫一套「依畫面初始化地圖」的邏輯，
   容易兩邊順序兜不起來；統一成這一個函式，由 router 的 afterEach 呼叫，
   不管是點選單、瀏覽器上一頁/下一頁、還是直接輸入網址都會走同一條路徑。] */
export async function ensureViewReady(view) {
  await nextTick();
  if (view === "transit") {
    initLeaflet();
    leafletMap && leafletMap.invalidateSize();
    await appState.loadTransit();
  } else if (view === "combined") {
    initPopulation3dMap();
    await appState.loadTransit();
    ensureIntegratedTransitLayers();
    setIntegratedTransitVisibility(true);
  } else if (view === "map3d") {
    initPopulation3dMap();
    setIntegratedTransitVisibility(false);
  } else {
    setIntegratedTransitVisibility(false);
  }
}
