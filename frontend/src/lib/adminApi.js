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
      payload = { error: text.slice(0, 300) };
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
