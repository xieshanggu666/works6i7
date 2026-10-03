<script setup>
import { computed } from 'vue'
import { useEventStore } from '@/store/event'
const store = useEventStore()
const sorted = computed(() => store.medals.slice().sort((a, b) => (b.gold - a.gold) || (b.silver - a.silver) || (b.bronze - a.bronze) || a.unit_id - b.unit_id))
</script>

<template>
  <div v-if="store.loaded">
    <div class="page-h">
      <div><h2>🥇 奖牌榜</h2><div class="sub">按 金>银>铜 排序，含各类项目结算</div></div>
    </div>

    <div class="grid g2">
      <div class="card">
        <div class="caption">🏆 各单位奖牌榜</div>
        <div class="pad">
          <table>
            <thead><tr><th>#</th><th>单位</th><th class="gold">🥇金</th><th>🥈银</th><th>🥉铜</th><th>总数</th></tr></thead>
            <tbody>
              <tr v-for="(m, i) in sorted" :key="m.unit_id">
                <td><b :style="{ color: i===0 ? 'var(--gold)' : i===1 ? '#90a4ae' : i===2 ? '#c9743a' : 'var(--muted)' }">{{ i + 1 }}</b></td>
                <td><span class="badge"><span class="dot" :style="{ background: store.unitOfUid(m.unit_id)?.color }"></span>{{ m.name }}</span></td>
                <td><b class="mono" style="font-size:18px;color:var(--gold)">{{ m.gold }}</b></td>
                <td class="mono">{{ m.silver }}</td>
                <td class="mono">{{ m.bronze }}</td>
                <td><b class="mono">{{ m.gold + m.silver + m.bronze }}</b></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="caption">📊 金牌构成 —— 各项目冠军归属</div>
        <div class="pad" style="display:flex;flex-direction:column;gap:14px">
          <div v-for="s in store.sports" :key="s.id">
            <div class="row spread" style="margin-bottom:7px">
              <span class="badge">{{ s.name }}</span>
              <span class="tag" v-if="s.format==='track'">🏃 单项</span>
              <span class="tag" v-else-if="s.format==='roundrobin'">🔁 循环</span>
              <span class="tag" v-else>🏆 淘汰</span>
            </div>
          </div>
          <div class="empty" v-if="!sorted.length">暂无奖牌数据</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gold { color: var(--gold); }
</style>