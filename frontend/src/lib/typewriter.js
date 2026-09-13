/* 打字機動畫。

   為什麼不用 setInterval 每次加一個字：那樣的速度會被分頁節流、背景頁面回來後
   會爆衝補進度，而且逐字累加的誤差會隨長度累積。這裡改成 requestAnimationFrame
   依「經過的時間」換算應該露出幾個字，掉幀只會讓步伐變粗，不會走音。

   兩個容易錯的地方：

   **切字元不能用 text[i]**：中文在 UTF-16 裡是一個 code unit 沒問題，但 emoji
   （尤其帶膚色或 ZWJ 的組合）會被切成半個，畫面上出現破字。所以一律先用
   Intl.Segmenter（或 Array.from 當備援）切成字元陣列再逐個露出。

   **不要停在 Markdown 標記中間**：回覆是 Markdown，露到一半的 `**粗體` 會被
   算成普通文字，畫面上就閃出兩顆星號。所以游標落在未閉合的行內標記裡時，直接
   跳到閉合處，讓標記成對出現。 */

/* 一秒露出幾個字元。中文閱讀速度大約每秒 5~9 字，這個值刻意快得多：
   目的是「看得出在打字」而不是逼使用者跟著唸。 */
const CHARS_PER_SECOND = 55;

/* 動畫總長上限。長回覆若照固定速度會打上一分鐘，沒有人會等。
   超過就自動加速，寧可打快一點也不要讓人盯著看。 */
const MAX_DURATION_MS = 4500;

/* 行內標記：游標不能停在成對標記的中間。長的要排在前面，
   否則 `*` 會先命中 `**` 的第一顆星。 */
const INLINE_MARKERS = ["**", "__", "`", "*", "_"];

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/* 把字串切成「使用者看到的字元」。Intl.Segmenter 會正確處理 emoji 組合，
   沒有的話退回 Array.from（至少不會切壞 surrogate pair）。 */
export function toGraphemes(text) {
  const value = String(text || "");
  if (!value) return [];
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    try {
      const segmenter = new Intl.Segmenter("zh-Hant", { granularity: "grapheme" });
      const out = [];
      for (const part of segmenter.segment(value)) out.push(part.segment);
      return out;
    } catch (error) {
      /* 某些環境的 Segmenter 存在但建構會丟錯，退回下面的做法 */
    }
  }
  return Array.from(value);
}

/* 游標停在未閉合的行內標記裡時，往後推到閉合之後。
   推不到（例如標記到結尾都沒閉合）就回原位，寧可有點瑕疵也不要卡住不動。 */
export function snapToSafeBoundary(text, index) {
  if (index <= 0 || index >= text.length) return index;

  for (let i = 0; i < INLINE_MARKERS.length; i += 1) {
    const marker = INLINE_MARKERS[i];
    /* 數這個標記在已露出的部分出現幾次。奇數代表還開著。 */
    let count = 0;
    let at = text.indexOf(marker);
    while (at !== -1 && at + marker.length <= index) {
      count += 1;
      at = text.indexOf(marker, at + marker.length);
    }
    if (count % 2 === 0) continue;

    const closing = text.indexOf(marker, index);
    if (closing === -1) continue;
    return closing + marker.length;
  }
  return index;
}

/**
 * 對一段文字跑打字機動畫。
 *
 * @param {string} fullText 完整定稿
 * @param {object} options
 * @param {Function} options.onReveal 每次進度更新時收到目前該顯示的文字
 * @param {Function} [options.onDone]  打完（或被跳過）時呼叫一次
 * @param {boolean}  [options.instant] 直接顯示全文，不跑動畫
 * @returns {{ finish: Function, cancel: Function, done: boolean }} 控制器
 */
export function typewrite(fullText, options) {
  const settings = options || {};
  const onReveal = settings.onReveal || function () {};
  const onDone = settings.onDone || function () {};
  const text = String(fullText || "");
  const graphemes = toGraphemes(text);

  const controller = { done: false, finish: finish, cancel: cancel };
  let frameId = 0;

  function settle(finalText) {
    if (controller.done) return;
    controller.done = true;
    if (frameId) {
      cancelAnimationFrame(frameId);
      frameId = 0;
    }
    onReveal(finalText);
    onDone();
  }

  function finish() {
    settle(text);
  }

  /* 取消跟 finish 的差別：取消不會補上全文，給「訊息被移除」這種情況用。 */
  function cancel() {
    if (controller.done) return;
    controller.done = true;
    if (frameId) {
      cancelAnimationFrame(frameId);
      frameId = 0;
    }
  }

  /* 沒有內容、要求直接顯示、使用者關掉動畫效果、或環境沒有 rAF
     （SSR / 測試）時，一律直接給全文。 */
  if (!graphemes.length || settings.instant || prefersReducedMotion() ||
      typeof requestAnimationFrame !== "function") {
    settle(text);
    return controller;
  }

  /* 依長度決定速度：短回覆用固定速度，長回覆壓縮到上限之內。 */
  const naturalDuration = (graphemes.length / CHARS_PER_SECOND) * 1000;
  const duration = Math.min(naturalDuration, MAX_DURATION_MS);
  const startedAt = performance.now();
  let lastCut = 0;

  function step(now) {
    frameId = 0;
    /* 已經收尾就什麼都不做。cancelAnimationFrame 攔不住「已經開始執行」的那一幀，
       少了這道判斷，finish() 之後那一幀會把全文覆蓋回半截。 */
    if (controller.done) return;

    const progress = Math.min(1, (now - startedAt) / duration);
    const target = Math.round(progress * graphemes.length);

    if (target >= graphemes.length) {
      settle(text);
      return;
    }

    /* graphemes 是「看得到的字元」，而 snapToSafeBoundary 是在原字串的索引上
       運作，所以先把 grapheme 數換算回字串長度。 */
    let cut = graphemes.slice(0, target).join("").length;
    cut = snapToSafeBoundary(text, cut);
    /* 只前進不後退：snap 可能把游標往前推，下一幀不該退回去。 */
    if (cut < lastCut) cut = lastCut;
    lastCut = cut;

    onReveal(text.slice(0, cut));
    frameId = requestAnimationFrame(step);
  }

  onReveal("");
  frameId = requestAnimationFrame(step);
  return controller;
}
