<script setup>
import { nextTick, ref, watch } from "vue";
import { appState } from "../store/appState.js";
import aiAvatar from "../assets/youth-ai-avatar.png";
import userAvatar from "../assets/jerry-user-avatar.png";

const messagesEl = ref(null);
const chatPanelEl = ref(null);
const chatInputEl = ref(null);
const chatLauncherEl = ref(null);
const planPanelEl = ref(null);
const planChartHtml = ref("");
const planChartKey = ref("");
let planChartTrigger = null;

function handleSend() {
  appState.sendChat(messagesEl.value);
}

function closeChat() {
  closePlanChart(false);
  appState.chatOpen = false;
  nextTick(function () {
    chatLauncherEl.value?.focus();
  });
}

/* [Jerry 2026-09-13 改版：AI 圖表不再擠在訊息氣泡裡；訊息改顯示
   「規劃展示」按鈕，點擊後在聊天室左側開啟較大的閱讀面板。] */
function openPlanChart(chart, key, event) {
  planChartHtml.value = chart;
  planChartKey.value = key;
  planChartTrigger = event.currentTarget;
  nextTick(function () {
    planPanelEl.value?.focus();
  });
}

function closePlanChart(returnFocus = true) {
  const trigger = planChartTrigger;
  planChartHtml.value = "";
  planChartKey.value = "";
  planChartTrigger = null;
  if (returnFocus && trigger) nextTick(function () { trigger.focus(); });
}

function handleChatEscape() {
  if (planChartHtml.value) {
    closePlanChart();
    return;
  }
  closeChat();
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
  if (!isOpen) {
    closePlanChart(false);
    return;
  }
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
      <section v-if="appState.chatOpen" id="chat-panel" ref="chatPanelEl" tabindex="-1"
               class="chat-panel" role="dialog" aria-labelledby="chat-title"
               @keydown.esc="handleChatEscape">
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
                  <!-- 散文一律走 {{ }}，由 Vue 轉義，永遠不會被當成 HTML 執行。
                       v-if 是為了「只有圖表、沒有文字」的回覆不留一個空段落。 -->
                  <p v-if="message.text">{{ message.text }}</p>
                  <!-- [Jerry 2026-09-13 改版：圖表內容已在 lib/chartHtml.js 消毒；
                       訊息內只留按鈕，真正圖表改在聊天室旁的大面板顯示。] -->
                  <button v-for="(chart, chartIndex) in (message.charts || [])"
                          :key="'chart-' + chartIndex" type="button" class="chat-plan-button"
                          :aria-expanded="planChartKey === index + '-' + chartIndex"
                          aria-controls="chat-plan-panel"
                          :aria-label="'開啟規劃展示' + ((message.charts || []).length > 1 ? ' ' + (chartIndex + 1) : '')"
                          @click="openPlanChart(chart, index + '-' + chartIndex, $event)">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 19V9m6 10V5m6 14v-7m4 7H2"></path>
                    </svg>
                    <span>規劃展示</span>
                  </button>
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
                    <span class="typing-label">回覆中</span>
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
    </Transition>

    <!-- [Jerry 2026-09-13 新增：桌面版位於聊天室左側；窄螢幕改為安全留邊的覆蓋面板。] -->
    <Transition name="chat-plan-panel">
      <aside v-if="appState.chatOpen && planChartHtml" id="chat-plan-panel" ref="planPanelEl"
             class="chat-plan-panel" tabindex="-1" role="dialog" aria-labelledby="chat-plan-title"
             @keydown.esc="closePlanChart">
        <header class="chat-plan-header">
          <div>
            <small>AI 規劃結果</small>
            <strong id="chat-plan-title">規劃展示</strong>
          </div>
          <button type="button" class="chat-plan-close" aria-label="關閉規劃展示" @click="closePlanChart">
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <!-- 圖表字串已由 chartHtml.js 的 DOMPurify 白名單處理。 -->
        <div class="chat-plan-body" v-html="planChartHtml"></div>
      </aside>
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
