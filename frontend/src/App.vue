<script setup>
import { computed } from "vue";
import { useRoute } from "vue-router";
import NavOrb from "./components/NavOrb.vue";
import ChatWidget from "./components/ChatWidget.vue";

/* [2026-09-12 新增：後台是全螢幕的獨立介面，不要疊上前台的懸浮選單與 AI 對話框。
   兩者都是 Teleport/fixed 定位，單靠 z-index 壓過去仍然可以被點到，
   所以直接不渲染比較乾淨。] */
const route = useRoute();
const isAdmin = computed(() => route.path.startsWith("/admin"));
</script>

<template>
  <!-- ===== [改版新增：Vue 3 單頁應用開始] ===== -->
  <div id="app" class="site-shell">
    <NavOrb v-if="!isAdmin" />
    <main class="page-container">
      <router-view />
    </main>
    <ChatWidget v-if="!isAdmin" />
  </div>
  <!-- ===== [改版新增：Vue 3 單頁應用結束] ===== -->
</template>
