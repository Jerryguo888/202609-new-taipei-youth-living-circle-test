/* [Jerry 2026-09-13 新增：地圖資料瀏覽器快取]
   地圖 CSV 存在 Cache Storage，30 分鐘可達計算結果存在 localStorage。
   使用者離開／切離網站才開始倒數 30 分鐘；逾時後清除兩類快取。
   若頁面已關閉，瀏覽器無法在背景準時執行，下次進站會先檢查並補清除。 */
export const MAP_DATA_CACHE_VERSION = "ntpc-youth-map-data-v1";
export const TRANSIT_REACH_CACHE_VERSION = "ntpc-transit-reach-v1";
export const MAP_CACHE_CLEARED_EVENT = "ntpc-map-cache-cleared";
export const CACHE_LEAVE_TTL_MS = 30 * 60 * 1000;

const LAST_LEFT_AT_KEY = MAP_DATA_CACHE_VERSION + ":left-at";
const LOCAL_CACHE_PREFIXES = [
  MAP_DATA_CACHE_VERSION + ":",
  TRANSIT_REACH_CACHE_VERSION + ":",
];

let lifecyclePromise = null;
let lifecycleBound = false;
let leaveCleanupTimer = null;

function localStorageRef() {
  try {
    return globalThis.localStorage || null;
  } catch (error) {
    return null;
  }
}

function readLastLeftAt() {
  const storage = localStorageRef();
  if (!storage) return 0;
  return Number(storage.getItem(LAST_LEFT_AT_KEY)) || 0;
}

function clearLeaveCleanupTimer() {
  if (leaveCleanupTimer !== null) {
    globalThis.clearTimeout(leaveCleanupTimer);
    leaveCleanupTimer = null;
  }
}

function notifyCacheCleared() {
  if (typeof globalThis.dispatchEvent !== "function" || typeof globalThis.Event !== "function") return;
  globalThis.dispatchEvent(new globalThis.Event(MAP_CACHE_CLEARED_EVENT));
}

/* [Jerry 2026-09-13 新增：只移除本專案建立的地圖／交通快取，不碰其他網站資料。] */
export async function clearPersistedMapCaches() {
  /* 先通知同一分頁停止沿用記憶體裡的 30 分鐘計算，避免刪除期間又寫回舊結果。 */
  notifyCacheCleared();

  try {
    if ("caches" in globalThis) {
      await globalThis.caches.delete(MAP_DATA_CACHE_VERSION);
    }
  } catch (error) {
    /* 隱私模式可能禁用 Cache Storage；localStorage 清理仍繼續。 */
  }

  const storage = localStorageRef();
  if (!storage) return;
  try {
    const keysToRemove = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key && LOCAL_CACHE_PREFIXES.some(function (prefix) { return key.startsWith(prefix); })) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach(function (key) { storage.removeItem(key); });
  } catch (error) {
    /* 瀏覽器封鎖儲存空間時不阻斷網站載入。 */
  }
}

function scheduleCleanupFrom(leftAt) {
  clearLeaveCleanupTimer();
  const remaining = Math.max(0, CACHE_LEAVE_TTL_MS - (Date.now() - leftAt));
  leaveCleanupTimer = globalThis.setTimeout(function () {
    leaveCleanupTimer = null;
    /* 其他同站分頁仍在使用時會移除離站標記；此時不應誤刪共用快取。 */
    if (readLastLeftAt() !== leftAt) return;
    void clearPersistedMapCaches();
  }, remaining);
}

function markWebsiteLeft() {
  const storage = localStorageRef();
  if (!storage) return;
  try {
    /* visibilitychange 後通常還會接 pagehide；保留第一次離開時間，不重設倒數。 */
    const leftAt = readLastLeftAt() || Date.now();
    storage.setItem(LAST_LEFT_AT_KEY, String(leftAt));
    scheduleCleanupFrom(leftAt);
  } catch (error) {
    /* 無法寫入時間戳時只能由瀏覽器自行管理儲存空間。 */
  }
}

async function markWebsiteActive() {
  clearLeaveCleanupTimer();
  const storage = localStorageRef();
  if (!storage) return;
  const leftAt = readLastLeftAt();
  if (leftAt && Date.now() - leftAt >= CACHE_LEAVE_TTL_MS) {
    await clearPersistedMapCaches();
  }
  try {
    storage.removeItem(LAST_LEFT_AT_KEY);
  } catch (error) {
    /* 已回到網站即可，移除時間戳失敗不影響功能。 */
  }
}

function bindCacheLifecycle() {
  if (lifecycleBound || typeof document === "undefined") return;
  lifecycleBound = true;

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      markWebsiteLeft();
    } else {
      lifecyclePromise = markWebsiteActive();
    }
  });

  if (typeof globalThis.addEventListener === "function") {
    globalThis.addEventListener("pagehide", markWebsiteLeft);
    globalThis.addEventListener("pageshow", function () {
      if (document.visibilityState !== "hidden") lifecyclePromise = markWebsiteActive();
    });
    /* [Jerry 2026-09-13 新增：同一網站開多個分頁時，只要還有可見分頁就不啟動清除。] */
    globalThis.addEventListener("storage", function (event) {
      if (event.key === LAST_LEFT_AT_KEY && event.newValue && document.visibilityState !== "hidden") {
        const storage = localStorageRef();
        if (storage) storage.removeItem(LAST_LEFT_AT_KEY);
      }
      if (event.key?.startsWith(TRANSIT_REACH_CACHE_VERSION + ":") && event.newValue === null) {
        notifyCacheCleared();
      }
    });
  }
}

/* CSV 與 30 分鐘計算都先等待同一個生命週期檢查，避免剛回站時讀到已過期資料。 */
export function ensureMapCacheLifecycle() {
  if (!lifecyclePromise) {
    bindCacheLifecycle();
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      markWebsiteLeft();
      lifecyclePromise = Promise.resolve();
    } else {
      lifecyclePromise = markWebsiteActive();
    }
  }
  return lifecyclePromise;
}

async function fetchAndStore(cache, url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) return response;
  try {
    await cache.put(url, response.clone());
  } catch (error) {
    /* 儲存空間不足或隱私模式禁用快取時，仍回傳已下載成功的資料。 */
  }
  return response;
}

export async function fetchWithBrowserCache(url, options) {
  const settings = options || {};
  await ensureMapCacheLifecycle();

  if (!("caches" in globalThis)) {
    /* 無 Cache Storage 時不要改用無法由本站精準清除的 HTTP 快取。 */
    return fetch(url, { cache: "no-store" });
  }

  let cache;
  try {
    cache = await globalThis.caches.open(MAP_DATA_CACHE_VERSION);
    if (settings.forceNetwork) return fetchAndStore(cache, url);
    const cached = await cache.match(url);
    if (cached) return cached;
  } catch (error) {
    return fetch(url, { cache: "no-store" });
  }

  return fetchAndStore(cache, url);
}

/* 首頁尚未載入地圖時也先完成逾期檢查。 */
void ensureMapCacheLifecycle();
