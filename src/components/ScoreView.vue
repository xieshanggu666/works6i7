<script setup>
import { ref, computed, reactive } from 'vue'
import { useEventStore } from '@/store/event'

const store = useEventStore()
const curSport = ref('all')
const active = ref(null)
const toast = ref('')

const ballSports = computed(() => store.sports.filter(s => s.format !== 'track'))
const matches = computed(() => store.matches.filter(m => {
  const s = store.sports.find(x => x.id === m.sport_id)
  if (curSport.value !== 'all' && m.sport_id !== Number(curSport.value)) return false
  return s && s.format !== 'track'
}))
const trackSports = computed(() => store.sports.filter(s => s.format === 'track'))

const KO_STAGES = ['半决赛', '决赛', '季军']
const isKO = m => KO_STAGES.includes(m?.stage)
const winnerName = m => (m.winner != null && m.winner === m.team_a ? m.teamA?.name : m.teamB?.name)

const sa = ref(0), sb = ref(0), ta = ref(null), tb = ref(null)
function open(m) { active.value = m; sa.value = m.score_a ?? 0; sb.value = m.score_b ?? 0; ta.value = null; tb.value = null }
// 淘汰赛常规时间平分 → 必须录入加时/点球决胜比分
const needTB = computed(() => !!active.value && isKO(active.value) && sa.value === sb.value)
async function saveScore() {
  if (needTB.value && (!Number.isInteger(ta.value) || !Number.isInteger(tb.value) || ta.value < 0 || tb.value < 0 || ta.value === tb.value)) {
    toast.value = '⚠️ 淘汰赛平分需录入加时/点球决胜比分，且决胜比分不能再次持平'
    setTimeout(() => toast.value = '', 2600)
    return
  }
  try {
    const r = await store.score(active.value.id, sa.value, sb.value, needTB.value ? ta.value : null, needTB.value ? tb.value : null)
    toast.value = r?.warning ? '⚠️ ' + r.warning : '✅ 比分已录入，积分榜与执法记录已更新'
    active.value = null
  } catch (e) {
    toast.value = '⚠️ ' + e.message
  }
  setTimeout(() => toast.value = '', 3000)
}

const tr = reactive({})
const getMark = e => tr[e.athlete_id] ?? (e.mark ?? '')
// 保留原始字符串输入，避免空值被 Number('') 转成 0 混入结算
const setMark = (e, ev) => { tr[e.athlete_id] = ev.target.value }
// 空成绩排到最后，防止未录入行靠 NaN/0 排到榜首
const sortEntries = list => [...list].sort((a, b) => {
  const ma = Number(tr[a.athlete_id] ?? a.mark), mb = Number(tr[b.athlete_id] ?? b.mark)
  const ea = Number.isFinite(ma) && ma > 0, eb = Number.isFinite(mb) && mb > 0
  if (ea !== eb) return ea ? -1 : 1
  if (!ea && !eb) return 0
  return ma - mb
})
async function saveTrack(sid) {
  const list = store.entries.filter(e => e.sport_id === sid)
  if (!list.length) {
    toast.value = '⚠️ 本项目暂无可结算的运动员成绩'
    setTimeout(() => toast.value = '', 2600)
    return
  }
  const payload = []
  const ids = new Set()
  for (const e of list) {
    const raw = tr[e.athlete_id] ?? e.mark
    const v = raw === '' || raw == null ? NaN : Number(raw)
    if (!Number.isFinite(v) || v <= 0) {
      toast.value = `⚠️ 运动员「${e.aname}」成绩为空或无效，请填写大于 0 的秒数`
      setTimeout(() => toast.value = '', 3000)
      return
    }
    if (ids.has(e.athlete_id)) {
      toast.value = `⚠️ 运动员「${e.aname}」重复出现，结算已中止`
      setTimeout(() => toast.value = '', 3000)
      return
    }
    ids.add(e.athlete_id)
    payload.push({ athlete_id: e.athlete_id, mark: v })
  }
  payload.sort((a, b) => a.mark - b.mark)
  try {
    await store.saveTrack(sid, payload)
    Object.keys(tr).forEach(k => delete tr[k])
    toast.value = '✅ 田径成绩已校验并按时间排序结算金/银/铜'
  } catch (e) {
    toast.value = '⚠️ ' + e.message
  }
  setTimeout(() => toast.value = '', 3000)
}
const rankCls = r => r === 1 ? '#d99a00' : r === 2 ? '#90a4ae' : r === 3 ? '#c9743a' : 'var(--muted)'
</script>

<template>
  <div v-if="store.loaded">
    <div class="page-h">
      <div><h2>⚡ 成绩录入</h2><div class="sub">录入比分自动更新积分排名；田径按成绩计时结算奖项</div></div>
      <div v-if="toast" class="toast">{{ toast }}</div>
      <div class="filters">
        <button class="chip" :class="{ on: curSport === 'all' }" @click="curSport = 'all'">全部球类</button>
        <button v-for="s in ballSports" :key="s.id" class="chip" :class="{ on: curSport === String(s.id) }" @click="curSport = String(s.id)">{{ s.name }}</button>
      </div>
    </div>

    <div class="grid g2">
      <div v-for="m in matches" :key="m.id" class="mcard" :class="{ done: m.status==='finished' }">
        <div class="mheader">
          <span>{{ store.sports.find(x=>x.id===m.sport_id)?.name }} · {{ m.stage }}{{ m.group_name ? ' · ' + m.group_name : '' }}</span>
          <span class="tag" :class="m.status==='finished' ? 'g' : m.status==='void' ? 'r' : 'o'">{{ m.status==='finished' ? '已完赛' : m.status==='void' ? '已取消' : '待赛' }}</span>
        </div>
        <div class="mrow">
          <span class="t"><span class="badge"><span class="dot" :style="{ background: store.unitOfUid(m.teamA?.unit_id)?.color }"></span>{{ m.teamA?.name }}</span></span>
          <template v-if="active?.id === m.id">
            <input v-model.number="sa" type="number" min="0" class="score-in" style="width:52px"> :
            <input v-model.number="sb" type="number" min="0" class="score-in" style="width:52px">
          </template>
          <template v-else>
            <span class="score-chip ph" v-if="m.status==='scheduled'">—</span>
            <span class="score-chip ph" v-else-if="m.status==='void'">已取消</span>
            <span class="score-chip" v-else>{{ m.score_a }}:{{ m.score_b }}<template v-if="m.tb_a != null">（决胜 {{ m.tb_a }}:{{ m.tb_b }}）</template></span>
          </template>
          <span class="t" style="text-align:right"><span class="badge">{{ m.teamB?.name }}<span class="dot" :style="{ background: store.unitOfUid(m.teamB?.unit_id)?.color }"></span></span></span>
        </div>
        <div v-if="m.note" class="note-line">📝 {{ m.note }}</div>
        <div class="crew-line">
          <template v-if="store.crewOf(m.id).length">
            <span v-for="a in store.crewOf(m.id)" :key="a.id" class="tag" :class="a.role === 'chief' ? 'b' : 'gray'">
              {{ a.role === 'chief' ? '🧑‍⚖️ 主裁' : a.role === 'assistant' ? '🚩 助理' : '📋 记录台' }}：{{ a.referee?.name }}
            </span>
          </template>
          <span v-if="m.status==='scheduled' && !store.chiefOf(m.id)" class="tag o">🟠 尚未安排主裁</span>
        </div>
        <div v-if="active?.id === m.id && needTB" class="tbrow">
          <span>⚔️ 常规时间平分 · 加时/点球决胜：</span>
          <input v-model.number="ta" type="number" min="0" class="score-in" style="width:48px">
          <b>:</b>
          <input v-model.number="tb" type="number" min="0" class="score-in" style="width:48px">
        </div>
        <div class="row mt8" style="justify-content:flex-end">
          <button v-if="active?.id !== m.id && m.status==='scheduled'" class="btn primary sm" @click="open(m)">✍️ 录入比分</button>
          <template v-if="active?.id === m.id">
            <button class="btn ghost sm" @click="active=null">取消</button>
            <button class="btn green sm" @click="saveScore">保存赛果</button>
          </template>
          <template v-else-if="m.status==='finished'">
            <span v-if="isKO(m) && m.winner != null" class="tag y">🏆 {{ winnerName(m) }}</span>
            <span class="tag g">✔ 已结算</span>
          </template>
        </div>
      </div>
    </div>

    <div class="card mt" v-for="s in trackSports" :key="'t' + s.id">
      <div class="caption"><span class="badge">🏃 {{ s.name }}</span><span class="hint">按成绩(秒)升序自动排名，前 3 结算金/银/铜</span></div>
      <div class="pad">
        <table>
          <thead><tr><th>#</th><th>运动员</th><th>单位</th><th>成绩(秒)</th></tr></thead>
          <tbody>
            <tr v-for="(e, i) in sortEntries(store.entries.filter(x=>x.sport_id===s.id))" :key="e.id">
              <td><b :style="{ color: rankCls(e.rank), fontSize:'16px' }">{{ e.rank ?? '—' }}</b></td>
              <td>{{ e.aname }}</td>
              <td><span class="badge"><span class="dot" :style="{ background: store.unitOfUid(e.unit_id)?.color }"></span>{{ e.unit }}</span></td>
              <td><input :value="getMark(e)" @input="setMark(e, $event)" type="number" step="0.01" min="0.01" placeholder="待录" style="width:90px" /> <span class="tag gray mt8" style="margin-left:6px">s</span></td>
            </tr>
          </tbody>
        </table>
        <div class="row mt16" style="justify-content:flex-end">
          <button class="btn primary" @click="saveTrack(s.id)">💾 结算本项成绩</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.score-in { font-weight: 800; font-size: 15px; text-align: center; }
.tbrow { display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 8px; padding: 7px 10px; border-radius: 10px; background: #fff7ed; border: 1px dashed var(--accent); font-size: 12px; color: var(--muted); }
.note-line { font-size: 12px; color: var(--muted); margin-top: 8px; padding: 5px 9px; background: var(--bg2); border-radius: 8px; }
.crew-line { margin-top: 8px; }
</style>