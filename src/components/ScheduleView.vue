<script setup>
import { ref, computed, reactive } from 'vue'
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
const TIME_PRESETS = ['09:00', '09:20', '09:30', '09:40', '10:00', '10:20', '10:40', '11:00', '11:20', '12:30', '13:00', '14:00', '14:30', '15:30', '16:00']
const scDlg = reactive({ show: false, mid: 0, status: 'scheduled', time_label: '', venue_id: '', reason: '', error: '', conflicts: null, auto_rearrange: true })
function openSchedule(m) {
  scDlg.show = true; scDlg.mid = m.id; scDlg.status = m.status
  scDlg.time_label = m.time_label || ''; scDlg.venue_id = m.venue_id || ''
  scDlg.reason = ''; scDlg.error = ''; scDlg.conflicts = null; scDlg.auto_rearrange = true
}
async function submitSchedule(force = false) {
  if (scDlg.status === 'finished' && !scDlg.reason.trim()) {
    scDlg.error = '更正已完赛场次的历史赛程必须填写原因'
    return
  }
  try {
    const r = await store.changeSchedule(scDlg.mid, {
      time_label: scDlg.time_label,
      venue_id: scDlg.venue_id ? Number(scDlg.venue_id) : null,
      reason: scDlg.reason.trim() || (scDlg.status === 'finished' ? '历史赛程更正' : '赛程调整'),
      force,
      auto_rearrange: scDlg.auto_rearrange
    })
    scDlg.show = false
    toast.value = r.unchanged
      ? '赛程未发生变化'
      : r.status === 'finished'
        ? '已完赛场次历史赛程已更正，执法归档保持不变'
        : `赛程已保存：自动重排 ${r.rearranged?.length || 0} 席、补齐 ${r.auto_filled?.length || 0} 席`
    setTimeout(() => toast.value = '', 3200)
  } catch (e) {
    if (e.status === 409) { scDlg.conflicts = e.conflicts; scDlg.error = e.message }
    else scDlg.error = e.message
  }
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
              <button v-if="m.status !== 'void'" class="btn ghost sm" @click="openSchedule(m)">{{ m.status === 'finished' ? '📦 更正赛程记录' : '🕐 改期/换场' }}</button>
              <span :class="m.status==='finished' ? 'tag g' : m.status==='void' ? 'tag r' : 'tag o'">{{ m.status==='finished' ? '已完赛' : m.status==='void' ? '已取消' : '待赛' }}</span>
            </div>
          </div>
          <div v-if="!list.filter(x=>x.sport_id===s.id).length" class="empty">暂无场次</div>
        </div>
      </div>
    </div>
    <div v-if="scDlg.show" class="modal-mask" @click.self="scDlg.show = false">
      <div class="modal">
        <h3>{{ scDlg.status === 'finished' ? '📦 更正已完赛场次历史赛程' : '🕐 调整赛程时间 / 场地' }}</h3>
        <div v-if="scDlg.status === 'finished'" class="conf-box y">已完赛场次仅更正时间/场地档案；比分、积分和执法名单不会重排，更正原因会写入留痕。</div>
        <div class="row wrap mt8" style="gap:12px">
          <label>开赛时间
            <input v-model="scDlg.time_label" list="schedule-time-presets" placeholder="如 10:00" style="width:130px;margin-left:6px" />
            <datalist id="schedule-time-presets"><option v-for="t in TIME_PRESETS" :key="t" :value="t" /></datalist>
          </label>
          <label>比赛场地
            <select v-model="scDlg.venue_id" style="width:160px;margin-left:6px">
              <option value="">未指定场地</option>
              <option v-for="v in store.venues" :key="v.id" :value="v.id">{{ v.name }}</option>
            </select>
          </label>
        </div>
        <label v-if="scDlg.status === 'scheduled'" class="row mt8"><input type="checkbox" v-model="scDlg.auto_rearrange" />自动重排冲突裁判并补齐本场执法席位；无法解决时整单回滚</label>
        <textarea v-model="scDlg.reason" rows="2" class="mt8" :placeholder="scDlg.status === 'finished' ? '历史赛程更正原因（必填）' : '变更原因（将写入留痕）'" style="width:100%"></textarea>
        <div v-if="scDlg.conflicts" class="conf-box mt8">
          <div v-if="scDlg.conflicts.venue?.length"><b>🏟️ 场地撞场：</b><div v-for="(c,i) in scDlg.conflicts.venue" :key="'v'+i" class="conf-line">⛔ {{ c.title }}（{{ c.status === 'finished' ? '已完赛归档' : '待赛' }}）</div></div>
          <div v-if="scDlg.conflicts.referee?.length"><b>🧑‍⚖️ 裁判时间冲突：</b><div v-for="(c,i) in scDlg.conflicts.referee" :key="'r'+i" class="conf-line">⛔ {{ c.referee }} 同时执法 {{ c.title }}</div></div>
        </div>
        <div v-if="scDlg.error" class="tag r mt8">{{ scDlg.error }}</div>
        <div class="row spread mt16">
          <button class="btn ghost sm" @click="scDlg.show = false">取消</button>
          <div class="row">
            <button v-if="scDlg.conflicts" class="btn ghost sm" @click="submitSchedule(true)">强制保留冲突并留痕</button>
            <button class="btn primary sm" @click="submitSchedule(false)">保存变更</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.note-line { font-size: 12px; color: var(--muted); margin-top: 6px; padding: 5px 9px; background: var(--bg2); border-radius: 8px; }
.modal-mask { position: fixed; inset: 0; background: rgba(29,39,51,.42); display: grid; place-items: center; z-index: 1000; }
.modal { background: #fff; border-radius: 16px; padding: 22px; width: 520px; max-width: calc(100vw - 40px); box-shadow: var(--shadow); }
.modal h3 { font-size: 17px; margin-bottom: 12px; }
.conf-box { background: #fff5f5; border: 1px solid #f0a1a1; border-radius: 10px; padding: 10px 12px; font-size: 12px; margin-top: 10px; }
.conf-box.y { background: #fff6dd; border-color: #f0d68a; }
.conf-line { margin-top: 5px; }
</style>