/* 後台 API 客戶端。

   驗證是伺服器端的 HttpOnly cookie，所以這裡沒有、也不該有任何 token 保存邏輯 ——
   cookie 讀不到正是重點，XSS 就偷不走它。前端只需要記住 CSRF token，
   那個值本身不足以登入。

   注意：權限一律由後端判斷。這裡的 role 只用來決定要不要顯示按鈕，
   不是安全邊界；後端每個路由都會再驗一次。 */

const BASE = "/api/admin";

/* 登入後由後端給的 CSRF token，改狀態的請求都要帶。 */
let csrfToken = "";

export function setCsrfToken(token) {
  csrfToken = token || "";
}

async function request(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };

  if (method !== "GET" && method !== "HEAD") {
    headers["X-CSRF-Token"] = csrfToken;
  }
  /* FormData 要讓瀏覽器自己帶 multipart boundary，不能手動設 Content-Type */
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(BASE + path, {
    method,
    headers,
    /* same-origin 才會帶上 SameSite=Strict 的 cookie */
    credentials: "same-origin",
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
  });

  let payload = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      /* 非 JSON 幾乎都代表請求沒走到後端，被中間層攔下了。
         不要把 HTML 原文當成錯誤訊息倒到畫面上 —— 那會蓋掉唯一有用的線索
         （狀態碼），使用者只會看到一坨 <!DOCTYPE html>。 */
      payload = { error: describeNonJson(response.status, text) };
    }
  }

  if (!response.ok) {
    const message = (payload && payload.error) || `請求失敗（HTTP ${response.status}）`;
    const failure = new Error(message);
    failure.status = response.status;
    throw failure;
  }
  return payload;
}

/* 後端所有錯誤都回 JSON，所以收到 HTML 一定是 nginx、Cloudflare 或其他
   反向代理／WAF 回的。把狀態碼講清楚並指出該去哪裡查，比貼一段 HTML 有用。 */
function describeNonJson(status, text) {
  const looksLikeHtml = /^\s*<(!doctype|html)/i.test(text);
  const hints = {
    413: "檔案太大，被反向代理擋下（不是後端的 20 MB 上限）。請檢查 nginx 的 client_max_body_size，以及 Cloudflare／負載平衡器的上傳大小限制。",
    502: "後端沒有回應。請確認 chat 容器正在執行。",
    503: "後端暫時無法服務。",
    504: "後端逾時。上傳大檔時可能是中間層的超時設定太短。",
  };
  const hint =
    hints[status] ||
    (looksLikeHtml
      ? "請求被中間層攔截，沒有到達後端。若網域經過 Cloudflare 或其他 WAF，請檢查那一層的規則與上傳限制。"
      : "伺服器回了非預期的內容。");
  return `請求失敗（HTTP ${status}）：${hint}`;
}

export const adminApi = {
  session: () => request("/session"),

  async login(username, password) {
    const result = await request("/login", { method: "POST", json: { username, password } });
    setCsrfToken(result.csrf);
    return result;
  },

  async logout() {
    try {
      await request("/logout", { method: "POST" });
    } finally {
      setCsrfToken("");
    }
  },

  status: () => request("/status"),

  users: () => request("/users"),
  createUser: (username, password, role) =>
    request("/users", { method: "POST", json: { username, password, role } }),
  updateUser: (username, changes) =>
    request(`/users/${encodeURIComponent(username)}`, { method: "PUT", json: changes }),
  deleteUser: (username) =>
    request(`/users/${encodeURIComponent(username)}`, { method: "DELETE" }),

  kbFiles: () => request("/kb/files"),
  uploadKbFile(file) {
    const form = new FormData();
    form.append("file", file);
    return request("/kb/files", { method: "POST", body: form });
  },
  deleteKbFile: (key) =>
    request(`/kb/files?key=${encodeURIComponent(key)}`, { method: "DELETE" }),
  startSync: () => request("/kb/sync", { method: "POST" }),
  syncStatus: (jobId) => request(`/kb/sync/${encodeURIComponent(jobId)}`),

  startRefresh: () => request("/refresh", { method: "POST" }),
  refreshStatus: () => request("/refresh/status"),
};

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-TW", { hour12: false });
}
