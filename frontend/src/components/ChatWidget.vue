<script setup>
import { nextTick, ref, watch } from "vue";
import { appState } from "../store/appState.js";
import aiAvatar from "../assets/youth-ai-avatar.png";
import userAvatar from "../assets/jerry-user-avatar.png";

const messagesEl = ref(null);
const chatPanelEl = ref(null);
const chatInputEl = ref(null);
const chatLauncherEl = ref(null);

function handleSend() {
  appState.sendChat(messagesEl.value);
}

function closeChat() {
  appState.chatOpen = false;
  nextTick(function () {
    chatLauncherEl.value?.focus();
  });
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
      <section v-if="appState.chatOpen" id="chat-panel" ref="chatPanelEl" tabindex="-1"
               class="chat-panel" role="dialog" aria-labelledby="chat-title"
               @keydown.esc="closeChat">
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
                  <!-- [2026-09-12 新增：模型畫的圖表。
                       這是全專案唯一使用 v-html 的地方。內容已在 lib/chartHtml.js
                       以 DOMPurify 白名單消毒：只留規定的標籤與 class，style 僅允許
                       width 百分比。模型讀得到 S3 知識庫，而知識庫內容屬於不可信
                       輸入（可能被塞提示注入），所以這道消毒不能省。 -->
                  <div v-for="(chart, chartIndex) in (message.charts || [])"
                       :key="'chart-' + chartIndex" class="ai-chart-wrap" v-html="chart"></div>
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
  </Teleport>

  <button v-if="!appState.chatOpen" ref="chatLauncherEl" type="button" class="chat-launcher" aria-controls="chat-panel"
          aria-label="開啟生活圈 AI 助理" @click="appState.chatOpen = true">
    <img :src="aiAvatar" alt="">
  </button>
  <!-- ===== [Jerry 改版：右側手機型 AI 聊天室結束] ===== -->
</template>
