/* ===== AI 助理串接：Amazon Bedrock + S3 知識庫 =====

   流向：Vue -> 同源 /api/chat（nginx 反向代理）-> FastAPI（backend/app.py）
         -> bedrock-agent-runtime.retrieve（知識庫，來源是 S3）
         -> bedrock-runtime.converse_stream（Claude）

   憑證只存在後端，靠 EC2 IAM Role 取得。前端不碰任何 AWS key，
   所以這支檔案裡不該出現 access key、secret 或 session token。

   [改版說明] 原本這裡是 CHAT_SERVICE.enabled = false 的預留樣板，只會回傳
   localChatReply 的罐頭回覆。現在改成真的打後端並逐字串流，但保留本機回覆
   當退路：後端沒起來、沒設定知識庫、或 AWS 連不上時，聊天室仍然可用。 */

/* 同源相對路徑，正式與本機都適用，不需要為了不同網域改設定。
   VITE_CHAT_ENDPOINT 只有在前後端分開部署時才需要覆寫。 */
const CHAT_ENDPOINT = import.meta.env.VITE_CHAT_ENDPOINT || "/api/chat";

/* 明確關閉雲端串接時（VITE_CHAT_DISABLED=true）就一律走本機回覆，
   方便在沒有 AWS 環境的機器上做展示。 */
const CHAT_DISABLED = String(import.meta.env.VITE_CHAT_DISABLED || "") === "true";

export const CHAT_SERVICE = Object.freeze({
  enabled: !CHAT_DISABLED,
  endpoint: CHAT_ENDPOINT,
});

/* 後端沒回應時的等待上限。設有上限才不會讓輸入框一直卡在「回覆中」。 */
const REQUEST_TIMEOUT_MS = 30000;

export function localChatReply(text) {
  const query = text.toLowerCase();
  if (query.includes("設點") || query.includes("站位")) {
    return "請進入「30 分鐘交通」，可直接搜尋站名，或從依行政區分組的下拉選單挑選任一站位，再執行可達動畫。";
  }
  if (query.includes("30") || query.includes("分鐘") || query.includes("交通")) {
    return "選擇站位與出發時間後，系統會把候車、站間行駛與轉乘成本放入交通圖，計算時間上限內可達的節點。";
  }
  if (query.includes("預算") || query.includes("成本")) {
    return "到「預算模擬」調整固定據點、巡迴駐點、行動車與人力，畫面會立即更新年度成本與覆蓋率。";
  }
  if (query.includes("托育") || query.includes("學校") || query.includes("停車")) {
    return "「資源缺口」會把未來需求與現有容量相比，分成穩定、觀察與高需求三個層級。";
  }
  return "我可以先幫你把問題拆成青年需求、資源缺口、交通覆蓋與年度成本四個面向。";
}

/* SSE 是以空行分隔的事件串，chunk 邊界不保證切在事件邊界上，
   所以要自己留 buffer，只處理已經完整的事件。 */
function createSseParser(onEvent) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      parts.forEach(function (part) {
        const line = part.split("\n").find(function (item) { return item.startsWith("data:"); });
        if (!line) return;
        try {
          onEvent(JSON.parse(line.slice(5).trim()));
        } catch (error) {
          /* 壞掉的單一事件不該讓整段對話中斷 */
          console.warn("無法解析聊天事件", error);
        }
      });
    },
    flush() {
      if (buffer.trim()) this.push("\n\n");
    },
  };
}

/**
 * 呼叫後端取得回覆。
 *
 * @param {string} text 使用者這次輸入
 * @param {object} context 目前畫面狀態 { activeView, minuteLimit }
 * @param {object} [options]
 * @param {Array}  [options.history] 先前的對話 [{ role, text }]
 * @param {Function} [options.onDelta] 有值時逐字回呼，用來做打字機效果
 * @param {Function} [options.onTool] 模型開始讀某份資料時回呼，用來顯示「正在查詢…」
 * @returns {Promise<{ text: string, sources: Array, tools: Array, fallback: boolean }>}
 */
export async function getChatReply(text, context, options) {
  const settings = options || {};

  if (!CHAT_SERVICE.enabled || !CHAT_SERVICE.endpoint) {
    return { text: localChatReply(text), sources: [], tools: [], fallback: true };
  }

  /* 把前端的訊息格式轉成後端要的 {role, content}，並補上這次的輸入。 */
  const messages = (settings.history || [])
    .filter(function (item) { return item && item.text; })
    .map(function (item) {
      return { role: item.role === "user" ? "user" : "assistant", content: item.text };
    });
  messages.push({ role: "user", content: text });

  const abortController = new AbortController();
  const timeoutId = setTimeout(function () { abortController.abort(); }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(CHAT_SERVICE.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: messages, use_kb: true, context: context }),
      signal: abortController.signal,
    });

    /* 429（被 nginx 限流）跟 502（後端沒起來）都在這裡變成明確訊息，
       而不是讓使用者看到空白回覆。 */
    if (response.status === 429) {
      throw new Error("提問太頻繁，請稍等一下再試。");
    }
    if (!response.ok || !response.body) {
      throw new Error("聊天服務暫時無法使用（HTTP " + response.status + "）");
    }

    let full = "";
    let sources = [];
    let toolsUsed = [];
    let streamError = "";

    const parser = createSseParser(function (event) {
      if (event.text) {
        full += event.text;
        if (settings.onDelta) settings.onDelta(event.text, full);
      } else if (event.tool) {
        /* 模型自己決定要讀哪份資料時後端會送這個事件，
           拿來即時更新「正在查詢…」的狀態。 */
        if (settings.onTool) settings.onTool(event.tool);
      } else if (event.tools_used) {
        toolsUsed = event.tools_used;
      } else if (event.sources) {
        sources = event.sources;
      } else if (event.error) {
        streamError = event.error;
      }
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      parser.push(decoder.decode(step.value, { stream: true }));
    }
    parser.flush();

    /* 後端把 Bedrock 的錯誤當事件送回來。完全沒有文字才算失敗，
       已經串出一部分的話就保留那段內容，只是附註錯誤。 */
    if (!full && streamError) throw new Error(streamError);

    return {
      text: full || localChatReply(text),
      sources: sources,
      tools: toolsUsed,
      fallback: !full,
      partialError: full && streamError ? streamError : "",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
