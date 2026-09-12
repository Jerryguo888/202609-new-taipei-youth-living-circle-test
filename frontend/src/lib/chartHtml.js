/* ===== AI 圖表：把模型輸出的 HTML 消毒後才敢渲染 =====

   為什麼需要這一層：模型的輸出是「不可信輸入」。它不只可能自己寫出奇怪的
   標記，更重要的是它讀得到 S3 知識庫的內容 —— 只要有人把一份帶提示注入的
   文件放進知識庫，就能讓模型吐出 <img onerror="..."> 這類東西。如果直接
   v-html，那就是一個現成的 XSS，而且觸發者是我們自己的後端。

   因此這裡採兩道防線：
     1. 白名單：標籤、class、style 都只留規定內的，其餘一律丟掉。
     2. DOMPurify：不自己手刻 HTML parser，避免各種畸形標記的繞過手法。

   對話本文（散文）完全不走這條路，仍然用 Vue 的 {{ }} 純文字輸出，
   只有圍籬區塊裡的圖表會被當成 HTML。

   [重要] 下面的白名單必須跟 backend/app.py 的 CHART_INSTRUCTIONS 一致。
   改一邊沒改另一邊，圖表就會被清掉一部分。 */

import DOMPurify from "dompurify";

/* 模型被要求把圖表放在 ```chart 圍籬區塊裡。 */
const CHART_FENCE = /```chart\s*\n([\s\S]*?)```/g;
/* 串流過程中會先看到「開頭但還沒收尾」的區塊，用這個偵測。 */
const UNCLOSED_FENCE = /```chart\s*\n?([\s\S]*)$/;

const ALLOWED_TAGS = [
  "div", "span", "h4", "p", "strong", "em", "br",
  "ul", "ol", "li",
  "table", "caption", "thead", "tbody", "tr", "th", "td",
];

const ALLOWED_CLASSES = new Set([
  "ai-chart",
  "ai-chart-title",
  "ai-chart-row",
  "ai-chart-label",
  "ai-chart-track",
  "ai-chart-bar",
  "ai-chart-bar-alt",
  "ai-chart-value",
  "ai-chart-note",
  "ai-table",
]);

/* 只接受 0~100 的寬度百分比，允許小數。其他任何 CSS 都不留。
   這是刻意收得很緊：只要放行任意 style，就會多出 url() 外連、
   position 覆蓋畫面等一堆問題。 */
const WIDTH_ONLY = /^\s*width\s*:\s*(\d{1,3}(?:\.\d+)?)\s*%\s*;?\s*$/i;

let hookInstalled = false;

/* DOMPurify 的 hook 會走過每一個節點，比自己遍歷 DOM 保險：
   它是在消毒流程內部執行，不會漏掉巢狀或被改寫過的節點。 */
function installHook() {
  if (hookInstalled) return;
  DOMPurify.addHook("afterSanitizeAttributes", function (node) {
    if (node.hasAttribute && node.hasAttribute("class")) {
      const kept = String(node.getAttribute("class"))
        .split(/\s+/)
        .filter(function (name) { return ALLOWED_CLASSES.has(name); });
      if (kept.length) node.setAttribute("class", kept.join(" "));
      else node.removeAttribute("class");
    }

    if (node.hasAttribute && node.hasAttribute("style")) {
      const match = WIDTH_ONLY.exec(node.getAttribute("style"));
      const value = match ? Number(match[1]) : NaN;
      if (Number.isFinite(value) && value >= 0 && value <= 100) {
        node.setAttribute("style", "width: " + value + "%");
      } else {
        node.removeAttribute("style");
      }
    }

    /* scope 只在表格有意義，而且只有這兩個值是合法的。 */
    if (node.hasAttribute && node.hasAttribute("scope")) {
      const scope = String(node.getAttribute("scope")).toLowerCase();
      if (scope !== "row" && scope !== "col") node.removeAttribute("scope");
    }
  });
  hookInstalled = true;
}

export function sanitizeChartHtml(rawHtml) {
  if (!rawHtml || !rawHtml.trim()) return "";
  installHook();

  const clean = DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: ALLOWED_TAGS,
    ALLOWED_ATTR: ["class", "style", "scope"],
    /* 這些預設就不在白名單裡，明確寫出來是為了讓意圖清楚，
       也避免以後有人放寬 ALLOWED_TAGS 時不小心把它們帶進來。 */
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "link", "img", "svg", "math", "form", "a"],
    FORBID_ATTR: ["srcset", "src", "href", "xlink:href", "formaction", "background"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    /* 不允許 <template>、<slot> 這類會被瀏覽器特殊處理的容器。 */
    SANITIZE_DOM: true,
    KEEP_CONTENT: true,
    RETURN_TRUSTED_TYPE: false,
  });

  /* 消毒後如果什麼都不剩，就當作沒有圖表，避免渲染一個空框。
     長條圖的數值是靠 style 寬度呈現、內容可能沒有文字，
     所以「有結構標籤但沒有文字」也算有效。 */
  const textContent = clean.replace(/<[^>]*>/g, "").trim();
  if (!textContent && !hasStructuralTag(clean)) return "";
  return clean;
}

function hasStructuralTag(html) {
  return /<(div|table|tr|span)[\s>]/i.test(html);
}

/**
 * 把回覆拆成「散文」與「圖表」兩部分。
 *
 * @param {string} raw 模型回覆原文
 * @param {boolean} streaming 是否還在串流中
 * @returns {{ text: string, charts: string[] }}
 */
export function splitChartBlocks(raw, streaming) {
  if (!raw) return { text: "", charts: [] };

  const charts = [];
  let text = raw.replace(CHART_FENCE, function (_match, inner) {
    const clean = sanitizeChartHtml(inner);
    if (clean) charts.push(clean);
    return "";
  });

  /* 串流中途會出現還沒收尾的圍籬。直接顯示會是一堆生 HTML 標記，
     所以先切掉並給一個提示，等收尾後再正式渲染成圖表。 */
  if (UNCLOSED_FENCE.test(text)) {
    text = text.replace(UNCLOSED_FENCE, streaming ? "\n（正在繪製圖表…）" : "");
  }

  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), charts: charts };
}
