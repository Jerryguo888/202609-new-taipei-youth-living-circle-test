<script setup>
import { appState } from "../store/appState.js";
</script>

<template>
  <!-- ===== [本次改版：移除常駐頂部選單，改成可收起的懸浮圓球選單] ===== -->
  <div class="nav-orb-wrap" v-show="appState.activeView !== 'home'">
    <div class="nav-orb-menu" v-if="appState.navMenuOpen">
      <button v-for="item in appState.navItems" :key="item.id"
              class="nav-orb-item" :class="{ active: appState.activeView === item.id }"
              @click="appState.go(item.id)">{{ item.label }}</button>
    </div>
    <button class="nav-orb" :class="{ open: appState.navMenuOpen }"
            @click="appState.navMenuOpen = !appState.navMenuOpen"
            :aria-expanded="appState.navMenuOpen" aria-label="開啟導覽選單">
      <span v-if="!appState.navMenuOpen">☰</span><span v-else>×</span>
    </button>
  </div>
</template>
