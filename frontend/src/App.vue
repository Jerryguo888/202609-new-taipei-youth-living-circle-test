<script setup>
import { computed, watch } from "vue";
import { useRoute } from "vue-router";
import NavOrb from "./components/NavOrb.vue";
import ChatWidget from "./components/ChatWidget.vue";
import { appState } from "./store/appState.js";

/* [2026-09-12 新增：後台是全螢幕的獨立介面，不要疊上前台的懸浮選單與 AI 對話框。
   兩者都是 Teleport/fixed 定位，單靠 z-index 壓過去仍然可以被點到，
   所以直接不渲染比較乾淨。] */
const route = useRoute();
const isAdmin = computed(() => route.path.startsWith("/admin"));

/* [Jerry 2026-09-13 新增：首頁不顯示 AI；進入任一功能頁後才掛載聊天按鈕。] */
watch(function () { return route.name; }, function (routeName) {
  if (routeName === "home") appState.chatOpen = false;
}, { immediate: true });
</script>

<template>
  <!-- ===== [改版新增：Vue 3 單頁應用開始] ===== -->
  <div id="app" class="site-shell">
    <NavOrb v-if="!isAdmin" />
    <main class="page-container">
      <router-view />
    </main>
    <ChatWidget v-if="!isAdmin && route.name && route.name !== 'home'" />
  </div>
  <!-- ===== [改版新增：Vue 3 單頁應用結束] ===== -->
</template>
