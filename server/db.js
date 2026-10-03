import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const db = new DatabaseSync(path.join(__dirname, 'event.db'))

// 并发写者排队等待而非立即报 SQLITE_BUSY（多进程/多连接同时审核报名时兜底）
db.exec('PRAGMA busy_timeout = 5000')
db.exec('PRAGMA journal_mode = WAL')

db.exec(`
CREATE TABLE IF NOT EXISTS sports (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,        -- 球类/田径/水上/棋牌
  format TEXT NOT NULL,          -- roundrobin / group_knockout / knockout / track
  venue TEXT,
  quota INTEGER DEFAULT 8,       -- 参赛名额（队伍数 / 运动员数）
  finished INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT
);
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  unit_id INTEGER NOT NULL,
  sport_id INTEGER NOT NULL,
  status TEXT DEFAULT 'approved'   -- pending/approved/rejected/withdrawn/revoked
);
CREATE TABLE IF NOT EXISTS athletes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  unit_id INTEGER NOT NULL,
  sport_id INTEGER NOT NULL,
  status TEXT DEFAULT 'approved'   -- pending/approved/rejected/withdrawn/revoked
);
CREATE TABLE IF NOT EXISTS venues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS referees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sport TEXT,                    -- 专长项目（NULL = 综合执法）
  level TEXT DEFAULT '主裁',      -- 主裁 / 助理裁判 / 记录台
  status TEXT DEFAULT '就绪'
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sport_id INTEGER NOT NULL,
  stage TEXT,            -- 小组/循环/半决赛/决赛/季军
  group_name TEXT,
  team_a INTEGER,        -- 队伍id，可为 0 占位
  team_b INTEGER,
  venue_id INTEGER,
  order_no INTEGER,
  time_label TEXT,
  score_a INTEGER,
  score_b INTEGER,
  tb_a INTEGER,          -- 加时/点球决胜比分（淘汰赛常规时间平分时必填）
  tb_b INTEGER,
  winner INTEGER,        -- 胜方队伍id（唯一权威数据源；小组/循环平局为 NULL）
  status TEXT DEFAULT 'scheduled',   -- scheduled / finished / void
  note TEXT               -- 弃权(退报)/弃权(撤销资格)/成绩取消(退报)/成绩取消(撤销资格)
);
CREATE TABLE IF NOT EXISTS entries (
  -- 田径成绩（单项）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sport_id INTEGER NOT NULL,
  athlete_id INTEGER NOT NULL,
  mark REAL,
  rank INTEGER,
  unit_id INTEGER
);
CREATE TABLE IF NOT EXISTS standings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sport_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  play INTEGER DEFAULT 0,
  win INTEGER DEFAULT 0,
  draw INTEGER DEFAULT 0,
  lose INTEGER DEFAULT 0,
  gf INTEGER DEFAULT 0,
  ga INTEGER DEFAULT 0,
  points INTEGER DEFAULT 0,
  rank INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS medals (
  unit_id INTEGER PRIMARY KEY,
  gold INTEGER DEFAULT 0,
  silver INTEGER DEFAULT 0,
  bronze INTEGER DEFAULT 0
);
-- 参赛报名与资格审核（工作流 + 审计）
CREATE TABLE IF NOT EXISTS registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,            -- team / athlete
  unit_id INTEGER NOT NULL,
  sport_id INTEGER NOT NULL,
  team_id INTEGER,
  athlete_id INTEGER,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending/approved/rejected/withdrawn/revoked
  quota_no INTEGER,              -- 审核通过时占用的名额序号
  submitted_at TEXT DEFAULT (datetime('now','localtime')),
  reviewed_at TEXT,
  reviewer TEXT,
  review_note TEXT
);
-- 裁判执法安排（场次 × 裁判；仅 assigned 状态参与冲突检测）
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL,
  referee_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'chief',   -- chief(主裁) / assistant(助理裁判) / recorder(记录台)
  status TEXT NOT NULL DEFAULT 'assigned', -- assigned(在派) / released(已解除)
  created_at TEXT DEFAULT (datetime('now','localtime')),
  released_at TEXT
);
-- 同一场次同一名裁判只允许存在一条"在派"安排（解除后可重新排班）
CREATE UNIQUE INDEX IF NOT EXISTS idx_assignment_active
  ON assignments(match_id, referee_id) WHERE status='assigned';
-- 排班/调班/赛程变更全量留痕
CREATE TABLE IF NOT EXISTS assignment_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,        -- assign/force_assign/auto_assign/release/reassign/swap/match_change/auto_reassign/reschedule_rollback/schedule_added/schedule_rebuild/match_finish/void_release
  match_id INTEGER,
  referee_id INTEGER,
  detail TEXT,                 -- 人类可读快照（场次/裁判/变更前后）
  reason TEXT,
  operator TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_logs_match ON assignment_logs(match_id);
`)

// —— 旧库迁移：补充字段（列已存在则忽略） ——
;[['tb_a', 'INTEGER'], ['tb_b', 'INTEGER'], ['winner', 'INTEGER']].forEach(([col, def]) => {
  try { db.prepare(`ALTER TABLE matches ADD COLUMN ${col} ${def}`).run() } catch (e) { /* 列已存在 */ }
})
;[['quota', 'INTEGER DEFAULT 8']].forEach(([col, def]) => {
  try { db.prepare(`ALTER TABLE sports ADD COLUMN ${col} ${def}`).run() } catch (e) { /* 列已存在 */ }
})
;[['status', "TEXT DEFAULT 'approved'"]].forEach(([col, def]) => {
  try { db.prepare(`ALTER TABLE teams ADD COLUMN ${col} ${def}`).run() } catch (e) { /* 列已存在 */ }
  try { db.prepare(`ALTER TABLE athletes ADD COLUMN ${col} ${def}`).run() } catch (e) { /* 列已存在 */ }
})
try { db.prepare(`ALTER TABLE matches ADD COLUMN note TEXT`).run() } catch (e) { /* 列已存在 */ }
;[['level', "TEXT DEFAULT '主裁'"], ['sport', 'TEXT'], ['status', "TEXT DEFAULT '就绪'"]].forEach(([col, def]) => {
  try { db.prepare(`ALTER TABLE referees ADD COLUMN ${col} ${def}`).run() } catch (e) { /* 列已存在 */ }
})
// 回填历史已完赛场次的胜方；小组/循环平局 winner 保持 NULL
db.prepare(`UPDATE matches SET winner = CASE WHEN score_a > score_b THEN team_a WHEN score_b > score_a THEN team_b ELSE NULL END WHERE status='finished' AND winner IS NULL`).run()

export function run(sql, ...p) { return db.prepare(sql).run(...p) }
export function all(sql, ...p) { return db.prepare(sql).all(...p) }
export function get(sql, ...p) { return db.prepare(sql).get(...p) }

// 事务助手：BEGIN IMMEDIATE 在事务开启时即取写锁，把"名额检查 → 占位 → 级联写入"
// 这类读-改-写序列在并发下串行化，杜绝两个审核请求同时通过名额检查。
// 支持嵌套调用：内层直接并入外层事务，由最外层统一提交；任一环节抛错整体回滚。
let txDepth = 0
export function withTransaction(fn) {
  if (txDepth > 0) return fn()
  db.exec('BEGIN IMMEDIATE')
  txDepth++
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 连接已回滚 */ }
    throw e
  } finally {
    txDepth--
  }
}
