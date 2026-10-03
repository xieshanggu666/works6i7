<script setup>
import { ref, computed, reactive } from 'vue'
import { useEventStore } from '@/store/event'
const store = useEventStore()

const toast = ref('')
const showToast = msg => { toast.value = msg; setTimeout(() => toast.value = '', 3200) }

/* ---------- 提交报名 ---------- */
const form = reactive({ unit_id: null, sport_id: null, name: '' })
const kindOf = sid => store.sports.find(s => s.id === Number(sid))?.format === 'track' ? 'athlete' : 'team'
const kindLabel = computed(() => kindOf(form.sport_id) === 'athlete' ? '运动员' : '队伍')
async function submit() {
  if (!form.unit_id || !form.sport_id) return showToast('⚠️ 请选择参赛单位与比赛项目')
  if (!form.name.trim()) return showToast('⚠️ 请输入' + kindLabel.value + '名称')
  try {
    await store.submitRegistration({ kind: kindOf(form.sport_id), unit_id: Number(form.unit_id), sport_id: Number(form.sport_id), name: form.name.trim() })
    showToast('✅ 报名已提交，等待组委会审核')
    form.name = ''
  } catch (e) { showToast('⚠️ ' + e.message) }
}

/* ---------- 名额 ---------- */
const quotaOf = sid => store.quota.find(q => q.sport_id === sid) || { quota: 8, approved: 0, pending: 0 }

/* ---------- 报名列表 ---------- */
const statusFilter = ref('all')
const sportFilter = ref('all')
const STATUS_META = {
  pending: { tag: 'o', text: '待审核' },
  approved: { tag: 'g', text: '已通过' },
  rejected: { tag: 'r', text: '已驳回' },
  withdrawn: { tag: 'gray', text: '已退报' },
  revoked: { tag: 'r', text: '已撤销' }
}
const list = computed(() => store.registrations.filter(r => {
  if (statusFilter.value !== 'all' && r.status !== statusFilter.value) return false
  if (sportFilter.value !== 'all' && r.sport_id !== Number(sportFilter.value)) return false
  return true
}))

/* ---------- 审核操作 ---------- */
const acting = ref(null)   // 当前展开备注的报名 id
const note = ref('')
function openAct(r) { acting.value = r.id; note.value = r.review_note || '' }
function cancelAct() { acting.value = null; note.value = '' }

async function approve(r) {
  try {
    const res = await store.approveRegistration(r.id)
    showToast(`✅ 已通过资格审核，占用名额 #${res.quota_no}，已纳入参赛名单${r.kind === 'team' ? '与赛程' : ''}`)
  } catch (e) { showToast('⚠️ ' + e.message) }
}
async function reject(r) {
  try { await store.rejectRegistration(r.id, note.value); showToast('✅ 已驳回报名'); cancelAct() }
  catch (e) { showToast('⚠️ ' + e.message) }
}
const impactText = im => {
  const parts = [`弃权 ${im.walkover} 场`, `取消成绩 ${im.voided} 场`]
  if (im.replacements) parts.push(`淘汰赛递补 ${im.replacements} 场`)
  if (im.cascade) parts.push(`后续轮次级联调整 ${im.cascade} 场`)
  if (im.entries) parts.push(`田径成绩 ${im.entries} 条`)
  return parts.join(' · ')
}
async function withdraw(r) {
  try {
    const res = await store.withdrawRegistration(r.id, note.value)
    showToast(`✅ 已退报。同步处理：${impactText(res.impact)}`)
    cancelAct()
  } catch (e) { showToast('⚠️ ' + e.message) }
}
async function revoke(r) {
  try {
    const res = await store.revokeRegistration(r.id, note.value)
    showToast(`✅ 已撤销资格。同步处理：${impactText(res.impact)}`)
    cancelAct()
  } catch (e) { showToast('⚠️ ' + e.message) }
}

const unitColor = uid => store.unitOfUid(uid)?.color || '#ccc'
</script>

<template>
  <div v-if="store.loaded">
    <div class="page-h">
      <div><h2>📝 报名与资格审核</h2><div class="sub">各单位提交队伍与运动员报名 · 组委会审核资格与名额 · 通过后纳入参赛名单与赛程</div></div>
      <div v-if="toast" class="toast">{{ toast }}</div>
    </div>

    <!-- 名额概览 -->
    <div class="grid g4">
      <div v-for="s in store.sports" :key="s.id" class="card stat">
        <span class="bar" :style="{ background: 'linear-gradient(90deg, var(--accent3), #7cc4ff)' }"></span>
        <span class="ic">{{ s.format === 'track' ? '🏃' : '🏀' }}</span>
        <b>{{ quotaOf(s.id).approved }}<span style="font-size:14px;color:var(--muted);font-weight:600"> / {{ quotaOf(s.id).quota }}</span></b>
        <em>{{ s.name }} · 已报名{{ s.format === 'track' ? '运动员' : '队伍' }}</em>
        <div class="hbar" style="margin-top:6px"><i :style="{ width: Math.min(100, (quotaOf(s.id).approved / quotaOf(s.id).quota) * 100) + '%', background: quotaOf(s.id).approved >= quotaOf(s.id).quota ? '#e5484d' : 'var(--accent2)' }"></i></div>
      </div>
    </div>

    <div class="grid g2 mt">
      <!-- 提交报名 -->
      <div class="card">
        <div class="caption">➕ 提交报名 <span class="hint">单位报名参赛队伍 / 运动员</span></div>
        <div class="pad">
          <div class="form-row">
            <label>参赛单位</label>
            <select v-model.number="form.unit_id">
              <option :value="null" disabled>选择单位</option>
              <option v-for="u in store.units" :key="u.id" :value="u.id">{{ u.name }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>比赛项目</label>
            <select v-model.number="form.sport_id">
              <option :value="null" disabled>选择项目</option>
              <option v-for="s in store.sports" :key="s.id" :value="s.id">{{ s.name }}（{{ s.format === 'track' ? '运动员' : '队伍' }}）</option>
            </select>
          </div>
          <div class="form-row">
            <label>{{ kindLabel }}名称</label>
            <input v-model="form.name" :placeholder="'输入' + kindLabel + '名称'" @keyup.enter="submit">
          </div>
          <div class="row mt8" style="justify-content:space-between;align-items:center">
            <span class="hint" v-if="form.sport_id">将报名为：<b :style="{ color: 'var(--accent)' }">{{ kindLabel }}</b> · 占用 {{ kindLabel === '运动员' ? '运动员' : '队伍' }}名额</span>
            <button class="btn primary" @click="submit">📨 提交报名</button>
          </div>
        </div>
      </div>

      <!-- 审核说明 -->
      <div class="card">
        <div class="caption">ℹ️ 审核规则与退报/撤销处理</div>
        <div class="pad" style="font-size:13px;line-height:1.9;color:var(--ink)">
          <p>· 各单位提交报名后状态为 <span class="tag o">待审核</span>，组委会审核<b>资格与名额</b>。</p>
          <p>· 名额按项目核定，<b>通过数不得超过名额上限</b>；通过后状态为 <span class="tag g">已通过</span>，纳入参赛名单。</p>
          <p>· 循环赛项目若<b>尚未开赛</b>，通过后自动重排对阵，把新队伍纳入赛程。</p>
          <p>· <span class="tag gray">已退报</span> / <span class="tag r">已撤销</span> 时同步处理受影响的对阵及成绩：</p>
          <p style="padding-left:14px">— 未赛场次：判弃权，对手 <b>3:0</b> 胜；</p>
          <p style="padding-left:14px">— 已赛场次：<b>取消该场成绩</b>，重算积分榜与奖牌；</p>
          <p style="padding-left:14px">— 田径项目：删除该运动员成绩并重排名。</p>
        </div>
      </div>
    </div>

    <!-- 报名列表 -->
    <div class="card mt">
      <div class="caption">
        <span>📋 报名记录 <span class="hint">共 {{ list.length }} 条</span></span>
        <div class="filters">
          <button class="chip" :class="{ on: statusFilter === 'all' }" @click="statusFilter = 'all'">全部</button>
          <button v-for="(meta, key) in STATUS_META" :key="key" class="chip" :class="{ on: statusFilter === key }" @click="statusFilter = key">{{ meta.text }}</button>
        </div>
      </div>
      <div class="pad">
        <div class="filters" style="margin-bottom:14px">
          <button class="chip" :class="{ on: sportFilter === 'all' }" @click="sportFilter = 'all'">全部项目</button>
          <button v-for="s in store.sports" :key="s.id" class="chip" :class="{ on: sportFilter === String(s.id) }" @click="sportFilter = String(s.id)">{{ s.name }}</button>
        </div>

        <div style="display:flex;flex-direction:column;gap:10px">
          <div v-for="r in list" :key="r.id" class="mcard" :class="{ done: r.status === 'approved' }">
            <div class="mheader">
              <span>
                <span class="badge"><span class="dot" :style="{ background: unitColor(r.unit_id) }"></span>{{ r.unit }}</span>
                <span class="tag b" style="margin-left:6px">{{ r.sport }}</span>
                <span class="tag gray" style="margin-left:4px">{{ r.kind === 'team' ? '队伍' : '运动员' }}</span>
              </span>
              <span class="tag" :class="STATUS_META[r.status]?.tag">{{ STATUS_META[r.status]?.text }}</span>
            </div>
            <div class="mrow">
              <span class="t" style="font-size:15px"><b>{{ r.name }}</b><span v-if="r.quota_no" class="tag y" style="margin-left:8px">名额 #{{ r.quota_no }}</span></span>
              <span class="hint" style="font-size:11px">提交于 {{ r.submitted_at }}</span>
            </div>
            <div v-if="r.review_note" class="note-line">📝 {{ r.review_note }}<span v-if="r.reviewer"> · {{ r.reviewer }}</span><span v-if="r.reviewed_at"> · {{ r.reviewed_at }}</span></div>

            <!-- 操作区 -->
            <div class="row mt8" style="justify-content:flex-end;gap:6px;flex-wrap:wrap">
              <template v-if="r.status === 'pending'">
                <button class="btn primary sm" @click="approve(r)">✅ 通过</button>
                <button class="btn ghost sm" @click="openAct(r)">⛔ 驳回</button>
              </template>
              <template v-else-if="r.status === 'approved'">
                <button class="btn ghost sm" @click="openAct(r)">📤 退报</button>
                <button class="btn sm" style="background:#ffecec;color:#e5484d" @click="openAct(r)">⚔ 撤销资格</button>
              </template>
              <template v-else>
                <span class="hint">已处理完毕</span>
              </template>
            </div>

            <!-- 备注展开 -->
            <div v-if="acting === r.id && (r.status === 'pending' || r.status === 'approved')" class="act-panel">
              <input v-model="note" :placeholder="r.status === 'pending' ? '驳回原因（选填）' : '退报 / 撤销原因（选填）'" style="flex:1;min-width:200px">
              <template v-if="r.status === 'pending'">
                <button class="btn ghost sm" @click="cancelAct">取消</button>
                <button class="btn sm" style="background:#ffecec;color:#e5484d" @click="reject(r)">确认驳回</button>
              </template>
              <template v-else>
                <button class="btn ghost sm" @click="cancelAct">取消</button>
                <button class="btn ghost sm" style="color:var(--accent)" @click="withdraw(r)">确认退报</button>
                <button class="btn sm" style="background:#ffecec;color:#e5484d" @click="revoke(r)">确认撤销资格</button>
              </template>
            </div>
          </div>
          <div v-if="!list.length" class="empty">暂无报名记录</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.form-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.form-row label { width: 78px; flex-shrink: 0; font-size: 12px; color: var(--muted); font-weight: 700; }
.form-row select, .form-row input { flex: 1; }
.note-line { font-size: 12px; color: var(--muted); margin-top: 6px; padding: 5px 9px; background: var(--bg2); border-radius: 8px; }
.act-panel { display: flex; gap: 8px; margin-top: 10px; padding: 10px; background: var(--bg2); border-radius: 10px; align-items: center; flex-wrap: wrap; }
</style>
