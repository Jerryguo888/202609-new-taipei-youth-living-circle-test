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
/* [2026-09-12 新增：模型會輸出圖表 HTML，一律先經過 chartHtml.js 消毒。] */
import { splitChartBlocks } from "../lib/chartHtml.js";
import { typewrite } from "../lib/typewriter.js";
import { estimateChildcareGapRows } from "../lib/resourceGaps.js";
import { estimateTransitGapRows } from "../lib/transitGap.js";
import { loadYouthSuicideShareRows } from "../lib/mortalityStats.js";

const EMPTY_METRICS = { stops: "—", routes: "—", distance: "—", wait: "—" };

/* [2026-09-12 新增：串流回覆會反覆更新同一則訊息，捲動邏輯抽出來共用。] */
function scrollChatToBottom(messagesEl) {
  if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* 打字動畫會持續好幾秒，這段期間無條件捲到底會跟「使用者往上滾看前文」打架。
   只有本來就貼在底部附近時才跟著捲。 */
const STICKY_SCROLL_SLACK_PX = 120;
function scrollChatToBottomIfNear(messagesEl) {
  if (!messagesEl) return;
  const distanceFromBottom =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  if (distanceFromBottom <= STICKY_SCROLL_SLACK_PX) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

/* 同一時間只會有一則訊息在打字。留在模組層是因為它不該進 reactive()：
   控制器是命令式的，放進 reactive 會被 Proxy 包起來，比較身分時容易出錯。 */
let activeTypewriter = null;

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
      /* [本次新增：點開卡片會跳出跟死因統計一樣的 modal，footer 用這行公式說明] */
      formula: "稀缺率＝機構缺口（公立＋私立）÷ 應有機構總數 × 100",
      rows: [],
      /* [2026-09-13 新增：資料時點與更新頻率。先宣告 key，reactive() 才追蹤得到
         後續的賦值 —— Proxy 只攔既有屬性的寫入。] */
      freshness: null,
    },
    /* [本次新增：交通稀缺率＝(需求標準化分數－供給標準化分數)／需求標準化分數×100，
       需求＝20~29歲青年人口、供給＝30分鐘平均可達站數，見 loadTransitGapData /
       lib/transitGap.js，rows 在資料載入完成前先留空。] */
    transit: {
      label: "交通",
      unit: "%",
      metricLabel: "稀缺率",
      copy: "各行政區交通稀缺率（需求標準化分數與供給標準化分數的落差；需求為20~29歲人口，供給為30分鐘平均可達站數）",
      formula: "稀缺率＝(需求標準化分數－供給標準化分數) ÷ 需求標準化分數 × 100",
      rows: [],
      /* 交通稀缺率的來源是靜態路網 CSV，沒有排程更新，所以固定是 null。 */
      freshness: null,
    },
  },
  transitLoaded: false,
  transitLoading: false,
  transitStatus: "官方資料待載入",
  /* [本次新增：托育缺口改成非同步從 CSV 估算，需要自己的載入狀態旗標] */
  childcareGapLoaded: false,
  childcareGapLoading: false,
  childcareGapStatus: "托育缺口資料待載入",
  /* [本次新增：交通稀缺率也是非同步估算（需要先載入公車／捷運路網並跑可達性抽樣），
     用同一套載入狀態旗標的命名慣例] */
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
  reachabilityActive: false,
  metrics: { ...EMPTY_METRICS },
  /* [Jerry 2026-09-13 改版：公車站與捷運站圖層分開管理，預設都開啟。] */
  showBusStops: true,
  showMetroStops: true,
  /* [本次新增：3D 人口柱圖例（年齡層／可及性）選取狀態，取代原本的年份滑桿；
     ageGroups/colors 是固定常數，直接從地圖模組帶過來給左側面板畫勾選框] */
  legendAgeGroups: AGE_GROUPS,
  legendColors: AGE_GROUP_COLORS,
  selectedAgeGroups: [...AGE_GROUPS],
  chatOpen: false,
  chatInput: "",
  /* [Jerry 改版：保留 AI 請求中的狀態，日後接 AWS API 時可直接驅動聊天室載入動畫。] */
  chatLoading: false,
  /* [2026-09-12 新增：AI 自己選資料時的即時狀態，例如「查詢數值：youth_population」。
     tool use 會讓第一個字延遲拉長，這行字讓使用者知道它在做什麼而不是卡住。] */
  chatActivity: "",
  chatChips: ["哪裡最適合設點？", "30 分鐘怎麼算？", "幫我看預算方案"],
  chatMessages: [
    /* [Jerry 2026-09-13 更新：聊天室首次歡迎訊息。] */
    { role: "assistant", text: "您好，我是生活圈 AI 助理!\n可以協助了解有關於青年的現階段與未來資訊，例如: 交通可及性、未來青年熱區、潛在問題探討。\n歡迎提出您的疑問!" },
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
        freshness: category.freshness,
        copy: category.copy,
        formula: category.formula,
        rows: sorted.slice(0, 5).map(mapRow),
        allRows: sorted.map(mapRow),
      };
    }, this);
  },
  /* [本次新增：每一類資源缺口各自非同步載入，卡片要顯示各自的載入中／失敗訊息，
     用這個小 map 讓 ResourcesView.vue 不用針對每個 key 各寫一次 if/else] */
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
  /* [Jerry 2026-09-13 新增：只清空 30 分鐘分析產生的路線與可達節點，
     保留目前選定的出發站，並恢復人口柱及基礎公車／捷運圖層。] */
  clearReachability() {
    this.reachabilityActive = false;
    this.animationClock = "00:00";
    this.metrics = { ...EMPTY_METRICS };
    clearIntegratedResults(false);
  },
  /* [Jerry 2026-09-13 改版：兩個勾選框可獨立控制公車與捷運基礎圖層。] */
  toggleTransitLayer(mode, visible) {
    if (mode === "bus") this.showBusStops = visible;
    if (mode === "metro") this.showMetroStops = visible;
    setIntegratedTransitVisibility(this.showBusStops, this.showMetroStops);
  },
  /* [本次新增：圖例勾選框呼叫這個方法，取代原本切換年份重繪] */
  toggleAgeGroup(age, visible) {
    const index = this.selectedAgeGroups.indexOf(age);
    if (!visible) {
      /* [Jerry 2026-09-13 修正：允許取消最後一個項目，才能真正清空所有人口柱。] */
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
      const result = await estimateChildcareGapRows();
      this.resourceGaps.childcare.rows = result.rows;
      /* 資料時點與更新頻率一起帶進來，卡片才能標出「每月更新，資料時間 X」。 */
      this.resourceGaps.childcare.freshness = result.freshness;
      this.childcareGapLoaded = true;
      this.childcareGapStatus = "";
    } catch (error) {
      console.error(error);
      this.childcareGapStatus = "資料載入失敗。" + dataLoadHint();
    } finally {
      this.childcareGapLoading = false;
    }
  },
  /* [本次新增：交通稀缺率也非同步估算；會連帶觸發公車／捷運路網載入與
     30 分鐘可達性抽樣（跟整合地圖共用同一份模組級快取，不會重算兩次），
     首次進資源缺口頁可能要等一下，所以一樣有自己的載入狀態文字。] */
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
    this.reachabilityActive = false;
    this.metrics = { ...EMPTY_METRICS };
    clearIntegratedResults(false);
    drawIntegratedOrigin(node, moveMap);
  },
  selectDistrict(district) {
    this.stopMode = "bus";
    this.activeDistrict = district;
    this.selectedStartId = null;
    this.reachabilityActive = false;
    this.metrics = { ...EMPTY_METRICS };
    clearIntegratedResults();
    focusIntegratedNodes(this.activeDistrictStops, 13);
  },
  selectMetroLine(lineId) {
    this.stopMode = "metro";
    this.activeMetroLine = lineId;
    this.selectedStartId = null;
    this.reachabilityActive = false;
    this.metrics = { ...EMPTY_METRICS };
    clearIntegratedResults();
    focusIntegratedNodes(this.activeMetroStops, 13);
  },
  selectStopMode(mode) {
    this.stopMode = mode;
    this.selectedStartId = null;
    this.reachabilityActive = false;
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
    this.reachabilityActive = true;
    animateIntegratedResult(result);
  },
  localChatReply(text) {
    return localChatReply(text);
  },
  async getChatReply(text, options) {
    return getChatReplyService(
      text,
      {
        activeView: this.activeView,
        minuteLimit: this.minuteLimit,
      },
      options,
    );
  },
  async sendChat(messagesEl) {
    const text = this.chatInput.trim();
    if (!text || this.chatLoading) return;

    /* [2026-09-12 改版：接上 Bedrock 之後要送完整對話脈絡，模型才能接續前文。
       先複製一份「還不含這次輸入」的歷史，這次的輸入由 chatService 自己補在最後。] */
    const history = this.chatMessages.map(function (message) {
      return { role: message.role, text: message.text };
    });

    this.chatMessages.push({ role: "user", text: text });
    this.chatInput = "";
    this.chatLoading = true;
    this.chatActivity = "";
    await nextTick();
    scrollChatToBottom(messagesEl);

    /* [Jerry 改版保留：最短載入時間避免氣泡一閃而過。] */
    const loadingStartedAt = Date.now();
    const minimumLoadingTime = 560;
    const store = this;

    /* 模型每選一份資料就更新狀態字串。這段期間還沒有任何文字，
       所以維持 chatLoading，只是把「思考中」換成它正在讀什麼。 */
    function handleTool(tool) {
      store.chatActivity = tool && tool.summary ? tool.summary : "查詢資料";
      nextTick(function () { scrollChatToBottom(messagesEl); });
    }

    let reply;
    try {
      reply = await this.getChatReply(text, {
        history: history,
        onTool: handleTool,
      });
    } catch (error) {
      /* 雲端不通時仍然給得出東西：附上原因，再退回本機情境回覆。 */
      reply = {
        text: localChatReply(text),
        sources: [],
        notice: error && error.message ? error.message : "聊天服務暫時無法使用",
      };
    }

    this.chatActivity = "";

    /* 氣泡一閃而過會看不清楚，補足最短載入時間。逐字串流的年代不需要這個
       （第一個 token 一到就有東西看），改成收完才顯示之後又用得上了。 */
    const loadingTimeLeft = minimumLoadingTime - (Date.now() - loadingStartedAt);
    if (loadingTimeLeft > 0) {
      await new Promise(function (resolve) { setTimeout(resolve, loadingTimeLeft); });
    }
    this.chatLoading = false;

    let body = reply.text || "";
    if (reply.notice) body += "\n\n（" + reply.notice + "，以上為本機情境回覆）";
    if (reply.partialError) body += "\n\n（回覆中斷：" + reply.partialError + "）";

    const done = splitChartBlocks(body);
    /* 只有圖表沒有文字是合法的；真的兩者都空才退回顯示原文，
       免得回覆整段消失。 */
    const finalText = done.text || (done.charts.length ? "" : body);

    /* charts 先留空、typing 標記為 true：圖表等打字打完才淡入，
       否則圖表先出現、文字還在打，閱讀順序會反過來。 */
    this.chatMessages.push({
      role: "assistant",
      text: "",
      fullText: finalText,
      charts: [],
      pendingCharts: done.charts,
      sources: reply.sources || [],
      tools: reply.tools || [],
      typing: true,
    });
    /* 一定要用陣列取回的那一份來跑動畫，不能沿用剛才 push 進去的字面物件。
       reactive() 是 Proxy：push 存進去的是原始物件，透過原始參照改屬性不會經過
       set trap，Vue 收不到通知。症狀是「回覆其實已經到了，但要點一下畫面才顯示」
       —— 因為任何其他互動引發的重繪，才會重新讀到新值。 */
    const message = this.chatMessages[this.chatMessages.length - 1];

    await nextTick();
    scrollChatToBottom(messagesEl);

    this._runTypewriter(message, messagesEl);
  },

  /* 打字機動畫。抽成 method 是為了讓「點一下跳過」可以拿到同一個控制器。 */
  _runTypewriter(message, messagesEl) {
    if (activeTypewriter) activeTypewriter.cancel();

    activeTypewriter = typewrite(message.fullText, {
      onReveal: function (partial) {
        message.text = partial;
        /* 動畫期間持續往下捲，但使用者自己往上滾看前文時就不要搶捲軸。 */
        nextTick(function () { scrollChatToBottomIfNear(messagesEl); });
      },
      onDone: function () {
        message.typing = false;
        message.charts = message.pendingCharts || [];
        message.pendingCharts = [];
        activeTypewriter = null;
        nextTick(function () { scrollChatToBottomIfNear(messagesEl); });
      },
    });
  },

  /* 使用者點了正在打字的訊息：立刻顯示全文。 */
  revealMessageNow(message) {
    if (!message || !message.typing) return;
    if (activeTypewriter) {
      activeTypewriter.finish();
      return;
    }
    /* 控制器已經不見了（例如熱重載）也要能收尾，不然訊息會永遠停在半截。 */
    message.text = message.fullText || message.text;
    message.typing = false;
    message.charts = message.pendingCharts || [];
    message.pendingCharts = [];
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
    setIntegratedTransitVisibility(appState.showBusStops, appState.showMetroStops);
  } else if (view === "resources") {
    await Promise.all([
      appState.loadResourceGapData(),
      appState.loadTransitGapData(),
      appState.loadMortalityData(),
    ]);
  }
}
