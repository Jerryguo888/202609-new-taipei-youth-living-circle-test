<script setup>
/* 後台：知識庫檔案、資料更新、帳號管理。
   路由 #/admin，刻意不放進主選單 —— 一般使用者沒必要看到入口。

   前端只負責介面。是否有權限一律由後端判斷，這裡的 role 判斷只用來決定
   要不要把按鈕畫出來，繞過它也拿不到資料（後端每個路由都會再驗一次）。 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { adminApi, formatBytes, formatTime, setCsrfToken } from "../lib/adminApi.js";
import "../style/admin.css";

const booting = ref(true);
const user = ref(null);
const status = ref(null);
const tab = ref("kb");

const loginForm = ref({ username: "", password: "" });
const loginError = ref("");
const loggingIn = ref(false);

const notice = ref(null); // { kind: 'error'|'success'|'info'|'warning', text }

function flash(kind, text) {
  notice.value = { kind, text };
  if (kind === "success") {
    setTimeout(() => {
      if (notice.value && notice.value.text === text) notice.value = null;
    }, 6000);
  }
}

function reportError(error) {
  /* 401 代表工作階段過期，直接回登入畫面比顯示錯誤更合理 */
  if (error && error.status === 401) {
    user.value = null;
    flash("warning", "工作階段已過期，請重新登入。");
    return;
  }
  flash("error", (error && error.message) || "操作失敗");
}

/* ---------- 登入 ---------- */
async function boot() {
  try {
    const session = await adminApi.session();
    if (session.authenticated) {
      user.value = session.user;
      /* 重新載入頁面時 cookie 還在，但前端記憶體裡的 CSRF token 沒了，
         所以後端會在 /session 一併回傳現有工作階段的 token。 */
      setCsrfToken(session.csrf);
      await loadAll();
    }
  } catch (error) {
    reportError(error);
  } finally {
    booting.value = false;
  }
}

async function doLogin() {
  loginError.value = "";
  if (!loginForm.value.username || !loginForm.value.password) {
    loginError.value = "請輸入帳號與密碼。";
    return;
  }
  loggingIn.value = true;
  try {
    const result = await adminApi.login(loginForm.value.username, loginForm.value.password);
    user.value = result.user;
    loginForm.value.password = "";
    await loadAll();
  } catch (error) {
    loginError.value = error.message || "登入失敗";
  } finally {
    loggingIn.value = false;
  }
}

async function doLogout() {
  await adminApi.logout().catch(() => {});
  user.value = null;
  status.value = null;
  files.value = [];
  users.value = [];
  stopSyncPolling();
  stopRefreshPolling();
}

const isAdmin = computed(() => user.value && user.value.role === "admin");

async function loadAll() {
  await Promise.allSettled([loadStatus(), loadFiles(), loadRefresh()]);
  if (isAdmin.value) await loadUsers();
}

async function loadStatus() {
  try {
    status.value = await adminApi.status();
  } catch (error) {
    reportError(error);
  }
}

/* ---------- 知識庫檔案 ---------- */
const files = ref([]);
const filesError = ref("");
const uploading = ref(false);
const dragging = ref(false);
const fileInput = ref(null);

async function loadFiles() {
  filesError.value = "";
  try {
    const result = await adminApi.kbFiles();
    files.value = result.files || [];
  } catch (error) {
    if (error.status === 401) return reportError(error);
    /* 503 = 還沒設定 KB_BUCKET／KNOWLEDGE_BASE_ID，這是設定問題不是錯誤，
       單獨顯示在卡片裡而不是蓋掉整頁 */
    filesError.value = error.message;
    files.value = [];
  }
}

function pickFiles() {
  if (fileInput.value) fileInput.value.click();
}

async function onFilesChosen(event) {
  const chosen = Array.from(event.target.files || []);
  event.target.value = "";
  await uploadFiles(chosen);
}

async function onDrop(event) {
  dragging.value = false;
  await uploadFiles(Array.from(event.dataTransfer.files || []));
}

async function uploadFiles(list) {
  if (!list.length) return;
  uploading.value = true;
  const failures = [];
  for (const file of list) {
    try {
      await adminApi.uploadKbFile(file);
    } catch (error) {
      failures.push(`${file.name}：${error.message}`);
    }
  }
  uploading.value = false;
  await loadFiles();
  if (failures.length) {
    flash("error", `${failures.length} 個檔案上傳失敗 — ${failures.join("；")}`);
  } else {
    flash("success", `已上傳 ${list.length} 個檔案。記得執行「同步知識庫」才會生效。`);
  }
}

async function removeFile(file) {
  if (!window.confirm(`確定要刪除「${file.name}」？\n刪除後需要再同步一次，AI 的回答內容會改變。`)) return;
  try {
    await adminApi.deleteKbFile(file.key);
    await loadFiles();
    flash("success", `已刪除 ${file.name}，請再執行一次同步。`);
  } catch (error) {
    reportError(error);
  }
}

/* ---------- 知識庫同步 ---------- */
const sync = ref(null);
let syncTimer = null;

function stopSyncPolling() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}

async function startSync() {
  try {
    const job = await adminApi.startSync();
    sync.value = { jobId: job.jobId, status: job.status, statistics: {}, failureReasons: [] };
    stopSyncPolling();
    syncTimer = setInterval(pollSync, 4000);
    flash("info", "同步已啟動，處理時間依檔案數量而定。");
  } catch (error) {
    reportError(error);
  }
}

async function pollSync() {
  if (!sync.value) return stopSyncPolling();
  try {
    sync.value = await adminApi.syncStatus(sync.value.jobId);
    if (["COMPLETE", "FAILED", "STOPPED"].includes(sync.value.status)) {
      stopSyncPolling();
      if (sync.value.status === "COMPLETE") flash("success", "知識庫同步完成。");
      else flash("error", `同步結束於 ${sync.value.status}。`);
    }
  } catch (error) {
    stopSyncPolling();
    reportError(error);
  }
}

const syncBadge = computed(() => {
  if (!sync.value) return null;
  const map = { COMPLETE: "ok", FAILED: "bad", STOPPED: "bad", IN_PROGRESS: "warn", STARTING: "warn" };
  return map[sync.value.status] || "idle";
});

/* ---------- 資料更新 ---------- */
const refresh = ref(null);
let refreshTimer = null;

function stopRefreshPolling() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

async function loadRefresh() {
  try {
    refresh.value = await adminApi.refreshStatus();
    if (refresh.value.running && !refreshTimer) {
      refreshTimer = setInterval(loadRefresh, 3000);
    } else if (!refresh.value.running) {
      stopRefreshPolling();
    }
  } catch (error) {
    if (error.status === 401) reportError(error);
  }
}

async function startRefresh() {
  try {
    await adminApi.startRefresh();
    flash("info", "資料更新已開始，會重新抓取各來源的開放資料 API。");
    await loadRefresh();
    if (!refreshTimer) refreshTimer = setInterval(loadRefresh, 3000);
  } catch (error) {
    reportError(error);
  }
}

/* ---------- 帳號 ---------- */
const users = ref([]);
const roles = ref(["admin", "editor"]);
const newUser = ref({ username: "", password: "", role: "editor" });
const creating = ref(false);

async function loadUsers() {
  try {
    const result = await adminApi.users();
    users.value = result.users || [];
    roles.value = result.roles || roles.value;
  } catch (error) {
    reportError(error);
  }
}

async function createUser() {
  creating.value = true;
  try {
    await adminApi.createUser(newUser.value.username, newUser.value.password, newUser.value.role);
    flash("success", `已建立帳號 ${newUser.value.username}。`);
    newUser.value = { username: "", password: "", role: "editor" };
    await loadUsers();
  } catch (error) {
    reportError(error);
  } finally {
    creating.value = false;
  }
}

async function changeRole(target, role) {
  try {
    await adminApi.updateUser(target.username, { role });
    await loadUsers();
    flash("success", `${target.username} 的角色已改為 ${role}。`);
  } catch (error) {
    reportError(error);
    await loadUsers();
  }
}

async function toggleDisabled(target) {
  try {
    await adminApi.updateUser(target.username, { disabled: !target.disabled });
    await loadUsers();
    flash("success", `${target.username} 已${target.disabled ? "啟用" : "停用"}。`);
  } catch (error) {
    reportError(error);
  }
}

async function unlockUser(target) {
  try {
    await adminApi.updateUser(target.username, { unlock: true });
    await loadUsers();
    flash("success", `${target.username} 已解除鎖定。`);
  } catch (error) {
    reportError(error);
  }
}

async function resetPassword(target) {
  const next = window.prompt(`為 ${target.username} 設定新密碼（至少 12 字元）：`);
  if (next === null) return;
  try {
    await adminApi.updateUser(target.username, { password: next });
    flash("success", `${target.username} 的密碼已更新，該帳號的登入狀態已被登出。`);
    await loadUsers();
  } catch (error) {
    reportError(error);
  }
}

async function removeUser(target) {
  if (!window.confirm(`確定要刪除帳號「${target.username}」？此操作無法復原。`)) return;
  try {
    await adminApi.deleteUser(target.username);
    await loadUsers();
    flash("success", `已刪除 ${target.username}。`);
  } catch (error) {
    reportError(error);
  }
}

onMounted(boot);
onBeforeUnmount(() => {
  stopSyncPolling();
  stopRefreshPolling();
});
</script>

<template>
  <!-- 圖示一律用 inline SVG，不用 emoji（ui-ux-pro-max checklist） -->
  <section class="admin">
    <!-- ============ 登入 ============ -->
    <div v-if="!booting && !user" class="admin-login">
      <div class="admin-login-card">
        <h1>生活圈後台</h1>
        <p>管理知識庫文件、開放資料更新與帳號。</p>

        <div v-if="notice" class="admin-alert" :class="notice.kind" role="status">
          <span>{{ notice.text }}</span>
        </div>

        <form class="admin-login-form" @submit.prevent="doLogin">
          <div class="admin-field">
            <label for="admin-username">帳號</label>
            <input id="admin-username" class="admin-input" v-model="loginForm.username"
                   autocomplete="username" required>
          </div>
          <div class="admin-field">
            <label for="admin-password">密碼</label>
            <input id="admin-password" class="admin-input" type="password" v-model="loginForm.password"
                   autocomplete="current-password" required
                   :aria-invalid="loginError ? 'true' : 'false'"
                   aria-describedby="admin-login-error">
          </div>
          <p v-if="loginError" id="admin-login-error" class="admin-alert error" role="alert">
            {{ loginError }}
          </p>
          <button class="admin-btn" type="submit" :disabled="loggingIn">
            {{ loggingIn ? "登入中…" : "登入" }}
          </button>
        </form>
        <p class="admin-hint">
          第一個管理員帳號需在伺服器上執行 <code>create_admin.py</code> 建立，後台沒有註冊功能。
        </p>
      </div>
    </div>

    <!-- ============ 後台 ============ -->
    <div v-else-if="user" class="admin-shell">
      <header class="admin-topbar">
        <span class="admin-brand" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" />
          </svg>
        </span>
        <h1 class="admin-title">生活圈後台</h1>
        <div class="admin-spacer"></div>
        <div class="admin-who">
          <span class="admin-mono">{{ user.username }}</span>
          <span class="admin-role">{{ user.role }}</span>
        </div>
        <button class="admin-exit" type="button" @click="doLogout">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
               stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" />
          </svg>
          登出
        </button>
      </header>

      <div v-for="warning in (status && status.warnings) || []" :key="warning"
           class="admin-alert warning" role="status">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M12 9v4" /><path d="M12 17h.01" /><circle cx="12" cy="12" r="9" />
        </svg>
        <span>{{ warning }}</span>
      </div>

      <div v-if="notice" class="admin-alert" :class="notice.kind" role="status">
        <span>{{ notice.text }}</span>
      </div>

      <nav class="admin-tabs" role="tablist">
        <button class="admin-tab" role="tab" :aria-selected="tab === 'kb'" @click="tab = 'kb'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" aria-hidden="true">
            <path d="M4 19.5V5a2 2 0 0 1 2-2h11l3 3v13.5" /><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          </svg>
          知識庫文件
        </button>
        <button class="admin-tab" role="tab" :aria-selected="tab === 'data'" @click="tab = 'data'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" aria-hidden="true">
            <ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
            <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
          </svg>
          開放資料
        </button>
        <button v-if="isAdmin" class="admin-tab" role="tab" :aria-selected="tab === 'users'"
                @click="tab = 'users'">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" aria-hidden="true">
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          </svg>
          帳號管理
        </button>
      </nav>

      <!-- ---------- 知識庫 ---------- -->
      <div v-show="tab === 'kb'">
        <div class="admin-card">
          <div class="admin-card-head">
            <h2>上傳文件</h2>
            <p v-if="status">
              最大 {{ status.maxUploadMb }} MB，可用型別
              <span class="admin-mono">{{ status.allowedExtensions.join(" ") }}</span>
            </p>
          </div>

          <div v-if="filesError" class="admin-alert warning" role="status">
            <span>{{ filesError }}</span>
          </div>

          <div v-else class="admin-drop" :class="{ dragging }" role="button" tabindex="0"
               @click="pickFiles" @keydown.enter.prevent="pickFiles" @keydown.space.prevent="pickFiles"
               @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false"
               @drop.prevent="onDrop">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
                 stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="m7 10 5-5 5 5" /><path d="M12 5v12" />
            </svg>
            <strong>{{ uploading ? "上傳中…" : "點擊或拖曳檔案到這裡" }}</strong>
            <span>上傳後需執行「同步知識庫」才會被 AI 檢索到</span>
          </div>
          <input ref="fileInput" type="file" multiple hidden @change="onFilesChosen">
        </div>

        <div class="admin-card">
          <div class="admin-card-head">
            <h2>已上傳文件</h2>
            <p v-if="status && status.kbBucket" class="admin-mono">
              s3://{{ status.kbBucket }}/{{ status.kbPrefix }}
            </p>
            <div class="admin-spacer"></div>
            <button class="admin-btn secondary small" type="button" @click="loadFiles">重新載入</button>
            <button class="admin-btn accent small" type="button" @click="startSync"
                    :disabled="!!filesError">同步知識庫</button>
          </div>

          <div v-if="sync" class="admin-alert info" role="status">
            <span>
              同步作業 <span class="admin-mono">{{ sync.jobId }}</span>
              <span class="admin-badge" :class="syncBadge">{{ sync.status }}</span>
              <template v-if="sync.statistics && sync.statistics.numberOfDocumentsScanned !== undefined">
                　掃描 {{ sync.statistics.numberOfDocumentsScanned }} 份，
                新增索引 {{ sync.statistics.numberOfNewDocumentsIndexed || 0 }} 份，
                失敗 {{ sync.statistics.numberOfDocumentsFailed || 0 }} 份
              </template>
              <template v-if="sync.failureReasons && sync.failureReasons.length">
                　原因：{{ sync.failureReasons.join("；") }}
              </template>
            </span>
          </div>

          <div v-if="files.length" class="admin-table-wrap">
            <table class="admin-table">
              <thead>
                <tr>
                  <th scope="col">檔名</th>
                  <th scope="col" style="text-align:right">大小</th>
                  <th scope="col">最後修改</th>
                  <th scope="col" v-if="isAdmin"><span class="sr-only">操作</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="file in files" :key="file.key">
                  <td>{{ file.name }}</td>
                  <td class="admin-num">{{ formatBytes(file.size) }}</td>
                  <td class="admin-mono">{{ formatTime(file.modified) }}</td>
                  <td v-if="isAdmin" class="admin-actions">
                    <button class="admin-btn danger small" type="button" @click="removeFile(file)">刪除</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else-if="!filesError" class="admin-empty">還沒有任何文件。</p>
        </div>
      </div>

      <!-- ---------- 開放資料 ---------- -->
      <div v-show="tab === 'data'">
        <div class="admin-card">
          <div class="admin-card-head">
            <h2>手動更新開放資料</h2>
            <p>重新抓取各來源 API。平時每月自動執行一次。</p>
            <div class="admin-spacer"></div>
            <button class="admin-btn" type="button" @click="startRefresh"
                    :disabled="refresh && refresh.running">
              {{ refresh && refresh.running ? "更新中…" : "立即更新" }}
            </button>
          </div>

          <div v-if="refresh" class="admin-stats">
            <div class="admin-stat">
              <dt>狀態</dt>
              <dd>
                <span class="admin-badge" :class="refresh.running ? 'warn'
                  : (refresh.result ? (refresh.result.ok ? 'ok' : 'bad') : 'idle')">
                  {{ refresh.running ? "進行中" : (refresh.result ? (refresh.result.ok ? "成功" : "失敗") : "閒置") }}
                </span>
              </dd>
            </div>
            <div class="admin-stat"><dt>開始</dt><dd>{{ formatTime(refresh.started_at) }}</dd></div>
            <div class="admin-stat"><dt>結束</dt><dd>{{ formatTime(refresh.finished_at) }}</dd></div>
          </div>

          <pre v-if="refresh && refresh.result && refresh.result.log" class="admin-log">{{ refresh.result.log }}</pre>
          <p class="admin-hint">
            抓到 0 筆、或筆數比上次掉超過門檻時會保留舊資料不覆蓋，避免上游異常把名冊清空。
          </p>
        </div>

        <div class="admin-card">
          <div class="admin-card-head">
            <h2>各資料表時點</h2>
            <div class="admin-spacer"></div>
            <button class="admin-btn secondary small" type="button" @click="loadRefresh">重新載入</button>
          </div>
          <div class="admin-table-wrap">
            <table class="admin-table">
              <thead>
                <tr>
                  <th scope="col">資料表</th>
                  <th scope="col">狀態</th>
                  <th scope="col" style="text-align:right">筆數</th>
                  <th scope="col">抓取時間</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="table in (refresh && refresh.tables) || []" :key="table.table">
                  <td class="admin-mono">{{ table.table }}</td>
                  <td>
                    <span class="admin-badge" :class="table.status === 'ok'
                      ? (table.bundled_fallback ? 'warn' : 'ok') : 'bad'">
                      {{ table.status !== "ok" ? table.status
                        : (table.bundled_fallback ? "內建版本" : "已更新") }}
                    </span>
                  </td>
                  <td class="admin-num">{{ table.row_count ?? "—" }}</td>
                  <td class="admin-mono">{{ formatTime(table.generated_at) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="admin-hint">「內建版本」表示這個表還沒執行過更新，用的是隨程式打包的資料。</p>
        </div>
      </div>

      <!-- ---------- 帳號 ---------- -->
      <div v-show="tab === 'users'" v-if="isAdmin">
        <div class="admin-card">
          <div class="admin-card-head">
            <h2>新增帳號</h2>
            <p>admin 可管理帳號；editor 只能上傳文件與更新資料。</p>
          </div>
          <form @submit.prevent="createUser">
            <div class="admin-form-row">
              <div class="admin-field">
                <label for="new-username">帳號</label>
                <input id="new-username" class="admin-input" v-model="newUser.username"
                       autocomplete="off" required>
              </div>
              <div class="admin-field">
                <label for="new-password">密碼（至少 12 字元）</label>
                <input id="new-password" class="admin-input" type="password" v-model="newUser.password"
                       autocomplete="new-password" required>
              </div>
              <div class="admin-field">
                <label for="new-role">角色</label>
                <select id="new-role" class="admin-input" v-model="newUser.role">
                  <option v-for="role in roles" :key="role" :value="role">{{ role }}</option>
                </select>
              </div>
              <button class="admin-btn" type="submit" :disabled="creating">
                {{ creating ? "建立中…" : "建立帳號" }}
              </button>
            </div>
          </form>
        </div>

        <div class="admin-card">
          <div class="admin-card-head">
            <h2>帳號清單</h2>
            <div class="admin-spacer"></div>
            <button class="admin-btn secondary small" type="button" @click="loadUsers">重新載入</button>
          </div>
          <div class="admin-table-wrap">
            <table class="admin-table">
              <thead>
                <tr>
                  <th scope="col">帳號</th>
                  <th scope="col">角色</th>
                  <th scope="col">狀態</th>
                  <th scope="col">最後登入</th>
                  <th scope="col"><span class="sr-only">操作</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in users" :key="row.username">
                  <td class="admin-mono">
                    {{ row.username }}
                    <span v-if="row.username === user.username" class="admin-badge idle">你</span>
                  </td>
                  <td>
                    <select class="admin-input" style="min-height:32px" :value="row.role"
                            :disabled="row.username === user.username"
                            @change="changeRole(row, $event.target.value)"
                            :aria-label="`${row.username} 的角色`">
                      <option v-for="role in roles" :key="role" :value="role">{{ role }}</option>
                    </select>
                  </td>
                  <td>
                    <span class="admin-badge" :class="row.disabled ? 'bad' : (row.locked ? 'warn' : 'ok')">
                      {{ row.disabled ? "已停用" : (row.locked ? "已鎖定" : "正常") }}
                    </span>
                  </td>
                  <td class="admin-mono">{{ formatTime(row.last_login) }}</td>
                  <td class="admin-actions">
                    <button v-if="row.locked" class="admin-btn secondary small" type="button"
                            @click="unlockUser(row)">解鎖</button>
                    <button class="admin-btn secondary small" type="button"
                            @click="resetPassword(row)">改密碼</button>
                    <button class="admin-btn secondary small" type="button"
                            :disabled="row.username === user.username"
                            @click="toggleDisabled(row)">{{ row.disabled ? "啟用" : "停用" }}</button>
                    <button class="admin-btn danger small" type="button"
                            :disabled="row.username === user.username"
                            @click="removeUser(row)">刪除</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="admin-hint">
            系統會保留至少一個可用的管理員：最後一個 admin 無法被停用、降級或刪除。
            改密碼會讓該帳號目前的登入狀態立即失效。
          </p>
        </div>
      </div>
    </div>

    <div v-else class="admin-login">
      <p>載入中…</p>
    </div>
  </section>
</template>
