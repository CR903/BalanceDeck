// ═══════════════════════════════════════════════════════════════════════════════
// 本机 opencode.db 用量扫描 —— SQL 侧投影 + 增量 + 变更探测
//
// 为什么单独成文件：读本机库这件事要用**真 sqlite** 才能验证（临时库夹具），
// 而出网适配器要用 request 桩 —— 两者混在一个文件里，谁都测不干净。本模块
// 不 import electron、不 import ./types，可以被 scripts/test-local-scan.mjs
// 用 loadTs 直接加载。
//
// 三层结构，每一层都是被实测逼出来的（2026-10-18 真机 678MB 库）：
//
//   ① **SQL 侧 json_extract 投影 + provider 过滤**。要的数字（cost/providerID/model/
//      tokens/时间）只存在于 `data` 这一列 JSON 文本里（E10：session_message 没有独立
//      cost/provider 列）。旧实现把整列搬进 JS 再 `JSON.parse` 2.6 万次（265MB → 实测
//      4.1s/轮）；投影只把用到的 13 个字段取回来，JS 侧一次 `JSON.parse` 都不做。
//      `json_valid(data)` 是**必须的**：sqlite 的 json_extract 遇到坏 JSON 会抛错，
//      一行坏数据就会让整轮扫描失败；旧实现是逐行 try/catch 容忍的，不能退步。
//
//   ② **增量：以 rowid 为游标只重读"最近写过的 N 行"**。为什么不是设计稿初稿写的
//      `time_updated > 水位`：`time_updated` **没有索引**，任何以它为条件的查询都会
//      退化成全表扫描（真机实测 200–350ms/轮），直接违反"稳态每轮 < 50ms"。
//      rowid 是 b-tree 的原生范围键，取最近 N 行是 O(N)。
//      回看窗口 = `DELTA_LOOKBACK_ROWS`（600 行）：真机 651MB 库上实测 1000 行
//      ≈ 50–78ms（已经越过 50ms 红线），600 行 ≈ 29–35ms。600 行 ≈ 峰值写入速率
//      （86 条/10 分钟）下约 70 分钟的量 —— 覆盖"先插行、后回写"的绝大多数时距
//      （实测 94.4% < 1 分钟、99.3% < 10 分钟）。
//      ⚠ 窗口是**范围**不是"最后 N 行"：区间是 `(上次表尾 - 600, 本次表尾]`，所以
//      期间**新插入**的行永远在窗口里（哪怕间隔很久、插了几千行）。窗口只影响
//      "老行的迟到回写"能不能被看见 —— 而那有 6 小时的全量核对兜底。
//      单轮成本有上界：增量的 WHERE 与全量同款、只是 rowid 范围更窄 ⇒ 永远不会比
//      一次全量更贵（长间隔后那一轮最多退化成一次全量，不会更糟）。
//
//   ③ **变更探测 = 主库 stamp + `PRAGMA data_version` + `MAX(rowid)`**。三者全等
//      且已有快照时直接返回上次结果（0 次查询）。**`-wal`/`-shm` 的 size/mtime 不在
//      任何缓存键里** —— 活跃写入区 5 秒内就变（E9），把它当键等于每轮全量重扫，
//      那正是本任务要修的 Bug 3。`data_version` 由"**另一个连接**提交过"驱动：
//      它区分得了"opencode 真的写了"与"文件只是被 touch"，这正是"要不要跑增量"
//      需要的判据，而且是 0 成本（不需要 stat 任何 -wal）。
//
// **诚实边界（不为省事而撒谎）**：增量的盲区有两处，都靠"全量核对"收口 ——
//   ① 某行的 `data` 在**离表尾 > 600 行之后**才被回写（实测 lag ≥ 1h 的只有 30 行，
//      占 0.07%，离表尾最远 811 行 ⇒ 其中一部分落在 600 行窗口外）；
//   ② 远离表尾的行被删除（例如用户删掉一个旧会话）。
// 两者都在下一次全量核对时消失。全量核对的间隔是 `FULL_RESCAN_MAX_AGE_MS`（6 小时）：
// 它是一次 ~0.7s 的同步阻塞（真机实测），**不能**做成 10 分钟一次 —— 那等于把
// "每轮 2 秒沙漏"换成"每 10 分钟卡一次"，症状只是变稀而不是消失。
// 进程每次启动也天然是全量，所以真实会话里核对远比 6 小时频繁。
// ═══════════════════════════════════════════════════════════════════════════════

import { statSync } from 'fs'

export interface LocalPoint {
  t: number
  cost: number
  tokens: number
  model: string
}

export interface LocalStats {
  /** 按 t 升序（与 opencode.ts 既有消费形状一致） */
  pts: LocalPoint[]
  byModel: Map<string, { cost: number; tokens: number }>
}

export type LocalScanMode = 'cache' | 'full' | 'delta'

export interface LocalRun {
  mode: LocalScanMode
  ms: number
  rows: number
}

export interface LocalScanner {
  /** 扫描（自动在 cache / full / delta 之间择一）。db 不存在时返回 null */
  scan(nowMs: number): Promise<LocalStats | null>
  /** 诊断用：上一次实际做了什么（模式 / 耗时 / 读到的原始行数） */
  lastRun(): LocalRun | null
}

// ─── 常量（导出以便测试与诊断引用，不复制第二份）──────────────────────────────

/** 采集窗口：官方最长窗口 30 天，多取 1 天（与旧实现逐字同参） */
export const LOCAL_WINDOW_MS = 31 * 86400_000

/** 增量回看的行数（按 rowid）。见文件头 ② 与"诚实边界"的实测依据 */
export const DELTA_LOOKBACK_ROWS = 600

/** 全量核对的最长间隔。见文件头"诚实边界" */
export const FULL_RESCAN_MAX_AGE_MS = 6 * 3600_000

// ─── node:sqlite 的最小类型（动态 import：本模块在纯 node 里也要能被 loadTs 加载）──

interface SqliteStmt {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}

interface SqliteDb {
  prepare(sql: string): SqliteStmt
  close(): void
}

// ─── SQL ─────────────────────────────────────────────────────────────────────

/**
 * 投影列。**别名即 JS 侧字段名**，改别名等于改契约（测试用真库钉住）。
 * `rowid` 是身份（增量游标 / 行快照的键），`tc` 是 `time_created` 列 ——
 * 窗口裁剪用它（旧实现也是 `WHERE time_created > ?`），不是 JSON 里的 `time.created`。
 */
const PROJECTION = `
    rowid      AS rowid,
    id         AS id,
    time_created AS tc,
    json_extract(data, '$.cost')                  AS cost,
    json_extract(data, '$.providerID')            AS pid,
    json_extract(data, '$.model.providerID')      AS mpid,
    json_extract(data, '$.modelID')               AS mid,
    json_extract(data, '$.model.id')              AS modelid,
    json_extract(data, '$.time.created')          AS t,
    json_extract(data, '$.tokens.input')          AS tkIn,
    json_extract(data, '$.tokens.output')         AS tkOut,
    json_extract(data, '$.tokens.reasoning')      AS tkReason,
    json_extract(data, '$.tokens.cache.read')     AS tkCacheRead,
    json_extract(data, '$.tokens.cache.write')    AS tkCacheWrite`

/**
 * 预过滤（**安全超集**，判据的权威仍在 JS 侧 `pointFromProjection`）。
 *
 * 三条都必须满足"SQL 不会排除掉 JS 会保留的行"，否则口径就漂了：
 *   · `cost > 0`  / `t > 0` —— NULL 与数值 ≤ 0 的必被 JS 拒（`cost ?? 0` → `<= 0`）；
 *     TEXT 值在 sqlite 里恒大于数字，所以"像 '-1' 这种字符串"只会被**多**带进来，
 *     再由 JS 的同一个表达式拒掉 —— 方向是安全的。
 *   · `COALESCE(a, b)` 与旧实现的 `d.providerID ?? d.model?.providerID` 字面同义。
 *     写成 `pid = X OR mpid = X` 也**不会**出错（那是"多带行"，JS 仍会拒掉 pid 为
 *     别的值的那一行 —— 实测过，行为零差异），但让 SQL 与 JS 的判据逐字一致更省心：
 *     免得将来有人觉得"SQL 已经过滤过了"，把 JS 那层权威判据删掉。
 *     `pointFromProjection` 才是权威，`L1h` 直接钉住 `??` 语义。
 */
const PREFILTER = `
    json_valid(data)
    AND json_extract(data, '$.cost') > 0
    AND json_extract(data, '$.time.created') > 0
    AND COALESCE(json_extract(data, '$.providerID'), json_extract(data, '$.model.providerID')) = 'opencode-go'`

interface ProjRow {
  rowid: number
  id: string
  tc: number
  cost?: number | null
  pid?: string | null
  mpid?: string | null
  mid?: string | null
  modelid?: string | null
  t?: number | null
  tkIn?: number | null
  tkOut?: number | null
  tkReason?: number | null
  tkCacheRead?: number | null
  tkCacheWrite?: number | null
}

/**
 * 投影行 → 点。**与旧 `parsePoint` 逐字同义**（本任务的等价性总闸门）：
 * providerID 取 `pid ?? mpid`、cost/t 非正即弃、缺 tokens 各段按 0 计、
 * model 取 `mid ?? modelid ?? ''`。这里**不补 0、不 clamp** —— 缺失值就是缺失值。
 */
export function pointFromProjection(r: ProjRow): LocalPoint | null {
  const providerID = r.pid ?? r.mpid
  if (providerID !== 'opencode-go') return null
  const cost = r.cost ?? 0
  if (cost <= 0) return null
  const t = r.t ?? 0
  if (t <= 0) return null
  const tokens =
    (r.tkIn ?? 0) + (r.tkOut ?? 0) + (r.tkReason ?? 0) + (r.tkCacheRead ?? 0) + (r.tkCacheWrite ?? 0)
  return { t, cost, tokens, model: r.mid ?? r.modelid ?? '' }
}

/**
 * 主库 stamp：**只有主库**的 `size:roundedMtime`。
 * ⚠ 不要把 `-wal` / `-shm` 加回来。它们每 5 秒就变（opencode 活跃写入），
 * 一旦进缓存键，缓存几乎永不命中 ⇒ 每轮全量重扫（就是本任务修的那个 2 秒沙漏）。
 * "数据库被写过了"这件事由 `PRAGMA data_version` 承担，且它只用来触发**增量**。
 */
export function dbStamp(dbPath: string): string {
  try {
    const s = statSync(dbPath)
    return `${s.size}:${Math.round(s.mtimeMs)}`
  } catch {
    return '-'
  }
}

// ─── 单表状态 ────────────────────────────────────────────────────────────────

interface TableState {
  name: string
  /** 表类型过滤（旧 `message` 表没有 type 列） */
  typeWhere: string
  /** rowid → 该行的点。**只放"解析后有效"的行**：无效行由窗口清扫负责移除 */
  rows: Map<number, { tc: number; p: LocalPoint }>
}

interface TableDef {
  name: string
  typeWhere: string
}

/** 两表的探测与判据顺序与旧实现逐字一致（先新表后旧表，各自独立 try/catch） */
const TABLE_DEFS: TableDef[] = [
  { name: 'session_message', typeWhere: `type = 'assistant'` },
  { name: 'message', typeWhere: '1 = 1' }
]

interface Conn {
  path: string
  db: SqliteDb
}

// ─── 实现 ────────────────────────────────────────────────────────────────────

export function createLocalScanner(opts: { detectDbPath: () => string | null }): LocalScanner {
  let conn: Conn | null = null
  let tables: TableState[] = []
  let tableNames = ''
  let lastDv: number | null = null
  let lastStamp: string | null = null
  let lastMax = new Map<string, number>()
  let lastFullAt = 0
  let haveSnapshot = false
  /** 上次派生结果与它里面最小的行 `time_created`（cache 轮复用它，见下） */
  let derived: LocalStats | null = null
  let derivedMinTc = 0
  let run: LocalRun | null = null
  let inFlight: Promise<LocalStats | null> | null = null

  function closeConn(): void {
    try {
      conn?.db.close()
    } catch {
      // 关闭失败无所谓：连接对象就要丢了
    }
    conn = null
    tables = []
    tableNames = ''
    lastDv = null
    lastStamp = null
    lastMax = new Map()
    haveSnapshot = false
    derived = null
    derivedMinTc = 0
  }

  async function openConn(path: string): Promise<Conn> {
    const mod = (await import('node:sqlite')) as {
      DatabaseSync: new (p: string, o?: object) => SqliteDb
    }
    return { path, db: new mod.DatabaseSync(path, { readOnly: true }) }
  }

  function dataVersion(db: SqliteDb): number | null {
    try {
      const r = db.prepare('PRAGMA data_version').get() as { data_version?: number } | undefined
      return typeof r?.data_version === 'number' ? r.data_version : null
    } catch {
      return null
    }
  }

  function maxRowid(db: SqliteDb, table: string): number {
    const r = db.prepare(`SELECT MAX(rowid) AS m FROM ${table}`).get() as { m?: number | null } | undefined
    return typeof r?.m === 'number' ? r.m : 0
  }

  /** 探测存在的表（一次连接只做一次；表结构不符的表整个跳过，与旧实现同款容忍） */
  function buildTables(db: SqliteDb): TableState[] {
    const present = new Set<string>()
    try {
      const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
      for (const r of rows) present.add(r.name)
    } catch {
      // 探测失败则按老表尝试（旧实现同款）
    }
    const out: TableState[] = []
    for (const def of TABLE_DEFS) {
      if (!present.has(def.name)) continue
      out.push({ name: def.name, typeWhere: def.typeWhere, rows: new Map() })
    }
    return out
  }

  /** 全量投影：保留 `time_created > since` 条件 —— 它是**索引范围**（31 天），不是可选优化 */
  function queryFull(db: SqliteDb, t: TableState, sinceMs: number): ProjRow[] {
    try {
      return db
        .prepare(`SELECT ${PROJECTION} FROM ${t.name} WHERE ${t.typeWhere} AND time_created > ? AND ${PREFILTER}`)
        .all(sinceMs) as ProjRow[]
    } catch {
      // 表结构不符（缺列等）则跳过该表：另一张表的结果仍然有效
      return []
    }
  }

  /**
   * 增量投影：`rowid` 范围（b-tree 原生键，O(N)）+ `time_created` 下限。
   *
   * 为什么要带 `time_created > since`：它**不会**把查询计划挤到索引上（实测 EXPLAIN：
   * 仍走 `SEARCH ... USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)`），但能挡掉
   * 那些"落在 rowid 窗口里、却早已出 31 天窗口"的行 —— 真库的旧 `message` 表就是
   * 这种（5663 行全在窗口外，不挡的话每轮白读一整个窗口的行、白解析其中 ~790 行 JSON）。
   */
  function queryDelta(db: SqliteDb, t: TableState, low: number, high: number, sinceMs: number): ProjRow[] {
    try {
      return db
        .prepare(
          `SELECT ${PROJECTION} FROM ${t.name} WHERE ${t.typeWhere} AND time_created > ? AND rowid > ? AND rowid <= ? AND ${PREFILTER}`
        )
        .all(sinceMs, low, high) as ProjRow[]
    } catch {
      return []
    }
  }

  function absorb(t: TableState, rows: ProjRow[]): number {
    let n = 0
    for (const r of rows) {
      n++
      const p = pointFromProjection(r)
      if (p) t.rows.set(r.rowid, { tc: r.tc, p })
    }
    return n
  }

  /**
   * 由行快照派生结果。三条纪律与旧实现逐字对齐（AC2 的等价性全靠它）：
   *   · 表顺序：session_message 在前、message 在后（旧实现的 ingest 顺序）；
   *   · 表内顺序：rowid 升序（旧实现无 ORDER BY，顺序是"未定义"的；这里取确定的那一个）；
   *   · 去重键：`t|cost`（旧实现原样），**不是** rowid —— 两表按它去重取并集。
   *     同一键只保留先遇到的那行（模型归属因此是确定的）。
   *
   * ⚠ **唯一一处已知的"口径不逐点等价"边界**（2026-10-18 核查代理实测，不要再花时间"修"它）：
   * 旧实现的返回顺序**是查询计划的副产品，两张表还不一样** —— 实测
   * `session_message` 走 `SEARCH … USING INDEX session_message_time_created_idx`（**time_created
   * 升序**），而 `message` 走 `SCAN message`（**rowid 升序**）。所以"旧顺序"本身没有单一答案，
   * 对齐其中一张表必然与另一张错开。分歧只在一种输入下可见：**同一张表内两行共享 `(t, cost)`
   * 但 `time_created` 次序与 rowid 次序相反**（此时"先遇到的那行"不同 ⇒ 保留的 `model`/`tokens`
   * 不同）。真库实测 **0 组**这样的重复键（4248 个去重键里重复 0 个），因此当前不可观测；
   * 旧行为本身也不可依赖（换统计信息就可能换成表扫描）。这里取 rowid 升序 = 确定、可复现。
   *
   * 顺带返回**入选行的最小 `time_created`**：窗口随 now 前移，只要这个值还在窗口内，
   * 下一次 cache 轮就没有任何行会掉出去 ⇒ 可以直接复用上次的派生结果（见 scanOnce）。
   */
  function derive(tablesIn: TableState[], sinceMs: number): { stats: LocalStats; minTc: number } {
    const seen = new Set<string>()
    const pts: LocalPoint[] = []
    const byModel = new Map<string, { cost: number; tokens: number }>()
    let minTc = Infinity
    for (const t of tablesIn) {
      const keys = [...t.rows.keys()].sort((a, b) => a - b)
      for (const k of keys) {
        const row = t.rows.get(k)
        if (!row) continue
        // 与旧 `WHERE time_created > since` 同义（严格大于）。窗口随 now 前移，旧行自然掉出
        if (!(row.tc > sinceMs)) continue
        if (row.tc < minTc) minTc = row.tc
        const p = row.p
        const dedupKey = `${p.t}|${p.cost}`
        if (seen.has(dedupKey)) continue
        seen.add(dedupKey)
        pts.push(p)
        if (p.model) {
          const cur = byModel.get(p.model) ?? { cost: 0, tokens: 0 }
          cur.cost += p.cost
          cur.tokens += p.tokens
          byModel.set(p.model, cur)
        }
      }
    }
    pts.sort((a, b) => a.t - b.t)
    return { stats: { pts, byModel }, minTc }
  }

  async function scanOnce(nowMs: number): Promise<LocalStats | null> {
    const dbPath = opts.detectDbPath()
    if (!dbPath) {
      closeConn()
      run = null
      return null
    }
    const sinceMs = nowMs - LOCAL_WINDOW_MS
    const t0 = performance.now()
    try {
      // 路径变了（或首次）⇒ 重开连接并丢弃快照：旧快照属于另一个库
      if (!conn || conn.path !== dbPath) {
        closeConn()
        conn = await openConn(dbPath)
      }
      const db = conn.db
      if (tables.length === 0) tables = buildTables(db)

      const names = tables.map((t) => t.name).join(',')
      const stamp = dbStamp(dbPath)
      const dv = dataVersion(db)
      const maxNow = new Map<string, number>()
      for (const t of tables) maxNow.set(t.name, maxRowid(db, t.name))

      // ── 择一：cache / delta / full ─────────────────────────────────────────
      // rowid 回退 = VACUUM 重排了物理键 ⇒ 快照的键全部失效，只能重扫
      const rewind = [...maxNow].some(([n, m]) => m < (lastMax.get(n) ?? 0))
      const schemaChanged = names !== tableNames
      const changed =
        lastDv === null ||
        dv === null ||
        dv !== lastDv ||
        stamp !== lastStamp ||
        [...maxNow].some(([n, m]) => m !== (lastMax.get(n) ?? 0))
      const stale = haveSnapshot && nowMs - lastFullAt >= FULL_RESCAN_MAX_AGE_MS

      let mode: LocalScanMode
      if (!haveSnapshot || rewind || schemaChanged || stale) mode = 'full'
      else if (changed) mode = 'delta'
      else mode = 'cache'

      let rows = 0
      if (mode === 'full') {
        for (const t of tables) {
          t.rows.clear()
          rows += absorb(t, queryFull(db, t, sinceMs))
        }
        lastFullAt = nowMs
        haveSnapshot = true
      } else if (mode === 'delta') {
        for (const t of tables) {
          const mx = maxNow.get(t.name) ?? 0
          // 窗口 = (上次表尾 - 回看, 本次表尾]。下界用**上次**表尾：本次新增的行一定落在里面
          const low = Math.max(0, (lastMax.get(t.name) ?? mx) - DELTA_LOOKBACK_ROWS)
          // 先清窗口内的旧行：被删掉的行不会出现在查询结果里，不清就会变成幽灵数据
          for (const k of [...t.rows.keys()]) if (k > low) t.rows.delete(k)
          rows += absorb(t, queryDelta(db, t, low, mx, sinceMs))
        }
      }
      // cache：三探针全等 ⇒ 另一个连接没提交过、表尾没动，上次的派生结果就是结果（0 次查询）

      lastDv = dv
      lastStamp = stamp
      lastMax = maxNow
      tableNames = names

      // 派生（快照 → 消费形状）。cache 轮**只在"有行会掉出窗口"时才重算**：
      // 入选行的最小 time_created 还在窗口内 ⇒ 这一轮的集合与上次逐字相同。
      // 这样稳态一轮只有几个探针查询的开销（真机实测 ~5ms 里的大头就是那次重排序）。
      let stats: LocalStats
      if (mode === 'cache' && derived && derivedMinTc > sinceMs) {
        stats = derived
      } else {
        const d = derive(tables, sinceMs)
        derived = d.stats
        derivedMinTc = d.minTc
        stats = d.stats
      }
      run = { mode, ms: Math.round(performance.now() - t0), rows }
      return stats
    } catch {
      // 打开失败 / 库被换掉 / PRAGMA 抛错：丢掉连接，下一轮按冷启动重来。
      // 不返回旧快照 —— 那是"看起来有数据"的谎言（诚实口径优先）
      closeConn()
      run = null
      return null
    }
  }

  return {
    scan(nowMs: number): Promise<LocalStats | null> {
      // 同一时刻只允许一次：并发进入会让游标/快照交错
      if (inFlight) return inFlight
      inFlight = scanOnce(nowMs).finally(() => {
        inFlight = null
      })
      return inFlight
    },
    lastRun(): LocalRun | null {
      return run
    }
  }
}
