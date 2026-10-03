<script setup>
import { computed } from 'vue'
import { useEventStore } from '@/store/event'

const store = useEventStore()
const ov = computed(() => store.overview || {})

const tot = computed(() => store.sports.length)
const doneTotal = computed(() => ov.value.finishedMatches || 0)
const prog = computed(() => tot.value ? Math.round((doneTotal.value / Math.max(1, doneTotal.value + (ov.value.pendingMatches || 0))) * 100) : 0)
</script>

<template>
  <div v-if="store.loaded">
    <div class="page-h">
      <div><h2>🏟️ 赛事总览</h2><div class="sub">第 3 届青春杯运动会 · 实时赛况与进度</div></div>
      <div class="row">
        <button class="btn ghost sm" @click="store.refresh">🔄 刷新</button>
      </div>
    </div>

    <div class="grid" style="grid-template-columns:repeat(5,1fr)">
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#ff7a2f,#ffb27e)"></span><span class="ic">🏅</span><b>{{ tot }}</b><em>比赛项目</em></div>
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#2f9bff,#79c4ff)"></span><span class="ic">🗓️</span><b>{{ doneTotal }}</b><em>已完赛场次</em></div>
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#dd5b5b,#f0a1a1)"></span><span class="ic">⏳</span><b>{{ ov.pendingMatches || 0 }}</b><em>待赛预约</em></div>
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#ffb92b,#ffd98a)"></span><span class="ic">🧑‍⚖️</span><b>{{ ov.crewCoverage ? ov.crewCoverage.filled + '/' + ov.crewCoverage.need : '—' }}</b><em>执法席位已排{{ ov.crewCoverage ? '（' + ov.crewCoverage.pct + '%）' : '' }}</em></div>
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#22c15e,#7edda4)"></span><span class="ic">⛳</span><b>{{ prog }}%</b><em>整体完成度</em></div>
    </div>

    <div class="grid g2 mt">
      <!-- 项目进度 -->
      <div class="card">
        <div class="caption">📋 各项目赛程进度 <span class="hint">完成场次 / 总场次</span></div>
        <div class="pad" style="display:flex;flex-direction:column;gap:16px">
          <div v-for="s in ov.sportDone" :key="s.id">
            <div class="row spread" style="margin-bottom:7px">
              <span class="badge">{{ s.name }}</span>
              <span class="tag" :class="s.done >= s.total ? 'g' : 'o'">{{ s.done }}/{{ s.total }} · {{ s.done >= s.total ? '收官' : '进行中' }}</span>
            </div>
            <div class="hbar"><i :style="{ width: (s.total ? (s.done / s.total) * 100 : 0) + '%', background: s.done >= s.total ? 'var(--accent2)' : 'var(--accent)' }"></i></div>
          </div>
        </div>
      </div>
      <!-- 最新赛果 -->
      <div class="card">
        <div class="caption">🏁 最近完赛/待赛场次</div>
        <div class="pad" style="display:flex;flex-direction:column;gap:10px">
          <div v-for="m in ov.recent" :key="m.id" class="mcard" :class="{ done: m.status === 'finished' }">
            <div class="mheader"><span>{{ m.teamA?.name }} · {{ m.stage }}{{ m.group_name || '' }}</span><span>⚽ {{ m.venue?.name }}</span></div>
            <div class="mrow">
              <span class="t"><span class="badge"><span class="dot" :style="{ background: store.unitOfUid(m.teamA?.unit_id)?.color }"></span>{{ m.teamA?.name || '待定' }}</span></span>
              <span class="score-chip ph" v-if="m.status==='scheduled'">— : —</span>
              <span class="score-chip ph" v-else-if="m.status==='void'">已取消</span>
              <span class="score-chip" v-else>{{ m.score_a }} : {{ m.score_b }}<template v-if="m.tb_a != null">（决胜 {{ m.tb_a }}:{{ m.tb_b }}）</template></span>
              <span class="t" style="text-align:right"><span class="badge">{{ m.teamB?.name || '待定' }}<span class="dot" :style="{ background: store.unitOfUid(m.teamB?.unit_id)?.color }"></span></span></span>
            </div>
            <div v-if="m.note" class="note-line">📝 {{ m.note }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 奖牌速览 -->
    <div class="card mt">
      <div class="caption">🥇 奖牌榜速览</div>
      <div class="pad">
        <table>
          <thead><tr><th>#</th><th>参赛单位</th><th>🏅 金</th><th>🥈 银</th><th>🥉 铜</th><th>总数</th></tr></thead>
          <tbody>
            <tr v-for="(m, i) in store.medals.slice(0, 4)" :key="m.unit_id">
              <td><b>{{ i + 1 }}</b></td>
              <td><span class="badge"><span class="dot" :style="{ background: store.unitOfUid(m.unit_id)?.color }"></span>{{ m.name }}</span></td>
              <td class="mono" style="color:var(--gold);font-weight:800">{{ m.gold }}</td>
              <td class="mono">{{ m.silver }}</td>
              <td class="mono">{{ m.bronze }}</td>
              <td class="mono"><b>{{ m.gold + m.silver + m.bronze }}</b></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.note-line { font-size: 12px; color: var(--muted); margin-top: 6px; padding: 5px 9px; background: var(--bg2); border-radius: 8px; }
</style>