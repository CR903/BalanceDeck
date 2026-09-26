import { join } from 'path'
import { existsSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import type { ProviderAdapter, CollectContext } from './types'
import { errSnap, identityOf, localSnap, noDataSnap, officialSnap, readJson } from './engine'
import { fmtMoney } from './types'
import type { ProviderSnapshot, ProviderWindow, ProviderModelRow } from '../../shared/types'
import {
  fetchUsageViaCookie,
  normalizeCookie,
  WINDOW_SPANS,
  WINDOW_NAMES,
  USAGE_UNIT_SCALE
} from './opencode-cookie'
import type { UsageWindowKind, SsrUsageWindow, SsrRawWindow } from './opencode-cookie'
import type { ConsoleModelRow, ConsoleDetails } from '../opencode-details'

// ═══════════════════════════════════════════════════════════════════════════════
// OpenCode Go 同步策略 v3 —— 对齐官方控制台
//
// 数据源（按优先级）：
//   ① 官方 API   GET https://opencode.ai/zen/go/v1/usage（Bearer key）
//      → 与控制台同源：{ status, percent, resetsAt }
//      ⚠️ 403 `EntitlementError` 只发生在 `auth.json` 里那把 key 上；应用实际用
//         `opencode.db` credential 表里的那把（debug 显示「本机凭据(…9dFe)」），
//         所以这条路径在应用内通常是**通的**。
//   ② Cookie 路径   GET /console/api/go/status（会话 cookie + x-org-id）
//      → 2026-09-26 起。控制台重写成纯客户端 SPA，旧的 SSR `data-slot="usage-item"`
//         解析已失效；新端点由「打开真实 Go 页观测它调了谁」定位（不是从 bundle 声明猜的
//         —— `/console/api/usage/summary` 也在声明里，但那是**用量聚合**，没有窗口百分比）。
//         好处：限额由服务端下发，已用量是精确值。
//      → 每模型明细：GET /console/api/usage/models（tokens 也来自服务端，多设备不再漏）
//   ③ 本机 opencode.db → cost + tokens 明细（仅本机，多设备不全）
//
// 关键原则（重要）：
//   - 百分比 + 重置时间永远以官方为准（API 或 cookie），不用本机推算
//   - 窗口边界用服务端 resetsAt 反推：start = resetsAt - span
//     （5h/7d/30d），本机 cost/tokens 在官方窗口内求和，保证与官方口径一致
//   - 官方不可用时才退回本机 block 算法，且明确标注"本机估算"
//   - 限额优先用控制台 `go/status` 下发的 `limitMicroCents`；只有拿不到时才用下面的
//     `LOCAL_LIMITS` 兜底（2026-09-26 起服务端才是权威，硬编码只是保底）
// ═══════════════════════════════════════════════════════════════════════════════

/** 兜底限额（美元）。仅在控制台与 API 都拿不到限额时使用。 */
const LOCAL_LIMITS = { fiveHour: 12, weekly: 30, monthly: 60 }
const USAGE_ENDPOINT = 'https://opencode.ai/zen/go/v1/usage'

interface MsgData {
  // 旧 schema（message 表）：role/providerID/modelID 在顶层
  role?: string
  providerID?: string
  modelID?: string
  // 新 schema（session_message 表）：model.{id,providerID}
  model?: { id?: string; providerID?: string }
  cost?: number
  time?: { created?: number }
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
}

interface Point {
  t: number
  cost: number
  tokens: number
  model: string
}

/** 解析一条消息记录（兼容旧 message 与新 session_message 两种 schema） */
function parsePoint(d: MsgData): Point | null {
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

interface ApiWindow {
  status?: string
  percent?: number
  resetsAt?: string
}

type ApiUsage = Partial<Record<UsageWindowKind, ApiWindow>>

// ─── 凭据解析 ───────────────────────────────────────────────────────────────

/** 从 opencode auth.json 读取 API key（可能 403：归属用户与订阅不匹配） */
export function readGoKey(): string | null {
  const candidates: string[] = []
  if (process.env.XDG_DATA_HOME) candidates.push(join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json'))
  candidates.push(join(homedir(), '.local', 'share', 'opencode', 'auth.json'))
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'opencode', 'auth.json'))
    if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'opencode', 'auth.json'))
  }
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue
      const auth = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, { type?: string; key?: string }>
      const entry = auth['opencode-go'] ?? auth['opencode']
      if (entry?.key) return entry.key
    } catch {
      // 继续尝试下一个路径
    }
  }
  return null
}

/**
 * 从 opencode.db 的 credential 表读取 opencode 集成 key。
 * opencode 1.x 起凭据迁入数据库（`{"type":"key","key":"sk-…"}`），
 * 该 key 通常才是控制台当前有效的那把（auth.json 可能是旧 key，会 403）。
 */
export async function readDbCredentialKey(): Promise<string | null> {
  const dbPath = detectDbPath()
  if (!dbPath) return null
  try {
    const { DatabaseSync } = (await import('node:sqlite')) as { DatabaseSync: new (p: string, o?: object) => {
      prepare(sql: string): { all(...p: unknown[]): unknown[] }
      close(): void
    } }
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
      if (!tables.some((t) => t.name === 'credential')) return null
      const rows = db
        .prepare(`SELECT value FROM credential WHERE integration_id = 'opencode' ORDER BY time_updated DESC`)
        .all() as { value: string }[]
      for (const row of rows) {
        try {
          const v = JSON.parse(row.value) as { type?: string; key?: string }
          if (v?.key && typeof v.key === 'string' && v.key.trim()) return v.key.trim()
        } catch {
          // 非 JSON 则跳过
        }
      }
    } finally {
      db.close()
    }
  } catch {
    return null
  }
  return null
}

interface KeyEntry {
  key: string
  /** 来源标签（UI 展示用） */
  label: string
}

async function resolveKeys(ctx: CollectContext): Promise<KeyEntry[]> {
  const out: KeyEntry[] = []
  const seen = new Set<string>()
  const push = (key: string, label: string): void => {
    const k = key.trim()
    if (!k || seen.has(k)) return
    seen.add(k)
    out.push({ key: k, label })
  }

  const configured = await ctx.getKey('opencodeKeys')
  if (configured) {
    try {
      const arr = JSON.parse(configured) as unknown
      if (Array.isArray(arr)) {
        arr.forEach((k, i) => {
          if (typeof k === 'string') push(k, `账号${i + 1}`)
        })
      }
    } catch {
      // 配置损坏则忽略
    }
  }
  const fromAuth = readGoKey()
  if (fromAuth) push(fromAuth, 'auth.json')
  const fromDb = await readDbCredentialKey()
  if (fromDb) push(fromDb, '本机凭据')
  return out
}

async function resolveActiveIndex(ctx: CollectContext, keys: KeyEntry[]): Promise<number> {
  const raw = await ctx.getExtra('opencodeActive')
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isInteger(n) && n >= 0 && n < keys.length ? n : 0
}

/** 是否已存在 opencode.db credential 表凭据（设置页凭据来源探测用） */
export async function hasDbCredentialKey(): Promise<boolean> {
  return (await readDbCredentialKey()) !== null
}

/** 来源标签：settings 多账号显示 账号N(尾号)，其余显示来源名 */
function keyTag(entry: KeyEntry, multiAccount: boolean): string {
  const tail = `…${entry.key.slice(-4)}`
  if (entry.label.startsWith('账号')) return multiAccount ? `${entry.label}(${tail})` : '官方 API'
  return `${entry.label}(${tail})`
}

// ─── Cookie 凭据 ────────────────────────────────────────────────────────────

/**
 * 从 dsh-opencode-go-usage 插件的配置文件读取凭据。
 * 该插件（用户参考过的项目）把 cookie + workspaceID 存在 $DSH_HOME/ocgo-usage.json，
 * 若用户已在那里配置过，这里直接复用，无需重复填写。
 */
function readDshOcgoConfig(): { cookie?: string; workspaceId?: string } {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const path = join(home, 'ocgo-usage.json')
  try {
    if (!existsSync(path)) return {}
    const j = JSON.parse(readFileSync(path, 'utf-8')) as { cookie?: unknown; workspaceID?: unknown }
    return {
      cookie: typeof j.cookie === 'string' && j.cookie.trim() ? j.cookie.trim() : undefined,
      workspaceId: typeof j.workspaceID === 'string' && j.workspaceID.trim() ? j.workspaceID.trim() : undefined
    }
  } catch {
    return {}
  }
}

/**
 * 解析控制台凭据。cookie 来源优先级：
 *   ① **授权分区的实时 cookie**（唯一可靠来源 —— 服务端每次响应都轮换 session，
 *      保存的副本必然过期）
 *   ② 设置中保存的 cookie / 环境变量 / dsh 插件配置（手动粘贴场景的兜底）
 */
async function resolveCookie(
  ctx: CollectContext
): Promise<{ cookie: string; workspaceId: string } | null> {
  const dsh = readDshOcgoConfig()
  const rawWid =
    (await ctx.getExtra('opencodeWorkspaceId')) ?? process.env.OPENCODE_GO_WORKSPACE_ID ?? dsh.workspaceId ?? null
  const workspaceId = rawWid?.trim() || null
  if (!workspaceId) return null

  // ① 授权分区实时 cookie（含轮换后的最新值）
  try {
    const { readPartitionCookie } = await import('../opencode-auth')
    const live = await readPartitionCookie()
    if (live) return { cookie: live, workspaceId }
  } catch {
    // 分区不可用则走兜底
  }

  // ② 保存的 / 环境变量 / dsh 配置
  const rawCookie = (await ctx.getKey('opencodeCookie')) ?? process.env.OPENCODE_GO_COOKIE ?? dsh.cookie ?? null
  const cookie = normalizeCookie(rawCookie)
  return cookie ? { cookie, workspaceId } : null
}

// ─── 本机 opencode.db ───────────────────────────────────────────────────────

function detectDbPath(): string | null {
  const candidates: string[] = []
  if (process.env.XDG_DATA_HOME) candidates.push(join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db'))
  candidates.push(join(homedir(), '.local', 'share', 'opencode', 'opencode.db'))
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'opencode', 'opencode.db'))
    if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'opencode', 'opencode.db'))
  }
  return candidates.find((p) => existsSync(p)) ?? null
}

/** 5 小时窗口（块）算法：窗口自首条记录起持续 5h，结束后首条新记录开新窗 */
function activeBlockRange(pts: Point[], now: number, spanMs = 5 * 3600_000): { start: number; end: number } | null {
  if (pts.length === 0) return null
  let start = pts[0].t
  for (const p of pts) {
    if (p.t >= start + spanMs) start = p.t
  }
  const end = start + spanMs
  if (now >= end) return null
  return { start, end }
}

function sumSince(pts: Point[], sinceMs: number, pick: (p: Point) => number): number {
  let s = 0
  for (const p of pts) if (p.t >= sinceMs) s += pick(p)
  return s
}

/** 在 [startMs, endMs) 区间内求 cost/tokens 总和（对齐官方窗口边界用） */
function sumInRange(pts: Point[], startMs: number, endMs: number): { cost: number; tokens: number } {
  let cost = 0
  let tokens = 0
  for (const p of pts) {
    if (p.t >= startMs && p.t < endMs) {
      cost += p.cost
      tokens += p.tokens
    }
  }
  return { cost, tokens }
}

interface LocalStats {
  pts: Point[]
  byModel: Map<string, { cost: number; tokens: number }>
}

/**
 * 本机 db 解析缓存。
 *
 * 为什么需要：用户可以把手动刷新频率调到 10 秒，而 opencode.db 是几百 MB 的库，
 * 每轮全表扫 message/session_message 太浪费。SQLite 处于 WAL 模式，主库 mtime
 * 可能长时间不变（写入先落 -wal），因此 key 必须同时包含 -wal/-shm 的大小与时间。
 * 另外加 2 分钟兜底 TTL，避免任何探测不到的变化导致长期陈旧。
 */
const localCache = new Map<string, { key: string; at: number; stats: LocalStats }>()
const LOCAL_CACHE_TTL = 120_000

function fileStamp(path: string): string {
  try {
    const s = statSync(path)
    return `${s.size}:${Math.round(s.mtimeMs)}`
  } catch {
    return '-'
  }
}

function localDbStamp(dbPath: string): string {
  return `${fileStamp(dbPath)}|${fileStamp(`${dbPath}-wal`)}|${fileStamp(`${dbPath}-shm`)}`
}

/**
 * 读取本机 opencode.db 用量记录，兼容两代 schema：
 *   旧（opencode 0.x）：`message` 表，data 顶层含 role/providerID
 *   新（opencode 1.x）：`session_message` 表，type='assistant'，model.providerID
 * 两表按 (time, cost) 去重取并集（实测新表覆盖旧表 96%，仅旧表独有少数记录）。
 */
async function loadLocal(nowMs: number): Promise<LocalStats | null> {
  const dbPath = detectDbPath()
  if (!dbPath) return null
  const stamp = localDbStamp(dbPath)
  const cached = localCache.get(dbPath)
  if (cached && cached.key === stamp && nowMs - cached.at < LOCAL_CACHE_TTL) return cached.stats
  try {
    const { DatabaseSync } = (await import('node:sqlite')) as { DatabaseSync: new (p: string, o?: object) => {
      prepare(sql: string): { all(...p: unknown[]): unknown[] }
      close(): void
    } }
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const pts: Point[] = []
    const byModel = new Map<string, { cost: number; tokens: number }>()
    const seen = new Set<string>()
    const sinceMs = nowMs - 31 * 86400_000 // 官方最长窗口 30 天，多取 1 天
    try {
      // 探测表结构（新老版本差异）
      const tables = new Set<string>()
      try {
        const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]
        for (const r of rows) tables.add(r.name)
      } catch {
        // 探测失败则按老表尝试
      }

      const ingest = (rows: { data: string }[]): void => {
        for (const row of rows) {
          let d: MsgData
          try {
            d = JSON.parse(row.data)
          } catch {
            continue
          }
          const p = parsePoint(d)
          if (!p) continue
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

      // 新 schema：session_message（type 列区分消息类型，data 无 role）
      if (tables.has('session_message')) {
        try {
          const rows = db
            .prepare(`SELECT data FROM session_message WHERE type = 'assistant' AND time_created > ?`)
            .all(sinceMs) as { data: string }[]
          ingest(rows)
        } catch {
          // 表结构不符则跳过
        }
      }
      // 旧 schema：message（data 顶层含 role）
      if (tables.has('message')) {
        try {
          const rows = db
            .prepare(`SELECT data FROM message WHERE time_created > ?`)
            .all(sinceMs) as { data: string }[]
          ingest(rows)
        } catch {
          // 表结构不符则跳过
        }
      }
    } finally {
      db.close()
    }
    pts.sort((a, b) => a.t - b.t)
    const stats = { pts, byModel }
    localCache.set(dbPath, { key: stamp, at: nowMs, stats })
    return stats
  } catch {
    return null
  }
}

// ─── 官方窗口构建 ───────────────────────────────────────────────────────────

/**
 * 服务端窗口（精度策略）：
 *
 *   官方 API  `GET /zen/go/v1/usage` 的 `percent` 是**整数**（向下取整），
 *   控制台页面（SSR）渲染的是**一位小数**（如 4.3%）。
 *   两者同源，API 是控制台值的下界。
 *
 *   因此：
 *     - 配了控制台 cookie → 用 cookie 的精确百分比（与控制台逐位一致），
 *       并保留 API 的精确 `resetsAt`；两者需落在同一整数带内才合并（防串窗）。
 *     - 只有 API → 用整数百分比（诚实展示，不伪造小数）。
 *
 *   ⚠️ 不要用本机 cost 反推百分比：本机 db 只是本机份额（官方额度全客户端共享），
 *   且滚动窗口滑动时会回退，会造成数值抖动。
 *
 *   tokens 官方不提供，取本机 db 在 [resetsAt - span, now) 区间的求和（标注"本机"）。
 */
function officialWindows(
  apiUsage: ApiUsage | null,
  cookie:
    | {
        windows: Partial<Record<UsageWindowKind, SsrUsageWindow>>
        raw: Partial<Record<UsageWindowKind, SsrRawWindow>>
      }
    | null,
  local: LocalStats | null,
  nowMs: number
): ProviderWindow[] {
  const defs: [UsageWindowKind, number][] = [
    ['rolling', LOCAL_LIMITS.fiveHour],
    ['weekly', LOCAL_LIMITS.weekly],
    ['monthly', LOCAL_LIMITS.monthly]
  ]
  const windows: ProviderWindow[] = []
  for (const [kind, defaultLimit] of defs) {
    const api = apiUsage?.[kind]
    const rendered = cookie?.windows?.[kind]
    const raw = cookie?.raw?.[kind]
    if (!api && !rendered && !raw) continue

    // 配额：控制台 payload 的 limit（1e-8 USD）最准；否则用已知默认限额
    const limit = raw?.limit != null && raw.limit > 0 ? raw.limit / USAGE_UNIT_SCALE : defaultLimit

    // 百分比来源优先级：
    //   ① 控制台 payload 的 usagePercent（最精确，可含多位小数）
    //   ② 控制台渲染文本的 percent（一位小数）
    //   ③ 官方 API 的实数 percent
    //   ①/② 需与 API 整数带一致（防串窗）；无 API 时直接采用
    const apiPct = api?.percent != null ? clampPct(api.percent) : null
    const rawPct = raw?.usagePercent != null && Number.isFinite(raw.usagePercent)
      ? clampPct(raw.usagePercent)
      : null
    const renderedPct = rendered?.percent != null ? clampPct(rendered.percent) : null

    let percent: number
    let sourceNote: string
    const inBand = (p: number | null): boolean =>
      p != null && (apiPct == null || (p >= apiPct - 0.001 && p < apiPct + 1))
    if (inBand(rawPct)) {
      percent = rawPct!
      sourceNote = '控制台'
    } else if (inBand(renderedPct)) {
      percent = renderedPct!
      sourceNote = '控制台'
    } else if (apiPct != null) {
      percent = apiPct
      sourceNote = '官方 API'
    } else if (rawPct != null) {
      percent = rawPct
      sourceNote = '控制台'
    } else {
      percent = renderedPct ?? 0
      sourceNote = '控制台'
    }
    percent = clampPct(percent)

    // 花了钱却算不出百分比（控制台没给限额）时，**必须说不知道，不能显示 0%**。
    // 2026-09-26 修：此前这种情况下界面会渲染「已用 $5.06 / 配额 $30 · 0%」。
    const percentUnknown = apiPct == null && rawPct == null && (raw?.usage ?? 0) > 0
    if (percentUnknown) sourceNote = '百分比不可用（控制台未给限额）'

    // 已用金额：控制台 payload 的 usage（1e-8 USD）是真实值；否则按百分比折算
    const used =
      raw?.usage != null && raw.usage >= 0 && raw?.limit != null
        ? raw.usage / USAGE_UNIT_SCALE
        : (percent / 100) * limit

    // 重置时间：API 的 ISO 时间精确；控制台只有"X 小时 Y 分钟"短语（分钟级）
    const resetAt =
      api?.resetsAt ??
      (rendered && rendered.resetInSec > 0
        ? new Date(nowMs + rendered.resetInSec * 1000).toISOString()
        : raw?.resetInSec != null && raw.resetInSec > 0
          ? new Date(nowMs + raw.resetInSec * 1000).toISOString()
          : undefined)

    // 5h 滚动窗口 percent=0 且 resetsAt≈now+5h：占位值，表示当前无活跃窗口
    const resetMs = resetAt ? Date.parse(resetAt) : NaN
    const isRollingIdle =
      kind === 'rolling' && percent === 0 && Number.isFinite(resetMs) && Math.abs(resetMs - nowMs - WINDOW_SPANS.rolling) < 120_000

    // tokens 只能来自本机：按窗口边界 [resetsAt - span, now) 求和
    let tokens: number | undefined
    if (local && Number.isFinite(resetMs)) {
      const r = sumInRange(local.pts, resetMs - WINDOW_SPANS[kind], nowMs)
      if (r.tokens > 0) tokens = r.tokens
    }

    const status = api?.status ?? rendered?.status ?? raw?.status
    // `percentUnknown` 时 sourceNote 已经是「百分比不可用（控制台未给限额）」，
    // 直接用它 —— 否则用户会看到「0% · 控制台」，把"不知道"误读成"就是 0%"。
    const note = status === 'rate-limited' ? '已触发限流' : isRollingIdle ? '当前无活跃窗口' : sourceNote

    windows.push({
      name: WINDOW_NAMES[kind],
      used,
      limit,
      unit: 'usd',
      percent,
      tokens,
      resetAt: isRollingIdle ? undefined : resetAt,
      note
    })
  }
  return windows
}

function clampPct(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return 0
  // 归一化到一位小数：杜绝无限小数流入托盘/卡片/详情
  return Math.max(0, Math.min(100, Math.round(v * 10) / 10))
}

function modelRows(stats: LocalStats, topN = 6): ProviderModelRow[] {
  const rows: ProviderModelRow[] = []
  for (const [model, v] of stats.byModel) rows.push({ model, cost: v.cost, tokens: v.tokens, source: 'local' })
  return rows.sort((a, b) => b.cost - a.cost).slice(0, topN)
}

/** 模型名归一化（用于把控制台显示名与本机 model id 对上） */
function normModel(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** 调试追踪（BALANCEDECK_DEBUG=1 时写入 /tmp/balancedeck-scheduler.log） */
function debugLog(msg: string): void {
  if (!process.env.BALANCEDECK_DEBUG) return
  void import('fs').then(({ appendFileSync }) =>
    appendFileSync('/tmp/balancedeck-scheduler.log', `${new Date().toISOString()} ${msg}\n`)
  )
}

/**
 * 合并控制台官方明细与本机 tokens。
 *
 * 2026-09-26 起**控制台直接给 tokens 了**（`usage/models` 响应里有
 * totalInput/Output/CacheRead + 两种 CacheWrite），所以本机 tokens 只在
 * 服务端缺该模型时兜底 —— 之前是"官方给 cost、本机给 token"的双源拼接。
 *
 * ⚠️ **quota / percent 故意不给**（填 undefined，而不是 0）：
 * 新接口只有每模型**已用量**，没有每模型配额与百分比（旧 DOM 版能从表头读到）。
 * 填 0 会让界面显示「$0 / 0%」，那是撒谎。渲染层本来就支持缺省
 * （`DetailView.tsx` 对 undefined 显示「—」）。
 */
function mergeConsoleModels(
  consoleRows: ConsoleModelRow[],
  stats: LocalStats | null,
  topN = 12
): ProviderModelRow[] {
  const localByNorm = new Map<string, { tokens: number; cost: number }>()
  if (stats) {
    for (const [model, v] of stats.byModel) {
      const k = normModel(model)
      const cur = localByNorm.get(k) ?? { tokens: 0, cost: 0 }
      cur.tokens += v.tokens
      cur.cost += v.cost
      localByNorm.set(k, cur)
    }
  }
  // 本机条目只被消费一次：控制台可能有两个同名不同 id 的模型（如两个
  // "DeepSeek V4.1 Flash"），若都匹配同一份本机数据会重复计数。
  const consumed = new Set<string>()
  return consoleRows
    .filter((r) => r.usageUsd > 0)
    .sort((a, b) => b.usageUsd - a.usageUsd)
    .slice(0, topN)
    .map((r) => {
      const k = normModel(r.model)
      const local = !consumed.has(k) ? localByNorm.get(k) : undefined
      if (local) consumed.add(k)
      return {
        model: r.model,
        cost: r.usageUsd,
        tokens: r.tokens || local?.tokens || 0,
        source: 'console' as const
      }
    })
}

// ─── 本机兜底窗口（无官方数据时使用）────────────────────────────────────────

function localWindows(stats: LocalStats, now: number): ProviderWindow[] {
  const limitations = LOCAL_LIMITS
  const windows: ProviderWindow[] = []
  const blk = activeBlockRange(stats.pts, now)
  const blkPts = blk ? stats.pts.filter((p) => p.t >= blk.start) : []
  const fiveCost = blkPts.reduce((s, p) => s + p.cost, 0)
  windows.push(
    blk
      ? {
          name: WINDOW_NAMES.rolling,
          used: fiveCost,
          tokens: blkPts.reduce((s, p) => s + p.tokens, 0),
          limit: limitations.fiveHour,
          unit: 'usd',
          percent: Math.min(100, (fiveCost / limitations.fiveHour) * 100),
          resetAt: new Date(blk.end).toISOString()
        }
      : { name: WINDOW_NAMES.rolling, used: 0, limit: limitations.fiveHour, unit: 'usd', percent: 0, note: '当前无活跃窗口' }
  )
  const wkStart = now - WINDOW_SPANS.weekly
  const wkCost = sumSince(stats.pts, wkStart, (p) => p.cost)
  windows.push({
    name: WINDOW_NAMES.weekly,
    used: wkCost,
    tokens: sumSince(stats.pts, wkStart, (p) => p.tokens),
    limit: limitations.weekly,
    unit: 'usd',
    percent: Math.min(100, (wkCost / limitations.weekly) * 100)
  })
  const moStart = now - WINDOW_SPANS.monthly
  const moCost = sumSince(stats.pts, moStart, (p) => p.cost)
  windows.push({
    name: WINDOW_NAMES.monthly,
    used: moCost,
    tokens: sumSince(stats.pts, moStart, (p) => p.tokens),
    limit: limitations.monthly,
    unit: 'usd',
    percent: Math.min(100, (moCost / limitations.monthly) * 100),
    note: '滚动 30 天'
  })
  return windows
}

// ─── 适配器主体 ─────────────────────────────────────────────────────────────

export const opencodeAdapter: ProviderAdapter = {
  id: 'opencode',
  name: 'OpenCode Go',
  kind: 'coding',
  builtin: true,

  async collect(ctx: CollectContext): Promise<ProviderSnapshot> {
    const nowMs = ctx.now.getTime()
    const keys = await resolveKeys(ctx)
    const activeIdx = await resolveActiveIndex(ctx, keys)
    const cookieCred = await resolveCookie(ctx)
    const local = await loadLocal(nowMs)

    // ── 数据源 ①：官方 API（Bearer key）→ 精确 resetsAt + 整数 percent ──────
    let apiUsage: ApiUsage | null = null
    let apiTag = ''
    let apiError = ''
    for (let attempt = 0; attempt < keys.length; attempt++) {
      const idx = (activeIdx + attempt) % keys.length
      const entry = keys[idx]
      try {
        const { status, body } = await readJson(ctx, USAGE_ENDPOINT, { Authorization: `Bearer ${entry.key}`, Accept: 'application/json' })
        if (status === 200) {
          const u = (body as { usage?: ApiUsage }).usage
          if (u) {
            apiUsage = u
            apiTag = keyTag(entry, keys.length > 1)
            apiError = ''
            break
          }
          apiError = '官方 API 响应缺少 usage 字段'
        } else {
          apiError = `官方 API HTTP ${status}`
        }
        if (status !== 401 && status !== 403) continue
        // 401/403：多账号时换下一个 key
      } catch (e) {
        // 网络失败：换下一个 key
        apiError = (e as Error).message
      }
    }

    // ── 数据源 ②：控制台 cookie → 精确 percent / 金额 + 每模型明细 ──────────
    let cookie: { windows: Partial<Record<UsageWindowKind, SsrUsageWindow>>; raw: Partial<Record<UsageWindowKind, SsrRawWindow>> } | null = null
    let cookieError = ''
    let consoleDetails: ConsoleDetails | null = null
    if (cookieCred) {
      try {
        const r = await fetchUsageViaCookie(ctx, cookieCred.cookie, cookieCred.workspaceId)
        cookie = { windows: r.windows, raw: r.raw }
        if (r.unknownMeters.length) {
          debugLog(`opencode: 控制台接口出现未知计费项 ${r.unknownMeters.join(',')}`)
        }
        // 每模型明细（5 分钟缓存，非阻塞：本轮用缓存，后台刷新）
        try {
          const { fetchConsoleDetails } = await import('../opencode-details')
          consoleDetails = fetchConsoleDetails(cookieCred.workspaceId, cookieCred.cookie)
        } catch {
          consoleDetails = null
        }
      } catch (e) {
        cookieError = (e as Error).message
        debugLog(`opencode: 保存的 cookie 失效（${cookieError}），尝试自愈`)
        // 自愈：cookie 可能被服务端轮换。授权会话若还在，静默换用实时 cookie 并回写。
        try {
          const { readLiveCookie } = await import('../opencode-auth')
          const live = await readLiveCookie(cookieCred.workspaceId)
          if (live && live !== cookieCred.cookie) {
            const r = await fetchUsageViaCookie(ctx, live, cookieCred.workspaceId)
            cookie = { windows: r.windows, raw: r.raw }
            cookieError = ''
            // 自愈成功后同样要报未知计费项 —— 否则"第一次失败恰好因为结构变了"时，
            // 这个改版信号会被丢掉，快照静悄悄退回本机估算（2026-09-26 评审发现）
            if (r.unknownMeters.length) {
              debugLog(`opencode: 自愈后仍出现未知计费项 ${r.unknownMeters.join(',')}`)
            }
            if (ctx.setKey) await ctx.setKey('opencodeCookie', live)
            try {
              const { fetchConsoleDetails, invalidateConsoleDetails } = await import('../opencode-details')
              invalidateConsoleDetails()
              consoleDetails = fetchConsoleDetails(cookieCred.workspaceId, live)
            } catch {
              /* 明细是增强项，失败就算了 */
            }
            debugLog('opencode: 已用实时 cookie 自愈')
          }
        } catch {
          // 自愈失败：保留原错误
        }
      }
    } else {
      debugLog(`opencode: 无 cookie 凭据（workspace/key 缺失）`)
    }

    // ── 合并：控制台精确数据 + API 精确重置时间 + 本机 tokens/模型明细 ──────
    if (apiUsage || cookie) {
      const windows = officialWindows(apiUsage, cookie, local, nowMs)

      // 分窗口的每模型明细（控制台口径）
      // 注意 `consoleDetails` 只有 weekly/monthly —— 5 小时窗口**没有**明细，
      // 因为端点最小 range 是 24h（口径对不上，宁可不给，见 opencode-console-api 的说明）
      const modelsByWindow: Record<string, ProviderModelRow[]> = {}
      if (consoleDetails) {
        for (const [kind, rows] of Object.entries(consoleDetails) as [
          'weekly' | 'monthly',
          ConsoleModelRow[]
        ][]) {
          if (rows && rows.length) modelsByWindow[WINDOW_NAMES[kind]] = mergeConsoleModels(rows, local)
        }
      }
      const monthlyModels = consoleDetails?.monthly?.length ? mergeConsoleModels(consoleDetails.monthly, local) : null

      const parts: string[] = []
      if (cookie) parts.push('控制台（精确）')
      if (apiUsage) parts.push(`API · ${apiTag}`)
      return officialSnap(
        {
          ...identityOf(this),
          plan: 'Go 套餐',
          windows,
          models: monthlyModels ?? (local ? modelRows(local) : undefined),
          modelsByWindow: Object.keys(modelsByWindow).length ? modelsByWindow : undefined,
          source: parts.join(' + '),
          detail: cookieError
            ? `控制台 cookie 抓取失败（${cookieError}）；当前百分比来自官方 API，精度为整数`
            : undefined
        },
        ctx
      )
    }

    // ── 降级：本机统计（明确标注为估算，绝不当成官方数据展示）──────────────
    if (!local || local.pts.length === 0) {
      const reason = keys.length
        ? `官方 API 无响应且本机无用量记录（${apiError || '网络不可达'}）`
        : '未找到 opencode 凭据与用量记录（未安装或从未使用）'
      return noDataSnap(identityOf(this), reason, ctx)
    }
    const reason = apiError || cookieError || '官方接口不可达'
    const detailBits = [
      cookieCred
        ? `官方 API 与控制台均不可用（${reason}），当前为本机估算`
        : `官方 API 不可达（${reason}），当前为本机估算（配置控制台 Cookie 可提升精度）`
    ]
    const top = [...local.byModel.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 3)
    if (top.length) detailBits.push(`30天模型花费 Top: ${top.map(([m, v]) => `${m} ${fmtMoney(v.cost, 'usd')}`).join(' · ')}`)
    return localSnap(
      {
        ...identityOf(this),
        plan: 'Go 套餐',
        windows: localWindows(local, nowMs),
        models: modelRows(local),
        source: '本机统计',
        // 诚实标注：口径不同（本机份额 ≠ 官方账户额度），UI 必须显式提示。
        // 来路由 localSnap 盖章（ADR-0002：可信度是铸造的必填输入，不再写进字段）
        failureReason: `官方数据不可用（${reason}）`,
        degradedReason: `官方数据不可用（${reason}）· 当前为本机估算，与官方百分比口径不同`,
        detail: detailBits.join(' · ')
      },
      ctx
    )
  }
}
