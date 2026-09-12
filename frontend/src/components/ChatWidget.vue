<script setup>
import { nextTick, ref, watch } from "vue";
import { appState } from "../store/appState.js";
import { renderAssistantMarkdown } from "../lib/assistantMarkdown.js";
import aiAvatar from "../assets/youth-ai-avatar.png";
import userAvatar from "../assets/jerry-user-avatar.png";

const messagesEl = ref(null);
const chatPanelEl = ref(null);
const chatInputEl = ref(null);
const chatLauncherEl = ref(null);
const chartModalEl = ref(null);
const chartModalCloseEl = ref(null);
const expandedChartHtml = ref("");
let chartReturnFocusEl = null;

function handleSend() {
  appState.sendChat(messagesEl.value);
}

function closeChat() {
  expandedChartHtml.value = "";
  chartReturnFocusEl = null;
  appState.chatOpen = false;
  nextTick(function () {
    chatLauncherEl.value?.focus();
  });
}

async function openChartModal(chart, event) {
  if (!chart) return;
  chartReturnFocusEl = event?.currentTarget || null;
  expandedChartHtml.value = chart;
  await nextTick();
  chartModalEl.value?.focus();
}

function closeChartModal() {
  const returnTarget = chartReturnFocusEl;
  expandedChartHtml.value = "";
  chartReturnFocusEl = null;
  nextTick(function () {
    returnTarget?.focus();
  });
}

function handleChatEscape() {
  if (expandedChartHtml.value) closeChartModal();
  else closeChat();
}

function keepChartModalFocus(event) {
  if (event.key !== "Tab") return;
  event.preventDefault();
  chartModalCloseEl.value?.focus();
}

/* [2026-09-12 新增：知識庫來源是 s3://bucket/key，只取檔名顯示比較好讀。] */
function sourceFileName(uri) {
  if (!uri) return "（未知來源）";
  const name = uri.split("/").pop() || uri;
  try {
    return decodeURIComponent(name);
  } catch (error) {
    return name;
  }
}

/* [Jerry 改版：右側手機型聊天室開啟後聚焦輸入框，並顯示最新一則訊息。] */
watch(function () { return appState.chatOpen; }, async function (isOpen) {
  if (!isOpen) return;
  await nextTick();
  chatPanelEl.value?.focus();
  chatInputEl.value?.focus();
  if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
});
</script>

<template>
  <!-- ===== [Jerry 改版：右側手機型 AI 聊天室開始] ===== -->
  <Teleport to="body">
    <Transition name="chat-drawer">
      <div v-if="appState.chatOpen" class="chat-shell" @keydown.esc.stop="handleChatEscape">
        <section id="chat-panel" ref="chatPanelEl" tabindex="-1"
                 class="chat-panel" role="dialog" aria-labelledby="chat-title">
        <header class="chat-header">
          <div class="chat-title-group">
            <strong id="chat-title">生活圈 AI 對話</strong>
          </div>
          <button type="button" class="chat-close" @click="closeChat" aria-label="關閉生活圈 AI 助理">
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <main class="chat-workspace">
          <div class="messages" ref="messagesEl" aria-live="polite">
            <!-- [Jerry 改版：名稱移到訊息上方，AI 靠左、Jerry 靠右，兩側各自顯示頭貼。] -->
            <article class="chat-message-row" :class="{ user: message.role === 'user' }"
                     v-for="(message, index) in appState.chatMessages" :key="index">
              <img class="chat-avatar" :class="{ 'is-user': message.role === 'user' }"
                   :src="message.role === 'user' ? userAvatar : aiAvatar" alt="">
              <div class="chat-message-content">
                <small class="chat-message-name">{{ message.role === "user" ? "USER" : "生活圈 AI 助理" }}</small>
                <div class="message" :class="{ user: message.role === 'user' }">
                  <!-- 只有明確標記為 assistant 的回覆才解析 Markdown，且解析結果會先經
                       DOMPurify 白名單消毒。user 與其他未知 role 一律走 {{ }} 純文字轉義。 -->
                  <div v-if="message.role === 'assistant' && message.text"
                       class="message-markdown" v-html="renderAssistantMarkdown(message.text)"></div>
                  <p v-else-if="message.text">{{ message.text }}</p>
                  <!-- 只有 assistant 的已消毒 chart HTML 能進入預覽與放大流程；
                       user 訊息即使帶有 charts 欄位也不會執行 v-html。 -->
                  <template v-if="message.role === 'assistant'">
                    <div v-for="(chart, chartIndex) in (message.charts || [])"
                         :key="'chart-' + chartIndex" class="ai-chart-preview">
                      <div class="ai-chart-wrap" v-html="chart"></div>
                      <button type="button" class="ai-chart-expand-button"
                              aria-haspopup="dialog" aria-controls="ai-chart-modal"
                              @click="openChartModal(chart, $event)">
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"></path>
                        </svg>
                        <span>放大查看圖表</span>
                      </button>
                    </div>
                  </template>
                  <!-- [2026-09-12 新增：這次回答讀了哪些資料。AI 是自己決定要查什麼的，
                       把它的選擇攤開來，使用者才判斷得出數字可不可信。] -->
                  <details v-if="message.tools && message.tools.length" class="chat-sources chat-tools">
                    <summary>讀取的資料（{{ message.tools.length }}）</summary>
                    <ol>
                      <li v-for="(tool, toolIndex) in message.tools" :key="toolIndex">
                        {{ tool.summary }}
                      </li>
                    </ol>
                  </details>
                  <!-- [2026-09-12 新增：知識庫引用來源。S3 的 s3:// URI 在瀏覽器點不開，
                       所以只顯示檔名，避免給出一個按了沒反應的連結。] -->
                  <details v-if="message.sources && message.sources.length" class="chat-sources">
                    <summary>參考來源（{{ message.sources.length }}）</summary>
                    <ol>
                      <li v-for="(source, sourceIndex) in message.sources" :key="sourceIndex">
                        {{ sourceFileName(source.uri) }}
                      </li>
                    </ol>
                  </details>
                </div>
              </div>
            </article>
            <!-- [Jerry 改版：非同步 AI 回覆期間顯示三點跳動氣泡，之後串 AWS API 不需重做版面。] -->
            <article v-if="appState.chatLoading" class="chat-message-row" role="status" aria-label="AI 助理正在回覆">
              <img class="chat-avatar" :src="aiAvatar" alt="">
              <div class="chat-message-content">
                <small class="chat-message-name">生活圈 AI 助理</small>
                <div class="message typing-message">
                  <div class="typing-status">
                    <!-- [2026-09-12 改版：AI 會先自己去查資料再回答，那段等待比單純
                         生成長。顯示它正在讀什麼，等待才不像沒反應。] -->
                    <span class="typing-label">{{ appState.chatActivity || "回覆中" }}</span>
                    <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
                  </div>
                </div>
              </div>
            </article>
          </div>
        </main>

        <footer class="chat-compose-area">
          <div class="chat-input">
            <input ref="chatInputEl" v-model="appState.chatInput" @keydown.enter.exact.prevent="handleSend"
                   aria-label="輸入問題" placeholder="問選址、30 分鐘覆蓋或預算配置…">
            <button type="button" class="chat-send" :disabled="appState.chatLoading"
                    @click="handleSend" aria-label="送出訊息">
              <span aria-hidden="true">➤</span>
            </button>
          </div>
        </footer>
        </section>
      </div>
    </Transition>

    <Transition name="chart-modal">
      <div v-if="appState.chatOpen && expandedChartHtml" class="chat-chart-modal-backdrop"
           @click.self="closeChartModal" @keydown.esc.stop="closeChartModal">
        <section id="ai-chart-modal" ref="chartModalEl" tabindex="-1"
                 class="chat-chart-modal" role="dialog" aria-modal="true"
                 aria-labelledby="ai-chart-modal-title" @keydown="keepChartModalFocus">
          <header class="chat-chart-modal-header">
            <strong id="ai-chart-modal-title">圖表放大檢視</strong>
            <button ref="chartModalCloseEl" type="button" class="chart-collapse-button"
                    @click="closeChartModal" aria-label="關閉放大圖表">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18"></path>
              </svg>
              <span>關閉圖表</span>
            </button>
          </header>
          <div class="chat-chart-modal-body">
            <div class="ai-chart-wrap" v-html="expandedChartHtml"></div>
          </div>
        </section>
      </div>
    </Transition>

  </Teleport>

  <!-- [Jerry 2026-09-13 新增：AI 圓形按鈕上方的常駐提示泡泡；聊天室開啟後一起收起。] -->
  <div v-if="!appState.chatOpen" class="chat-launcher-wrap">
    <p id="chat-launcher-hint" class="chat-launcher-hint" v-once>我是您的 AI 助理</p>
    <button ref="chatLauncherEl" type="button" class="chat-launcher" aria-controls="chat-panel"
            aria-describedby="chat-launcher-hint" aria-label="開啟生活圈 AI 助理"
            @click="appState.chatOpen = true">
      <img :src="aiAvatar" alt="">
    </button>
  </div>
  <!-- ===== [Jerry 改版：右側手機型 AI 聊天室結束] ===== -->
</template>
