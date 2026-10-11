import {
  CONSOLE_ORIGIN,
  GO_STATUS_PATH,
  MODELS_PAGE_SIZE,
  MODELS_RANGES,
  MODELS_RANGE_ROLLING,
  USAGE_COST_BY_DAY_PATH,
  USAGE_MODELS_PATH,
  USAGE_UNIT_SCALE,
  buildConsoleHeaders,
  type CostBucket
} from './adapters/opencode-console-api'
import { parseGoStatus } from './adapters/opencode-cookie'
import type { UsageBucket } from '../shared/types'

// ═══════════════════════════════════════════════════════════════════════════════
// 控制台「每模型用量明细」+「用量时序」
//
// 背景与历史：控制台最早把明细放在「显示详情」展开后的表格里。那张表不在 SSR HTML 里，
// 是点击后由客户端 RPC 拉的，于是当时的实现选择驱动一个隐藏窗口完成
// 「点击展开 → 读 DOM」（见 `design.md` 记录的判断：与其逆向私有 RPC，不如驱动用户手动做的事，
// 对站点改版更鲁棒）。
//
// **2026-09-26 那个判断被站点改版证伪了**：控制台重写为纯客户端 SPA，SSR 消失，
// DOM 换了一轮（实测 `[data-slot="usage-details-trigger"]` 与 `usage-item` 都不存在了，
// `npm run details:test` 耗时 21s 返回 `{}`）。而数据端点反而在公开 bundle 里
// 带着 OpenAPI 声明标了 stable。所以改成直接调接口，删掉整段 DOM 驱动。
//
// 2026-10-11 再扩一轮：官网新增 `usage/cost-by-day`（按小时/按天），且 `since`
// 参数**覆盖 range 起点**——于是「5 小时窗口没有明细」这条旧限制被推翻。本模块现在抓：
//   · models?range=7d|30d|24h&since=<窗口起点>   → 每模型明细（三窗口）
//   · cost-by-day?range&bucket=hour|day&since=<窗口起点> → 用量时序（趋势区数据源）
//
// 端点：GET /console/api/usage/models?range=7d|30d|24h&pageSize=N&since=<ISO>（必需 x-org-id）
// 真实响应（2026-09-26 实测，已脱敏）：
//   { "items": [ { "model": "deepseek-flash", "provider": "opencode-go",
//                  "totalRequests": "4357", "totalInputTokens": "18089708",
//                  "totalOutputTokens": "3193794", "totalCacheReadTokens": "858154621",
//                  "totalCacheWrite5mTokens": "0", "totalCacheWrite1hTokens": "0",
//                  "totalCostMicroCents": "1180850167" } ],
//     "pageInfo": { … } }
//
// ⚠️ **它没有 per-model 的配额与百分比**（旧 DOM 版能从表头读到「每月配额」与 %）。
//    所以 `quotaUsd` / `percent` 这两个字段被删掉，而不是填 0 ——
//    填 0 会在界面上显示成「0% / $0」，那是撒谎。渲染层本来就支持缺省
//    （`DetailView.tsx` 对 undefined 显示「—」）。
//    反过来多了样东西：**服务端 tokens**（旧版 tokens 只能取本机 db，多设备不全）。
//
// 非阻塞：命中缓存直接返回；未命中时后台刷新并立即返回旧值（或 null）。
// 抓取要出网 + 分页，合理耗时；同步等待会拖慢采集周期。
// ═══════════════════════════════════════════════════════════════════════════════

const CACHE_TTL_MS = 5 * 60_000
const TIMEOUT_MS = 12_000

export interface ConsoleModelRow {
  model: string
  /** 服务端归一化的 provider（实测恒为 "opencode-go"） */
  provider: string
  /** 该范围内已用金额（USD） */
  usageUsd: number
  /**
   * token 总量，**来自服务端**（input + output + cache read + 5m/1h cache write）。
   * 旧版这里只能拼本机 db，所以多设备会漏；现在以服务端为准。
   */
  tokens: number
  /** 请求数（服务端口径） */
  requests: number
}

/** 三个窗口的键 —— 与 `METER_FIELDS` 的值一一对应 */
export type ConsoleWindowKind = 'rolling' | 'weekly' | 'monthly'

/**
 * 窗口起点（ISO）。三个窗口的 `since` 都取自官方 `go/status`，是**跨模块的权威口径**：
 * 明细/时序只有与窗口百分比用同一个起点，才不会「串窗」。
 */
export interface ConsoleWindowStarts {
  rolling?: string
  weekly?: string
  monthly?: string
}

export interface ConsoleDetails {
  /**
   * 分窗口每模型明细。**key 不存在 = 该窗口抓取失败**（增强项，失败不该让整轮采集失败）；
   * key 存在但为空数组 = 官方确认该窗口无已用模型。
   */
  models?: Partial<Record<ConsoleWindowKind, ConsoleModelRow[]>>
  /**
   * 分窗口用量时序（官方 `cost-by-day`）。**key 不存在 = 抓取失败**，渲染层据此
   * 退回本机历史并标注「本机估算」；key 存在但为空数组 = 官方确认该窗口无用量。
   */
  series?: Partial<Record<ConsoleWindowKind, UsageBucket[]>>
}

interface CacheEntry {
  at: number
  data: ConsoleDetails
}

const cache = new Map<string, CacheEntry>()
/**
 * 在途请求 —— **按缓存键分开**，不是单一全局槽。
 *
 * 原来是一个模块级变量，而 `invalidateConsoleDetails()` 只清了 `cache`、没清它：
 * 自愈路径（换了 cookie）调 `fetchConsoleDetails` 时会看到旧 cookie 的请求仍在途，
 * 于是跳过新抓取，而 `hit` 刚被清掉 → 返回 null，明细空一轮，
 * 且旧结果最后被写进**旧键**的缓存。（2026-09-26 评审发现）
 */
const inflight = new Map<string, Promise<ConsoleDetails | null>>()

/**
 * 缓存键。
 *
 * 身份部分：用 cookie 的**长度**做身份近似是当时的权宜之计（不把凭据本身塞进 Map key，
 * 免得它出现在调试输出里）。代价：会话轮换后若新 cookie 恰好等长，会拿到最多 5 分钟的
 * 旧数据。所以键里额外掺一个 cookie 首尾字符的短摘要。
 *
 * ⚠️ **窗口起点必须进键**（2026-10-11）：`since` 从 `go/status` 来，5 小时窗口每 5 小时
 *    就滚动一次。若键里只有 cookie，滚动后最多 5 分钟会拿到「上一个窗口的序列」——
 *    而百分比已经是新窗口的，两者不同窗正是本任务要消灭的口径 bug。
 */
function cacheKey(workspaceId: string, cookie: string, starts: ConsoleWindowStarts): string {
  const head = cookie.slice(0, 12)
  const tail = cookie.slice(-8)
  const sfp = [starts.rolling, starts.weekly, starts.monthly]
    .map((s) => (s ? Date.parse(s) : 0))
    .join(',')
  return `${workspaceId}|${cookie.length}|${head.length}${tail.length}|${sfp}`
}

const debugLog = (msg: string): void => {
  if (!process.env.BALANCEDECK_DEBUG) return
  void import('fs').then(({ appendFileSync }) =>
    appendFileSync('/tmp/balancedeck-details.log', `${new Date().toISOString()} ${msg}\n`)
  )
}

/** 字符串或数字都吃（端点把数字发成字符串，测试里可能用数字） */
function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v !== 'string') return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 同 `num`，但**「缺失/不可解析」与「真的是 0」分得开**（返回 undefined vs 0）。
 *
 * 用于金额这类「0 是断言」的字段：缺 `totalCostMicroCents` 只能说明**结构变了**，
 * 编成 0 会把「不知道」渲染成「$0.00」。
 */
function numOpt(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v !== 'string' || v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 解析 `usage/models` 响应。**纯函数**（可直接单测）。
 * 认不出的 item 键不会导致丢弃 —— 只取已知的四个数值字段。
 */
export function parseModelsResponse(body: unknown): ConsoleModelRow[] {
  if (!body || typeof body !== 'object') return []
  const items = (body as { items?: unknown }).items
  if (!Array.isArray(items)) return []
  const out: ConsoleModelRow[] = []
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const m = raw as Record<string, unknown>
    const model = typeof m.model === 'string' ? m.model.trim() : ''
    if (!model) continue
    out.push({
      model,
      provider: typeof m.provider === 'string' ? m.provider : '',
      usageUsd: num(m.totalCostMicroCents) / USAGE_UNIT_SCALE,
      tokens:
        num(m.totalInputTokens) +
        num(m.totalOutputTokens) +
        num(m.totalCacheReadTokens) +
        num(m.totalCacheWrite5mTokens) +
        num(m.totalCacheWrite1hTokens),
      requests: num(m.totalRequests)
    })
  }
  return out
}

/**
 * 解析 `usage/cost-by-day` 响应。**纯函数**。
 *
 * 真实响应（2026-10-11 实测，脱敏）：
 * ```json
 * [ { "date": "2026-10-11T04:00:00Z", "totalCostMicroCents": "123456789",
 *     "totalTokens": "1234567", "totalRequests": "42" }, … ]
 * ```
 *
 * 容忍未知键：只取已知的四个字段；坏行（`date` 不可解析）跳过而**不丢整张表**。
 * 升序返回（图表按时间从左到右画）。**空数组是合法结果**（该窗口确实没用过）。
 *
 * ⚠️ **金额缺失/不可解析 → 跳过该桶**（不是补 0）：`totalCostMicroCents` 是接口的
 *    必填字段，缺它说明响应结构变了；补 0 会把「不知道」渲染成「$0.00」（K14 的由来）。
 */
export function parseCostByDay(body: unknown, bucket: CostBucket): UsageBucket[] {
  if (!Array.isArray(body)) return []
  const out: UsageBucket[] = []
  for (const raw of body) {
    if (!raw || typeof raw !== 'object') continue
    const b = raw as Record<string, unknown>
    const t = typeof b.date === 'string' ? b.date : ''
    if (!t || !Number.isFinite(Date.parse(t))) continue
    const cost = numOpt(b.totalCostMicroCents)
    if (cost === undefined) continue
    out.push({
      t,
      bucket,
      cost: cost / USAGE_UNIT_SCALE,
      tokens: num(b.totalTokens),
      requests: num(b.totalRequests)
    })
  }
  return out.sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
}

// ─── 明细/时序 → 快照的窗口映射（纯函数，可单测）────────────────────────────

/** 三个窗口的键（与 `METER_FIELDS` 的值一一对应） */
const WINDOW_KINDS: ConsoleWindowKind[] = ['rolling', 'weekly', 'monthly']

/**
 * `ConsoleDetails.models` → `snapshot.modelsByWindow`（key = 窗口名）。
 *
 * **契约**（spec §3.3 / §3.5）：`details` 里**没有**该 kind 的 key = 抓取失败 →
 * 快照里也不产出该 key（渲染层据此知道「拿不到」）；key 存在（**空数组也算**）=
 * 官方确认该窗口数据 → 快照保留该 key（空数组 = 该窗口无已用模型）。
 *
 * 抽成纯函数是为了让「三窗口都产出 / 空数组保留 / 缺失不产出」这三条可被单测钉住 ——
 * 之前这段内联在 `collect()` 里，删掉 rolling 映射或把 `if (rows)` 改成
 * `if (rows.length)` 都不会让任何测试变红（评审实测）。
 */
export function modelsByWindowOf(
  details: ConsoleDetails | null | undefined,
  windowNames: Record<ConsoleWindowKind, string>
): Record<string, ConsoleModelRow[]> {
  const out: Record<string, ConsoleModelRow[]> = {}
  const models = details?.models
  if (!models) return out
  for (const kind of WINDOW_KINDS) {
    const rows = models[kind]
    if (rows) out[windowNames[kind]] = rows
  }
  return out
}

/** `ConsoleDetails.series` → `snapshot.seriesByWindow`。契约同 `modelsByWindowOf`（空数组保留） */
export function seriesByWindowOf(
  details: ConsoleDetails | null | undefined,
  windowNames: Record<ConsoleWindowKind, string>
): Record<string, UsageBucket[]> {
  const out: Record<string, UsageBucket[]> = {}
  const series = details?.series
  if (!series) return out
  for (const kind of WINDOW_KINDS) {
    const buckets = series[kind]
    if (buckets) out[windowNames[kind]] = buckets
  }
  return out
}

// ─── 出网（原生 fetch，串行 + 重试一次）────────────────────────────────────────

interface FetchOutcome {
  ok: boolean
  body: unknown
}

function modelsUrl(range: string, since?: string): string {
  const p = new URLSearchParams({ range, page: '1', pageSize: String(MODELS_PAGE_SIZE) })
  if (since) p.set('since', since)
  return `${CONSOLE_ORIGIN}${USAGE_MODELS_PATH}?${p.toString()}`
}

function costByDayUrl(range: string, bucket: CostBucket, since: string): string {
  const p = new URLSearchParams({ range, bucket, since })
  return `${CONSOLE_ORIGIN}${USAGE_COST_BY_DAY_PATH}?${p.toString()}`
}

/**
 * 抓一个 JSON 端点，**串行 + 重试一次**，两个刻意的决定（都是 2026-09-26 实测踩出来的）：
 *
 * 1) 原来用 `Promise.all` 并发两个 range。实测会**间歇性有一个失败**（`fetch failed`，
 *    undici 的连接层错误），后果是整整一个窗口的明细静默消失 —— 而明细是"某个窗口
 *    突然没有模型表"这种用户看得见又说不清的问题。串行后没再复现。
 * 2) 单次失败重试一次再放弃：这些请求本身只要 ~1s，重试的代价远小于丢一窗数据。
 *
 * 失败返回 `{ ok:false }`（明细是增强项，不该让整轮采集失败），但**必须留下日志** ——
 * 静默为空和"真的没有数据"在界面上长得一模一样。
 *
 * **刻意不走采集引擎的 `ctx.request`**，而用原生 fetch —— 这是有意的：
 * 引擎会做可达性记账，而明细是**增强项**，它挂掉绝不该让 opencode 被判成「离线」。
 * 窗口数据走 `opencode-cookie.ts`（经过引擎），明细走这里（不经过），
 * 两条路径的失败语义因此不同，是设计决定而非遗漏。
 *
 * ⚠️ **这一层目前没有自动化测试**（`test-ssr-parser` 只覆盖纯解析器）。
 * 2026-09-26 评审实测：把串行改回并发、或删掉重试，测试全绿。
 * 要覆盖得给原生 fetch 打桩；`test-adapters.mjs` 已有给 `ctx.request` 打桩的先例，
 * 但本模块刻意不用 `ctx.request`（见上），所以不能直接复用那个桩。
 */
async function fetchJson(url: string, cookie: string, orgId: string, label: string): Promise<FetchOutcome> {
  let lastErr = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(url, { headers: buildConsoleHeaders(cookie, orgId), signal: ctrl.signal })
      if (res.status !== 200) {
        // 401/403 是稳定的（会话问题），重试没有意义
        if (res.status < 500 && res.status !== 429) {
          debugLog(`${label} -> HTTP ${res.status}，不重试（会话/参数问题）`)
          return { ok: false, body: null }
        }
        lastErr = `HTTP ${res.status}`
      } else {
        const body: unknown = JSON.parse(await res.text())
        return { ok: true, body }
      }
    } catch (e) {
      lastErr = (e as Error).message
    } finally {
      clearTimeout(timer)
    }
    if (attempt === 1) debugLog(`${label} 第 1 次失败（${lastErr}），重试`)
  }
  debugLog(`${label} 重试后仍失败：${lastErr} —— 该窗口数据将缺失`)
  return { ok: false, body: null }
}

// ─── 抓取编排 ─────────────────────────────────────────────────────────────────

async function scrape(
  cookie: string,
  orgId: string,
  starts: ConsoleWindowStarts
): Promise<ConsoleDetails | null> {
  if (!cookie || !orgId) return null
  const kinds = WINDOW_KINDS
  const out: ConsoleDetails = { models: {}, series: {} }

  // ① 每模型明细（三窗口）。串行，见 fetchJson 的注释。
  for (const kind of kinds) {
    const since = starts[kind]
    // rolling 没有官方起点时无法精确对齐 → 跳过（宁可不给，也不拿 24h 冒充 5 小时）
    if (kind === 'rolling' && !since) continue
    const range = kind === 'rolling' ? MODELS_RANGE_ROLLING : MODELS_RANGES[kind]
    const o = await fetchJson(modelsUrl(range, since), cookie, orgId, `models ${kind}`)
    if (o.ok) {
      const rows = parseModelsResponse(o.body)
      out.models![kind] = rows
      debugLog(
        `models ${kind} -> ${rows.length} 行${rows[0] ? `，首行=${rows[0].model} $${rows[0].usageUsd.toFixed(4)}` : '（空）'}`
      )
    }
  }

  // ② 用量时序（趋势区数据源）。rolling 用小时桶，周/月用日桶。
  for (const kind of kinds) {
    const since = starts[kind]
    if (!since) continue
    const bucket: CostBucket = kind === 'rolling' ? 'hour' : 'day'
    const range = kind === 'rolling' ? MODELS_RANGE_ROLLING : MODELS_RANGES[kind]
    const o = await fetchJson(costByDayUrl(range, bucket, since), cookie, orgId, `cost-by-day ${kind}`)
    if (o.ok) {
      const buckets = parseCostByDay(o.body, bucket)
      const rawLen = Array.isArray(o.body) ? o.body.length : 0
      // 非空响应却解析出 0 桶 = 全行缺必填金额（结构变了）→ **不设 key**，
      // 让快照按「抓取失败」处理（渲染层退本机/不显示），而不是冒充「官方确认无用量」。
      // 真·空数组（rawLen=0）= 官方确认该窗口没用过 → 保留空数组 key（契约见 spec §3.5）。
      if (rawLen > 0 && buckets.length === 0) {
        debugLog(`cost-by-day ${kind} -> 非空响应(${rawLen})但 0 桶可用，疑结构变更，该窗口序列缺失`)
        continue
      }
      out.series![kind] = buckets
      debugLog(
        `cost-by-day ${kind} -> ${buckets.length} 桶` +
          (rawLen > buckets.length ? `（跳过 ${rawLen - buckets.length} 个坏桶，疑结构变更）` : '')
      )
    }
  }

  const anyModels = Object.keys(out.models!).length > 0
  const anySeries = Object.keys(out.series!).length > 0
  debugLog(
    `scrape 完成: models=${Object.keys(out.models!).join(',') || '—'} series=${Object.keys(out.series!).join(',') || '—'}`
  )
  return anyModels || anySeries ? out : null
}

/**
 * 读控制台每模型明细 + 用量时序（按 workspace+会话+**窗口起点**缓存）。
 *
 * **非阻塞**：命中缓存直接返回；未命中/过期时触发后台刷新并立即返回旧值（或 null）。
 *
 * ⚠️ `starts` 是该窗口的官方起点（`go/status` 的 `meters.*.startsAt`，month 用
 *    `access.startsAt`）。三项都缺时只能拿到 weekly/monthly 的 range 明细，
 *    rolling 与全部时序缺失 —— 所以采集路径必须传它。
 */
export function fetchConsoleDetails(
  workspaceId: string,
  cookie: string,
  starts: ConsoleWindowStarts = {}
): ConsoleDetails | null {
  if (!workspaceId || !cookie) return null
  const key = cacheKey(workspaceId, cookie, starts)
  const hit = cache.get(key)
  const fresh = hit && Date.now() - hit.at < CACHE_TTL_MS
  debugLog(
    `fetch wid=${workspaceId.slice(0, 8)} hit=${hit ? summaryOf(hit.data) : 'none'} fresh=${!!fresh} inflight=${inflight.has(key)}`
  )
  if (!fresh && !inflight.has(key)) {
    const task = scrape(cookie, workspaceId, starts)
      .then((data) => {
        if (data) cache.set(key, { at: Date.now(), data })
        return data
      })
      .finally(() => {
        inflight.delete(key)
      })
    inflight.set(key, task)
  }
  return hit?.data ?? null
}

function summaryOf(d: ConsoleDetails): string {
  const models = Object.entries(d.models ?? {})
    .map(([k, v]) => `${k}=${v.length}`)
    .join(',')
  const series = Object.entries(d.series ?? {})
    .map(([k, v]) => `${k}=${v.length}`)
    .join(',')
  return `m[${models || '—'}] s[${series || '—'}]`
}

/**
 * 显式抓取一次并写入缓存（预热/诊断用，不用于采集路径）。
 *
 * `starts` 缺省时**自己打一发 `go/status` 取起点**（仅诊断路径如此）—— 否则缓存键与
 * 采集路径对不上，预热等于没做。诊断路径本就该看到与产品一致的结果。
 */
export async function fetchConsoleDetailsNow(
  workspaceId: string,
  cookie: string,
  starts?: ConsoleWindowStarts
): Promise<ConsoleDetails | null> {
  if (!workspaceId || !cookie) return null
  const s = starts ?? (await deriveStartsNative(cookie, workspaceId))
  const data = await scrape(cookie, workspaceId, s)
  if (data) cache.set(cacheKey(workspaceId, cookie, s), { at: Date.now(), data })
  return data
}

/**
 * 诊断专用：用原生 fetch 打一发 `go/status` 只为拿到三个窗口起点。
 * 失败返回 `{}`（诊断场景不值得为它加重试）。
 */
async function deriveStartsNative(cookie: string, orgId: string): Promise<ConsoleWindowStarts> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(`${CONSOLE_ORIGIN}${GO_STATUS_PATH}`, {
        headers: buildConsoleHeaders(cookie, orgId),
        signal: ctrl.signal
      })
      if (res.status !== 200) return {}
      const parsed = parseGoStatus(JSON.parse(await res.text()), Date.now())
      const out: ConsoleWindowStarts = {}
      for (const [kind, raw] of Object.entries(parsed.raw) as [ConsoleWindowKind, { startAt?: string }][]) {
        if (raw?.startAt) out[kind] = raw.startAt
      }
      return out
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return {}
  }
}

/** 清除缓存（凭据变更后调用）。在途请求也一并丢弃，不让旧 cookie 的结果回填。 */
export function invalidateConsoleDetails(): void {
  cache.clear()
  inflight.clear()
}
