<script setup>
import { ref } from "vue";
import { appState } from "../store/appState.js";

const messagesEl = ref(null);

function handleSend() {
  appState.sendChat(messagesEl.value);
}

function handleChip(chip) {
  appState.chatInput = chip;
  handleSend();
}
</script>

<template>
  <!-- ===== [改版新增：前端示範 AI 對話框] ===== -->
  <section class="chat-panel" v-if="appState.chatOpen" aria-label="生活圈 AI 助理">
    <header class="chat-header">
      <div><strong>生活圈 AI 助理</strong><span>DEMO・前端情境回覆</span></div>
      <button class="chat-close" @click="appState.chatOpen = false" aria-label="關閉對話框">×</button>
    </header>
    <div class="messages" ref="messagesEl">
      <div class="message" :class="{ user: message.role === 'user' }"
           v-for="(message, index) in appState.chatMessages" :key="index">{{ message.text }}</div>
    </div>
    <div class="chat-chips">
      <button class="chat-chip" v-for="chip in appState.chatChips" :key="chip" @click="handleChip(chip)">{{ chip }}</button>
    </div>
    <div class="chat-input">
      <input v-model="appState.chatInput" @keydown.enter="handleSend" placeholder="問選址、覆蓋或預算…">
      <button class="chat-send" @click="handleSend" aria-label="送出">→</button>
    </div>
  </section>
  <button class="chat-launcher" @click="appState.chatOpen = !appState.chatOpen" :aria-expanded="appState.chatOpen">AI</button>
</template>
