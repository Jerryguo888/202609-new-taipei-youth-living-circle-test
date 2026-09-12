<script setup>
import { watch } from "vue";
import { useRoute } from "vue-router";
import NavOrb from "./components/NavOrb.vue";
import ChatWidget from "./components/ChatWidget.vue";
import { appState } from "./store/appState.js";

/* [Jerry 2026-09-13 新增：首頁不顯示 AI；進入任一功能頁後才掛載聊天按鈕。] */
const route = useRoute();
watch(function () { return route.name; }, function (routeName) {
  if (routeName === "home") appState.chatOpen = false;
}, { immediate: true });
</script>

<template>
  <!-- ===== [改版新增：Vue 3 單頁應用開始] ===== -->
  <div id="app" class="site-shell">
    <NavOrb />
    <main class="page-container">
      <router-view />
    </main>
    <ChatWidget v-if="route.name && route.name !== 'home'" />
  </div>
  <!-- ===== [改版新增：Vue 3 單頁應用結束] ===== -->
</template>
