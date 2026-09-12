<script setup>
defineProps({
  rows: { type: Array, default: function () { return []; } },
  showRank: { type: Boolean, default: false },
});

function formatRatio(value) {
  return value === null ? "—" : value.toFixed(1) + "%";
}
</script>

<template>
  <ol class="mortality-chart-bars" :class="{ 'show-rank': showRank }">
    <li v-for="(row, index) in rows" :key="row.area" class="mortality-chart-row"
        :title="row.ratio === null
          ? row.area + '：當年度無20~29歲死亡紀錄'
          : row.area + '：自殺死亡 ' + row.suicideDeaths + ' 人／全部死亡 ' + row.totalDeaths + ' 人'">
      <span v-if="showRank" class="mortality-chart-rank">{{ index + 1 }}</span>
      <span class="resource-chart-label mortality-chart-label">
        <span>{{ row.area }}</span>
        <small v-if="row.isLowSample" class="mortality-sample-tag">樣本少</small>
        <small v-else-if="row.totalDeaths === 0" class="mortality-sample-tag is-empty">無紀錄</small>
      </span>
      <span class="resource-chart-bar is-mortality" aria-hidden="true">
        <i :style="{ width: (row.ratio === null ? 0 : row.ratio) + '%' }"></i>
      </span>
      <strong class="resource-chart-value mortality-chart-value">
        {{ formatRatio(row.ratio) }}
        <small>（{{ row.suicideDeaths }}/{{ row.totalDeaths }}）</small>
      </strong>
    </li>
  </ol>
</template>
