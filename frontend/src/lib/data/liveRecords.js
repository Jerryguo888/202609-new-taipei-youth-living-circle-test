/* 讀「會跟著排程更新」的那一份資料。

   兩種來源，前者優先：

     /live/<表名>.json   掛載的 volume，排程更新完立刻生效（見 compose.yml 的
                         living-circle-data 與 docker/nginx/default.conf 的
                         location /live/）
     靜態 CSV            build 時烘進 image，只有重新部署才會變

   為什麼一定要有 fallback：全新部署時 volume 是空的，第一次排程跑完之前
   /live/ 會回 404。少了退路，圖表在那段時間會整片空白 —— 而那正是最多人
   第一次打開網站的時候。

   為什麼不打 /api/records：面板要算全域統計（YouBike 1606 站、托育 391 筆），
   而 records 的 MAX_LIMIT 是 50，分頁拿會變成幾十次請求。這裡要的就是整份檔案。 */

const LIVE_PREFIX = "/live/";

/* 來源時戳是 20260913T014500 這種格式，轉成看得懂的。
   不是這個格式就原樣回傳（可能是 ISO 字串或空字串）。 */
export function formatSourceStamp(value) {
  const text = String(value || "");
  const match = text.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!match) return text;
  return `${match[1]}/${match[2]}/${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
}

/* generated_at 是我們抓取的時間（ISO），轉成本地時間字串。 */
export function formatFetchedAt(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = function (n) { return String(n).padStart(2, "0"); };
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 嘗試讀 /live/<table>.json。
 *
 * @param {string} table 表名，例如 "youbike_stations"
 * @returns {Promise<object|null>} payload，或 null（沒有 live 資料可用）
 */
export async function loadLiveRecords(table) {
  const url = new URL(LIVE_PREFIX + table + ".json", document.baseURI).href;
  let response;
  try {
    /* 不走 browserCache 的 Cache Storage：那一層是為了「離站 30 分鐘才清」的
       靜態地圖資料設計的，而這份資料每小時就會變。改由 nginx 的
       Cache-Control: max-age=60 控制，讓瀏覽器自己判斷。 */
    response = await fetch(url);
  } catch (error) {
    /* 網路層失敗（離線、DNS）也走 fallback，不要讓圖表整片空白 */
    return null;
  }
  /* 404 = 還沒跑過任何排程更新，volume 是空的。這是預期狀態不是錯誤。 */
  if (!response.ok) return null;

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    return null;
  }
  if (!payload || !Array.isArray(payload.rows) || !payload.rows.length) return null;
  return payload;
}

/**
 * 把 payload 的頻率資訊整理成畫面可以直接顯示的物件。
 *
 * @param {object|null} payload loadLiveRecords 的回傳
 * @param {string} fallbackLabel 沒有 live 資料時要顯示的說明
 */
export function describeFreshness(payload, fallbackLabel) {
  if (!payload) {
    return {
      isLive: false,
      refreshLabel: fallbackLabel || "隨版本更新",
      fetchedAt: "",
      sourceStamp: "",
      rowCount: 0,
    };
  }
  /* 站點各自的來源時戳可能不同，取第一個有值的當代表 */
  const stamped = payload.rows.find(function (row) { return row && row.updated; });
  return {
    isLive: true,
    refreshLabel: payload.refresh_label || "",
    fetchedAt: formatFetchedAt(payload.generated_at),
    sourceStamp: stamped ? formatSourceStamp(stamped.updated) : "",
    rowCount: payload.row_count || payload.rows.length,
  };
}
