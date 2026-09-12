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
import { estimateChildcareGapRows } from "../lib/resourceGaps.js";
import { estimateTransitGapRows } from "../lib/transitGap.js";
import { loadYouthSuicideShareRows } from "../lib/mortalityStats.js";

const EMPTY_METRICS = { stops: "—", routes: "—", distance: "—", wait: "—" };

/* [2026-09-12 新增：串流回覆會反覆更新同一則訊息，捲動邏輯抽出來共用。] */
function scrollChatToBottom(messagesEl) {
  if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
}

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
  /* [Jerry 改版：保留 AI 請求中的狀態，日後接 AWS API 時可直接驅動聊天室載入動畫。] */
  chatLoading: false,
  /* [2026-09-12 新增：AI 自己選資料時的即時狀態，例如「查詢數值：youth_population」。
     tool use 會讓第一個字延遲拉長，這行字讓使用者知道它在做什麼而不是卡住。] */
  chatActivity: "",
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

    /* [Jerry 改版保留：最短載入時間避免氣泡一閃而過。
       [2026-09-12 改版：真的有串流時就不需要這個保護，第一個 token 一到就
       直接把跳動氣泡換成逐字增長的回覆；只有本機回覆或失敗才補足時間。] */
    const loadingStartedAt = Date.now();
    const minimumLoadingTime = 560;
    const store = this;
    let streamingMessage = null;

    /* 模型每選一份資料就更新狀態字串。這時還沒有任何文字，
       所以維持 chatLoading，只是把氣泡裡的字換掉。 */
    function handleTool(tool) {
      store.chatActivity = tool && tool.summary ? tool.summary : "查詢資料";
      nextTick(function () { scrollChatToBottom(messagesEl); });
    }

    function handleDelta(delta, full) {
      if (!streamingMessage) {
        store.chatLoading = false;
        store.chatActivity = "";
        streamingMessage = { role: "assistant", text: "", sources: [], charts: [], tools: [] };
        store.chatMessages.push(streamingMessage);
      }
      /* 沒有圍籬符號時走快速路徑，不必每個 token 都重跑一次消毒；
         純文字回覆因此完全不碰 DOMPurify。 */
      if (full.indexOf("```") === -1) {
        streamingMessage.text = full;
      } else {
        /* 已收尾的圖表邊串邊畫，還沒收尾的用提示文字代替，
           使用者才不會看到一堆生 HTML 標記。 */
        const partial = splitChartBlocks(full, true);
        streamingMessage.text = partial.text;
        streamingMessage.charts = partial.charts;
      }
      nextTick(function () { scrollChatToBottom(messagesEl); });
    }

    let reply;
    try {
      reply = await this.getChatReply(text, {
        history: history,
        onDelta: handleDelta,
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

    if (streamingMessage) {
      this.chatLoading = false;
      streamingMessage.tools = reply.tools || [];
      const finalText = reply.text || streamingMessage.text;
      /* 收尾後重跑一次（streaming=false），把「正在繪製圖表…」的提示換成真的圖表。 */
      const done = splitChartBlocks(finalText, false);
      streamingMessage.charts = done.charts;
      /* 只有圖表沒有文字是合法的；真的兩者都空才退回顯示原文，
         免得回覆整段消失。 */
      streamingMessage.text = done.text || (done.charts.length ? "" : finalText);
      streamingMessage.sources = reply.sources || [];
      if (reply.partialError) {
        streamingMessage.text += "\n\n（回覆中斷：" + reply.partialError + "）";
      }
    } else {
      const loadingTimeLeft = minimumLoadingTime - (Date.now() - loadingStartedAt);
      if (loadingTimeLeft > 0) {
        await new Promise(function (resolve) { setTimeout(resolve, loadingTimeLeft); });
      }
      this.chatLoading = false;
      let body = reply.text;
      if (reply.notice) body += "\n\n（" + reply.notice + "，以上為本機情境回覆）";
      const done = splitChartBlocks(body, false);
      this.chatMessages.push({
        role: "assistant",
        text: done.text || (done.charts.length ? "" : body),
        charts: done.charts,
        sources: reply.sources || [],
        tools: reply.tools || [],
      });
    }

    await nextTick();
    scrollChatToBottom(messagesEl);
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
    await Promise.all([
      appState.loadResourceGapData(),
      appState.loadTransitGapData(),
      appState.loadMortalityData(),
    ]);
  }
}
