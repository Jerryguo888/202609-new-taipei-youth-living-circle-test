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
              <span>DEMO · 尚未連接 AWS 模型</span>
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
            </div>
          </div>
        </main>

        <footer class="chat-compose-area">
          <div class="chat-chips" aria-label="快速提問">
            <button type="button" class="chat-chip" v-for="chip in appState.chatChips" :key="chip"
                    @click="handleChip(chip)">{{ chip }}</button>
          </div>
          <div class="chat-input">
            <input ref="chatInputEl" v-model="appState.chatInput" @keydown.enter.exact.prevent="handleSend"
                   aria-label="輸入問題" placeholder="問選址、30 分鐘覆蓋或預算配置…">
            <button type="button" class="chat-send" @click="handleSend" aria-label="送出訊息">
              <span>送出</span><b aria-hidden="true">↑</b>
            </button>
          </div>
          <p class="chat-connection-note">目前使用前端示範回覆；AWS AI 服務開放後將由同一個輸入框串接。</p>
        </footer>
      </section>
    </Transition>
  </Teleport>

  <button v-if="!appState.chatOpen" ref="chatLauncherEl" type="button" class="chat-launcher" aria-controls="chat-panel"
          aria-label="開啟生活圈 AI 助理" @click="appState.chatOpen = true">AI</button>
  <!-- ===== [Jerry 改版：全畫面 AI 對話工作區結束] ===== -->
</template>
