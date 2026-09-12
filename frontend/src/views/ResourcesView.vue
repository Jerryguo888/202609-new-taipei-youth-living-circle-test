<script setup>
import { appState } from "../store/appState.js";
</script>

<template>
  <!-- ===== [改版新增：公共資源缺口頁] ===== -->
  <section class="view module">
    <div class="module-hero green">
      <div>
        <p class="section-kicker" style="color:#b8f0d0">Capacity & Demand</p>
        <h1>公共資源負擔力</h1>
      </div>
      <p>用預測需求減去既有容量，將托育、學校與停車壓力轉成市府能直接採取行動的風險訊號。</p>
    </div>
    <div class="module-body">
      <div class="toolbar">
        <span><strong>生活圈缺口快照</strong></span>
        <div class="segmented">
          <button :class="{ active: appState.resourceType === 'all' }" @click="appState.resourceType = 'all'">全部</button>
          <button :class="{ active: appState.resourceType === 'childcare' }" @click="appState.resourceType = 'childcare'">托育</button>
          <button :class="{ active: appState.resourceType === 'school' }" @click="appState.resourceType = 'school'">學校</button>
          <button :class="{ active: appState.resourceType === 'parking' }" @click="appState.resourceType = 'parking'">停車</button>
        </div>
      </div>
      <div class="gap-grid">
        <article v-for="item in appState.filteredGaps" :key="item.area + item.type"
                 class="gap-card" :class="item.level">
          <span class="status">{{ item.label }}</span>
          <h3>{{ item.area }}・{{ item.name }}</h3>
          <strong>{{ item.gap }}</strong>
          <p>{{ item.copy }}</p>
        </article>
      </div>
    </div>
  </section>
</template>
