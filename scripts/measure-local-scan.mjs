// 真机测量：本机用量扫描的三档成本（旧口径 / 新全量 / 新增量 / 稳态 cache）
// 用法：node scripts/measure-local-scan.mjs [--rounds 5]
//
// 为什么需要单独一个脚本：AC4 的红线是"冷启动全量 < 900ms、稳态每轮 < 50ms"，
// 而**数字必须带测量条件**（quality-guidelines：换台机器/换个负载，同一个数能差一倍）。
// 所以这里把旧口径与新实现在**同一次进程、同一份数据**上背靠背测，并打印 load average。
//
// 只读真库：先把真库 APFS 克隆（`cp -c`，秒级且不占额外空间）到临时目录，所有写入
// （制造增量）都发生在副本上。真库一个字节都不动。
//
// ⚠ 旧口径是本任务**要替换掉**的那条路的冻结副本（整条 `data` 取回 + JSON.parse），
// 它的价值是当"同一条件下的对照组" —— 与 test-local-scan.mjs 里的基准同源同理由。

import { loadTs } from './lib/load-ts.mjs'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'

const rounds = Number(process.argv.includes('--rounds') ? process.argv[process.argv.indexOf('--rounds') + 1] : 5)
const DAY = 86400_000

// ─── 真库路径与产品同源（同一个 detectDbPath，不另写一份候选表）───────────────
// 不传 electron 替身：`opencode.ts` 只在运行时动态 import `../opencode-auth`（要 electron），
// 这里只取 detectDbPath，那条路不会被执行 —— 传替身反而会因为替身缺成员而在打包期报错
const { detectDbPath } = await loadTs('src/main/adapters/opencode.ts')
const realPath = detectDbPath()
if (!realPath) {
  console.error('未找到本机 opencode.db（XDG_DATA_HOME / ~/.local/share/opencode）')
  process.exit(1)
}
const realStat = statSync(realPath)
console.log(`真库：${realPath}`)
console.log(`大小：${(realStat.size / 1024 / 1024).toFixed(0)} MB`)
console.log(`load average：${loadavg().map((x) => x.toFixed(2)).join(' / ')}`)

// ─── 克隆到临时目录（写入只发生在副本上）────────────────────────────────────
const dir = mkdtempSync(joinPath(tmpdir(), 'bd-measure-'))
const dbPath = joinPath(dir, 'opencode.db')
try {
  execFileSync('cp', ['-c', realPath, dbPath]) // APFS clonefile：秒级、不复制数据块
} catch {
  execFileSync('cp', [realPath, dbPath])
}
console.log(`副本：${dbPath}`)
if (existsSync(`${realPath}-wal`)) console.log(`（-wal 不参与克隆：副本是最后一次 checkpoint 的状态，测量口径一致）`)

// ⚠ 预热：APFS 克隆出来的文件在页缓存里是**冷的**。不预热的话，先测到的那条路会
// 替另一条路把 651MB 从磁盘读进来 —— 实测这会让"冷页那次"多花 6–7 秒（不是实现差异，
// 是测量顺序差异）。真机常态是热页（opencode 一直在写这个库）。
{
  const t = performance.now()
  const warm = new DatabaseSync(dbPath, { readOnly: true })
  warm.prepare('SELECT SUM(LENGTH(data)) AS n FROM session_message').get()
  warm.close()
  console.log(`预热（把 data 页读进页缓存）：${(performance.now() - t).toFixed(0)}ms`)
}

// ─── ① 旧口径（冻结副本：整条 data + JSON.parse）──────────────────────────────
function parsePointFrozen(d) {
  const providerID = d.providerID ?? d.model?.providerID
  if (providerID !== 'opencode-go') return null
  const cost = d.cost ?? 0
  if (cost <= 0) return null
  const t = d.time?.created ?? 0
  if (t <= 0) return null
  const tk = d.tokens
  const tokens =
    (tk?.input ?? 0) + (tk?.output ?? 0) + (tk?.reasoning ?? 0) + (tk?.cache?.read ?? 0) + (tk?.cache?.write ?? 0)
  return { t, cost, tokens, model: d.modelID ?? d.model?.id ?? '' }
}

function oldWay(nowMs) {
  const sinceMs = nowMs - 31 * DAY
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const t0 = performance.now()
  const pts = []
  const seen = new Set()
  const ingest = (rows) => {
    for (const row of rows) {
      let d
      try {
        d = JSON.parse(row.data)
      } catch {
        continue
      }
      const p = parsePointFrozen(d)
      if (!p) continue
      const key = `${p.t}|${p.cost}`
      if (seen.has(key)) continue
      seen.add(key)
      pts.push(p)
    }
  }
  const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name))
  if (tables.has('session_message')) {
    ingest(db.prepare(`SELECT data FROM session_message WHERE type = 'assistant' AND time_created > ?`).all(sinceMs))
  }
  if (tables.has('message')) ingest(db.prepare(`SELECT data FROM message WHERE time_created > ?`).all(sinceMs))
  db.close()
  return { ms: performance.now() - t0, pts }
}

// ─── ② 新实现：cold full / delta / cache ─────────────────────────────────────
const { createLocalScanner, DELTA_LOOKBACK_ROWS, FULL_RESCAN_MAX_AGE_MS } = await loadTs('src/main/adapters/opencode-local.ts')
const scanner = createLocalScanner({ detectDbPath: () => dbPath })
const NOW = Date.now()

// 旧/新交替跑两轮：同一次会话、同一份（已预热）数据，避免测量顺序影响结论
const oldRuns = []
const fullRuns = []
for (let i = 0; i < 2; i++) {
  const tOld = performance.now()
  const oldPts = oldWay(NOW).pts
  oldRuns.push({ ms: performance.now() - tOld, pts: oldPts })
  const sc2 = createLocalScanner({ detectDbPath: () => dbPath })
  const tFull = performance.now()
  await sc2.scan(NOW)
  fullRuns.push({ ms: performance.now() - tFull, run: sc2.lastRun() })
}
const coldMs = fullRuns[fullRuns.length - 1].ms
const coldRun = fullRuns[fullRuns.length - 1].run
const cold = await scanner.scan(NOW)

// 稳态：连跑 N 轮（什么都不动 ⇒ cache）
const cacheTimes = []
for (let i = 0; i < rounds; i++) {
  const t = performance.now()
  await scanner.scan(NOW + 1000 * (i + 1))
  cacheTimes.push(performance.now() - t)
}

// 制造一次真实增量：改一行 + 插一行（写在副本上）
const db = new DatabaseSync(dbPath)
const since = NOW - 31 * DAY
const target = db
  .prepare(
    `SELECT id, data FROM session_message WHERE type='assistant' AND time_created > ?
     AND (json_extract(data,'$.providerID')='opencode-go' OR json_extract(data,'$.model.providerID')='opencode-go')
     ORDER BY rowid DESC LIMIT 1`
  )
  .get(since)
if (target) {
  db.prepare('UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?').run(target.data, NOW, target.id)
}
// 真库有外键（session_id → session_v2.id）与 (session_id, seq) 唯一索引：
// 借一条已存在的 session_id，seq 用远离现网值的高位，避免撞约束
const sid = db.prepare('SELECT session_id FROM session_message ORDER BY rowid DESC LIMIT 1').get().session_id
db.exec('BEGIN')
for (let i = 0; i < 3; i++) {
  db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run(
    `measure-${i}`,
    sid,
    'assistant',
    9_000_000 + i,
    NOW,
    NOW,
    JSON.stringify({
      time: { created: NOW },
      model: { id: 'measure', providerID: 'opencode-go' },
      cost: 0.01,
      tokens: { input: 1 }
    })
  )
}
db.exec('COMMIT')
db.close()

const tDelta = performance.now()
await scanner.scan(NOW + 60_000)
const deltaMs = performance.now() - tDelta
const deltaRun = scanner.lastRun()

const old = oldRuns[oldRuns.length - 1]
const oldMs = old.ms

// ─── 输出 ────────────────────────────────────────────────────────────────────
const avg = (xs) => (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2)
const max = (xs) => Math.max(...xs).toFixed(2)
console.log('\n── 同一份数据、同一次会话内的背靠背对比 ────────────────────────────')
console.log(`旧口径（整条 data + JSON.parse）  ${oldMs.toFixed(0)}ms   pts=${old.pts.length}   （两轮：${oldRuns.map((r) => r.ms.toFixed(0)).join('/')}ms）`)
console.log(`新实现 冷启动 full                ${coldMs.toFixed(0)}ms   rows=${coldRun.rows} pts=${cold.pts.length} mode=${coldRun.mode}   （两轮：${fullRuns.map((r) => r.ms.toFixed(0)).join('/')}ms）`)
console.log(`新实现 增量 delta                 ${deltaMs.toFixed(0)}ms   rows=${deltaRun.rows} mode=${deltaRun.mode}`)
console.log(`新实现 稳态 cache ×${rounds}             avg ${avg(cacheTimes)}ms  max ${max(cacheTimes)}ms`)
console.log(`\n回看窗口 DELTA_LOOKBACK_ROWS=${DELTA_LOOKBACK_ROWS}，全量核对间隔=${FULL_RESCAN_MAX_AGE_MS / 3600_000}h`)
console.log(`口径一致性：旧口径 pts=${old.pts.length} / 新实现 pts=${cold.pts.length}（应相等）`)
console.log(`AC4 红线：冷启动 < 900ms ⇒ ${coldMs < 900 ? '通过' : '未达标'}；稳态 < 50ms ⇒ ${Number(avg(cacheTimes)) < 50 ? '通过' : '未达标'}`)

rmSync(dir, { recursive: true, force: true })
process.exit(0)
