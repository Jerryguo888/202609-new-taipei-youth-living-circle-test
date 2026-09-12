<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { appState } from "../store/appState.js";

const messagesEl = ref(null);
const chatPanelEl = ref(null);
const chatInputEl = ref(null);
const chatLauncherEl = ref(null);

function handleSend() {
  appState.sendChat(messagesEl.value);
}

function handleChip(chip) {
  appState.chatInput = chip;
  handleSend();
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

/* [Jerry 改版：全畫面聊天室開啟時鎖住底層頁面，並把焦點移到輸入框。] */
watch(function () { return appState.chatOpen; }, async function (isOpen) {
  document.body.classList.toggle("has-chat-open", isOpen);
  if (!isOpen) return;
  await nextTick();
  chatPanelEl.value?.focus();
  chatInputEl.value?.focus();
});

onBeforeUnmount(function () {
  document.body.classList.remove("has-chat-open");
});
</script>

<template>
  <!-- ===== [Jerry 改版：全畫面 AI 對話工作區開始] ===== -->
  <Teleport to="body">
    <Transition name="chat-fullscreen">
      <section v-if="appState.chatOpen" id="chat-panel" ref="chatPanelEl" tabindex="-1"
               class="chat-panel" role="dialog" aria-modal="true" aria-labelledby="chat-title"
               @keydown.esc="closeChat">
        <header class="chat-header">
          <div class="chat-title-group">
            <span class="chat-mark" aria-hidden="true">AI</span>
            <div>
              <strong id="chat-title">生活圈 AI 助理</strong>
              <!-- [2026-09-12 改版：已接上 Bedrock，標示改成實際的服務組成。] -->
              <span>Amazon Bedrock · S3 知識庫</span>
            </div>
          </div>
          <button type="button" class="chat-close" @click="closeChat" aria-label="關閉生活圈 AI 助理">
            <span>關閉</span><b aria-hidden="true">×</b>
          </button>
        </header>

        <main class="chat-workspace">
          <div class="messages" ref="messagesEl" aria-live="polite">
            <div class="message" :class="{ user: message.role === 'user' }"
                 v-for="(message, index) in appState.chatMessages" :key="index">
              <small>{{ message.role === "user" ? "你" : "AI 助理" }}</small>
              <p>{{ message.text }}</p>
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
            <!-- [Jerry 改版：非同步 AI 回覆期間顯示三點跳動氣泡，之後串 AWS API 不需重做版面。] -->
            <div v-if="appState.chatLoading" class="message typing-message" role="status" aria-label="AI 助理正在回覆">
              <small>AI 助理</small>
              <div class="typing-status">
                <span class="typing-label">回覆中</span>
                <span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
              </div>
            </div>
          </div>
        </main>

        <footer class="chat-compose-area">
          <div class="chat-chips" aria-label="快速提問">
            <button type="button" class="chat-chip" v-for="chip in appState.chatChips" :key="chip"
                    :disabled="appState.chatLoading" @click="handleChip(chip)">{{ chip }}</button>
          </div>
          <div class="chat-input">
            <input ref="chatInputEl" v-model="appState.chatInput" @keydown.enter.exact.prevent="handleSend"
                   aria-label="輸入問題" placeholder="問選址、30 分鐘覆蓋或預算配置…">
            <button type="button" class="chat-send" :disabled="appState.chatLoading"
                    @click="handleSend" aria-label="送出訊息">
              <span>送出</span><b aria-hidden="true">↑</b>
            </button>
          </div>
          <p class="chat-connection-note">回覆由 Amazon Bedrock 生成，並優先引用 S3 知識庫的資料；雲端無法連線時會自動改用本機情境回覆。</p>
        </footer>
      </section>
    </Transition>
  </Teleport>

  <button v-if="!appState.chatOpen" ref="chatLauncherEl" type="button" class="chat-launcher" aria-controls="chat-panel"
          aria-label="開啟生活圈 AI 助理" @click="appState.chatOpen = true">AI</button>
  <!-- ===== [Jerry 改版：全畫面 AI 對話工作區結束] ===== -->
</template>
