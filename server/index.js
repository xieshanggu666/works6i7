import express from 'express'
import { db, run, all, get, withTransaction } from './db.js'

const app = express()
app.use(express.json())
const PORT = 4170

/* ================= 裁判排班：常量与工具 ================= */
const ROLE_NAME = { chief: '主裁', assistant: '助理裁判', recorder: '记录台' }
const ROLES = Object.keys(ROLE_NAME)
// 角色资质：裁判等级只能向下兼容（主裁可兼助理/记录台，反之不可）
const ROLE_RANK = { chief: 3, assistant: 2, recorder: 1 }
const LEVEL_RANK = { '主裁': 3, '助理裁判': 2, '记录台': 1 }
// 整场执法名单配置（田径无裁判组）：各球类项目 1 主裁 + 若干助理 + 1 记录台
function crewSpec(sport) {
  if (!sport || sport.format === 'track') return { chief: 0, assistant: 0, recorder: 0 }
  return { chief: 1, assistant: sport.format === 'group_knockout' ? 2 : 1, recorder: 1 }
}
function crewSpecOfMatch(m) { return crewSpec(get('SELECT * FROM sports WHERE id=?', m.sport_id)) }
// 某待赛场次已在派的执法名单
function crewRowsOf(matchId) {
  return all(`SELECT * FROM assignments WHERE match_id=? AND status='assigned'`, matchId)
}
// 某待赛场次各角色缺口（按项目配置）
function crewMissing(m, crew = null) {
  const need = crewSpecOfMatch(m)
  const rows = crew || crewRowsOf(m.id)
  const have = { chief: 0, assistant: 0, recorder: 0 }
  rows.forEach(a => { if (have[a.role] != null) have[a.role]++ })
  const missing = {}
  ROLES.forEach(role => { const d = need[role] - have[role]; if (d > 0) missing[role] = d })
  return missing
}
function crewShortText(missing) {
  return ROLES.filter(r => missing[r]).map(r => `${ROLE_NAME[r]}×${missing[r]}`).join('、')
}
// 裁判等级是否能担任某执法角色（等级未登记视为可担任，不阻断）
function refLevelOk(referee, role) {
  if (!referee || !referee.level) return true
  return (LEVEL_RANK[referee.level] ?? 3) >= ROLE_RANK[role]
}

function addLog(action, matchId, refereeId, detail, reason, operator) {
  run(`INSERT INTO assignment_logs (action,match_id,referee_id,detail,reason,operator)
       VALUES (?,?,?,?,?,?)`, action, matchId ?? null, refereeId ?? null, detail ?? null, reason ?? null, operator || '组委会')
}
function matchTitle(m) {
  if (!m) return '场次#' + m
  const sp = get('SELECT name FROM sports WHERE id=?', m.sport_id)?.name || ''
  const ta = m.team_a ? get('SELECT name FROM teams WHERE id=?', m.team_a)?.name : '待定'
  const tb = m.team_b ? get('SELECT name FROM teams WHERE id=?', m.team_b)?.name : '待定'
  return `${sp}·${m.stage}${m.group_name ? m.group_name : ''} ${ta || '待定'} VS ${tb || '待定'}（${m.time_label || '时间待定'}）`
}
// 裁判在指定时段的全部"在派"待赛场次（排除 excludeMatchId 自身；assistant/recorder 同样算占用）
function refBusyMatches(refereeId, timeLabel, excludeMatchId) {
  if (!timeLabel) return []
  const rows = all(`SELECT a.id aid, a.role, m.* FROM assignments a JOIN matches m ON m.id=a.match_id
                    WHERE a.referee_id=? AND a.status='assigned' AND m.status='scheduled' AND m.time_label=?`, refereeId, timeLabel)
  return rows.filter(r => r.id !== excludeMatchId)
}
// 某场待赛在同场地同时段的其它场次
function venueClashMatches(venueId, timeLabel, excludeMatchId) {
  if (!venueId || !timeLabel) return []
  return all(`SELECT * FROM matches WHERE venue_id=? AND time_label=? AND status='scheduled' AND id<>?`, venueId, timeLabel, excludeMatchId ?? 0)
}
// 场地名 → id（种子与动态编排均按名称解析，避免自增 id 漂移）
function vid(name) { return get('SELECT id FROM venues WHERE name=?', name)?.id ?? null }
// 裁判专长与项目是否匹配（未登记专长视为综合执法，可派所有项目）
function refSportOk(referee, sportId) {
  if (!referee || !referee.sport) return true
  const sp = get('SELECT name, category FROM sports WHERE id=?', sportId)
  return referee.sport === sp?.name || referee.sport === sp?.category
}
// 为一场待赛挑选某角色的合适裁判：
// 专长精确匹配优先 → 等级匹配（避免高等级裁判被过度占用）→ 待赛负荷低 → 无时间冲突
function pickRefForRole(m, role, crew = null) {
  if (!m.time_label) return null
  const spo = get('SELECT * FROM sports WHERE id=?', m.sport_id)
  const inCrew = new Set((crew || crewRowsOf(m.id)).map(a => a.referee_id))
  const loadOf = rid => get(`SELECT COUNT(*) c FROM assignments a JOIN matches mm ON mm.id=a.match_id
    WHERE a.referee_id=? AND a.status='assigned' AND mm.status='scheduled'`, rid)?.c ?? 0
  const cands = all(`SELECT * FROM referees WHERE status IN ('就绪','在岗') ORDER BY id`)
    .filter(r => refSportOk(r, m.sport_id))
    .filter(r => refLevelOk(r, role))
    .filter(r => refBusyMatches(r.id, m.time_label, m.id).length === 0)
    .filter(r => !inCrew.has(r.id))
    .map(r => ({
      r,
      // 精确专长 > 同类别 > 综合执法 > 跨专长
      sportPri: r.sport == null ? 2 : (r.sport === spo.name ? 0 : r.sport === spo.category ? 1 : 3),
      levelPri: (LEVEL_RANK[r.level] ?? 3) === ROLE_RANK[role] ? 0 : 1,
      load: loadOf(r.id)
    }))
    .sort((a, b) => a.sportPri - b.sportPri || a.levelPri - b.levelPri || a.load - b.load || a.r.id - b.r.id)
  return cands[0]?.r || null
}

/* ================= 排班 / 调班 / 解除 ================= */
// 分配裁判到场次。返回 assignment；冲突或专长不符时默认拒绝，force=true 强制安排并留痕
function assignReferee(matchId, refereeId, role = 'chief', operator = '组委会', reason = '', force = false) {
  const m = get('SELECT * FROM matches WHERE id=?', matchId)
  if (!m) throw new Error('场次不存在')
  if (m.status !== 'scheduled') throw new Error('仅待赛场次可安排裁判（完赛/取消场次执法记录已归档）')
  if (!m.team_a || !m.team_b) throw new Error('该场次对阵尚未确定，编排后才能安排裁判')
  const ref = get('SELECT * FROM referees WHERE id=?', refereeId)
  if (!ref) throw new Error('裁判不存在')
  if (ref.status && ref.status !== '就绪' && ref.status !== '在岗') throw new Error(`裁判当前状态为「${ref.status}」，暂不可排班`)
  if (!ROLES.includes(role)) throw new Error('执法角色无效')
  const dup = get(`SELECT id FROM assignments WHERE match_id=? AND referee_id=? AND status='assigned'`, matchId, refereeId)
  if (dup) throw new Error('该裁判已在本场次执法名单中')

  const busy = refBusyMatches(refereeId, m.time_label, matchId)
  const sportOk = refSportOk(ref, m.sport_id)
  const levelOk = refLevelOk(ref, role)
  if (!force && busy.length) {
    const err = new Error(`时间冲突：${ref.name} 在 ${m.time_label} 已被安排执法 ${busy.length} 场`)
    err.code = 'CONFLICT'
    err.conflicts = { referee: busy.map(b => ({ match_id: b.id, title: matchTitle(b) })) }
    throw err
  }
  if (!force && !sportOk) {
    const err = new Error(`专长不符：${ref.name} 的专长为「${ref.sport}」，本场为「${get('SELECT name FROM sports WHERE id=?', m.sport_id).name}」`)
    err.code = 'SKILL_MISMATCH'
    throw err
  }
  if (!force && !levelOk) {
    const err = new Error(`角色资质不符：${ref.name} 等级为「${ref.level}」，不能担任${ROLE_NAME[role]}`)
    err.code = 'ROLE_MISMATCH'
    throw err
  }
  const r = run(`INSERT INTO assignments (match_id,referee_id,role,status) VALUES (?,?,?,'assigned')`, matchId, refereeId, role)
  const aid = Number(r.lastInsertRowid)
  const forcedNotes = []
  if (busy.length) forcedNotes.push(`强制覆盖时间冲突 ${busy.length} 场`)
  if (!sportOk) forcedNotes.push('跨专长安排')
  if (!levelOk) forcedNotes.push(`跨等级安排（${ref.level}担任${ROLE_NAME[role]}）`)
  addLog(busy.length || !sportOk || !levelOk ? 'force_assign' : 'assign', matchId, refereeId,
    `${matchTitle(m)} → ${ref.name} 担任${ROLE_NAME[role]}${forcedNotes.length ? '（' + forcedNotes.join('，') + '）' : ''}`, reason, operator)
  return { id: aid, forced: !!(busy.length || !sportOk || !levelOk) }
}

function releaseAssignment(assignmentId, operator = '组委会', reason = '') {
  const a = get('SELECT * FROM assignments WHERE id=?', assignmentId)
  if (!a) throw new Error('执法安排不存在')
  if (a.status !== 'assigned') throw new Error('该安排已解除，无需重复操作')
  const m = get('SELECT * FROM matches WHERE id=?', a.match_id)
  if (m && m.status !== 'scheduled') throw new Error('仅待赛场次可解除执法安排')
  const ref = get('SELECT name FROM referees WHERE id=?', a.referee_id)
  run(`UPDATE assignments SET status='released', released_at=datetime('now','localtime') WHERE id=?`, assignmentId)
  addLog('release', a.match_id, a.referee_id, `${matchTitle(m)}：${ref?.name || '裁判'} 解除${ROLE_NAME[a.role] || '执法'}安排`, reason, operator)
  return { ok: true }
}

// 临时调班：target_id 为空=为 aid 改派裁判 new_referee_id；target_id 有值=两场裁判对调
function reassignAssignment(assignmentId, { target_id, new_referee_id, reason, operator } = {}) {
  const a = get('SELECT * FROM assignments WHERE id=?', assignmentId)
  if (!a) throw new Error('执法安排不存在')
  if (a.status !== 'assigned') throw new Error('该安排已解除，不能调班')
  const m = get('SELECT * FROM matches WHERE id=?', a.match_id)
  if (!m || m.status !== 'scheduled') throw new Error('仅待赛场次支持临时调班')
  if (!reason || !String(reason).trim()) throw new Error('调班必须填写原因并留痕')
  const op = operator || '组委会'

  if (target_id) {
    const b = get('SELECT * FROM assignments WHERE id=?', Number(target_id))
    if (!b || b.status !== 'assigned') throw new Error('对调目标安排不存在或已解除')
    if (b.id === a.id) throw new Error('不能与自身对调')
    if (b.role !== a.role) throw new Error('对调仅支持相同执法角色（主裁与主裁、助理与助理、记录台与记录台）')
    const mb = get('SELECT * FROM matches WHERE id=?', b.match_id)
    if (!mb || mb.status !== 'scheduled') throw new Error('对调场次不是待赛状态')
    // 专长校验：两名裁判对调后均需能执法目标场次
    const refA0 = get('SELECT * FROM referees WHERE id=?', a.referee_id)
    const refB0 = get('SELECT * FROM referees WHERE id=?', b.referee_id)
    if (!refSportOk(refA0, mb.sport_id)) {
      const err = new Error(`专长不符：${refA0.name} 的专长为「${refA0.sport}」，不能调至 ${get('SELECT name FROM sports WHERE id=?', mb.sport_id).name} 场次`)
      err.code = 'SKILL_MISMATCH'; throw err
    }
    if (!refSportOk(refB0, m.sport_id)) {
      const err = new Error(`专长不符：${refB0.name} 的专长为「${refB0.sport}」，不能调至 ${get('SELECT name FROM sports WHERE id=?', m.sport_id).name} 场次`)
      err.code = 'SKILL_MISMATCH'; throw err
    }
    // 角色资质校验：对调后两名裁判均需能担任目标场次的同角色
    if (!refLevelOk(refA0, b.role)) {
      const err = new Error(`角色资质不符：${refA0.name} 等级为「${refA0.level}」，不能担任${ROLE_NAME[b.role]}`)
      err.code = 'ROLE_MISMATCH'; throw err
    }
    if (!refLevelOk(refB0, a.role)) {
      const err = new Error(`角色资质不符：${refB0.name} 等级为「${refB0.level}」，不能担任${ROLE_NAME[a.role]}`)
      err.code = 'ROLE_MISMATCH'; throw err
    }
    // 调班后冲突预检
    const busyA = refBusyMatches(a.referee_id, mb.time_label, m.id)
    if (busyA.length) {
      const err = new Error(`调班冲突：对调后该裁判在 ${mb.time_label} 仍有其它执法`)
      err.code = 'CONFLICT'
      err.conflicts = { referee: busyA.map(x => ({ match_id: x.id, title: matchTitle(x) })) }
      throw err
    }
    const busyB = refBusyMatches(b.referee_id, m.time_label, mb.id)
    if (busyB.length) {
      const err = new Error(`调班冲突：对调后该裁判在 ${m.time_label} 仍有其它执法`)
      err.code = 'CONFLICT'
      err.conflicts = { referee: busyB.map(x => ({ match_id: x.id, title: matchTitle(x) })) }
      throw err
    }
    const r1 = run(`INSERT INTO assignments (match_id,referee_id,role,status) VALUES (?,?,?,'assigned')`, mb.id, a.referee_id, a.role)
    const r2 = run(`INSERT INTO assignments (match_id,referee_id,role,status) VALUES (?,?,?,'assigned')`, m.id, b.referee_id, b.role)
    run(`UPDATE assignments SET status='released', released_at=datetime('now','localtime') WHERE id IN (?,?)`, a.id, b.id)
    const refA = get('SELECT name FROM referees WHERE id=?', a.referee_id)
    const refB = get('SELECT name FROM referees WHERE id=?', b.referee_id)
    const detail = `${matchTitle(m)}：${refA.name} ⇄ ${refB.name}（${matchTitle(mb)}）对调`
    addLog('swap', m.id, b.referee_id, detail, reason, op)
    addLog('swap', mb.id, a.referee_id, detail, reason, op)
    return { ok: true, swapped: true, new_a: Number(r2.lastInsertRowid), new_b: Number(r1.lastInsertRowid) }
  }

  const newId = Number(new_referee_id)
  if (!Number.isInteger(newId)) throw new Error('请选择改派裁判')
  const newRef = get('SELECT * FROM referees WHERE id=?', newId)
  if (!newRef) throw new Error('裁判不存在')
  if (newId === a.referee_id) throw new Error('新裁判与原裁判相同')
  if (!refSportOk(newRef, m.sport_id)) {
    const err = new Error(`专长不符：${newRef.name} 的专长为「${newRef.sport}」，本场为「${get('SELECT name FROM sports WHERE id=?', m.sport_id).name}」`)
    err.code = 'SKILL_MISMATCH'; throw err
  }
  if (!refLevelOk(newRef, a.role)) {
    const err = new Error(`角色资质不符：${newRef.name} 等级为「${newRef.level}」，不能担任${ROLE_NAME[a.role]}`)
    err.code = 'ROLE_MISMATCH'; throw err
  }
  const busy = refBusyMatches(newId, m.time_label, m.id)
  if (busy.length) {
    const err = new Error(`时间冲突：${newRef.name} 在 ${m.time_label} 已被安排执法 ${busy.length} 场`)
    err.code = 'CONFLICT'
    err.conflicts = { referee: busy.map(x => ({ match_id: x.id, title: matchTitle(x) })) }
    throw err
  }
  const dup = get(`SELECT id FROM assignments WHERE match_id=? AND referee_id=? AND status='assigned'`, m.id, newId)
  if (dup) throw new Error('该裁判已在本场次执法名单中')
  const r = run(`INSERT INTO assignments (match_id,referee_id,role,status) VALUES (?,?,?,'assigned')`, m.id, newId, a.role)
  run(`UPDATE assignments SET status='released', released_at=datetime('now','localtime') WHERE id=?`, a.id)
  const oldRef = get('SELECT name FROM referees WHERE id=?', a.referee_id)
  addLog('reassign', m.id, newId, `${matchTitle(m)}：${ROLE_NAME[a.role]}由 ${oldRef.name} 改为 ${newRef.name}`, reason, op)
  return { ok: true, swapped: false, new_a: Number(r.lastInsertRowid) }
}

// 整场协同智能排班核心：按项目执法配置（主裁/助理/记录台）逐场补齐缺口
// 统一处理专长匹配、等级资质、同时段冲突与待赛负荷均衡；matchIds 限定处理范围（=全部待赛缺口场次）
function autoFillCrews(operator, matchIds = null, reasonText = '智能排班') {
  let need = all(`SELECT m.* FROM matches m WHERE m.status='scheduled'
                  AND m.team_a IS NOT NULL AND m.team_b IS NOT NULL`)
  if (matchIds) {
    const set = new Set(matchIds)
    need = need.filter(m => set.has(m.id))
  }
  // 先时段后场次，保证同一时段内全局负荷均衡
  need.sort((a, b) => (a.time_label || '').localeCompare(b.time_label || '') || a.id - b.id)
  const filled = [], skipped = [], crewCache = new Map()
  for (const m of need) {
    if (crewCache.has(m.id)) continue
    let crew = crewRowsOf(m.id)
    if (!m.time_label) {
      const missing = crewMissing(m, crew)
      if (Object.keys(missing).length) skipped.push({ match_id: m.id, title: matchTitle(m), reason: '未排定开赛时间', missing: crewShortText(missing) })
      crewCache.set(m.id, crew); continue
    }
    const spo = get('SELECT * FROM sports WHERE id=?', m.sport_id)
    if (spo.format === 'track') { crewCache.set(m.id, crew); continue }
    for (;;) {
      const missing = crewMissing(m, crew)
      const roles = ROLES.filter(role => missing[role])
      if (!roles.length) break
      // 一场内依次补 主裁 → 助理裁判 → 记录台
      const role = roles[0]
      const pick = pickRefForRole(m, role, crew)
      if (!pick) {
        skipped.push({ match_id: m.id, title: matchTitle(m), role, reason: `该时段无可用（专长/资质匹配且无冲突）的${ROLE_NAME[role]}`, missing: crewShortText(missing) })
        break
      }
      run(`INSERT INTO assignments (match_id,referee_id,role,status) VALUES (?,?,?, 'assigned')`, m.id, pick.id, role)
      crew.push({ id: -1, match_id: m.id, referee_id: pick.id, role, status: 'assigned' })
      addLog('auto_assign', m.id, pick.id, `${matchTitle(m)} → ${pick.name} 自动排班为${ROLE_NAME[role]}`, reasonText, operator)
      filled.push({ match_id: m.id, title: matchTitle(m), referee: pick.name, role })
    }
    crewCache.set(m.id, crew)
  }
  return { assigned: filled, skipped }
}

// 智能排班：为全部待赛场次补齐整场执法名单（主裁 + 助理裁判 + 记录台）
function autoAssign(operator = '组委会') {
  return autoFillCrews(operator)
}

// 赛程变更：调整场次时间/场地，联动执法安排——冲突席位自动重排，无法消解则整体回滚
// 自动重排：改期后与新时段冲突的执法席位，按智能排班同一口径（专长/资质/无冲突/负荷均衡）自动改派并留痕；
// 冲突回滚：场地撞场或存在无人可补的席位时，整个变更（含已重排席位）在事务内整体回滚，事务外补写回滚留痕；
// force=true 强制生效：能重排的席位照常重排，消解不了的冲突保留并在预警中持续标记。
// 仅待赛场次可改期；完赛/取消场次时间锁定，已归档的执法记录与工作量统计不受改期影响。
function updateMatchSchedule(matchId, { time_label, venue_id, operator, reason, force, auto_reassign = true }) {
  const m = get('SELECT * FROM matches WHERE id=?', matchId)
  if (!m) throw new Error('场次不存在')
  if (m.status !== 'scheduled') throw new Error('仅待赛场次可调整赛程（完赛/取消场次时间已锁定，执法记录已归档）')
  const newTime = time_label == null ? m.time_label : String(time_label).trim()
  let newVenue = venue_id == null ? m.venue_id : Number(venue_id)
  if (newVenue && !get('SELECT id FROM venues WHERE id=?', newVenue)) throw new Error('场地不存在')
  if ((newTime || null) === (m.time_label || null) && (newVenue || null) === (m.venue_id || null)) {
    return { ok: true, unchanged: true, reassigned: [], unresolved: [], venue_clash: [] }
  }
  const op = operator || '组委会'
  const why = reason || '赛程调整'
  const oldVenue = m.venue_id ? get('SELECT name FROM venues WHERE id=?', m.venue_id)?.name : '未指定'
  const venueName = newVenue ? get('SELECT name FROM venues WHERE id=?', newVenue)?.name : null

  try {
    // 单事务：变更应用 → 冲突检测 → 自动重排；任一环节不可消解即整体回滚，杜绝"改了一半"的中间态
    return withTransaction(() => {
      // 先应用变更，再基于"变更后"的全局排班状态检测（正确处理多场同时改期等交叉场景）
      run(`UPDATE matches SET time_label=?, venue_id=? WHERE id=?`, newTime, newVenue || null, matchId)
      const fresh = get('SELECT * FROM matches WHERE id=?', matchId)

      // 场地撞场无法通过改派裁判消解
      const clashRows = newVenue ? venueClashMatches(newVenue, newTime, matchId) : []
      // 改期后与新时段冲突的在派执法席位
      const conflicted = all(`SELECT a.*, r.name rname FROM assignments a JOIN referees r ON r.id=a.referee_id
                              WHERE a.match_id=? AND a.status='assigned'`, matchId)
        .map(a => ({ a, busy: refBusyMatches(a.referee_id, newTime, matchId) }))
        .filter(x => x.busy.length)

      const reassigned = [], unresolved = []
      conflicted.forEach(({ a, busy }) => {
        const busyList = busy.map(b => ({ match_id: b.id, title: matchTitle(b) }))
        // 自动重排：按智能排班同一口径为该席位另选裁判（crewRowsOf 实时读取，同场多席位不会重复占位）
        const pick = auto_reassign === false ? null
          : pickRefForRole(fresh, a.role, crewRowsOf(matchId).filter(x => x.id !== a.id))
        if (!pick) {
          unresolved.push({ referee_id: a.referee_id, referee: a.rname, role: a.role, role_name: ROLE_NAME[a.role], conflicts: busyList })
          return
        }
        run(`UPDATE assignments SET status='released', released_at=datetime('now','localtime') WHERE id=?`, a.id)
        run(`INSERT INTO assignments (match_id,referee_id,role,status) VALUES (?,?,?,'assigned')`, matchId, pick.id, a.role)
        addLog('auto_reassign', matchId, pick.id,
          `${matchTitle(fresh)} 改期至 ${newTime || '未指定'}，${a.rname} 与新时段冲突，自动改派 ${pick.name} 担任${ROLE_NAME[a.role]}`,
          why, op)
        reassigned.push({ role: a.role, role_name: ROLE_NAME[a.role], from: a.rname, to: pick.name })
      })

      if (!force && (clashRows.length || unresolved.length)) {
        // 冲突回滚：抛错触发事务回滚，赛程变更与已重排席位一并撤销
        const parts = []
        if (clashRows.length) parts.push(`场地撞场 ${clashRows.length} 起`)
        if (unresolved.length) parts.push(`${unresolved.length} 个执法席位冲突且无人可自动改派`)
        const err = new Error(`赛程变更存在${parts.join('、')}，已整体回滚；可强制生效或先调班`)
        err.code = 'CONFLICT'
        err.rolledBack = true
        err.conflicts = {
          venue: clashRows.map(c => ({ match_id: c.id, title: matchTitle(c) })),
          referee: unresolved,
          reassigned   // 本可自动重排的席位（已随回滚撤销，仅供前端说明）
        }
        throw err
      }
      addLog('match_change', matchId, null,
        `${matchTitle(m)}：时间 ${m.time_label || '未指定'} → ${newTime || '未指定'}；场地 ${oldVenue} → ${venueName || '未指定'}` +
        `${reassigned.length ? `；自动重排 ${reassigned.length} 个执法席位（${reassigned.map(r => `${r.role_name} ${r.from}→${r.to}`).join('，')}）` : ''}` +
        `${force && (clashRows.length || unresolved.length) ? `；强制生效（残留 ${clashRows.length + unresolved.length} 起冲突已标记）` : ''}`,
        force ? `${why}（强制）` : why, op)
      return { ok: true, reassigned, unresolved, venue_clash: clashRows.map(c => ({ match_id: c.id, title: matchTitle(c) })) }
    })
  } catch (e) {
    if (e.rolledBack) {
      // 回滚留痕：事务已回滚，在事务外补写一条回滚记录（变更本身不留痕，回滚事实留痕）
      addLog('reschedule_rollback', matchId, null,
        `${matchTitle(m)} 改期（${m.time_label || '未指定'} → ${newTime || '未指定'}）触发冲突回滚：${e.message}`,
        why, op)
    }
    throw e
  }
}

// 联动：场次完赛 → 执法安排归档
function lockAssignmentsOnFinish(m, operator = '系统') {
  const as = all(`SELECT * FROM assignments WHERE match_id=? AND status='assigned'`, m.id)
  as.forEach(a => {
    const r = get('SELECT name FROM referees WHERE id=?', a.referee_id)
    addLog('match_finish', m.id, a.referee_id, `${matchTitle(m)} 完赛，${r?.name || '裁判'} 的${ROLE_NAME[a.role]}安排归档`, null, operator)
  })
}
// 联动：场次取消（成绩取消）→ 解除全部在派安排
function releaseAssignmentsOfMatch(m, why, operator = '系统', action = 'void_release') {
  const as = all(`SELECT * FROM assignments WHERE match_id=? AND status='assigned'`, m.id)
  as.forEach(a => {
    run(`UPDATE assignments SET status='released', released_at=datetime('now','localtime') WHERE id=?`, a.id)
    const r = get('SELECT name FROM referees WHERE id=?', a.referee_id)
    addLog(action, m.id, a.referee_id, `${matchTitle(m)}：${r?.name || '裁判'} 的${ROLE_NAME[a.role]}安排随场次调整解除（${why}）`, why, operator)
  })
}

/* ================= 种子数据 ================= */
function seed() {
  if (get('SELECT COUNT(*) c FROM sports').c > 0) return

  // 单位
  const units = [['雷霆学院', '#ff7a2f'], ['飞鹰学院', '#2f9bff'], ['雄狮学院', '#2ecc71'], ['星河学院', '#9b59b6']]
  const unitId = {}
  units.forEach((u, i) => { run('INSERT INTO units (name,color) VALUES (?,?)', u[0], u[1]); unitId[u[0]] = i + 1 })

  // 场地
  const venues = ['中心篮球馆', '五人足球场', '羽毛球馆', '田径场', '备用2号场']
  venues.forEach(v => run('INSERT INTO venues (name,type) VALUES (?,?)', v, 'arena'))

  // 裁判（专长 / 等级）——覆盖主裁、助理裁判、记录台三角色与各球类专长
  const refRows = [
    ['王裁判', '篮球', '主裁'], ['李裁判', '篮球', '助理裁判'], ['褚裁判', '篮球', '助理裁判'], ['钱裁判', '篮球', '记录台'],
    ['张裁判', '五人制足球', '主裁'], ['赵裁判', '五人制足球', '助理裁判'], ['周裁判', '五人制足球', '助理裁判'], ['吴裁判', '五人制足球', '记录台'],
    ['陈裁判', '羽毛球', '主裁'], ['郑裁判', '羽毛球', '助理裁判'],
    ['孙裁判', null, '主裁'], ['冯裁判', null, '记录台']   // 综合执法
  ]
  const refId = {}
  refRows.forEach(([n, sp, lv]) => { const r = run('INSERT INTO referees (name,sport,level,status) VALUES (?,?,?,?)', n, sp, lv, '就绪'); refId[n] = Number(r.lastInsertRowid) })

  // 项目
  const sp = (name, cat, fmt, venue) => { const r = run('INSERT INTO sports (name,category,format,venue) VALUES (?,?,?,?)', name, cat, fmt, venue); return Number(r.lastInsertRowid) }
  const spBasket = sp('篮球', '球类', 'roundrobin', '中心篮球馆')
  const spFoot = sp('五人制足球', '球类', 'group_knockout', '五人足球场')
  const spBad = sp('羽毛球', '球类', 'knockout', '羽毛球馆')
  const sp100 = sp('田径 · 100米', '田径', 'track', '田径场')

  // 队伍
  const mk = (name, unit) => { const r = run('INSERT INTO teams (name,unit_id,sport_id) VALUES (?,?,?)', name, unitId[unit], 0); return Number(r.lastInsertRowid) }
  // 篮球 4 队
  const B = ['雷霆学院', '飞鹰学院', '雄狮学院', '星河学院'].map(u => mk(u === '雷霆学院' ? '雷霆队' : u === '飞鹰学院' ? '飞鹰队' : u === '雄狮学院' ? '雄狮队' : '星河队', u))
  B.forEach(id => run('UPDATE teams SET sport_id=? WHERE id=?', spBasket, id))
  // 足球 6 队
  const F = [
    ['雷霆队', '雷霆学院'], ['飞鹰队', '飞鹰学院'], ['雄狮队', '雄狮学院'],
    ['星河队', '星河学院'], ['闪电队', '雷霆学院'], ['烈焰队', '雄狮学院']
  ].map(([n, u]) => mk(n, u))
  F.forEach(id => run('UPDATE teams SET sport_id=? WHERE id=?', spFoot, id))
  // 羽毛球 4 队（同名队伍）
  const G = ['雷霆队', '飞鹰队', '雄狮队', '星河队'].map((n, i) => mk(n, units[i][0]))
  G.forEach(id => run('UPDATE teams SET sport_id=? WHERE id=?', spBad, id))
  // 田径 8 名运动员
  const runners = [['林一', '雷霆学院'], ['周楠', '飞鹰学院'], ['陈晨', '雄狮学院'], ['顾言', '星河学院'], ['徐凯', '雷霆学院'], ['韩雪', '飞鹰学院'], ['陆鸣', '雄狮学院'], ['宋词', '星河学院']]
  const slotsA = ['09:00', '09:40', '10:40']
  const slotsB = ['09:20', '10:00', '11:00']
  runners.forEach(([n, u]) => { run('INSERT INTO athletes (name,unit_id,sport_id) VALUES (?,?,?)', n, unitId[u], sp100) })

  // 循环赛助手
  const pairs = arr => { const p = []; for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) p.push([arr[i], arr[j]]); return p }

  const venueById = vid('中心篮球馆')

  // —— 篮球：4队 单循环 6 场
  let ono = 0
  pairs(B).forEach(([a, b]) => {
    ono++
    run('INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?)', spBasket, '循环', a, b, venueById, ono, ['09:00', '09:20', '09:40', '10:00', '10:20', '10:40'][(ono - 1) % 6], 'scheduled')
  })

  // —— 足球：分 AB 两组（A: 雷霆/雄狮/闪电  B: 飞鹰/星河/烈焰），组内循环 6 场；两组时段错开避免同场撞档 ——
  const grpA = [F[0], F[2], F[4]]
  const grpB = [F[1], F[3], F[5]]
  const footIds = { A: [], B: [] }
  ono = 0
  pairs(grpA).forEach(([a, b]) => { ono++; const r = run('INSERT INTO matches (sport_id,stage,group_name,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?,?)', spFoot, '小组', 'A组', a, b, vid('五人足球场'), ono, slotsA[(ono - 1) % 3], 'scheduled'); footIds.A.push(Number(r.lastInsertRowid)) })
  pairs(grpB).forEach(([a, b]) => { ono++; const r = run('INSERT INTO matches (sport_id,stage,group_name,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?,?)', spFoot, '小组', 'B组', a, b, vid('五人足球场'), ono, slotsB[(ono - 1) % 3], 'scheduled'); footIds.B.push(Number(r.lastInsertRowid)) })

  // —— 羽毛球：半决赛 2 场（固定对位），决赛/季军由编排按钮产生 ——
  const badSemi1 = run('INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?)', spBad, '半决赛', G[0], G[1], vid('羽毛球馆'), 1, '09:30', 'scheduled')
  const badSemi2 = run('INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?)', spBad, '半决赛', G[2], G[3], vid('羽毛球馆'), 2, '10:00', 'scheduled')
  const badIds = [Number(badSemi1.lastInsertRowid), Number(badSemi2.lastInsertRowid)]

  rebuildStandings()

  // —— 预录部分成绩（演示看板有内容）——
  const sc = (sport, a, b, sa, sb) => { const m = get('SELECT id FROM matches WHERE sport_id=? AND team_a=? AND team_b=? AND status=\'scheduled\'', sport, a, b); if (m) finishMatch(m.id, sa, sb) }
  // 篮球全录 → 决出冠军
  sc(spBasket, B[0], B[1], 78, 70); sc(spBasket, B[2], B[3], 65, 71)
  sc(spBasket, B[0], B[2], 82, 60); sc(spBasket, B[1], B[3], 69, 74)
  sc(spBasket, B[0], B[3], 58, 66); sc(spBasket, B[1], B[2], 88, 77)
  // 足球小组录 4 场，留每组末轮 2 场未赛（演示排班/调班）
  sc(spFoot, grpA[0], grpA[1], 3, 1); sc(spFoot, grpA[1], grpA[2], 2, 2)
  sc(spFoot, grpB[0], grpB[1], 1, 3); sc(spFoot, grpB[1], grpB[2], 2, 1)
  // 羽毛球两场半决赛都录 → 可编排决赛
  sc(spBad, G[0], G[1], 21, 16); sc(spBad, G[2], G[3], 18, 21)
  // 田径成绩
  const marks = [10.62, 10.88, 11.05, 11.21, 11.35, 11.42, 11.58, 11.79]
  all('SELECT id,name FROM athletes').forEach((ath, i) => run('INSERT INTO entries (sport_id,athlete_id,mark,rank,unit_id) VALUES (?,?,?,?,?)', sp100, ath.id, marks[i], i + 1, get('SELECT unit_id FROM athletes WHERE id=?', ath.id).unit_id))

  // —— 历史执法安排（已完赛场次：静默回填整场名单，作为工作量统计口径）——
  const seedHist = (mid, rid, role = 'chief') => run(`INSERT INTO assignments (match_id,referee_id,role,status) VALUES (?,?,?,'assigned')`, mid, rid, role)
  // 篮球：主裁王，助理李/褚轮值，记录台钱
  const basketDone = all(`SELECT id FROM matches WHERE sport_id=? AND status='finished' ORDER BY id`, spBasket).map(x => x.id)
  basketDone.forEach((x, i) => {
    seedHist(x, refId['王裁判'])
    seedHist(x, i % 2 ? refId['褚裁判'] : refId['李裁判'], 'assistant')
    seedHist(x, refId['钱裁判'], 'recorder')
  })
  // 足球：主裁张，助理赵/周轮值，记录台吴
  const footDone = all(`SELECT id FROM matches WHERE sport_id=? AND status='finished' ORDER BY id`, spFoot).map(x => x.id)
  footDone.forEach((x, i) => {
    seedHist(x, refId['张裁判'])
    seedHist(x, i % 2 ? refId['周裁判'] : refId['赵裁判'], 'assistant')
    seedHist(x, refId['吴裁判'], 'recorder')
  })
  // 羽毛球半决赛：主裁陈，助理郑，记录台冯（综合执法）
  badIds.forEach(x => { seedHist(x, refId['陈裁判']); seedHist(x, refId['郑裁判'], 'assistant'); seedHist(x, refId['冯裁判'], 'recorder') })

  // —— 为已有队伍/运动员补建「已通过」报名记录（完整审计轨迹）——
  all('SELECT id, name, unit_id, sport_id FROM teams').forEach(t => {
    if (!get('SELECT id FROM registrations WHERE team_id=?', t.id)) {
      run(`INSERT INTO registrations (kind,unit_id,sport_id,team_id,name,status,reviewer,reviewed_at)
           VALUES ('team',?,?,?,?,'approved','组委会',datetime('now','localtime'))`, t.unit_id, t.sport_id, t.id, t.name)
    }
  })
  all('SELECT id, name, unit_id, sport_id FROM athletes').forEach(a => {
    if (!get('SELECT id FROM registrations WHERE athlete_id=?', a.id)) {
      run(`INSERT INTO registrations (kind,unit_id,sport_id,athlete_id,name,status,reviewer,reviewed_at)
           VALUES ('athlete',?,?,?,?,'approved','组委会',datetime('now','localtime'))`, a.unit_id, a.sport_id, a.id, a.name)
    }
  })

  // —— 演示：新增待审核报名（队伍/运动员），由组委会审核资格与名额 ——
  const addPendingTeam = (name, unit, sport) => {
    const r = run('INSERT INTO teams (name,unit_id,sport_id,status) VALUES (?,?,?,?)', name, unitId[unit], sport, 'pending')
    const tid = Number(r.lastInsertRowid)
    run('INSERT INTO registrations (kind,unit_id,sport_id,team_id,name,status) VALUES (?,?,?,?,?,?)', 'team', unitId[unit], sport, tid, name, 'pending')
  }
  const addPendingAthlete = (name, unit, sport) => {
    const r = run('INSERT INTO athletes (name,unit_id,sport_id,status) VALUES (?,?,?,?)', name, unitId[unit], sport, 'pending')
    const aid = Number(r.lastInsertRowid)
    run('INSERT INTO registrations (kind,unit_id,sport_id,athlete_id,name,status) VALUES (?,?,?,?,?,?)', 'athlete', unitId[unit], sport, aid, name, 'pending')
  }
  addPendingTeam('雷霆三队', '雷霆学院', spBasket)
  addPendingTeam('飞鹰二队', '飞鹰学院', spFoot)
  addPendingAthlete('许诺', '星河学院', sp100)

  // —— 淘汰赛按真实赛果动态生成（与赛程编排页同一入口）；生成时自动整场协同排班 ——
  generateKO(spBad)
  // 季军战解除主裁安排（助理/记录台保留），演示"主裁缺口待排班"覆盖率
  const thirdM = get(`SELECT * FROM matches WHERE sport_id=? AND stage='季军'`, spBad)
  if (thirdM) {
    const thirdChief = get(`SELECT id FROM assignments WHERE match_id=? AND role='chief' AND status='assigned'`, thirdM.id)
    if (thirdChief) releaseAssignment(thirdChief.id, '组委会', '季军战裁判长待定，主裁暂时留空待排班')
  }

  // —— 待赛小组末轮：主裁初排 + 一次对调演示；助理/记录台留给"一键智能排班"现场补齐 ——
  const mA3 = get(`SELECT id FROM matches WHERE sport_id=? AND group_name='A组' AND status='scheduled'`, spFoot).id
  const mB3 = get(`SELECT id FROM matches WHERE sport_id=? AND group_name='B组' AND status='scheduled'`, spFoot).id
  const aAss = assignReferee(mA3, refId['孙裁判'], 'chief', '组委会', '末轮初排')
  assignReferee(mB3, refId['张裁判'], 'chief', '组委会', '末轮初排')
  reassignAssignment(aAss.id, { target_id: get(`SELECT id FROM assignments WHERE match_id=? AND role='chief' AND status='assigned'`, mB3).id, reason: '孙裁判临时请假，末轮主裁对调', operator: '裁判长' })

  recomputeMedals()
}
/* ================= 积分与奖牌 ================= */
function rebuildStandings(sportId) {
  const sports = sportId ? [sportId] : all('SELECT * FROM sports').map(s => s.id)
  sports.forEach(sid => {
    all('SELECT id FROM standings WHERE sport_id=?', sid).forEach(r => run('DELETE FROM standings WHERE id=?', r.id))
    // 仅已通过资格审核的队伍纳入积分榜
    const teams = all(`SELECT id FROM teams WHERE sport_id=? AND status='approved'`, sid).map(t => t.id)
    teams.forEach(t => run('INSERT INTO standings (sport_id,team_id) VALUES (?,?)', sid, t))
    const spo0 = get('SELECT format FROM sports WHERE id=?', sid)
    const done = all(`SELECT * FROM matches WHERE sport_id=? AND status='finished'`, sid)
      .filter(m => spo0.format === 'roundrobin' ? m.stage === '循环' : m.stage === '小组')
    done.forEach(m => {
      const rowA = get('SELECT * FROM standings WHERE sport_id=? AND team_id=?', sid, m.team_a)
      const rowB = get('SELECT * FROM standings WHERE sport_id=? AND team_id=?', sid, m.team_b)
      if (!rowA || !rowB) return
      const sa = m.score_a, sb = m.score_b
      rowA.play += 1; rowB.play += 1
      rowA.gf += sa; rowA.ga += sb; rowB.gf += sb; rowB.ga += sa
      if (sa > sb) { rowA.win++; rowB.lose++; rowA.points += 3 }
      else if (sa < sb) { rowB.win++; rowA.lose++; rowB.points += 3 }
      else { rowA.draw++; rowB.draw++; rowA.points += 1; rowB.points += 1 }
      run('UPDATE standings SET play=?,win=?,draw=?,lose=?,gf=?,ga=?,points=? WHERE id=?',
        rowA.play, rowA.win, rowA.draw, rowA.lose, rowA.gf, rowA.ga, rowA.points, rowA.id)
      run('UPDATE standings SET play=?,win=?,draw=?,lose=?,gf=?,ga=?,points=? WHERE id=?',
        rowB.play, rowB.win, rowB.draw, rowB.lose, rowB.gf, rowB.ga, rowB.points, rowB.id)
    })
    // 排名
    const rows = all('SELECT * FROM standings WHERE sport_id=?', sid).sort((x, y) => y.points - x.points || (y.gf - y.ga) - (x.gf - x.ga) || x.id - y.id)
    rows.forEach((r, i) => run('UPDATE standings SET rank=? WHERE id=?', i + 1, r.id))
  })
}
function unitOfTeam(teamId) {
  const t = teamId == null ? null : get('SELECT unit_id FROM teams WHERE id=?', teamId)
  return t ? t.unit_id : null
}
function recomputeMedals() {
  all('SELECT unit_id FROM medals').forEach(r => run('DELETE FROM medals WHERE unit_id=?', r.unit_id))
  const add = (uid, medal) => { if (!uid) return; const row = get('SELECT * FROM medals WHERE unit_id=?', uid); const k = medal === 'gold' ? 'gold' : medal === 'silver' ? 'silver' : 'bronze'; if (row) run(`UPDATE medals SET ${k}=${k}+1 WHERE unit_id=?`, uid); else run(`INSERT INTO medals (unit_id,${k}) VALUES (?,1)`, uid) }
  const sports = all('SELECT * FROM sports')
  sports.forEach(spo => {
    if (spo.format === 'track') {
      // 仅已录入有效成绩且仍具备资格的运动员参与前 3 名结算
      const tops = all(`SELECT e.* FROM entries e
                        JOIN athletes a ON a.id=e.athlete_id AND a.status='approved'
                        WHERE e.sport_id=? AND e.mark IS NOT NULL
                        ORDER BY e.mark ASC LIMIT 3`, spo.id)
      add(tops[0]?.unit_id, 'gold'); add(tops[1]?.unit_id, 'silver'); add(tops[2]?.unit_id, 'bronze')
    } else if (spo.format === 'roundrobin') {
      const champ = get('SELECT s.*, t.unit_id FROM standings s JOIN teams t ON t.id=s.team_id WHERE s.sport_id=? AND s.rank=1', spo.id)
      const second = get('SELECT s.*, t.unit_id FROM standings s JOIN teams t ON t.id=s.team_id WHERE s.sport_id=? AND s.rank=2', spo.id)
      const third = get('SELECT s.*, t.unit_id FROM standings s JOIN teams t ON t.id=s.team_id WHERE s.sport_id=? AND s.rank=3', spo.id)
      if (all('SELECT * FROM standings WHERE sport_id=?', spo.id).some(r => r.play > 0)) { add(champ?.unit_id, 'gold'); add(second?.unit_id, 'silver'); add(third?.unit_id, 'bronze') }
    } else {
      const fin = get(`SELECT * FROM matches WHERE sport_id=? AND status='finished' AND stage='决赛' ORDER BY id`, spo.id)
      const thirdM = get(`SELECT * FROM matches WHERE sport_id=? AND status='finished' AND stage='季军' ORDER BY id`, spo.id)
      const pendingThird = get(`SELECT id FROM matches WHERE sport_id=? AND status='scheduled' AND stage='季军'`, spo.id)
      const semis = all(`SELECT * FROM matches WHERE sport_id=? AND stage='半决赛' ORDER BY order_no,id`, spo.id)
      const gold = fin && isActiveTeam(fin.winner) ? fin.winner : null
      let silver = null, bronze = null

      if (gold != null) {
        add(unitOfTeam(gold), 'gold')
        const finOpponent = gold === fin.team_a ? fin.team_b : fin.team_a
        if (isActiveTeam(finOpponent)) silver = finOpponent

        // 决赛负者失去资格时：若季军战已赛，季军战胜/负者依次递补银/铜牌；
        // 若季军战待赛，先不结算银/铜；若不存在季军战，再按半决赛名次递补
        if (silver == null && !pendingThird) {
          if (thirdM && isActiveTeam(thirdM.winner)) {
            silver = thirdM.winner
            const thirdLoser = thirdM.winner === thirdM.team_a ? thirdM.team_b : thirdM.team_a
            if (isActiveTeam(thirdLoser)) bronze = thirdLoser
          }
          if (silver == null) {
            const disqualifiedFinalist = gold === fin.team_a ? fin.team_b : fin.team_a
            const dqSemi = semis.find(m => [m.team_a, m.team_b].includes(disqualifiedFinalist))
            silver = canonicalSemiFinalist(dqSemi)
            if (silver === gold || !isActiveTeam(silver)) silver = null
          }
          if (bronze == null) {
            const goldSemi = semis.find(m => [m.team_a, m.team_b].includes(gold))
            bronze = canonicalSemiLoser(goldSemi)
            if (bronze === silver) bronze = null
          }
        } else if (bronze == null && isActiveTeam(thirdM?.winner)) {
          bronze = thirdM.winner
        }
      } else if (thirdM && isActiveTeam(thirdM.winner)) {
        bronze = thirdM.winner
      }
      if (silver != null) add(unitOfTeam(silver), 'silver')
      if (bronze != null) add(unitOfTeam(bronze), 'bronze')
    }
  })
}
/* ================= 编排下一轮（KO） ================= */
const STAGE_ORDER = { '小组': 1, '循环': 1, '半决赛': 2, '决赛': 3, '季军': 3 }
const KO_STAGES = ['半决赛', '决赛', '季军']   // 淘汰赛阶段：不允许平分收场
const loserOf = m => (m.winner === m.team_a ? m.team_b : m.team_a)
function finishMatch(id, sa, sb, tbA = null, tbB = null) {
  // 单事务：比分落库 + 积分榜重建 + 奖牌重算 + 执法归档，任一失败整体回滚，杜绝半结算
  return withTransaction(() => {
    const m = get('SELECT * FROM matches WHERE id=?', id)
    if (m.status !== 'scheduled') throw new Error('该场次已完赛或取消，不能重复录入比分')
    if (m.team_a == null || m.team_b == null) throw new Error('该场次存在轮空，无需录入比分')
    if (!isActiveTeam(m.team_a) || !isActiveTeam(m.team_b)) throw new Error('对阵中存在失去资格队伍，需先完成淘汰赛级联调整')
    let winner = null, ta = null, tb = null
    if (sa > sb) winner = m.team_a
    else if (sb > sa) winner = m.team_b
    else if (KO_STAGES.includes(m.stage)) {
      // 淘汰赛常规时间平分：必须录入加时/点球决胜比分，且决胜不能再次持平
      ta = tbA === null || tbA === undefined || tbA === '' ? null : Number(tbA)
      tb = tbB === null || tbB === undefined || tbB === '' ? null : Number(tbB)
      if (!Number.isInteger(ta) || !Number.isInteger(tb) || ta < 0 || tb < 0) {
        throw new Error('淘汰赛常规时间平分，需录入加时/点球决胜比分')
      }
      if (ta === tb) throw new Error('决胜比分不能再次持平')
      winner = ta > tb ? m.team_a : m.team_b
    }
    // 小组/循环允许平局（winner 为 NULL）；决胜比分不计入进失球
    run(`UPDATE matches SET score_a=?, score_b=?, tb_a=?, tb_b=?, winner=?, status='finished' WHERE id=?`, sa, sb, ta, tb, winner, id)
    rebuildStandings(m.sport_id)
    recomputeMedals()
    // 联动比赛状态：执法安排随完赛归档留痕
    lockAssignmentsOnFinish({ ...m, status: 'finished' }, '系统')
  })
}

// 新增场次后：按整场执法配置自动补齐主裁/助理/记录台（失败不阻断编排，供排班页处理）
function autoCrewForNewMatches(matchIds, operator = '系统') {
  return autoFillCrews(operator, matchIds, '赛程新增联动')
}

/* ================= 淘汰赛退赛/撤销资格的级联处理 ================= */
const ACTIVE_TEAM_STATUS = new Set(['approved'])
const isActiveTeam = teamId => teamId != null && ACTIVE_TEAM_STATUS.has(get('SELECT status FROM teams WHERE id=?', teamId)?.status)

// 未赛场次按弃权判对手 3:0；执法安排随完赛归档
function finishWalkover(m, winnerId, note, operator = '系统') {
  if (m.status === 'finished' && m.winner === winnerId && isActiveTeam(winnerId)) {
    run(`UPDATE matches SET score_a=?, score_b=?, tb_a=NULL, tb_b=NULL, winner=?, note=? WHERE id=?`,
      m.team_a === winnerId ? 3 : 0, m.team_b === winnerId ? 3 : 0, winnerId, note, m.id)
    return false
  }
  const wasFinished = m.status === 'finished'
  const winnerSide = m.team_a === winnerId ? 'a' : m.team_b === winnerId ? 'b' : null
  const scoreA = winnerSide === 'a' ? 3 : 0
  const scoreB = winnerSide === 'b' ? 3 : 0
  run(`UPDATE matches SET status='finished', score_a=?, score_b=?, tb_a=NULL, tb_b=NULL, winner=?, note=? WHERE id=?`,
    scoreA, scoreB, winnerId, note, m.id)
  if (wasFinished) {
    addLog('match_change', m.id, null, `${matchTitle({ ...m, status: 'finished', winner: winnerId })} 因资格变动改判为有效队伍 3:0 胜`, note, operator)
  } else {
    lockAssignmentsOnFinish({ ...m, status: 'finished', winner: winnerId }, operator)
  }
  return !wasFinished
}

// 已赛场次取消成绩；仍在派/计入历史的执法安排同步解除
function voidMatch(m, note, operator = '系统') {
  run(`UPDATE matches SET status='void', score_a=NULL, score_b=NULL, tb_a=NULL, tb_b=NULL, winner=NULL, note=? WHERE id=?`, note, m.id)
  releaseAssignmentsOfMatch({ ...m, status: 'void' }, note, operator)
}

// 已生成的后续轮次需要改赛或重赛：释放原执法安排，回到待赛并替换对阵队伍
function resetScheduledMatch(m, teamA, teamB, note, operator = '系统') {
  releaseAssignmentsOfMatch(m, note, operator, 'match_change')
  run(`UPDATE matches SET status='scheduled', team_a=?, team_b=?, score_a=NULL, score_b=NULL, tb_a=NULL, tb_b=NULL, winner=NULL, note=? WHERE id=?`,
    teamA, teamB, note, m.id)
  const fresh = get('SELECT * FROM matches WHERE id=?', m.id)
  addLog('match_change', m.id, null, `${matchTitle(m)} 因资格变动调整对阵，原执法安排已解除`, note, operator)
  return fresh
}

function canonicalSemiWinner(m) {
  if (m.status !== 'finished' || m.winner == null || !isActiveTeam(m.winner)) return null
  return m.winner
}
function canonicalSemiLoser(m) {
  const winner = canonicalSemiWinner(m)
  if (winner == null) return null
  const loser = winner === m.team_a ? m.team_b : m.team_a
  return isActiveTeam(loser) ? loser : null
}
// 半决赛胜者赛后失去资格时，该场被取消；唯一仍有效的原负者递补进入决赛
function canonicalSemiFinalist(m) {
  const winner = canonicalSemiWinner(m)
  if (winner != null) return winner
  if (m.status !== 'void') return null
  const active = [m.team_a, m.team_b].filter(isActiveTeam)
  return active.length === 1 ? active[0] : null
}
function activeSideOfMatch(m) {
  const active = [m.team_a, m.team_b].filter(isActiveTeam)
  return active.length === 1 ? active[0] : null
}

function createPlacementMatch(sportId, stage, teamA, teamB, orderNo, timeLabel, status, winner, note) {
  const spo = get('SELECT * FROM sports WHERE id=?', sportId)
  const venueName = stage === '决赛' ? spo.venue : '备用2号场'
  const scoreA = status === 'finished' ? (teamA && winner === teamA ? 3 : 0) : null
  const scoreB = status === 'finished' ? (teamB && winner === teamB ? 3 : 0) : null
  const r = run(`INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status,score_a,score_b,winner,note)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    sportId, stage, teamA, teamB, vid(venueName), orderNo, timeLabel, status, scoreA, scoreB, status === 'finished' ? winner : null, note)
  return Number(r.lastInsertRowid)
}

// 将决赛/季军战同步到半决赛的权威晋级结果；处理递补、重赛、轮空与奖牌自动结算
function syncPlacementMatch(sportId, stage, desired, orderNo, timeLabel, reason, operator = '系统') {
  const m = get(`SELECT * FROM matches WHERE sport_id=? AND stage=?`, sportId, stage)
  const [a, b] = desired.teams
  if (!desired.teams.length) {
    if (m && m.status !== 'void') voidMatch(m, reason, operator)
    return null
  }

  if (desired.status === 'scheduled') {
    if (m && m.status === 'scheduled' && m.team_a === a && m.team_b === b) return m
    const fresh = m
      ? resetScheduledMatch(m, a, b, reason, operator)
      : get('SELECT * FROM matches WHERE id=?', createPlacementMatch(sportId, stage, a, b, orderNo, timeLabel, 'scheduled', null, null))
    if (!m) addLog('schedule_added', fresh.id, null, `${matchTitle(fresh)} 由淘汰赛资格变动级联生成`, reason, operator)
    autoCrewForNewMatches([fresh.id], operator)
    return fresh
  }

  // finished：当前轮次只剩一个有效队伍，按 3:0 轮空完赛并立即结算奖牌
  const winner = desired.teams[0]
  if (m) {
    const wasScheduled = m.status === 'scheduled'
    run(`UPDATE matches SET status='finished', team_a=?, team_b=?, score_a=?, score_b=?, tb_a=NULL, tb_b=NULL, winner=?, note=? WHERE id=?`,
      a, b, a ? (winner === a ? 3 : 0) : 0, b ? (winner === b ? 3 : 0) : 0, winner, reason, m.id)
    const fresh = get('SELECT * FROM matches WHERE id=?', m.id)
    if (wasScheduled) lockAssignmentsOnFinish(fresh, operator)
    addLog('match_change', m.id, null, `${matchTitle(fresh)} 因资格变动按轮空完赛`, reason, operator)
    return fresh
  }

  const id = createPlacementMatch(sportId, stage, a, b, orderNo, timeLabel, 'finished', winner, reason)
  const fresh = get('SELECT * FROM matches WHERE id=?', id)
  addLog('schedule_added', id, null, `${matchTitle(fresh)} 因资格变动按轮空完赛生成`, reason, operator)
  return fresh
}

function reconcileKnockout(sportId, reason, operator = '系统') {
  const semis = all(`SELECT * FROM matches WHERE sport_id=? AND stage='半决赛' ORDER BY order_no,id`, sportId)
  if (semis.length !== 2) return { created: 0, adjusted: 0 }
  // 正在待赛且可继续比赛的半决赛（含小组递补）不应提前决定决赛；已取消/完赛才可按轮空结算
  const settled = semis.every(m => m.status === 'finished' || m.status === 'void')
  const finalists = semis.map(canonicalSemiFinalist).filter(Boolean)
  const losers = semis.map(canonicalSemiLoser).filter(Boolean)

  const before = all(`SELECT id,status,team_a,team_b,winner FROM matches WHERE sport_id=? AND stage IN ('决赛','季军')`, sportId)
  if (!settled) {
    all(`SELECT * FROM matches WHERE sport_id=? AND stage IN ('决赛','季军') AND status<>'void'`, sportId)
      .forEach(m => voidMatch(m, reason, operator))
    const after = all(`SELECT id,status,team_a,team_b,winner FROM matches WHERE sport_id=? AND stage IN ('决赛','季军')`, sportId)
    return { created: 0, adjusted: after.filter(x => before.some(y => y.id === x.id && JSON.stringify(y) !== JSON.stringify(x))).length }
  }
  const final = get(`SELECT * FROM matches WHERE sport_id=? AND stage='决赛'`, sportId)
  // 决赛已完赛且仍有有效决赛队伍时，保留原决赛/季军战链路；只把失格一方改为对手 3:0 胜。
  // 若决赛双方都失格，才回退到半决赛口径重新递补决赛。
  const preserveFinishedPlacement = final?.status === 'finished' && activeSideOfMatch(final) != null
  if (preserveFinishedPlacement) {
    if (!isActiveTeam(final.team_a) || !isActiveTeam(final.team_b)) {
      finishWalkover(final, activeSideOfMatch(final), reason, operator)
    }
  } else if (finalists.length === 2) {
    syncPlacementMatch(sportId, '决赛', { status: 'scheduled', teams: finalists }, 101, '16:00', reason, operator)
  } else if (finalists.length === 1) {
    const f = finalists[0]
    syncPlacementMatch(sportId, '决赛', { status: 'finished', teams: semis.find(m => canonicalSemiFinalist(m) === f).team_a === f ? [f, null] : [null, f] },
      101, '16:00', reason, operator)
  } else {
    syncPlacementMatch(sportId, '决赛', { teams: [] }, 101, '16:00', reason, operator)
  }

  const third = get(`SELECT * FROM matches WHERE sport_id=? AND stage='季军'`, sportId)
  if (preserveFinishedPlacement) {
    if (third && third.status !== 'void') {
      const remaining = activeSideOfMatch(third)
      if (!isActiveTeam(third.team_a) || !isActiveTeam(third.team_b)) {
        if (remaining != null) finishWalkover(third, remaining, reason, operator)
        else voidMatch(third, reason, operator)
      }
    }
  } else if (losers.length === 2) {
    syncPlacementMatch(sportId, '季军', { status: 'scheduled', teams: losers }, 102, '15:30', reason, operator)
  } else if (losers.length === 1) {
    const l = losers[0]
    syncPlacementMatch(sportId, '季军', { status: 'finished', teams: semis.find(m => canonicalSemiLoser(m) === l).team_a === l ? [l, null] : [null, l] },
      102, '15:30', reason, operator)
  } else {
    syncPlacementMatch(sportId, '季军', { teams: [] }, 102, '15:30', reason, operator)
  }

  const after = all(`SELECT id,status,team_a,team_b,winner FROM matches WHERE sport_id=? AND stage IN ('决赛','季军')`, sportId)
  return {
    created: after.filter(x => !before.some(y => y.id === x.id)).length,
    adjusted: after.filter(x => before.some(y => y.id === x.id && JSON.stringify(y) !== JSON.stringify(x))).length
  }
}

// 足球小组赛出线名额被取消时，只在尚未进行的半决赛按同组名次递补；半决赛已赛则按失利方递补
function groupAlternateFor(sportId, groupName, occupiedTeamIds) {
  const occupied = new Set(occupiedTeamIds)
  const ids = all(`SELECT DISTINCT team_a id FROM matches WHERE sport_id=? AND group_name=? AND team_a IS NOT NULL
                   UNION SELECT DISTINCT team_b FROM matches WHERE sport_id=? AND group_name=? AND team_b IS NOT NULL`,
    sportId, groupName, sportId, groupName)
    .map(r => r.id)
    .filter(id => isActiveTeam(id) && !occupied.has(id))
  return ids
    .map(id => ({ id, rank: get('SELECT rank r FROM standings WHERE sport_id=? AND team_id=?', sportId, id)?.r ?? 999 }))
    .sort((a, b) => a.rank - b.rank || a.id - b.id)[0]?.id ?? null
}

function replaceScheduledKnockoutTeam(m, teamId, replacement, reason, operator = '系统') {
  const teamA = m.team_a === teamId ? replacement : m.team_a
  const teamB = m.team_b === teamId ? replacement : m.team_b
  run(`UPDATE matches SET team_a=?, team_b=?, note=? WHERE id=?`, teamA, teamB, reason, m.id)
  const fresh = get('SELECT * FROM matches WHERE id=?', m.id)
  addLog('match_change', m.id, null, `${matchTitle(m)}：失去资格队伍由递补队伍替换，执法安排继续有效`, reason, operator)
  return fresh
}

// 循环赛重排的场次初始化：保留仍存在对阵的时间/场地，新对阵补齐不撞场的默认时段
function initRoundRobinSchedule(sportId, oldMatches) {
  const spo = get('SELECT * FROM sports WHERE id=?', sportId)
  const defaultVenueId = vid(spo.venue)
  const oldByPair = new Map()
  oldMatches.forEach(m => {
    if (!m.team_a || !m.team_b) return
    oldByPair.set(`${Math.min(m.team_a, m.team_b)}-${Math.max(m.team_a, m.team_b)}`, m)
  })
  const taken = new Set(all(`SELECT venue_id, time_label FROM matches
                            WHERE status='scheduled' AND venue_id IS NOT NULL AND time_label IS NOT NULL`)
    .map(m => `${m.venue_id}:${m.time_label}`))
  const makeTime = index => {
    const total = index * 20
    return `${String(9 + Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  }
  let timeIndex = 0
  const nextSlot = venueId => {
    let label = makeTime(timeIndex++)
    while (venueId && taken.has(`${venueId}:${label}`)) label = makeTime(timeIndex++)
    if (venueId) taken.add(`${venueId}:${label}`)
    return label
  }
  return ([a, b], orderNo) => {
    const old = oldByPair.get(`${Math.min(a, b)}-${Math.max(a, b)}`)
    const venueId = old?.venue_id || defaultVenueId
    const timeLabel = old?.time_label || nextSlot(venueId)
    return { venueId, timeLabel }
  }
}

function generateKO(sportId) {
  const spo = get('SELECT * FROM sports WHERE id=?', sportId)
  if (spo.format === 'knockout') {
    // 羽毛球：半决赛全部有效完赛/取消后，由统一级联逻辑生成决赛与季军战
    const semis = all(`SELECT * FROM matches WHERE sport_id=? AND stage='半决赛' ORDER BY order_no,id`, sportId)
    const hasFinal = get(`SELECT id FROM matches WHERE sport_id=? AND stage='决赛'`, sportId)
    if (semis.length && semis.every(s => s.status === 'finished' || s.status === 'void')) {
      if (semis.some(s => s.status === 'finished' && s.winner == null)) return '半决赛存在平分未决胜场次，请先补录加时/点球决胜比分'
      reconcileKnockout(sportId, '淘汰赛按半决赛赛果编排', '系统')
      return '已生成羽毛球 决赛 与 季军战'
    }
    return null
  }
  // group_knockout：小组完成后生成半决赛，半决赛完成/取消后由统一逻辑同步决赛与季军战
  const groups = ['A组', 'B组']
  const done = {}
  groups.forEach(g => {
    const gms = all(`SELECT * FROM matches WHERE sport_id=? AND group_name=?`, sportId, g)
    done[g] = gms.length === 0 || gms.every(m => m.status === 'finished' || m.status === 'void')
  })
  const hasSemi = get(`SELECT id FROM matches WHERE sport_id=? AND stage='半决赛'`, sportId)
  if (groups.every(g => done[g]) && !hasSemi) {
    const rankOf = g => {
      const ids = all(`SELECT DISTINCT team_a id FROM matches WHERE sport_id=? AND group_name=? AND team_a IS NOT NULL UNION SELECT DISTINCT team_b FROM matches WHERE sport_id=? AND group_name=? AND team_b IS NOT NULL`, sportId, g, sportId, g)
        .map(r => r.id)
        .filter(id => get('SELECT status FROM teams WHERE id=?', id)?.status === 'approved')
      // 与积分榜同一排名口径（积分 → 净胜球），避免同分时晋级对阵与榜单不一致
      return ids.map(id => ({ id, rank: get('SELECT rank r FROM standings WHERE sport_id=? AND team_id=?', sportId, id)?.r ?? 999 })).sort((a, b) => a.rank - b.rank).map(r => r.id)
    }
    const A = rankOf('A组'), B = rankOf('B组')
    if (A.length >= 2 && B.length >= 2) {
      const r1 = run('INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?)', sportId, '半决赛', A[0], B[1], vid('五人足球场'), 99, '14:00', 'scheduled')
      const r2 = run('INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?)', sportId, '半决赛', B[0], A[1], vid('五人足球场'), 100, '14:30', 'scheduled')
      const ids = [Number(r1.lastInsertRowid), Number(r2.lastInsertRowid)]
      ids.forEach(id => addLog('schedule_added', id, null, `${matchTitle(get('SELECT * FROM matches WHERE id=?', id))} 由小组出线排名生成`, null, '系统'))
      autoCrewForNewMatches(ids, '系统')
      return '已按小组排名生成足球半决赛'
    }
    return null
  }
  const semis = all(`SELECT * FROM matches WHERE sport_id=? AND stage='半决赛' ORDER BY order_no,id`, sportId)
  const hasFinal = get(`SELECT id FROM matches WHERE sport_id=? AND stage='决赛'`, sportId)
  if (semis.length && semis.every(s => s.status === 'finished' || s.status === 'void') && !hasFinal) {
    if (semis.some(s => s.status === 'finished' && s.winner == null)) return '半决赛存在平分未决胜场次，请先补录加时/点球决胜比分'
    reconcileKnockout(sportId, '淘汰赛按半决赛赛果编排', '系统')
    return '已生成决赛 与 季军战'
  }
  return null
}
function finishTrack(sportId, body) {
  // body: [{athlete_id, mark}]（顺序无关，服务端按成绩重新排名）
  const spo = get('SELECT * FROM sports WHERE id=?', sportId)
  if (!spo) throw new Error('比赛项目不存在')
  if (spo.format !== 'track') throw new Error('仅田径项目可录入计时成绩')
  if (!Array.isArray(body) || !body.length) throw new Error('成绩数据不能为空')

  // 逐条结构校验：运动员 id 必须有效，成绩必须为大于 0 的数字（拒绝空值/NaN/负数/0）
  const rows = []
  const seen = new Set()
  for (const b of body) {
    if (!b || typeof b !== 'object') throw new Error('存在格式无效的成绩记录')
    const athleteId = Number(b.athlete_id)
    if (!Number.isInteger(athleteId) || athleteId <= 0) throw new Error('存在无效的运动员编号')
    if (seen.has(athleteId)) {
      const dup = get('SELECT name FROM athletes WHERE id=?', athleteId)
      throw new Error(`运动员「${dup?.name || athleteId}」的成绩重复提交，请去重后重新结算`)
    }
    seen.add(athleteId)
    const mark = Number(b.mark)
    if (!Number.isFinite(mark) || mark <= 0) throw new Error('成绩必须为大于 0 的有效数字（秒），不能为空')
    rows.push({ athleteId, mark })
  }

  // 有效参赛名单 = 本项目有成绩档案且资格仍为 approved 的运动员
  const entries = all(`SELECT e.id entry_id, e.athlete_id, a.name, a.status
                       FROM entries e JOIN athletes a ON a.id=e.athlete_id
                       WHERE e.sport_id=?`, sportId)
  const byAthlete = new Map(entries.map(e => [e.athlete_id, e]))
  const foreign = rows.find(r => {
    const e = byAthlete.get(r.athleteId)
    return !e || e.status !== 'approved'
  })
  if (foreign) {
    const ath = get('SELECT name FROM athletes WHERE id=?', foreign.athleteId)
    throw new Error(`运动员「${ath?.name || foreign.athleteId}」不在本项目的有效参赛名单中，不能计入成绩`)
  }
  // 缺失校验：有效名单中任何一人未提交成绩，都不允许结算
  const missing = entries.filter(e => e.status === 'approved' && !seen.has(e.athlete_id))
  if (missing.length) {
    throw new Error(`还有 ${missing.length} 名运动员缺少成绩（${missing.map(m => m.name).join('、')}），补齐后才能结算`)
  }

  // 事务写入：任一更新失败整体回滚，绝不允许半结算污染排名与奖牌
  withTransaction(() => {
    // 清理失去资格（退报/撤销）运动员残留的成绩档案
    entries.filter(e => e.status !== 'approved').forEach(e => run('DELETE FROM entries WHERE id=?', e.entry_id))
    rows.sort((a, b) => a.mark - b.mark)
    rows.forEach((r, i) => {
      const unitId = get('SELECT unit_id FROM athletes WHERE id=?', r.athleteId)?.unit_id ?? null
      run('UPDATE entries SET mark=?, rank=?, unit_id=? WHERE athlete_id=? AND sport_id=?',
        r.mark, i + 1, unitId, r.athleteId, sportId)
    })
    run('UPDATE sports SET finished=1 WHERE id=?', sportId)
  })

  recomputeMedals()
}
/* ================= 参赛资格审核（报名 → 审核 → 退报/撤销） ================= */
function submitRegistration(kind, unitId, sportId, name) {
  // 单事务：重名检查与入库原子化，避免并发重复提交产生两条待审记录
  return withTransaction(() => {
    if (!get('SELECT id FROM units WHERE id=?', unitId)) throw new Error('参赛单位不存在')
    if (!get('SELECT id FROM sports WHERE id=?', sportId)) throw new Error('比赛项目不存在')
    name = (name || '').trim()
    if (!name) throw new Error('名称不能为空')
    if (kind === 'team') {
      if (get('SELECT id FROM teams WHERE name=? AND sport_id=? AND unit_id=?', name, sportId, unitId)) throw new Error('该单位已报名同名队伍')
      const r = run('INSERT INTO teams (name,unit_id,sport_id,status) VALUES (?,?,?,?)', name, unitId, sportId, 'pending')
      const teamId = Number(r.lastInsertRowid)
      run('INSERT INTO registrations (kind,unit_id,sport_id,team_id,name,status) VALUES (?,?,?,?,?,?)', kind, unitId, sportId, teamId, name, 'pending')
      return { id: teamId, kind }
    }
    if (get('SELECT id FROM athletes WHERE name=? AND sport_id=? AND unit_id=?', name, sportId, unitId)) throw new Error('该单位已报名同名运动员')
    const r = run('INSERT INTO athletes (name,unit_id,sport_id,status) VALUES (?,?,?,?)', name, unitId, sportId, 'pending')
    const athId = Number(r.lastInsertRowid)
    run('INSERT INTO registrations (kind,unit_id,sport_id,athlete_id,name,status) VALUES (?,?,?,?,?,?)', kind, unitId, sportId, athId, name, 'pending')
    return { id: athId, kind }
  })
}

function approveRegistration(regId, reviewer) {
  // 整体单事务（BEGIN IMMEDIATE）：名额检查 → 占位 → 资格生效 → 循环赛程重排 → 积分/奖牌重建，
  // 任一环节失败整体回滚，杜绝"名额已占但赛程重排一半"的中间态；写锁前置使并发审核串行化。
  return withTransaction(() => {
    const reg = get('SELECT * FROM registrations WHERE id=?', regId)
    if (!reg) throw new Error('报名记录不存在')
    // 审核幂等：重复提交（双击/重试/并发）直接返回首次审核结果，
    // 不重复占用名额、不重复触发循环赛程重排
    if (reg.status === 'approved') return { ok: true, quota_no: reg.quota_no, idempotent: true }
    if (reg.status !== 'pending') throw new Error('该报名已处理，不能重复审核')
    const quota = get('SELECT quota FROM sports WHERE id=?', reg.sport_id)?.quota ?? 8
    const approved = reg.kind === 'team'
      ? get(`SELECT COUNT(*) c FROM teams WHERE sport_id=? AND status='approved'`, reg.sport_id).c
      : get(`SELECT COUNT(*) c FROM athletes WHERE sport_id=? AND status='approved'`, reg.sport_id).c
    if (approved >= quota) {
      const err = new Error(`名额已满（${quota} 个），无法通过`)
      err.code = 'QUOTA_FULL'
      throw err
    }
    const quotaNo = approved + 1
    // 原子状态迁移：并发下仅一个请求能把 pending → approved，其余按幂等成功返回首次结果
    const claim = run(`UPDATE registrations SET status='approved', quota_no=?, reviewed_at=datetime('now','localtime'), reviewer=?
                       WHERE id=? AND status='pending'`, quotaNo, reviewer || '组委会', regId)
    if (!claim.changes) {
      const now = get('SELECT status, quota_no FROM registrations WHERE id=?', regId)
      if (now?.status === 'approved') return { ok: true, quota_no: now.quota_no, idempotent: true }
      throw new Error('该报名已处理，不能重复审核')
    }
    if (reg.kind === 'team') {
      run(`UPDATE teams SET status='approved' WHERE id=?`, reg.team_id)
      // 循环赛：若尚未开赛，重新排定循环赛程，把新队伍纳入对阵
      const spo = get('SELECT * FROM sports WHERE id=?', reg.sport_id)
      const finished = get(`SELECT COUNT(*) c FROM matches WHERE sport_id=? AND status='finished'`, reg.sport_id).c
      if (spo.format === 'roundrobin' && finished === 0) {
        // 赛程重排：先释放旧场次在派执法安排并留痕，再重建对阵（与审核同事务，失败一并回滚）
        const old = all(`SELECT * FROM matches WHERE sport_id=?`, reg.sport_id)
        old.forEach(m => releaseAssignmentsOfMatch(m, '报名通过触发循环赛程重排', reviewer || '系统'))
        run(`DELETE FROM matches WHERE sport_id=?`, reg.sport_id)
        const teams = all(`SELECT id FROM teams WHERE sport_id=? AND status='approved' ORDER BY id`, reg.sport_id).map(t => t.id)
        const pairList = arr => { const p = []; for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) p.push([arr[i], arr[j]]); return p }
        const scheduleFor = initRoundRobinSchedule(reg.sport_id, old)
        let ono = 0
        const newIds = []
        pairList(teams).forEach(([a, b]) => {
          ono++
          const { venueId, timeLabel } = scheduleFor([a, b], ono)
          const r = run('INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?)',
            reg.sport_id, '循环', a, b, venueId, ono, timeLabel, 'scheduled')
          newIds.push(Number(r.lastInsertRowid))
        })
        const crewResult = autoCrewForNewMatches(newIds, reviewer || '系统')
        const skipText = crewResult.skipped.length ? `；${crewResult.skipped.length} 个执法席位待排班` : ''
        addLog('schedule_rebuild', null, null,
          `${spo.name} 循环赛程因新增通过队伍「${reg.name}」重排，共 ${newIds.length} 场；时间、场地已初始化，整场协同排班补齐 ${crewResult.assigned.length} 个执法席位（主裁/助理/记录台）${skipText}`,
          null, reviewer || '系统')
      }
    } else {
      run(`UPDATE athletes SET status='approved' WHERE id=?`, reg.athlete_id)
      // 田径：审核通过即建立成绩档案（成绩留空待录），否则该运动员无法参与成绩录入与结算
      const spo = get('SELECT * FROM sports WHERE id=?', reg.sport_id)
      if (spo.format === 'track') {
        const exists = get('SELECT id FROM entries WHERE sport_id=? AND athlete_id=?', reg.sport_id, reg.athlete_id)
        if (!exists) {
          run('INSERT INTO entries (sport_id,athlete_id,mark,rank,unit_id) VALUES (?,?,NULL,NULL,?)',
            reg.sport_id, reg.athlete_id, reg.unit_id)
        }
      }
    }
    rebuildStandings(reg.sport_id)
    recomputeMedals()
    return { ok: true, quota_no: quotaNo }
  })
}

function rejectRegistration(regId, note, reviewer) {
  return withTransaction(() => {
    const reg = get('SELECT * FROM registrations WHERE id=?', regId)
    if (!reg) throw new Error('报名记录不存在')
    // 审核幂等：重复驳回直接返回成功，不产生二次副作用
    if (reg.status === 'rejected') return { ok: true, idempotent: true }
    if (reg.status !== 'pending') throw new Error('该报名已处理')
    const claim = run(`UPDATE registrations SET status='rejected', review_note=?, reviewed_at=datetime('now','localtime'), reviewer=?
                       WHERE id=? AND status='pending'`, note || '资料不符', reviewer || '组委会', regId)
    if (!claim.changes) return { ok: true, idempotent: true }   // 并发下已被其它请求处理
    if (reg.kind === 'team') run(`UPDATE teams SET status='rejected' WHERE id=? AND status='pending'`, reg.team_id)
    else run(`UPDATE athletes SET status='rejected' WHERE id=? AND status='pending'`, reg.athlete_id)
    return { ok: true }
  })
}

// 退报（单位主动）/ 撤销资格（组委会）：同步处理受影响的对阵及成绩
// 整体单事务：资格变更 + 弃权/取消成绩 + 淘汰赛递补级联 + 积分/奖牌重算，任一失败整体回滚
function withdrawOrRevoke(regId, action, note, reviewer) {
  return withTransaction(() => {
    const reg = get('SELECT * FROM registrations WHERE id=?', regId)
    if (!reg) throw new Error('报名记录不存在')
    const newStatus = action === 'withdraw' ? 'withdrawn' : 'revoked'
    const emptyImpact = { voided: 0, walkover: 0, entries: 0, replacements: 0, cascade: 0 }
    // 幂等：已处于目标状态（重复提交/重试）直接返回成功，不重复级联
    if (reg.status === newStatus) return { ok: true, idempotent: true, impact: emptyImpact }
    if (reg.status !== 'approved') throw new Error('仅已通过的报名可退报/撤销')
    const reason = note || (action === 'withdraw' ? '单位退报' : '组委会撤销资格')
    // 原子状态迁移：并发下仅一个请求生效
    const claim = run(`UPDATE registrations SET status=?, review_note=?, reviewed_at=datetime('now','localtime'), reviewer=?
                       WHERE id=? AND status='approved'`, newStatus, reason, reviewer || '组委会', regId)
    if (!claim.changes) {
      const now = get('SELECT status FROM registrations WHERE id=?', regId)
      if (now?.status === newStatus) return { ok: true, idempotent: true, impact: emptyImpact }
      throw new Error('仅已通过的报名可退报/撤销')
    }
    const impact = { ...emptyImpact }
    if (reg.kind === 'team') {
      run(`UPDATE teams SET status=? WHERE id=?`, newStatus, reg.team_id)
      const teamId = reg.team_id
      const spo = get('SELECT * FROM sports WHERE id=?', reg.sport_id)
      const walkoverNote = action === 'withdraw' ? '弃权(退报)' : '弃权(撤销资格)'
      const voidNote = action === 'withdraw' ? '成绩取消(退报)' : '成绩取消(撤销资格)'
      const replaceNote = action === 'withdraw' ? '退报递补调整' : '撤销资格递补调整'
      const operator = reviewer || '系统'
      const matchesOfTeam = () => all(`SELECT * FROM matches WHERE sport_id=? AND (team_a=? OR team_b=?)`, reg.sport_id, teamId, teamId)

      if (spo.format === 'roundrobin') {
        matchesOfTeam().forEach(m => {
          if (m.status === 'scheduled') {
            const opponent = m.team_a === teamId ? m.team_b : m.team_a
            if (isActiveTeam(opponent)) {
              impact.walkover += finishWalkover(m, opponent, walkoverNote, operator) ? 1 : 0
            } else {
              voidMatch(m, voidNote, operator)
              impact.voided++
            }
          } else if (m.status === 'finished') {
            voidMatch(m, voidNote, operator)
            impact.voided++
          }
        })
        rebuildStandings(reg.sport_id)
      } else {
        const processMatch = m => {
          if (m.status === 'scheduled') {
            const opponent = m.team_a === teamId ? m.team_b : m.team_a
            if (isActiveTeam(opponent)) {
              impact.walkover += finishWalkover(m, opponent, walkoverNote, operator) ? 1 : 0
            } else {
              voidMatch(m, voidNote, operator)
              impact.voided++
            }
          } else if (m.status === 'finished') {
            voidMatch(m, voidNote, operator)
            impact.voided++
          }
        }

        // 先处理已有小组成绩并刷新积分榜；半决赛递补必须基于取消成绩后的真实排名
        matchesOfTeam().filter(m => m.group_name).forEach(processMatch)
        rebuildStandings(reg.sport_id)

        // 足球小组+淘汰：若半决赛尚未进行，先按同组积分榜顺位递补，避免后续轮次沿用失去资格的名额
        const existingSemis = all(`SELECT * FROM matches WHERE sport_id=? AND stage='半决赛' ORDER BY order_no,id`, reg.sport_id)
        const sourceSemi = existingSemis.find(m => (m.team_a === teamId || m.team_b === teamId) && m.status === 'scheduled')
        if (spo.format === 'group_knockout' && sourceSemi) {
          const occupied = existingSemis.flatMap(m => [m.team_a, m.team_b]).filter(id => id != null && id !== teamId)
          const groupName = get(`SELECT group_name FROM matches WHERE sport_id=? AND (team_a=? OR team_b=?) AND group_name IS NOT NULL LIMIT 1`, reg.sport_id, teamId, teamId)?.group_name
          const substitute = groupAlternateFor(reg.sport_id, groupName, occupied)
          if (substitute != null) {
            replaceScheduledKnockoutTeam(sourceSemi, teamId, substitute, replaceNote, operator)
            impact.replacements++
          }
        }

        // 直接处理来源半决赛；已生成的决赛、季军战交给统一级联逻辑改赛、重赛或轮空，避免提前按旧对阵判弃权
        matchesOfTeam()
          .filter(m => !m.group_name && m.stage === '半决赛')
          .forEach(processMatch)

        // 统一同步决赛/季军战、轮空结算、执法安排和奖牌
        rebuildStandings(reg.sport_id)
        if (existingSemis.length) {
          const r = reconcileKnockout(reg.sport_id, `${reason}触发淘汰赛级联调整`, operator)
          impact.cascade = r.created + r.adjusted
        }
      }
    } else {
      run(`UPDATE athletes SET status=? WHERE id=?`, newStatus, reg.athlete_id)
      // 田径：删除该运动员在该项目的成绩
      const r = run(`DELETE FROM entries WHERE athlete_id=? AND sport_id=?`, reg.athlete_id, reg.sport_id)
      impact.entries = r.changes
      recomputeTrackRanks(reg.sport_id)
    }
    recomputeMedals()
    return { ok: true, impact }
  })
}

function recomputeTrackRanks(sportId) {
  // 空成绩（未录入）不参与排名，避免 NULL 在升序中排到首位而被奖牌统计取中
  const rows = all(`SELECT id FROM entries WHERE sport_id=? AND mark IS NOT NULL ORDER BY mark ASC`, sportId)
  rows.forEach((r, i) => run(`UPDATE entries SET rank=? WHERE id=?`, i + 1, r.id))
  run(`UPDATE entries SET rank=NULL WHERE sport_id=? AND mark IS NULL`, sportId)
}

/* ================= 历史赛程统计修复 ================= */
// 校正并发审核/重排在历史数据中遗留的失真，让积分榜与奖牌榜回到权威赛果口径：
// 1) 循环赛重复对阵场次去重（并发重排可能重复插场）：保留最早有效场，多余场解除执法并作废留痕
// 2) 已通过报名的名额序号按审核时间重排，消除并发占号造成的重号/跳号
// 3) 清理失去资格运动员残留的成绩档案并重排田径名次
// 4) 积分榜按已完赛历史全量重建；5) 奖牌榜按权威赛果全量重算
// 幂等：健康库上执行为无操作；超额项目只报告不自动处置（取消资格属业务决策）
function repairHistoricalStats(operator = '系统') {
  return withTransaction(() => {
    const report = { duplicate_matches: 0, quota_no_fixed: 0, entries_cleaned: 0, standings_rebuilt: 0, over_quota: [] }

    // 1) 循环赛重复对阵去重（同项目同一对阵只允许存在一场有效场次）
    all(`SELECT id FROM sports WHERE format='roundrobin'`).forEach(spo => {
      const rows = all(`SELECT * FROM matches WHERE sport_id=? AND status<>'void'
                        AND team_a IS NOT NULL AND team_b IS NOT NULL ORDER BY id`, spo.id)
      const seen = new Set()
      rows.forEach(m => {
        const key = `${Math.min(m.team_a, m.team_b)}-${Math.max(m.team_a, m.team_b)}`
        if (!seen.has(key)) { seen.add(key); return }
        releaseAssignmentsOfMatch(m, '历史修复：并发重排产生的重复场次作废', operator)
        run(`UPDATE matches SET status='void', note=? WHERE id=?`, '历史修复：并发重排产生的重复场次', m.id)
        addLog('match_change', m.id, null, `${matchTitle(m)} 历史修复：并发重排产生的重复场次作废`, null, operator)
        report.duplicate_matches++
      })
    })

    // 2) 名额序号重排（按审核时间/提交顺序连续编号）
    all(`SELECT DISTINCT sport_id, kind FROM registrations WHERE status='approved'`).forEach(({ sport_id, kind }) => {
      const rows = all(`SELECT id, quota_no FROM registrations WHERE sport_id=? AND kind=? AND status='approved'
                        ORDER BY reviewed_at, id`, sport_id, kind)
      rows.forEach((r, i) => {
        if (r.quota_no !== i + 1) { run('UPDATE registrations SET quota_no=? WHERE id=?', i + 1, r.id); report.quota_no_fixed++ }
      })
    })

    // 3) 失格运动员残留成绩档案清理 + 田径名次重排
    report.entries_cleaned = run(`DELETE FROM entries WHERE athlete_id IN (SELECT id FROM athletes WHERE status<>'approved')`).changes
    all(`SELECT id FROM sports WHERE format='track'`).forEach(s => recomputeTrackRanks(s.id))

    // 4)+5) 积分榜/奖牌榜全量重建（均以完赛场次与有效资格为唯一口径）
    rebuildStandings()
    recomputeMedals()
    report.standings_rebuilt = all('SELECT id FROM sports').length

    // 超额项目告警：历史并发放行造成的超额只报告，不自动取消资格
    all('SELECT id, name, format, quota FROM sports').forEach(s => {
      const quota = s.quota ?? 8
      const used = s.format === 'track'
        ? get(`SELECT COUNT(*) c FROM athletes WHERE sport_id=? AND status='approved'`, s.id).c
        : get(`SELECT COUNT(*) c FROM teams WHERE sport_id=? AND status='approved'`, s.id).c
      if (used > quota) report.over_quota.push({ sport_id: s.id, name: s.name, quota, approved: used })
    })
    return report
  })
}
seed()
// 启动即对历史库做一次统计修复（幂等，健康库为无操作）
{
  const r = repairHistoricalStats('系统')
  const fixed = r.duplicate_matches + r.quota_no_fixed + r.entries_cleaned
  if (fixed || r.over_quota.length) console.log('[SPORT] 历史赛程统计修复：', JSON.stringify(r))
}

/* ================= API ================= */
const joinMatch = m => {
  if (!m) return null
  return {
    ...m,
    teamA: m.team_a ? get('SELECT id,name,unit_id FROM teams WHERE id=?', m.team_a) : null,
    teamB: m.team_b ? get('SELECT id,name,unit_id FROM teams WHERE id=?', m.team_b) : null,
    venue: get('SELECT * FROM venues WHERE id=?', m.venue_id) || null
  }
}
app.get('/api/sports', (_, res) => res.json(all('SELECT * FROM sports')))
app.get('/api/teams', (_, res) => res.json(all('SELECT t.*, u.name unit, u.color FROM teams t JOIN units u ON u.id=t.unit_id')))
app.get('/api/units', (_, res) => res.json(all('SELECT * FROM units')))
app.get('/api/venues', (_, res) => res.json(all('SELECT * FROM venues')))
app.get('/api/referees', (_, res) => res.json(all('SELECT * FROM referees ORDER BY id')))
app.post('/api/referees', (req, res) => {
  const name = (req.body.name || '').trim()
  if (!name) return res.status(400).json({ error: '裁判姓名不能为空' })
  if (get('SELECT id FROM referees WHERE name=?', name)) return res.status(400).json({ error: '已存在同名裁判' })
  const r = run('INSERT INTO referees (name,sport,level,status) VALUES (?,?,?,?)', name, req.body.sport || null, req.body.level || '主裁', req.body.status || '就绪')
  res.json({ ok: true, id: Number(r.lastInsertRowid) })
})
app.get('/api/athletes', (_, res) => res.json(all('SELECT a.*, u.name unit FROM athletes a JOIN units u ON u.id=a.unit_id')))
app.get('/api/matches', (_, res) => res.json(all('SELECT * FROM matches').map(joinMatch)))
app.get('/api/entries', (_, res) => res.json(all('SELECT e.*, a.name aname, u.name unit FROM entries e JOIN athletes a ON a.id=e.athlete_id JOIN units u ON u.id=e.unit_id')))

/* —— 裁判排班：执法安排 / 冲突 / 留痕 —— */
const joinAssignment = a => ({
  ...a,
  referee: get('SELECT id,name,sport,level,status FROM referees WHERE id=?', a.referee_id),
  match: joinMatch(get('SELECT * FROM matches WHERE id=?', a.match_id))
})
app.get('/api/assignments', (_, res) => {
  res.json(all(`SELECT a.* FROM assignments a WHERE a.status='assigned' ORDER BY a.id DESC`).map(joinAssignment))
})
app.post('/api/assignments', (req, res) => {
  try {
    const r = assignReferee(Number(req.body.match_id), Number(req.body.referee_id), req.body.role || 'chief', req.body.operator, req.body.reason, !!req.body.force)
    res.json({ ok: true, ...r })
  } catch (e) {
    res.status(e.code === 'CONFLICT' || e.code === 'SKILL_MISMATCH' || e.code === 'ROLE_MISMATCH' ? 409 : 400).json({ error: e.message, code: e.code, conflicts: e.conflicts })
  }
})
app.post('/api/assignments/auto', (req, res) => res.json({ ok: true, ...autoAssign(req.body.operator) }))
app.post('/api/assignments/:id/release', (req, res) => {
  try { res.json(releaseAssignment(Number(req.params.id), req.body.operator, req.body.reason)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/assignments/:id/reassign', (req, res) => {
  try {
    const r = reassignAssignment(Number(req.params.id), {
      target_id: req.body.target_id ? Number(req.body.target_id) : null,
      new_referee_id: req.body.new_referee_id,
      reason: req.body.reason, operator: req.body.operator
    })
    res.json({ ok: true, ...r })
  } catch (e) {
    res.status(e.code === 'CONFLICT' || e.code === 'SKILL_MISMATCH' || e.code === 'ROLE_MISMATCH' ? 409 : 400).json({ error: e.message, code: e.code, conflicts: e.conflicts })
  }
})
// 赛程变更（时间/场地），联动执法安排：冲突席位自动重排，不可消解则整体回滚
app.patch('/api/matches/:id/schedule', (req, res) => {
  try {
    const r = updateMatchSchedule(Number(req.params.id), {
      time_label: req.body.time_label, venue_id: req.body.venue_id,
      operator: req.body.operator, reason: req.body.reason, force: !!req.body.force,
      auto_reassign: req.body.auto_reassign !== false
    })
    res.json({ ok: true, ...r })
  } catch (e) {
    res.status(e.code === 'CONFLICT' ? 409 : 400).json({ error: e.message, code: e.code, conflicts: e.conflicts, rolled_back: !!e.rolledBack })
  }
})
app.get('/api/assignment-logs', (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 100)
  const rows = all(`SELECT l.*, r.name referee_name,
    s.name sport_name,
    (SELECT ta.name FROM matches m2 LEFT JOIN teams ta ON ta.id=m2.team_a WHERE m2.id=l.match_id) team_a_name,
    (SELECT tb.name FROM matches m3 LEFT JOIN teams tb ON tb.id=m3.team_b WHERE m3.id=l.match_id) team_b_name
    FROM assignment_logs l
    LEFT JOIN referees r ON r.id=l.referee_id
    LEFT JOIN matches m ON m.id=l.match_id
    LEFT JOIN sports s ON s.id=m.sport_id
    ORDER BY l.id DESC LIMIT ?`, limit)
  res.json(rows)
})
// 冲突与整场排班覆盖总览：待安排（分角色席位）/ 裁判撞档 / 场地撞场 / 专长不符 / 角色资质不符
app.get('/api/conflicts', (_, res) => {
  const ballSports = new Set(all(`SELECT id FROM sports WHERE format<>'track'`).map(s => s.id))
  const scheduled = all(`SELECT * FROM matches WHERE status='scheduled' AND team_a IS NOT NULL AND team_b IS NOT NULL`)
    .filter(m => ballSports.has(m.sport_id))
  // 整场覆盖率：按执法席位（主裁/助理/记录台）统计
  let needSlots = 0, filledSlots = 0
  const roleSlots = { chief: { need: 0, filled: 0 }, assistant: { need: 0, filled: 0 }, recorder: { need: 0, filled: 0 } }
  const crewGaps = []
  const unassigned = []
  scheduled.forEach(m => {
    const need = crewSpecOfMatch(m)
    const rows = crewRowsOf(m.id)
    const missing = crewMissing(m, rows)
    ROLES.forEach(role => {
      roleSlots[role].need += need[role]
      roleSlots[role].filled += Math.min(need[role], rows.filter(a => a.role === role).length)
    })
    const totalNeed = ROLES.reduce((n, r2) => n + need[r2], 0)
    const totalHave = ROLES.reduce((n, r2) => n + Math.min(need[r2], rows.filter(a => a.role === r2).length), 0)
    needSlots += totalNeed; filledSlots += totalHave
    if (Object.keys(missing).length) {
      crewGaps.push({ match_id: m.id, title: matchTitle(m), missing, missing_text: crewShortText(missing), missing_count: totalNeed - totalHave })
      if (missing.chief) unassigned.push({ match_id: m.id, title: matchTitle(m) })
    }
  })
  const refereeConflicts = []
  all(`SELECT a.* FROM assignments a WHERE a.status='assigned'`).forEach(a => {
    const m = get(`SELECT * FROM matches WHERE id=?`, a.match_id)
    if (!m || m.status !== 'scheduled') return
    refBusyMatches(a.referee_id, m.time_label, m.id).forEach(b => {
      const key = [a.id, b.aid].sort().join('-')
      if (refereeConflicts.some(c => c.key === key)) return
      const r1 = get('SELECT name FROM referees WHERE id=?', a.referee_id)
      refereeConflicts.push({
        key, referee_id: a.referee_id, referee: r1?.name, time: m.time_label,
        role: a.role, role_name: ROLE_NAME[a.role] || '执法',
        match_x: { match_id: m.id, title: matchTitle(m) },
        match_y: { match_id: b.id, title: matchTitle(b) }
      })
    })
  })
  const venueConflicts = []
  scheduled.forEach(m => {
    if (!m.venue_id) return
    venueClashMatches(m.venue_id, m.time_label, m.id).forEach(o => {
      const key = [m.id, o.id].sort().join('-')
      if (venueConflicts.some(c => c.key === key)) return
      const v = get('SELECT name FROM venues WHERE id=?', m.venue_id)
      venueConflicts.push({ key, venue_id: m.venue_id, venue: v?.name, time: m.time_label,
        match_x: { match_id: m.id, title: matchTitle(m) }, match_y: { match_id: o.id, title: matchTitle(o) } })
    })
  })
  const skillMismatch = [], roleMismatch = []
  all(`SELECT a.* FROM assignments a WHERE a.status='assigned'`).forEach(a => {
    const m = get(`SELECT * FROM matches WHERE id=?`, a.match_id)
    if (!m || m.status !== 'scheduled') return
    const r = get('SELECT * FROM referees WHERE id=?', a.referee_id)
    if (!refSportOk(r, m.sport_id)) skillMismatch.push({ assignment_id: a.id, referee: r.name, referee_sport: r.sport, role: a.role, role_name: ROLE_NAME[a.role], match_id: m.id, title: matchTitle(m) })
    if (!refLevelOk(r, a.role)) roleMismatch.push({ assignment_id: a.id, referee: r.name, level: r.level, role: a.role, role_name: ROLE_NAME[a.role], match_id: m.id, title: matchTitle(m) })
  })
  // 改期联动统计：自动重排席位数 / 冲突回滚次数 / 赛程变更次数（报表中心覆盖率联动展示）
  const rs = get(`SELECT
    COALESCE(SUM(CASE WHEN action='auto_reassign' THEN 1 ELSE 0 END),0) auto_reassigned,
    COALESCE(SUM(CASE WHEN action='reschedule_rollback' THEN 1 ELSE 0 END),0) rollbacks,
    COALESCE(SUM(CASE WHEN action='match_change' THEN 1 ELSE 0 END),0) changes
    FROM assignment_logs`)
  res.json({
    // unassigned 保持原语义：缺主裁的场次（兼容旧视图）
    unassigned,
    crew_gaps: crewGaps,
    coverage: {
      match_total: scheduled.length,
      match_covered: scheduled.length - unassigned.length,
      slots_need: needSlots,
      slots_filled: filledSlots,
      slots_pct: needSlots ? Math.round(filledSlots / needSlots * 100) : 100,
      roles: Object.fromEntries(ROLES.map(r2 => [r2, {
        ...roleSlots[r2],
        pct: roleSlots[r2].need ? Math.round(roleSlots[r2].filled / roleSlots[r2].need * 100) : 100
      }]))
    },
    reschedule: { auto_reassigned: rs.auto_reassigned, rollbacks: rs.rollbacks, changes: rs.changes },
    referee_conflicts: refereeConflicts,
    venue_conflicts: venueConflicts,
    skill_mismatch: skillMismatch,
    role_mismatch: roleMismatch
  })
})
// 裁判执法工作量（含历史完赛场次，按角色拆分 + 合计）
app.get('/api/referee-workload', (_, res) => {
  const rows = all(`SELECT r.id, r.name, r.sport, r.level, r.status,
      SUM(CASE WHEN m.status='finished' THEN 1 ELSE 0 END) done,
      SUM(CASE WHEN m.status='scheduled' THEN 1 ELSE 0 END) upcoming,
      SUM(CASE WHEN m.status='finished' AND a.role='chief' THEN 1 ELSE 0 END) done_chief,
      SUM(CASE WHEN m.status='finished' AND a.role='assistant' THEN 1 ELSE 0 END) done_assistant,
      SUM(CASE WHEN m.status='finished' AND a.role='recorder' THEN 1 ELSE 0 END) done_recorder,
      SUM(CASE WHEN m.status='scheduled' AND a.role='chief' THEN 1 ELSE 0 END) upcoming_chief,
      SUM(CASE WHEN m.status='scheduled' AND a.role='assistant' THEN 1 ELSE 0 END) upcoming_assistant,
      SUM(CASE WHEN m.status='scheduled' AND a.role='recorder' THEN 1 ELSE 0 END) upcoming_recorder
    FROM referees r LEFT JOIN assignments a ON a.referee_id=r.id AND a.status='assigned'
    LEFT JOIN matches m ON m.id=a.match_id
    GROUP BY r.id ORDER BY done DESC, upcoming DESC, r.id`)
  res.json(rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v ?? 0]))))
})

// 参赛报名与资格审核
app.get('/api/registrations', (_, res) => {
  const rows = all(`SELECT r.*, u.name unit, s.name sport, s.format, s.category,
    CASE WHEN r.kind='team' THEN t.name ELSE a.name END AS name
    FROM registrations r
    JOIN units u ON u.id=r.unit_id
    JOIN sports s ON s.id=r.sport_id
    LEFT JOIN teams t ON t.id=r.team_id
    LEFT JOIN athletes a ON a.id=r.athlete_id
    ORDER BY r.id DESC`)
  res.json(rows)
})
app.post('/api/registrations', (req, res) => {
  const { kind, unit_id, sport_id, name } = req.body
  if (!['team', 'athlete'].includes(kind)) return res.status(400).json({ error: '报名类型无效' })
  try {
    const r = submitRegistration(kind, Number(unit_id), Number(sport_id), name)
    res.json({ ok: true, ...r })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/registrations/:id/approve', (req, res) => {
  try { res.json(approveRegistration(Number(req.params.id), req.body.reviewer)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/registrations/:id/reject', (req, res) => {
  try { res.json(rejectRegistration(Number(req.params.id), req.body.note, req.body.reviewer)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/registrations/:id/withdraw', (req, res) => {
  try { res.json(withdrawOrRevoke(Number(req.params.id), 'withdraw', req.body.note, req.body.reviewer)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/registrations/:id/revoke', (req, res) => {
  try { res.json(withdrawOrRevoke(Number(req.params.id), 'revoke', req.body.note, req.body.reviewer)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
// 历史赛程统计修复：重复对阵去重 / 名额序号重排 / 失格成绩清理 / 积分奖牌全量重建（幂等）
app.post('/api/maintenance/repair', (req, res) => {
  try { res.json({ ok: true, report: repairHistoricalStats(req.body?.operator || '组委会') }) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.get('/api/quota', (_, res) => {
  const sports = all('SELECT * FROM sports')
  res.json(sports.map(s => {
    const approved = s.format === 'track'
      ? get(`SELECT COUNT(*) c FROM athletes WHERE sport_id=? AND status='approved'`, s.id).c
      : get(`SELECT COUNT(*) c FROM teams WHERE sport_id=? AND status='approved'`, s.id).c
    const pending = get(`SELECT COUNT(*) c FROM registrations WHERE sport_id=? AND status='pending'`, s.id).c
    return { sport_id: s.id, name: s.name, format: s.format, quota: s.quota, approved, pending, used: approved + pending }
  }))
})
app.get('/api/standings/:sid', (req, res) => res.json(all('SELECT s.*, t.name tname, u.name unit, u.color FROM standings s JOIN teams t ON t.id=s.team_id JOIN units u ON u.id=t.unit_id WHERE s.sport_id=? ORDER BY s.rank', Number(req.params.sid))))
app.get('/api/medals', (_, res) => res.json(all('SELECT m.*, u.name FROM medals m JOIN units u ON u.id=m.unit_id ORDER BY m.gold DESC, m.silver DESC')))

app.get('/api/overview', (_, res) => {
  const sp = all('SELECT * FROM sports')
  const mats = all('SELECT * FROM matches')
  const done = mats.filter(m => m.status === 'finished')
  const pend = mats.filter(m => m.status === 'scheduled' && m.team_a && m.team_b)
  // 排班联动速览：主裁覆盖率 + 整场席位（主裁/助理/记录台）覆盖率
  const unassigned = pend.filter(m => !get(`SELECT id FROM assignments WHERE match_id=? AND role='chief' AND status='assigned'`, m.id)).length
  let slotsNeed = 0, slotsFilled = 0
  pend.forEach(m => {
    const spo = get('SELECT * FROM sports WHERE id=?', m.sport_id)
    if (spo.format === 'track') return
    const need = crewSpec(spo)
    const rows = crewRowsOf(m.id)
    ROLES.forEach(role => {
      slotsNeed += need[role]
      slotsFilled += Math.min(need[role], rows.filter(a => a.role === role).length)
    })
  })
  res.json({
    sports: sp.length,
    finishedMatches: done.length,
    pendingMatches: mats.filter(m => m.status === 'scheduled').length,
    teams: all('SELECT id FROM teams').length || 0,
    athletes: all('SELECT id FROM athletes').length,
    unassignedMatches: unassigned,
    crewCoverage: { need: slotsNeed, filled: slotsFilled, pct: slotsNeed ? Math.round(slotsFilled / slotsNeed * 100) : 100 },
    refereeConflicts: all(`SELECT COUNT(DISTINCT a1.id) c FROM assignments a1
      JOIN assignments a2 ON a1.referee_id=a2.referee_id AND a1.id<a2.id AND a1.status='assigned' AND a2.status='assigned'
      JOIN matches m1 ON m1.id=a1.match_id JOIN matches m2 ON m2.id=a2.match_id
      WHERE m1.status='scheduled' AND m2.status='scheduled' AND m1.time_label=m2.time_label`)[0]?.c || 0,
    sportDone: sp.map(s => ({ ...s, total: mats.filter(m => m.sport_id === s.id).length, done: done.filter(m => m.sport_id === s.id).length })),
    recent: all('SELECT * FROM matches ORDER BY id DESC LIMIT 5').map(joinMatch)
  })
})
app.post('/api/matches/:id/score', (req, res) => {
  const { score_a, score_b, tb_a, tb_b } = req.body
  const m = get('SELECT * FROM matches WHERE id=?', Number(req.params.id))
  if (!m) return res.status(404).json({ error: '场次不存在' })
  if (m.team_a == null || m.team_b == null) return res.status(400).json({ error: '对阵尚未编排，先编排淘汰赛' })
  const sa = Number(score_a), sb = Number(score_b)
  if (!Number.isInteger(sa) || !Number.isInteger(sb) || sa < 0 || sb < 0) return res.status(400).json({ error: '比分必须为非负整数' })
  // 录入预警：主裁缺失必须提示；其余执法席位（助理/记录台）缺口同步提示
  const crew = crewRowsOf(m.id)
  const hasChief = crew.some(a => a.role === 'chief')
  const missing = crewMissing(m, crew)
  const warnings = []
  if (!hasChief) warnings.push('该场次未安排主裁')
  if (missing.assistant) warnings.push(`缺助理裁判×${missing.assistant}`)
  if (missing.recorder) warnings.push('缺记录台')
  try {
    finishMatch(m.id, sa, sb, tb_a, tb_b)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }
  res.json({ ok: true, warning: warnings.length ? warnings.join('，') + '，请注意补录执法记录' : null })
})
app.post('/api/ko/:sportId', (req, res) => {
  // 单事务：半决赛/决赛生成与自动排班原子化，避免并发编排产生重复轮次
  const msg = withTransaction(() => generateKO(Number(req.params.sportId)))
  res.json({ ok: !!msg, msg })
})
app.post('/api/track/:sportId', (req, res) => {
  try {
    finishTrack(Number(req.params.sportId), req.body)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})
app.get('/api/reset', (_, res) => {
  // 单事务重置 + 重置后立即执行历史统计修复，保证演示数据口径一致
  withTransaction(() => {
    ['assignment_logs', 'assignments', 'registrations', 'entries', 'standings', 'medals', 'matches', 'referees', 'venues', 'athletes', 'teams', 'units', 'sports'].forEach(t => { try { run(`DELETE FROM ${t}`) } catch (e) {} })
    seed()
    repairHistoricalStats('系统')
  })
  res.json({ ok: true })
})

app.listen(PORT, () => console.log(`[SPORT] API running at http://localhost:${PORT}`))
