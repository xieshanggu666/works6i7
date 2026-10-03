<script setup>
import { ref, computed } from 'vue'
import { useEventStore } from '@/store/event'
const store = useEventStore()
const cur = ref('all')
const ballSports = computed(() => store.sports.filter(s => s.format !== 'track'))
const sport = computed(() => cur.value === 'all' ? ballSports.value[0] : ballSports.value.find(x => x.id === Number(cur.value)))
const standings = computed(() => sport.value ? (store.standings[sport.value.id] || []) : [])
const matches = computed(() => sport.value ? store.matches.filter(m => m.sport_id === sport.value.id) : [])

const rankCls = r => r === 1 ? '#d99a00' : r === 2 ? '#90a4ae' : r === 3 ? '#c9743a' : 'var(--muted)'
const stages = computed(() => {
  if (!sport.value) return []
  const ms = matches.value
  if (sport.value.format === 'roundrobin') return [{ name: '单循环 · 循环赛', items: ms.filter(m => m.stage === '循环') }]
  if (sport.value.format === 'knockout') return [
    { name: '半决赛', items: ms.filter(m => m.stage === '半决赛') },
    { name: '决赛', items: ms.filter(m => m.stage === '决赛') },
    { name: '季军战', items: ms.filter(m => m.stage === '季军') }
  ]
  return [
    { name: 'A 组', items: ms.filter(m => m.group_name === 'A组') },
    { name: 'B 组', items: ms.filter(m => m.group_name === 'B组') },
    { name: '半决赛', items: ms.filter(m => m.stage === '半决赛') },
    { name: '决赛', items: ms.filter(m => m.stage === '决赛') },
    { name: '季军战', items: ms.filter(m => m.stage === '季军') }
  ]
})
function w(m) { return m.status === 'finished' && m.winner != null ? (m.winner === m.team_a ? m.teamA : m.teamB) : null }
function l(m) { return m.status === 'finished' && m.winner != null ? (m.winner === m.team_a ? m.teamB : m.teamA) : null }
</script>

<template>
  <div v-if="store.loaded" class="row wrap" style="align-items:flex-start;gap:16px">
    <div class="page-h" style="width:100%;margin-bottom:6px">
      <div><h2>🧩 对阵与积分</h2><div class="sub">积分榜按 胜3/平1 自动排名；淘汰赛当前回合可视化</div></div>
      <div class="filters">
        <button v-for="s in ballSports" :key="s.id" class="chip" :class="{ on: cur === String(s.id) }" @click="cur = String(s.id)">{{ s.name }}</button>
      </div>
    </div>

    <!-- 积分榜 -->
    <div class="card" style="flex:1;min-width:380px">
      <div class="caption">📈 {{ sport?.name }} · 积分榜</div>
      <div class="pad">
        <table>
          <thead><tr><th>#</th><th>队伍</th><th>赛</th><th>胜</th><th>平</th><th>负</th><th>进:失</th><th>积分</th></tr></thead>
          <tbody>
            <tr v-for="r in standings" :key="r.id">
              <td><b :style="{ color: rankCls(r.rank) }">{{ r.rank }}</b></td>
              <td><span class="badge"><span class="dot" :style="{ background: r.color }"></span>{{ r.tname }}<span class="tag gray" style="margin-left:6px">{{ r.unit }}</span></span></td>
              <td>{{ r.play }}</td><td style="color:var(--accent2);font-weight:700">{{ r.win }}</td>
              <td>{{ r.draw }}</td><td style="color:#e5484d">{{ r.lose }}</td>
              <td class="mono">{{ r.gf }}:{{ r.ga }}</td>
              <td><b class="mono" style="font-size:16px;color:var(--accent)">{{ r.points }}</b></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 赛程分组视图 -->
    <div class="grid g2" style="flex:2;min-width:460px">
      <div v-for="(st, si) in stages.filter(x=>x.items.length)" :key="st.name" class="card">
        <div class="caption"><span class="badge">{{ st.name }}</span><span class="hint">{{ st.items.length }} 场</span></div>
        <div class="pad" style="display:flex;flex-direction:column;gap:9px">
          <div v-for="m in st.items" :key="m.id" class="mcard" :class="{ done: m.status==='finished' }">
            <div class="mrow">
              <span class="t" :class="{ win: m.winner != null && m.winner === m.team_a }"><span class="badge"><span class="dot" :style="{ background: store.unitOfUid(m.teamA?.unit_id)?.color }"></span>{{ m.teamA?.name || '待定' }}</span></span>
              <span class="score-chip" v-if="m.status==='finished'">{{ m.score_a }}:{{ m.score_b }}<template v-if="m.tb_a != null">（决胜 {{ m.tb_a }}:{{ m.tb_b }}）</template></span>
              <span class="score-chip ph" v-else-if="m.status==='void'">已取消</span>
              <span class="score-chip ph" v-else>VS</span>
              <span class="t" :class="{ win: m.winner != null && m.winner === m.team_b }" style="text-align:right"><span class="badge">{{ m.teamB?.name || '待定' }}<span class="dot" :style="{ background: store.unitOfUid(m.teamB?.unit_id)?.color }"></span></span></span>
            </div>
            <div v-if="m.note" class="note-line">📝 {{ m.note }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.win { color: var(--accent2); font-weight: 800; }
.note-line { font-size: 12px; color: var(--muted); margin-top: 6px; padding: 5px 9px; background: var(--bg2); border-radius: 8px; }
</style>