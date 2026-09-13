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
const planPanelEl = ref(null);
const planChartHtml = ref("");
const planChartKey = ref("");
let planChartTrigger = null;

function handleSend() {
  appState.sendChat(messagesEl.value);
}

/* [2026-09-12 修正：中文輸入法下訊息會被提前送出。
   用 IME 打字時 Enter 是「確認候選字」，此時 keydown 仍然會觸發，而 Vue 的
   .exact 修飾詞只檢查 Ctrl/Shift 之類的輔助鍵，不會過濾組字狀態。結果是使用者
   打幾個字按 Enter 選字，訊息就被送出、輸入框被清空，看起來像「只能輸入幾個字」。
   keyCode === 229 是備援：部分 Android IME 與舊版 Safari 不會給正確的
   isComposing，但會回報這個代表「組字中」的鍵碼。 */
function onEnter(event) {
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  handleSend();
}

/* 打字動畫進行中時點一下訊息就直接看全文，不必等它慢慢打完。 */
function revealMessage(message) {
  appState.revealMessageNow(message);
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
                <!-- [2026-09-12 改版：回覆改成收完才顯示，並用打字動畫呈現。
                     動畫期間點一下氣泡就直接看全文，不必等它打完。 -->
                <div class="message" :class="{ user: message.role === 'user', 'is-typing': message.typing }"
                     :role="message.typing ? 'button' : null"
                     :tabindex="message.typing ? 0 : null"
                     :aria-label="message.typing ? '正在逐字顯示，點擊立即顯示全文' : null"
                     @click="message.typing && revealMessage(message)"
                     @keydown.enter.prevent="message.typing && revealMessage(message)"
                     @keydown.space.prevent="message.typing && revealMessage(message)">
                  <!-- 只有明確標記為 assistant 的回覆才解析 Markdown，且解析結果會先經
                       DOMPurify 白名單消毒。user 與其他未知 role 一律走 {{ }} 純文字轉義。 -->
                  <div v-if="message.role === 'assistant' && message.text"
                       class="message-markdown" v-html="renderAssistantMarkdown(message.text)"></div>
                  <p v-else-if="message.text">{{ message.text }}</p>
                  <!-- [Jerry 2026-09-13 改版：只有 assistant 的已消毒圖表能進入展示流程；
                       聊天氣泡內只留「規劃展示」按鈕，圖表本體在聊天室左側顯示。] -->
                  <template v-if="message.role === 'assistant'">
                    <button v-for="(chart, chartIndex) in (message.charts || [])"
                            :key="'chart-' + chartIndex" type="button" class="chat-plan-button"
                            :aria-expanded="planChartKey === index + '-' + chartIndex"
                            aria-haspopup="dialog" aria-controls="chat-plan-panel"
                            :aria-label="'開啟規劃展示' + ((message.charts || []).length > 1 ? ' ' + (chartIndex + 1) : '')"
                            @click="openPlanChart(chart, index + '-' + chartIndex, $event)">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M4 19V9m6 10V5m6 14v-7m4 7H2"></path>
                      </svg>
                      <span>規劃展示</span>
                    </button>
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
                         生成長。顯示它正在讀什麼，等待才不像沒反應。
                         回覆改成收完才顯示之後，這段等待涵蓋整個生成過程，
                         這行字是使用者唯一的進度資訊。] -->
                    <span class="typing-label">{{ appState.chatActivity || "思考中" }}</span>
                    <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
                  </div>
                </div>
              </div>
            </article>
          </div>
        </main>

        <footer class="chat-compose-area">
          <div class="chat-input">
            <input ref="chatInputEl" v-model="appState.chatInput" @keydown.enter="onEnter"
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
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18"></path>
            </svg>
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
