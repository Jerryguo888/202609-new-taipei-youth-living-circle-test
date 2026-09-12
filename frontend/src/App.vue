<script setup>
import NavOrb from "./components/NavOrb.vue";
import ChatWidget from "./components/ChatWidget.vue";
</script>

<template>
  <!-- ===== [改版新增：Vue 3 單頁應用開始] ===== -->
  <div id="app" class="site-shell">
    <NavOrb />
    <main class="page-container">
      <router-view />
    </main>
    <ChatWidget />
  </div>
  <!-- ===== [改版新增：Vue 3 單頁應用結束] ===== -->
</template>
