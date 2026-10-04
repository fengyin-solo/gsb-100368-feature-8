<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="recompute">按已复核气象重算火险</button>
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>

    <h3 class="board-title">火险预警看板</h3>
    <div class="warning-board">
      <article
        v-for="item in board"
        :key="item.label"
        class="warning-card"
        :class="item.cls"
      >
        <span class="warning-label">{{ item.label }}</span>
        <strong class="warning-value">{{ item.value }}</strong>
      </article>
    </div>
    <p class="board-note">
      等级来源：各监测点最新「已复核」气象观测记录；要素缺测或异常未修正的记录不参与重算。
      <span v-if="recomputeMessage" class="ok-text">{{ recomputeMessage }}</span>
    </p>

    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>
    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { loadOverview, listEntries } from '@/api/local-service'
import { recomputeAllFromWeather } from '@/api/weather-service'
import type { OverviewResult } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const recomputeMessage = ref('')

const gradeMeta = [
  { label: '正常', key: '正常', cls: 'is-normal' },
  { label: '蓝色预警', key: '蓝色预警', cls: 'is-blue' },
  { label: '黄色预警', key: '黄色预警', cls: 'is-yellow' },
  { label: '橙色预警', key: '橙色预警', cls: 'is-orange' },
  { label: '红色预警', key: '红色预警', cls: 'is-red' },
] as const

type WarningCard = { label: string; key: string; cls: string; value: number }

function warningCards(): WarningCard[] {
  const firewatch = listEntries('firewatch').items
  return gradeMeta.map((item) => ({
    label: item.label,
    key: item.key,
    cls: item.cls,
    value: firewatch.filter((row) => String(row.status) === item.key).length,
  }))
}
const board = ref<WarningCard[]>(warningCards())

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  board.value = warningCards()
}

function recompute() {
  const result = recomputeAllFromWeather()
  recomputeMessage.value = `已按 ${result.stations} 个站点最新复核记录重算，全域最高等级「${result.grade}」`
  refresh()
}

onMounted(refresh)
</script>
