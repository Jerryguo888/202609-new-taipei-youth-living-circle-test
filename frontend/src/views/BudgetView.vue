<script setup>
import { appState } from "../store/appState.js";
</script>

<template>
  <!-- ===== [改版新增：預算模擬頁] ===== -->
  <section class="view module">
    <div class="module-hero">
      <div>
        <p class="section-kicker">Budget Scenario</p>
        <h1>把方案變成可比較的預算。</h1>
      </div>
      <p>調整服務型態與人力，立即比較年度成本與預估 30 分鐘服務覆蓋率。</p>
    </div>
    <div class="module-body budget-layout">
      <article class="panel budget-controls">
        <div class="budget-control">
          <label><span>固定服務據點</span><strong>{{ appState.budget.fixed }} 處</strong></label>
          <input type="range" min="0" max="5" v-model.number="appState.budget.fixed">
        </div>
        <div class="budget-control">
          <label><span>每週巡迴駐點</span><strong>{{ appState.budget.popup }} 處</strong></label>
          <input type="range" min="0" max="10" v-model.number="appState.budget.popup">
        </div>
        <div class="budget-control">
          <label><span>行動服務車</span><strong>{{ appState.budget.mobile }} 輛</strong></label>
          <input type="range" min="0" max="4" v-model.number="appState.budget.mobile">
        </div>
        <div class="budget-control">
          <label><span>新增服務人力</span><strong>{{ appState.budget.staff }} 人</strong></label>
          <input type="range" min="0" max="20" v-model.number="appState.budget.staff">
        </div>
      </article>
      <article class="scenario-card">
        <div class="coverage-ring" :style="{ '--coverage': appState.coverageRate }">
          <div><strong>{{ appState.coverageRate }}%</strong><span>30 分鐘覆蓋率</span></div>
        </div>
        <div class="scenario-copy">
          <h2>年度 {{ appState.annualCost.toLocaleString() }} 萬元</h2>
          <p>
            增設 {{ appState.budget.fixed }} 個實體據點、{{ appState.budget.popup }} 個巡迴駐點與
            {{ appState.budget.mobile }} 輛行動服務車，預估可將服務覆蓋率由 72% 提升至 {{ appState.coverageRate }}%。
          </p>
        </div>
      </article>
    </div>
  </section>
</template>
