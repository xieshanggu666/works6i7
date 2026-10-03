<script setup>
import { ref, computed } from 'vue'
import { useEventStore } from '@/store/event'
const store = useEventStore()
const cur = ref('all')

const teams = computed(() => {
  const ts = store.teams
  return cur.value === 'all' ? ts : ts.filter(t => t.sport_id === Number(cur.value))
})
const athletes = computed(() => {
  const as = store.athletes
  return cur.value === 'all' ? as : as.filter(a => a.sport_id === Number(cur.value))
})
const groupBy = (arr, k) => {
  const m = {}
  arr.forEach(x => { m[x[k]] = m[x[k]] || []; m[x[k]].push(x) })
  return m
}
const STATUS_TAG = { approved: 'g', pending: 'o', rejected: 'r', withdrawn: 'gray', revoked: 'r' }
const STATUS_TEXT = { approved: '已通过', pending: '待审核', rejected: '已驳回', withdrawn: '已退报', revoked: '已撤销' }
</script>

<template>
  <div v-if="store.loaded">
    <div class="page-h">
      <div><h2>👥 队伍与运动员</h2><div class="sub">参赛队伍与单项运动员注册信息 · 仅「已通过」资格审核者纳入正式名单</div></div>
      <div class="filters">
        <button class="chip" :class="{ on: cur === 'all' }" @click="cur = 'all'">全部</button>
        <button v-for="s in store.sports" :key="s.id" class="chip" :class="{ on: cur === String(s.id) }" @click="cur = String(s.id)">{{ s.name }}</button>
      </div>
    </div>

    <div class="grid g2">
      <div class="card">
        <div class="caption">🏀 参赛队伍</div>
        <div class="pad">
          <div style="display:flex;flex-direction:column;gap:10px">
            <div v-for="(list, uid) in groupBy(teams, 'unit_id')" :key="uid" class="mcard">
              <div class="mheader"><span><span class="dot" :style="{ background: store.unitOfUid(Number(uid))?.color }"></span> {{ store.unitOfUid(Number(uid))?.name }}</span><span class="tag o">{{ list.length }} 支</span></div>
              <div class="row wrap" style="margin-top:8px">
                <span v-for="t in list" :key="t.id" class="tag" :class="STATUS_TAG[t.status] || 'g'">{{ t.name }}<span class="st">· {{ STATUS_TEXT[t.status] || '已通过' }}</span></span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="caption">🏃 运动员（田径等单项）</div>
        <div class="pad">
          <table>
            <thead><tr><th>姓名</th><th>参赛项目</th><th>单位</th><th>状态</th></tr></thead>
            <tbody>
              <tr v-for="a in athletes" :key="a.id">
                <td><b>{{ a.name }}</b></td>
                <td>{{ store.sports.find(s=>s.id===a.sport_id)?.name }}</td>
                <td><span class="badge"><span class="dot" :style="{ background: store.unitOfUid(a.unit_id)?.color }"></span>{{ a.unit }}</span></td>
                <td><span class="tag" :class="STATUS_TAG[a.status] || 'g'">{{ STATUS_TEXT[a.status] || '已通过' }}</span></td>
              </tr>
              <tr v-if="!athletes.length"><td colspan="4" class="empty">暂无运动员</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.st { opacity: .7; font-weight: 500; margin-left: 2px; }
</style>