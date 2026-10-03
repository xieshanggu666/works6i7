import { defineStore } from 'pinia'

const j = (p, o) => fetch(p, o).then(async r => {
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    const e = new Error(data.error || '请求失败')
    e.status = r.status
    e.code = data.code
    e.conflicts = data.conflicts
    throw e
  }
  return data
})

export const useEventStore = defineStore('event', {
  state: () => ({
    sports: [], teams: [], units: [], venues: [], referees: [],
    athletes: [], matches: [], entries: [], medals: [], overview: null,
    standings: {}, registrations: [], quota: [], loaded: false,
    assignments: [], assignmentLogs: [], conflicts: null, workload: []
  }),
  getters: {
    teamOf: s => id => s.teams.find(t => t.id === id),
    unitOfUid: s => id => s.units.find(u => u.id === id),
    // 场次 -> 在派执法安排
    crewOf: s => mid => s.assignments.filter(a => a.match_id === mid),
    chiefOf: s => mid => s.assignments.find(a => a.match_id === mid && a.role === 'chief')
  },
  actions: {
    async init() {
      const [sports, teams, units, venues, referees, athletes, matches, entries, medals, overview, registrations, quota, assignments, logs, conflicts, workload] = await Promise.all([
        j('/api/sports'), j('/api/teams'), j('/api/units'), j('/api/venues'), j('/api/referees'),
        j('/api/athletes'), j('/api/matches'), j('/api/entries'), j('/api/medals'), j('/api/overview'),
        j('/api/registrations'), j('/api/quota'),
        j('/api/assignments'), j('/api/assignment-logs?limit=80'), j('/api/conflicts'), j('/api/referee-workload')
      ])
      Object.assign(this, { sports, teams, units, venues, referees, athletes, matches, entries, medals, overview, registrations, quota, assignments, assignmentLogs: logs, conflicts, workload })
      const st = {}
      for (const s of sports) st[s.id] = await j('/api/standings/' + s.id)
      this.standings = st
      this.loaded = true
    },
    async refresh() {
      const [matches, entries, medals, overview, registrations, quota, teams, athletes, assignments, logs, conflicts, workload, referees] = await Promise.all([
        j('/api/matches'), j('/api/entries'), j('/api/medals'), j('/api/overview'),
        j('/api/registrations'), j('/api/quota'), j('/api/teams'), j('/api/athletes'),
        j('/api/assignments'), j('/api/assignment-logs?limit=80'), j('/api/conflicts'), j('/api/referee-workload'), j('/api/referees')
      ])
      Object.assign(this, { matches, entries, medals, overview, registrations, quota, teams, athletes, assignments, assignmentLogs: logs, conflicts, workload, referees })
      const st = {}
      for (const s of this.sports) st[s.id] = await j('/api/standings/' + s.id)
      this.standings = st
    },
    async score(mid, sa, sb, tbA = null, tbB = null) {
      const r = await j('/api/matches/' + mid + '/score', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ score_a: sa, score_b: sb, tb_a: tbA, tb_b: tbB }) })
      if (r && r.error) throw new Error(r.error)
      await this.refresh()
      return r
    },
    async genKO(sid) { const r = await j('/api/ko/' + sid, { method: 'POST' }); await this.refresh(); return r.msg },
    async saveTrack(sid, list) { await j('/api/track/' + sid, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list) }); await this.refresh() },
    async submitRegistration(payload) { const r = await j('/api/registrations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); if (r.error) throw new Error(r.error); await this.refresh(); return r },
    async approveRegistration(id) { const r = await j('/api/registrations/' + id + '/approve', { method: 'POST' }); if (r.error) throw new Error(r.error); await this.refresh(); return r },
    async rejectRegistration(id, note) { const r = await j('/api/registrations/' + id + '/reject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) }); if (r.error) throw new Error(r.error); await this.refresh(); return r },
    async withdrawRegistration(id, note) { const r = await j('/api/registrations/' + id + '/withdraw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) }); if (r.error) throw new Error(r.error); await this.refresh(); return r },
    async revokeRegistration(id, note) { const r = await j('/api/registrations/' + id + '/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) }); if (r.error) throw new Error(r.error); await this.refresh(); return r },
    // —— 裁判排班与场地协同 ——
    async assignReferee(payload) { const r = await j('/api/assignments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); await this.refresh(); return r },
    async autoAssign() { const r = await j('/api/assignments/auto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); await this.refresh(); return r },
    async releaseAssignment(id, reason) { const r = await j('/api/assignments/' + id + '/release', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) }); if (r.error) throw new Error(r.error); await this.refresh(); return r },
    async reassignAssignment(id, payload) { const r = await j('/api/assignments/' + id + '/reassign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); await this.refresh(); return r },
    async changeSchedule(id, payload) { const r = await j('/api/matches/' + id + '/schedule', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); await this.refresh(); return r },
    async addReferee(payload) { const r = await j('/api/referees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); if (r.error) throw new Error(r.error); await this.refresh(); return r },
    async reset() { await j('/api/reset'); await this.init() }
  }
})
