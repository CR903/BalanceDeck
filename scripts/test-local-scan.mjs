// 本机用量扫描（src/main/adapters/opencode-local.ts）—— SQL 投影 + 增量 + 变更探测
// 用法：node scripts/test-local-scan.mjs
//
// 为什么单独成一套：这是**唯一**能用真 sqlite 验证的适配器部件（临时库夹具）。
// 本套件的总闸门是**口径不许漂**：新实现（SQL 投影 + 增量累积）的结果必须与旧实现
// （整条 `data` 取回 + JSON.parse + parsePoint）**逐点相等**。
//
// 三条纪律（见 quality-guidelines.md）：
//   · 被测实现用 `loadTs` 加载**真源码**；
//   · 旧口径基准是**冻结副本**（本任务要把它从 src 里删掉，没有可加载的真源码了）——
//     它是参照物，不是被测对象（ADR-0003「黄金样本」的做法：先冻住旧行为再机械比对）；
//   · 每条护栏都先弄坏一次确认变红（红集记在 docs/daily/2026-10-18_local-db-off-mainthread.md）。
//
// 覆盖：AC1（三模式与变更探测）/ AC2（增量 ≡ 全量）/ AC3（水位：改值只出现一次、删行消失）
//      / AC5 的 claude-codex 部分（目录 mtime 短路：目录未变时 readdir 不被调用）

import { loadTs } from './lib/load-ts.mjs'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const FS_PROBE = joinPath(ROOT, 'scripts/lib/fs-probe.mjs')

let pass = 0
let fail = 0

function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}\n      实际: ${a}\n      期望: ${e}`)
  }
}

function ok(cond, label) {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}`)
  }
}

// ─── 被测实现（真源码）───────────────────────────────────────────────────────
const {
  createLocalScanner,
  pointFromProjection,
  dbStamp,
  DELTA_LOOKBACK_ROWS,
  FULL_RESCAN_MAX_AGE_MS,
  LOCAL_WINDOW_MS
} = await loadTs('src/main/adapters/opencode-local.ts')

// ─── 时间基准 ────────────────────────────────────────────────────────────────
const NOW = Date.parse('2026-10-18T12:00:00.000Z')
const H = 3600_000
const D = 86400_000
const at = (ms) => NOW + ms

// ═══════════════════════════════════════════════════════════════════════════════
// L0. 夹具：真 DDL（照抄真库 sqlite_master）+ 覆盖性数据
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nL0. 夹具与旧口径基准')

/**
 * 夹具建库。DDL 照抄 2026-10-18 真库的 `sqlite_master`（含 time_created 索引：
 * 全量查询靠它做 31 天范围扫描，没有它"全量"会退化成整表扫）。
 */
function makeDb(dirName) {
  const dir = mkdtempSync(joinPath(tmpdir(), `bd-${dirName}-`))
  const dbPath = joinPath(dir, 'opencode.db')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`CREATE TABLE session_message (
    id text PRIMARY KEY,
    session_id text NOT NULL,
    type text NOT NULL,
    seq integer NOT NULL,
    time_created integer NOT NULL,
    time_updated integer NOT NULL,
    data text NOT NULL
  )`)
  db.exec(`CREATE INDEX session_message_time_created_idx ON session_message (time_created)`)
  db.exec(`CREATE TABLE message (
    id text PRIMARY KEY,
    session_id text NOT NULL,
    time_created integer NOT NULL,
    time_updated integer NOT NULL,
    data text NOT NULL
  )`)
  return { dir, dbPath, db }
}

/** 一条 assistant 消息的 data（新 schema：model.providerID） */
function dataNew(over = {}) {
  return JSON.stringify({
    time: { created: NOW - H },
    model: { id: 'deepseek-v4.1', providerID: 'opencode-go' },
    cost: 1,
    tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 100, write: 2 } },
    ...over
  })
}

/** 一条旧 schema 消息的 data（顶层 providerID/modelID） */
function dataOld(over = {}) {
  return JSON.stringify({
    role: 'assistant',
    providerID: 'opencode-go',
    modelID: 'legacy-old-schema',
    cost: 1,
    time: { created: NOW - H },
    tokens: { input: 1, output: 1 },
    ...over
  })
}

/**
 * 覆盖性行集。每行都写明"算不算"以及为什么 —— 这些正是口径的边界：
 *   r1  正常新 schema                          → 算
 *   r2  cost 0                                 → 不算（cost<=0）
 *   r3  没有 cost 字段                          → 不算
 *   r4  provider 不是 opencode-go               → 不算
 *   r5  顶层 providerID + 顶层 modelID（老形状） → 算（model 取 modelID）
 *   r6  time.created = 0                        → 不算
 *   r7  只有 model.id                           → 算
 *   r8  与 r9 同 (t, cost)（跨表重复）            → 算，r9 被去重（表顺序：先 session_message）
 *   r9  message 表里同 (t, cost) 的另一条         → 不算（去重保留先遇到的那条 = r8）
 *   r10 坏 JSON                                 → 不算（json_valid 必须挡住它的抛错）
 *   r11 time_created 早于 31 天窗口               → 不算（窗口裁剪）
 *   r12 time_created 刚进窗口（边界内）            → 算
 *   r13 type='user'（不是 assistant）             → 不算（表类型过滤）
 *   r14 没有 tokens 字段                          → 算，tokens=0
 *   r15 只在 message 表里的旧记录                  → 算（两表取并集）
 *   r16 cost 是 JSON null                        → 不算
 *   r17 cost 是负数                              → 不算
 *   r18 cost 是**字符串** '0.5'                   → 算（SQL 预过滤是"安全超集"，JS 仍是权威）
 *   r19 顶层 providerID 是别的值、model.providerID 才是 opencode-go
 *                                                 → **不算**（旧口径 `pid ?? mpid` 取 pid）
 */
const ROWS = [
  ['r1', 'session_message', 'assistant', NOW - 1 * H, dataNew()],
  ['r2', 'session_message', 'assistant', NOW - 2 * H, dataNew({ cost: 0 })],
  ['r3', 'session_message', 'assistant', NOW - 2 * H, `{"time":{"created":${NOW - 2 * H}},"model":{"id":"no-cost","providerID":"opencode-go"}}`],
  ['r4', 'session_message', 'assistant', NOW - 3 * H, dataNew({ model: { id: 'x', providerID: 'anthropic' } })],
  ['r5', 'session_message', 'assistant', NOW - 4 * H, dataOld({ cost: 1.25, time: { created: NOW - 4 * H } })],
  ['r6', 'session_message', 'assistant', NOW - 5 * H, dataNew({ cost: 2.5, time: { created: 0 } })],
  ['r7', 'session_message', 'assistant', NOW - 6 * H, dataNew({ model: { id: 'only-model-id', providerID: 'opencode-go' }, time: { created: NOW - 6 * H } })],
  ['r8', 'session_message', 'assistant', NOW - 7 * H, dataNew({ cost: 5, model: { id: 'dup-a', providerID: 'opencode-go' }, time: { created: NOW - 7 * H } })],
  ['r9', 'message', null, NOW - 7 * H, dataOld({ cost: 5, modelID: 'dup-b', time: { created: NOW - 7 * H } })],
  ['r10', 'session_message', 'assistant', NOW - 8 * H, '{坏 JSON'],
  ['r11', 'session_message', 'assistant', NOW - 31 * D - 1000, dataNew({ cost: 6, time: { created: NOW - 31 * D - 1000 } })],
  ['r12', 'session_message', 'assistant', NOW - 30 * D, dataNew({ cost: 7, model: { id: 'edge-window', providerID: 'opencode-go' }, time: { created: NOW - 30 * D } })],
  ['r13', 'session_message', 'user', NOW - 1 * H, dataNew({ cost: 8, model: { id: 'user-row', providerID: 'opencode-go' } })],
  ['r14', 'session_message', 'assistant', NOW - 9 * H, `{"time":{"created":${NOW - 9 * H}},"model":{"id":"no-tokens","providerID":"opencode-go"},"cost":0.25}`],
  ['r15', 'message', null, NOW - 20 * D, dataOld({ cost: 0.75, modelID: 'old-only', time: { created: NOW - 20 * D } })],
  ['r16', 'session_message', 'assistant', NOW - 10 * H, dataNew({ cost: null })],
  ['r17', 'session_message', 'assistant', NOW - 10 * H, dataNew({ cost: -1 })],
  ['r18', 'session_message', 'assistant', NOW - 11 * H, dataNew({ cost: '0.5', model: { id: 'string-cost', providerID: 'opencode-go' }, time: { created: NOW - 11 * H } })],
  // r20：`time_created` 刚好在窗口内 **1 分钟** —— 用来测"cache 轮里窗口前移导致行掉出"
  ['r-edge', 'session_message', 'assistant', NOW - 31 * D + 60_000, dataNew({ cost: 0.3, model: { id: 'edge-tight', providerID: 'opencode-go' }, time: { created: NOW - 31 * D + 60_000 } })],
  [
    'r19',
    'session_message',
    'assistant',
    NOW - 12 * H,
    dataNew({ providerID: 'opencode', cost: 9, model: { id: 'pid-wins', providerID: 'opencode-go' }, time: { created: NOW - 12 * H } })
  ]
]

let seqNo = 0
function insertRows(db, rows) {
  for (const [id, table, type, tc, data] of rows) {
    if (table === 'session_message') {
      db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)').run(id, 's1', type, ++seqNo, tc, tc, data)
    } else {
      db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(id, 's1', tc, tc, data)
    }
  }
}

const fx = makeDb('local-scan')
insertRows(fx.db, ROWS)

// ─── 旧口径基准（**冻结副本**）───────────────────────────────────────────────
// 逐字来自 src/main/adapters/opencode.ts 的 parsePoint + ingest（本任务把它删掉了）。
// 它不测新实现，只回答"旧实现会算出什么"。⚠ 不要"顺手同步"它 —— 它的价值就在于冻住。
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

function baselineScan(dbPath, nowMs) {
  const sinceMs = nowMs - 31 * D
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const seen = new Set()
  const pts = []
  const byModel = new Map()
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
      if (p.model) {
        const cur = byModel.get(p.model) ?? { cost: 0, tokens: 0 }
        cur.cost += p.cost
        cur.tokens += p.tokens
        byModel.set(p.model, cur)
      }
    }
  }
  const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name))
  if (tables.has('session_message')) {
    ingest(db.prepare(`SELECT data FROM session_message WHERE type = 'assistant' AND time_created > ?`).all(sinceMs))
  }
  if (tables.has('message')) ingest(db.prepare(`SELECT data FROM message WHERE time_created > ?`).all(sinceMs))
  pts.sort((a, b) => a.t - b.t)
  db.close()
  return { pts, byModel }
}

/** 只投影消费形状：pts 逐点 + byModel 逐键（Map 不能直接比） */
function shape(stats) {
  return {
    pts: stats.pts.map((p) => ({ t: p.t, cost: p.cost, tokens: p.tokens, model: p.model })),
    byModel: [...stats.byModel.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([m, v]) => [m, { cost: v.cost, tokens: v.tokens }])
  }
}

const scannerOf = (dbPath) => createLocalScanner({ detectDbPath: () => dbPath })

// ─── L0 前置：基准自身自洽（否则下面的比对没有参照物）────────────────────────
{
  const base = baselineScan(fx.dbPath, NOW)
  ok(base.pts.length > 0, 'L0a 前置：旧口径基准在夹具上产出非空点集')
  eq(base.pts.length, new Set(base.pts.map((p) => `${p.t}|${p.cost}`)).size, 'L0b 基准自己去重后无重复 (t,cost)')
  const models = [...base.byModel.keys()].sort()
  ok(models.includes('dup-a') && !models.includes('dup-b'), 'L0c 跨表重复按"先 session_message"保留（dup-a 在，dup-b 不在）')
  ok(!models.includes('pid-wins'), 'L0d 顶层 providerID 非 opencode-go 时整行不算（`pid ?? mpid` 取 pid）')
  ok(!models.includes('user-row'), "L0e type='user' 的行不算")
  ok(models.includes('edge-window'), 'L0f 30 天前（窗口内）的行算（窗口边界在 31 天）')
}

// ═══════════════════════════════════════════════════════════════════════════════
// L1. 投影口径（AC2 上半）：full 结果与旧口径逐点相等
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nL1. 投影口径 == 旧口径（逐点）')

const sc = scannerOf(fx.dbPath)
{
  const first = await sc.scan(NOW)
  ok(first !== null, 'L1a db 存在 ⇒ 返回非 null')
  eq(shape(first), shape(baselineScan(fx.dbPath, NOW)), 'L1b 冷启动全量结果与旧口径基准**逐点相等**（pts + byModel）')
  eq(sc.lastRun().mode, 'full', 'L1c 冷启动走 full（无快照）')
  ok(sc.lastRun().rows > 0, 'L1d lastRun 记下了本次读到的原始行数（R4 可观测）')
  ok(first.pts.every((p, i, a) => i === 0 || a[i - 1].t <= p.t), 'L1e pts 按 t 升序（消费方依赖）')
}

// 单行投影的边界（纯函数，逐条钉住）
{
  const R = (over) => ({ rowid: 1, id: 'a', tc: 0, ...over })
  eq(pointFromProjection(R({ cost: 1, t: 2, mpid: 'opencode-go', mid: 'm' })), { t: 2, cost: 1, tokens: 0, model: 'm' }, 'L1f 缺 tokens ⇒ tokens=0（不补假值）')
  eq(
    pointFromProjection(R({ cost: 1, t: 2, mpid: 'opencode-go', mid: 'top-level-wins', modelid: 'inner-loses' })),
    { t: 2, cost: 1, tokens: 0, model: 'top-level-wins' },
    'L1f2 model 取 `mid ?? modelid`（顶层 modelID 优先，与旧实现同）'
  )
  eq(pointFromProjection(R({ cost: 1, t: 2, mpid: 'opencode-go', modelid: 'm2' })), { t: 2, cost: 1, tokens: 0, model: 'm2' }, 'L1g mpid 形式可用，model 回落 modelid')
  eq(pointFromProjection(R({ cost: 1, t: 2, pid: 'opencode', mpid: 'opencode-go' })), null, 'L1h pid 存在但不是 opencode-go ⇒ 拒（`??` 语义，不是 OR）')
  eq(pointFromProjection(R({ cost: 0, t: 2, pid: 'opencode-go' })), null, 'L1i cost=0 ⇒ 拒')
  eq(pointFromProjection(R({ cost: 1, t: 0, pid: 'opencode-go' })), null, 'L1j t=0 ⇒ 拒')
  eq(pointFromProjection(R({ pid: 'opencode-go' })), null, 'L1k 缺 cost 与 t（JSON null → SQL NULL）⇒ 拒')
}

// ═══════════════════════════════════════════════════════════════════════════════
// L2. 变更探测与三模式（AC1）
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nL2. 三模式：cache / delta / full（AC1）')

const firstObj = await sc.scan(NOW + 1000)
const baselineNow = shape(firstObj)
{
  eq(sc.lastRun().mode, 'cache', 'L2a 什么都不动 ⇒ cache（0 次查询）')
  const secondObj = await sc.scan(NOW + 2000)
  eq(shape(secondObj), baselineNow, 'L2b cache 命中的结果与上次逐字相同')
  ok(secondObj === firstObj, 'L2b2 cache 轮复用同一份派生结果（不重排序 4 千个点）—— 窗口内没有行会掉出时才可复用')
}

// E9 的原始场景：opencode 活跃写入让 -wal 5 秒就变，主库不动
{
  const mainBefore = dbStamp(fx.dbPath)
  // 把 -wal 的 mtime 拨到 1 分钟前（模拟"活跃写入区被动过"）
  utimesSync(`${fx.dbPath}-wal`, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  const walBefore = dbStamp(`${fx.dbPath}-wal`)
  ok(walBefore !== '-', 'L2c 前置：读得到 -wal 的 stamp')
  eq(dbStamp(fx.dbPath), mainBefore, 'L2d 前置：主库 stamp 没变（WAL 写入不落主库）')
  await sc.scan(NOW + 3000)
  eq(sc.lastRun().mode, 'cache', 'L2e 只动 -wal ⇒ 仍命中 cache、**未重扫**（E9/R1 的核心）')
}

// 真提交（另一个连接）：wal 变、主库不变 —— 必须是增量，不能是重扫
{
  const mainBefore = dbStamp(fx.dbPath)
  const walBefore = dbStamp(`${fx.dbPath}-wal`)
  // 插一条 user 行：提交了，但没有任何 assistant 数据变化
  insertRows(fx.db, [['r-noop', 'session_message', 'user', NOW, dataNew({ cost: 999, model: { id: 'noop' } })]])
  ok(dbStamp(`${fx.dbPath}-wal`) !== walBefore, 'L2f 前置：真提交让 -wal stamp 变')
  eq(dbStamp(fx.dbPath), mainBefore, 'L2g 前置：主库 stamp 仍没变（WAL 模式）')
  const r = await sc.scan(NOW + 4000)
  eq(sc.lastRun().mode, 'delta', 'L2h 有提交 ⇒ 走 **增量**（wal 活跃不再等于整轮重扫）')
  ok(sc.lastRun().mode !== 'full', 'L2i 明确断言"不是重扫"（E9/R1 的核心）')
  eq(shape(r), baselineNow, 'L2j 增量后结果不变（那条 user 行不算数）')
}

// cache 轮里窗口前移：没有任何 db 变更，但 2 分钟后那条"刚好在窗口内"的行必须掉出去
// （这条专门钉住"cache 轮不能无条件复用上次派生结果"——去掉判据即红）
{
  const s2 = scannerOf(fx.dbPath)
  const cold = await s2.scan(NOW)
  ok(cold.byModel.has('edge-tight'), 'L2r 前置：窗口边界内 1 分钟的那行在冷启动结果里')
  const later = await s2.scan(NOW + 120_000)
  eq(s2.lastRun().mode, 'cache', 'L2r2 无 db 变更 ⇒ 仍走 cache（不是重扫）')
  ok(!later.byModel.has('edge-tight'), 'L2r3 cache 轮里窗口前移 ⇒ 掉出窗口的行必须消失（不能复用旧派生结果）')
  eq(shape(later), shape(baselineScan(fx.dbPath, NOW + 120_000)), 'L2r4 该轮结果仍与旧口径相等')
}

// checkpoint：主库文件真的变了
{
  const mainBefore = dbStamp(fx.dbPath)
  fx.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  ok(dbStamp(fx.dbPath) !== mainBefore, 'L2k 前置：checkpoint 改了主库 stamp')
  await sc.scan(NOW + 5000)
  ok(
    sc.lastRun().mode !== 'full',
    'L2l 主库 stamp 变（checkpoint）⇒ **不重扫**：设计稿的"stamp 变即全量"在 WAL 下等于每次 checkpoint 卡 1.4s（实测）'
  )
}

// TTL：全量核对（设计稿的 TTL 语义保留，间隔见 opencode-local.ts 文件头"诚实边界"）
{
  await sc.scan(at(FULL_RESCAN_MAX_AGE_MS + 6000))
  eq(sc.lastRun().mode, 'full', 'L2m 距上次全量超过 FULL_RESCAN_MAX_AGE_MS ⇒ 全量核对（AC1 的 TTL 到期 → 重扫）')
}
{
  const r = await sc.scan(at(FULL_RESCAN_MAX_AGE_MS + 7000))
  eq(sc.lastRun().mode, 'cache', 'L2n 全量核对之后立刻又是 cache（TTL 计时重置）')
  eq(
    shape(r),
    shape(baselineScan(fx.dbPath, NOW + FULL_RESCAN_MAX_AGE_MS + 7000)),
    'L2o 全量核对的结果同样等于旧口径（含 r-noop 插入后；比对用这一轮真正的 now）'
  )
}

// 表尾行被删 ⇒ MAX(rowid) 回退。游标可能指向错行（VACUUM 重排与删表尾在这里不可区分），
// 所以宁可多扫一次全量 —— 单次 1.4s 换"数字不会错位"，且删表尾在真库上 16 次/整库生命期。
{
  const lastId = fx.db.prepare('SELECT id FROM session_message ORDER BY rowid DESC LIMIT 1').get().id
  fx.db.prepare('DELETE FROM session_message WHERE id = ?').run(lastId)
  await sc.scan(at(FULL_RESCAN_MAX_AGE_MS + 8000))
  eq(sc.lastRun().mode, 'full', 'L2p rowid 回退（表尾被删 / VACUUM 重排不可区分）⇒ 全量重扫，不让游标指向错行')
  eq(
    shape(await sc.scan(at(FULL_RESCAN_MAX_AGE_MS + 9000))),
    shape(baselineScan(fx.dbPath, NOW + FULL_RESCAN_MAX_AGE_MS + 9000)),
    'L2q 重扫后仍与旧口径相等'
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// L3. 增量等价与水位（AC2 下半 / AC3）
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nL3. 增量累积 == 一次性全量（AC2）+ 水位（AC3）')

const inc = scannerOf(fx.dbPath)
{
  const first = await inc.scan(NOW)
  eq(inc.lastRun().mode, 'full', 'L3a 增量组：先冷启动一次全量')
  const fullRows = inc.lastRun().rows

  // ① 改大某行的 cost（并推进 time_updated）② 插一条新行 ③ 删一行 ④ 插一条无效行
  fx.db
    .prepare('UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?')
    .run(dataNew({ cost: 9.5, time: { created: NOW - 1 * H } }), at(60_000), 'r1')
  fx.db.prepare('DELETE FROM session_message WHERE id = ?').run('r5')
  insertRows(fx.db, [
    ['r20', 'session_message', 'assistant', NOW - 1800_000, dataNew({ cost: 4.25, model: { id: 'new-model', providerID: 'opencode-go' }, time: { created: NOW - 1800_000 } })],
    ['r21', 'session_message', 'assistant', NOW - 1800_000, dataNew({ cost: 0, model: { id: 'zero-cost', providerID: 'opencode-go' } })]
  ])

  const after = await inc.scan(NOW + 60_000)
  eq(inc.lastRun().mode, 'delta', 'L3b 有变更 ⇒ 走增量（不是全量）')
  // 夹具行数 < 回看窗口 ⇒ 增量读的就是"窗口内的行"（≈ 全量）。精确计数会随窗口前移变
  // （r-edge 这类贴着 31 天边界的行会掉出去），所以这里只断言量级；上界由 L3x 证明。
  ok(inc.lastRun().rows > 0 && inc.lastRun().rows <= fullRows + 5, `L3c 增量读的是窗口内的行（增量 ${inc.lastRun().rows} / 全量 ${fullRows}）；大表上界见 L3x`)
  ok(inc.lastRun().rows <= DELTA_LOOKBACK_ROWS, `L3d 增量读到的行数不超过回看窗口（${DELTA_LOOKBACK_ROWS} 行）`)
  eq(shape(after), shape(baselineScan(fx.dbPath, NOW + 60_000)), 'L3e 增量累积结果 == 旧口径一次性全量（逐点）')

  const fresh = await scannerOf(fx.dbPath).scan(NOW + 60_000)
  eq(shape(after), shape(fresh), 'L3f 增量累积结果 == 全新扫描器的冷启动全量（新实现内部也自洽）')

  // AC3：改值的那行只出现一次，且是新值
  const r1Hits = after.pts.filter((p) => p.t === NOW - 1 * H)
  eq(r1Hits.length, 1, 'L3g 被改写的行**只出现一次**（不双计）')
  eq(r1Hits[0].cost, 9.5, 'L3h 取的是改写后的新值')
  ok(!after.pts.some((p) => p.t === NOW - 4 * H), 'L3i 被删掉的行（r5）从结果里消失')
  ok(after.byModel.has('new-model'), 'L3j 新增的有效行进来了')
  ok(!after.byModel.has('zero-cost'), 'L3k 新增的 cost<=0 行没进来')
  ok(after.byModel.get('deepseek-v4.1').cost >= 9.5, 'L3l byModel 汇总跟着更新')
  ok(first.pts.find((p) => p.t === NOW - 1 * H).cost === 1, 'L3m 前置：改写前 r1 的 cost 是 1（改写断言有意义）')

  const third = await inc.scan(NOW + 120_000)
  eq(inc.lastRun().mode, 'cache', 'L3n 无新变更 ⇒ cache')
  eq(shape(third), shape(after), 'L3o cache 轮结果不变')
  ok(after !== first, 'L3o2 快照变了（增量）⇒ **重新派生**，绝不复用变更前的对象')
}

// ═══════════════════════════════════════════════════════════════════════════════
// L3x. 窗口化增量：表行数 > 回看窗口时，"窗口外靠快照、窗口内靠重读"
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nL3x. 窗口化增量（表行数 > 回看窗口）')

const big = makeDb('local-scan-big')
{
  const N = DELTA_LOOKBACK_ROWS + 300
  big.db.exec('BEGIN')
  for (let i = 0; i < N; i++) {
    const t = NOW - 20 * D + i * 60_000
    insertRows(big.db, [
      [`b${i}`, 'session_message', 'assistant', t, dataNew({ cost: 0.01, model: { id: 'bulk', providerID: 'opencode-go' }, time: { created: t } })]
    ])
  }
  big.db.exec('COMMIT')

  const s = scannerOf(big.dbPath)
  const cold = await s.scan(NOW)
  eq(s.lastRun().mode, 'full', 'L3x-a 冷启动全量')
  eq(s.lastRun().rows, N, `L3x-b 全量读到全部 ${N} 行`)
  eq(shape(cold), shape(baselineScan(big.dbPath, NOW)), 'L3x-c 大表全量 == 旧口径（逐点）')

  // 表尾那行改写 + 插一行新的：增量窗口应只覆盖最近 1000 行
  const tailT = NOW - 20 * D + (N - 1) * 60_000
  big.db
    .prepare('UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?')
    .run(dataNew({ cost: 5, model: { id: 'tail-changed', providerID: 'opencode-go' }, time: { created: tailT } }), NOW, `b${N - 1}`)
  insertRows(big.db, [
    ['b-new', 'session_message', 'assistant', NOW - 60_000, dataNew({ cost: 0.5, model: { id: 'newcomer', providerID: 'opencode-go' }, time: { created: NOW - 60_000 } })]
  ])

  const after = await s.scan(NOW + 1000)
  eq(s.lastRun().mode, 'delta', 'L3x-d 有变更 ⇒ 走增量')
  ok(s.lastRun().rows <= DELTA_LOOKBACK_ROWS + 5, `L3x-e 增量只读回看窗口内的行（${s.lastRun().rows} ≤ ${DELTA_LOOKBACK_ROWS} + 5）`)
  ok(s.lastRun().rows < N, `L3x-f 明显少于全量行数（${s.lastRun().rows} < ${N}）`)
  eq(shape(after), shape(baselineScan(big.dbPath, NOW + 1000)), 'L3x-g 窗口化增量累积 == 旧口径一次性全量（窗口外的行靠快照保留）')
  ok(after.byModel.has('tail-changed'), 'L3x-h 表尾被改写的行取到了新值')
  ok(after.byModel.has('newcomer'), 'L3x-i 新插入的行进来了')

  // 已知盲区（**诚实断言**）：离表尾超过回看窗口的回写，本轮看不见 —— 由全量核对收口。
  // 实测依据：真库上 lag ≥ 1h 的回写只有 30 行，且离表尾最远 811 行（< 1000 的回看窗口）。
  big.db
    .prepare('UPDATE session_message SET data = ? WHERE id = ?')
    .run(dataNew({ cost: 42, model: { id: 'far-away', providerID: 'opencode-go' }, time: { created: NOW - 20 * D } }), 'b0')
  const blind = await s.scan(NOW + 2000)
  ok(!blind.byModel.has('far-away'), 'L3x-j 已知盲区：远离表尾的回写本轮看不见（增量只重读窗口内）')

  const reconciled = await s.scan(at(FULL_RESCAN_MAX_AGE_MS + 3000))
  eq(s.lastRun().mode, 'full', 'L3x-k 盲区由全量核对收口（间隔 = FULL_RESCAN_MAX_AGE_MS）')
  ok(reconciled.byModel.has('far-away'), 'L3x-l 全量核对后那条回写出现了（盲区有界，不是永久丢失）')

  big.db.close()
  rmSync(big.dir, { recursive: true, force: true })
}

// ═══════════════════════════════════════════════════════════════════════════════
// L4. 边界与异常
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nL4. 边界与异常')

{
  const none = createLocalScanner({ detectDbPath: () => null })
  eq(await none.scan(NOW), null, 'L4a 没有 db 路径 ⇒ null（旧实现同款）')
  eq(none.lastRun(), null, 'L4b 没扫过 ⇒ lastRun 为 null')
}

{
  const { dir, dbPath, db } = makeDb('no-tables')
  db.close()
  const s = scannerOf(dbPath)
  eq(
    shape(await s.scan(NOW)),
    { pts: [], byModel: [] },
    'L4c 库在但既无 session_message 也无 message ⇒ 空结果（**不是 null**，旧实现同款）'
  )
  rmSync(dir, { recursive: true, force: true })
}

{
  const { dir, dbPath, db } = makeDb('old-only')
  db.exec('DROP TABLE session_message')
  insertRows(db, [['m1', 'message', null, NOW - H, dataOld({ cost: 3 })]])
  const s = scannerOf(dbPath)
  eq(shape(await s.scan(NOW)), shape(baselineScan(dbPath, NOW)), 'L4d 只有旧 message 表 ⇒ 仍与旧口径相等（老版本 opencode 兼容）')
  db.close()
  rmSync(dir, { recursive: true, force: true })
}

{
  const dir = mkdtempSync(joinPath(tmpdir(), 'bd-junk-'))
  const dbPath = joinPath(dir, 'opencode.db')
  writeFileSync(dbPath, '这不是 sqlite 文件')
  const s = scannerOf(dbPath)
  // 旧实现也是这个行为：表探测的 prepare 抛错被吞掉 ⇒ 两张表都当成不存在 ⇒ 空结果。
  // 这里断言的是**等价**（不抛异常、也不冒充有数据），不是"应该 null"。
  eq(shape(await s.scan(NOW)), { pts: [], byModel: [] }, 'L4e 文件不是合法 sqlite ⇒ 空结果（与旧实现同款：不抛、不冒充有数据）')
  rmSync(dir, { recursive: true, force: true })
}

{
  // 窗口随 now 前移：把 now 推到让 30 天前的行也出窗
  const s = scannerOf(fx.dbPath)
  const later = NOW + 3 * D
  eq(shape(await s.scan(later)), shape(baselineScan(fx.dbPath, later)), 'L4f now 前移导致旧行掉出 31 天窗口 ⇒ 仍与旧口径相等')
}

{
  const s = scannerOf(fx.dbPath)
  const [a, b] = await Promise.all([s.scan(NOW + 10 * D), s.scan(NOW + 10 * D)])
  eq(shape(a), shape(b), 'L4g 并发调用返回同一次扫描（游标/快照不交错）')
}

// ═══════════════════════════════════════════════════════════════════════════════
// L5. 静态守卫
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nL5. 静态守卫（先决条件 + 负向断言）')

/** 去注释：负向断言必须看**代码**，不能命中注释里提到的 `-wal` */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

{
  const local = stripComments(readFileSync(joinPath(ROOT, 'src/main/adapters/opencode-local.ts'), 'utf8'))
  const adapter = stripComments(readFileSync(joinPath(ROOT, 'src/main/adapters/opencode.ts'), 'utf8'))
  ok(local.includes('json_extract') && local.includes('dbStamp'), 'L5a 前置：去注释源码里读得到投影与 stamp（下面的守卫不空洞）')
  ok(!local.includes('-wal') && !local.includes('-shm'), 'L5b opencode-local.ts 代码里零 `-wal`/`-shm`（活跃写入区不得进缓存键 —— 加回去即红）')
  ok(!local.includes('JSON.parse'), 'L5c opencode-local.ts 代码里零 JSON.parse（投影的意义就在于不再解析整条 data）')
  ok(!adapter.includes('localDbStamp'), 'L5d 旧实现（localDbStamp）没有并行留在 opencode.ts')
  ok(adapter.includes('createLocalScanner'), 'L5e opencode.ts 是**装配**（调用新模块），不是又抄一份实现')
  ok(!/SELECT\s+data/i.test(local) && !/SELECT\s+data/i.test(adapter), 'L5f 产品路径里没有 `SELECT data`（整列搬运是被替换掉的那条路）')
  const st = statSync(fx.dbPath)
  eq(dbStamp(fx.dbPath), `${st.size}:${Math.round(st.mtimeMs)}`, 'L5g dbStamp = 主库 size:round(mtime)')
  ok(/^-$|^\d+:\d+$/.test(dbStamp(`${fx.dbPath}-wal`)), 'L5h dbStamp 是单值（不是三段拼接 —— 老 localDbStamp 的形状）')
  eq([LOCAL_WINDOW_MS, DELTA_LOOKBACK_ROWS], [31 * D, 600], 'L5i 窗口 31 天 / 回看 600 行（口径常量与实测选定的窗口）')
}

// ═══════════════════════════════════════════════════════════════════════════════
// L6. 目录 mtime 短路（AC5 的 claude/codex 部分）
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nL6. 目录遍历 mtime 短路（AC5）')

const withProbe = { alias: { fs: FS_PROBE } }
const { collectFiles } = await loadTs('src/main/adapters/scan-dir.ts', withProbe)
const { claudeAdapter } = await loadTs('src/main/adapters/claude.ts', withProbe)
const { codexAdapter } = await loadTs('src/main/adapters/codex.ts', withProbe)

const readdirCount = () => globalThis.__bd_readdir_calls ?? 0

/** 造一棵临时目录树；返回根 */
function makeTree(files) {
  const root = mkdtempSync(joinPath(tmpdir(), 'bd-tree-'))
  for (const rel of files) {
    const p = joinPath(root, rel)
    mkdirSync(joinPath(p, '..'), { recursive: true })
    writeFileSync(p, '{}')
  }
  return root
}

{
  const root = makeTree(['a/x.jsonl', 'a/y.txt', 'b/c/z.jsonl', 'b/c/d.json', 'deep/1/2/3/4/5/6/too-deep.jsonl'])
  const opts = { maxDepth: 4, match: (n) => n.endsWith('.jsonl') }
  const rel = (ps) => ps.map((p) => p.slice(root.length + 1)).sort()
  const first = rel(collectFiles(root, opts))
  eq(first, ['a/x.jsonl', 'b/c/z.jsonl'], 'L6a 只收匹配项，且深度上限 4（6 层的那个不收）')

  const before = readdirCount()
  const second = collectFiles(root, opts)
  eq(readdirCount() - before, 0, 'L6b 目录 mtime 未变 ⇒ **一次 readdir 都没调**（AC5 的核心断言）')
  eq(rel(second), first, 'L6c 短路走的是同一份条目列表（结果逐条相同）')

  // 子目录 mtime 变了 ⇒ 必须走进那个子目录（父目录未变也不能漏）
  const cDir = joinPath(root, 'b/c')
  const beforeTouch = readdirCount()
  writeFileSync(joinPath(cDir, 'new.jsonl'), '{}')
  utimesSync(cDir, new Date(), new Date(Date.now() + 10_000))
  const third = collectFiles(root, opts)
  eq(readdirCount() - beforeTouch, 1, 'L6d 只重新 readdir 变了的那个子目录（缓存的是条目，不是最终文件列表）')
  eq(rel(third), ['a/x.jsonl', 'b/c/new.jsonl', 'b/c/z.jsonl'], 'L6e 子目录新增的会话被收到（不因父目录未变而漏）')

  rmSync(root, { recursive: true, force: true })
}

{
  // 符号链接目录：旧实现用 statSync 判定（跟随链接），行为必须保持
  const root = makeTree(['real/x.jsonl'])
  symlinkSync(joinPath(root, 'real'), joinPath(root, 'link'))
  const got = collectFiles(root, { maxDepth: 4, match: (n) => n.endsWith('.jsonl') }).map((p) => p.slice(root.length + 1)).sort()
  eq(got, ['link/x.jsonl', 'real/x.jsonl'], 'L6f 符号链接目录仍被跟随（dirent 判不出链接目录时退回 stat）')
  rmSync(root, { recursive: true, force: true })
}

// ─── L6g：产品路径上的行为证明（claude）──────────────────────────────────────
{
  const cfg = mkdtempSync(joinPath(tmpdir(), 'bd-claude-'))
  const proj = joinPath(cfg, 'projects', 'p1')
  mkdirSync(proj, { recursive: true })
  const line = (model, id) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-10-18T10:00:00.000Z',
      requestId: id,
      message: { id, model, usage: { input_tokens: 100, output_tokens: 50 } }
    }) + '\n'
  writeFileSync(joinPath(proj, 's1.jsonl'), line('claude-sonnet-5', 'm1'))

  const savedHome = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = cfg
  const mkCtx = () => ({
    now: new Date(NOW),
    getKey: async () => null,
    getExtra: async () => null,
    request: async () => ({ status: 200, text: '{}' })
  })
  const modelsOf = (snap) => (snap.models ?? []).map((m) => m.model).sort()

  const first = await claudeAdapter.collect(mkCtx())
  eq(modelsOf(first), ['claude-sonnet-5'], 'L6g 前置：claude 适配器读到了第一个会话文件')

  // 第二遍：文件系统一个字都没动 ⇒ 一次 readdir 都不该发生（条目列表从缓存来）
  const before = readdirCount()
  const second = await claudeAdapter.collect(mkCtx())
  eq(readdirCount() - before, 0, 'L6h 产品路径：目录未变 ⇒ 0 次 readdir（claude 每轮不再递归扫目录）')
  eq(modelsOf(second), ['claude-sonnet-5'], 'L6i 目录未变时复用条目列表（结果不变）')

  // 新增第二个会话文件（目录 mtime 因此变化）⇒ 必须被收到，短路不能漏文件
  writeFileSync(joinPath(proj, 's2.jsonl'), line('claude-opus-5', 'm2'))
  const third = await claudeAdapter.collect(mkCtx())
  eq(modelsOf(third), ['claude-opus-5', 'claude-sonnet-5'], 'L6j 目录变了 ⇒ 新会话立刻进来（短路不会漏文件）')

  if (savedHome === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedHome
  rmSync(cfg, { recursive: true, force: true })
}

// ─── L6k：产品路径上的行为证明（codex）──────────────────────────────────────
{
  const cfg = mkdtempSync(joinPath(tmpdir(), 'bd-codex-'))
  const dayDir = joinPath(cfg, 'sessions', '2026', '10', '18')
  mkdirSync(dayDir, { recursive: true })
  const rollout = (total) =>
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-10-18T10:00:00.000Z',
      payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total } }, rate_limits: null }
    }) + '\n'
  writeFileSync(joinPath(dayDir, 'rollout-a.jsonl'), rollout(1000))

  const savedCodex = process.env.CODEX_HOME
  const savedToken = process.env.CODEX_ACCESS_TOKEN
  process.env.CODEX_HOME = cfg
  delete process.env.CODEX_ACCESS_TOKEN
  const mkCtx = () => ({
    now: new Date(NOW),
    getKey: async () => null,
    getExtra: async () => null,
    request: async () => {
      throw new TypeError('本套件不出网')
    }
  })
  const weekUsed = (snap) => (snap.windows ?? []).find((w) => w.name === '本周（7天）')?.used

  const first = await codexAdapter.collect(mkCtx())
  eq(weekUsed(first), 1000, 'L6k 前置：codex 读到了第一个 rollout 的 token')

  const before = readdirCount()
  const second = await codexAdapter.collect(mkCtx())
  eq(readdirCount() - before, 0, 'L6l 产品路径：目录未变 ⇒ 0 次 readdir（codex 的深层 sessions 目录不再每轮递归）')
  eq(weekUsed(second), 1000, 'L6m 目录未变时复用条目列表（结果不变）')

  writeFileSync(joinPath(dayDir, 'rollout-b.jsonl'), rollout(2000))
  const third = await codexAdapter.collect(mkCtx())
  eq(weekUsed(third), 3000, 'L6n 目录变了 ⇒ 新 rollout 立刻进来')

  if (savedCodex === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = savedCodex
  if (savedToken === undefined) delete process.env.CODEX_ACCESS_TOKEN
  else process.env.CODEX_ACCESS_TOKEN = savedToken
  rmSync(cfg, { recursive: true, force: true })
}

// ─── 收尾 ────────────────────────────────────────────────────────────────────
fx.db.close()
rmSync(fx.dir, { recursive: true, force: true })

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
