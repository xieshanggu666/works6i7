<script setup>
import { ref, computed } from 'vue'
import { useEventStore } from '@/store/event'

const store = useEventStore()
const filter = ref('all')
const toast = ref('')

const sports = computed(() => store.sports)
const list = computed(() => store.matches.filter(m => filter.value === 'all' || m.sport_id === Number(filter.value)))

async function ko(sid, name) {
  const msg = await store.genKO(sid)
  toast.value = msg || `${name} 当前无可编排的新一轮淘汰赛场次`
  setTimeout(() => toast.value = '', 2600)
}

const iconOf = s => ({ '球类': '🏀', '田径': '🏃', '水上': '🏊', '棋牌': '♟️' }[s.category] || '🏅')

const settled = m => m.status === 'finished' || m.status === 'void'
const canKO = sid => {
  const s = store.sports.find(x => x.id === sid)
  if (!s || s.format === 'roundrobin' || s.format === 'track') return false
  const ms = store.matches.filter(m => m.sport_id === sid)
  const hasFinal = ms.some(m => m.stage === '决赛')
  if (s.format === 'knockout') {
    const semis = ms.filter(m => m.stage === '半决赛')
    return !hasFinal && semis.length > 0 && semis.every(settled)
  }
  const groups = ['A组', 'B组']
  const grouped = groups.every(g => { const gms = ms.filter(m => m.group_name === g); return gms.length > 0 && gms.every(settled) })
  const hasSemi = ms.some(m => m.stage === '半决赛')
  const semis = ms.filter(m => m.stage === '半决赛')
  if (!hasSemi) return grouped
  return !hasFinal && semis.length > 0 && semis.every(settled)
}
</script>

<template>
  <div v-if="store.loaded">
    <div class="page-h">
      <div><h2>🗓️ 赛程编排</h2><div class="sub">自动对阵排程 · 小组循环与淘汰赛推进</div></div>
      <div class="filters">
        <button class="chip" :class="{ on: filter === 'all' }" @click="filter = 'all'">全部</button>
        <button v-for="s in sports" :key="s.id" class="chip" :class="{ on: filter === String(s.id) }" @click="filter = String(s.id)">{{ s.name }}</button>
      </div>
    </div>

    <div v-if="toast" class="toast">✅ {{ toast }}</div>

    <div class="grid g2">
      <div v-for="s in (filter==='all' ? sports : sports.filter(x=>x.id===Number(filter)))" :key="s.id" class="card">
        <div class="caption">
          <span class="badge">{{ iconOf(s) }} {{ s.name }}</span>
          <div class="row">
            <span class="tag gray">{{ s.category }}</span>
            <button v-if="canKO(s.id)" class="btn primary sm" @click="ko(s.id, s.name)">🧩 编排下一轮淘汰赛</button>
          </div>
        </div>
        <div class="pad" style="display:flex;flex-direction:column;gap:10px;max-height:520px;overflow:auto">
          <div v-for="m in list.filter(x=>x.sport_id===s.id).sort((a,b)=>a.order_no-b.order_no)" :key="m.id" class="mcard" :class="{ done: m.status==='finished' }">
            <div class="mheader">
              <span><span class="tag" :class="m.status==='finished' ? '' : m.status==='void' ? 'r' : 'o'">{{ m.stage }}{{ m.group_name ? ' · ' + m.group_name : '' }}</span></span>
              <span>⏱ {{ m.time_label }}</span>
            </div>
            <div class="mrow">
              <span class="t"><span class="badge"><span class="dot" :style="{ background: store.unitOfUid(m.teamA?.unit_id)?.color }"></span>{{ m.teamA?.name || '待定' }}</span></span>
              <span class="score-chip ph" v-if="m.status==='scheduled'">VS</span>
              <span class="score-chip ph" v-else-if="m.status==='void'">已取消</span>
              <span class="score-chip" v-else>{{ m.score_a }}:{{ m.score_b }}<template v-if="m.tb_a != null">（决胜 {{ m.tb_a }}:{{ m.tb_b }}）</template></span>
              <span class="t" style="text-align:right"><span class="badge">{{ m.teamB?.name || '待定' }}<span class="dot" :style="{ background: store.unitOfUid(m.teamB?.unit_id)?.color }"></span></span></span>
            </div>
            <div v-if="m.note" class="note-line">📝 {{ m.note }}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:8px">
              📍 {{ m.venue?.name }}
              <span v-if="m.status==='scheduled'" style="margin-left:8px">
                🧑‍⚖️ {{ store.crewOf(m.id).map(a => (a.role === 'chief' ? '主' : a.role === 'assistant' ? '助' : '台') + a.referee?.name).join(' · ') || '执法名单待安排' }}
              </span>
              <span style="float:right" :class="m.status==='finished' ? 'tag g' : m.status==='void' ? 'tag r' : 'tag o'">{{ m.status==='finished' ? '已完赛' : m.status==='void' ? '已取消' : '待赛' }}</span>
            </div>
          </div>
          <div v-if="!list.filter(x=>x.sport_id===s.id).length" class="empty">暂无场次</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.note-line { font-size: 12px; color: var(--muted); margin-top: 6px; padding: 5px 9px; background: var(--bg2); border-radius: 8px; }
</style>