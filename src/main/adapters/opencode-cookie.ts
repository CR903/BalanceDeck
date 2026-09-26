// OpenCode Go 控制台「配额窗口」读取路径（cookie 会话）。
//
// 用途：当 API Key 路径不可用（未配置 / 403 EntitlementError）时，
// 用浏览器会话 cookie 读控制台自己的接口，取与控制台完全一致的
// 三个窗口百分比与重置倒计时。
//
// ── 2026-09-26 改版：从 SSR 页面抓取 换成 控制台自己的 JSON API ──────────────
// 旧实现 GET `https://opencode.ai/workspace/<id>/go` 并解析 SSR HTML 里的
// `data-slot="usage-item"`。控制台重写成纯客户端 SPA 后这条路死了：
//   · `/workspace/<id>/go` → 302 `/console/login`
//   · `/console/workspace/<id>/go` → 200 但只有 1565 字符空壳、**0 个 data-slot**
// 新端点是实测出来的（带有效会话打开 Go 页抓它自己的请求）：
//   GET /console/api/go/status   必需 x-org-id，缺则 400 `org_required`
//   → access.meters.{fiveHour,week,month}
// 金额是**微美分级字符串**（1 USD = 1e8 microcents），与旧 SSR 的
// `usage`/`limit` 同尺度，所以下游换算一行都不用改。
//
// 这个改法还推翻了本文件原来的一条设计判断：旧注释论证「与其逆向 RPC 协议，
// 不如解析页面 DOM，对站点改版更鲁棒」。改版把 DOM 一起换掉时，DOM 鲁棒论
// 失效；而数据端点反倒在公开 bundle 里带 OpenAPI 声明标了 stable。
//
// 逻辑移植自 dsh-opencode-go-usage（MIT）的 cookie 规范化部分：
//   https://github.com/v587d/dsh-opencode-go-usage

import {
  CONSOLE_ORIGIN,
  GO_STATUS_PATH,
  METER_FIELDS,
  PERIOD_END_RESET_FIELDS,
  buildConsoleHeaders,
  classifyConsoleStatus,
  consoleAuthMessage
} from './opencode-console-api'
import type { CollectContext } from './types'

export type UsageWindowKind = 'rolling' | 'weekly' | 'monthly'

export interface SsrUsageWindow {
  kind: UsageWindowKind
  /** 0–100 整数百分比 */
  percent: number
  /** 距重置的秒数（页面只提供粗粒度短语） */
  resetInSec: number
  status: 'ok' | 'rate-limited'
}

/** 窗口跨度（ms），用于从 resetAt 反推窗口起点 */
export const WINDOW_SPANS: Record<UsageWindowKind, number> = {
  rolling: 5 * 3600_000,
  weekly: 7 * 86400_000,
  monthly: 30 * 86400_000
}

/** 窗口显示名（与官方 API 路径保持一致） */
export const WINDOW_NAMES: Record<UsageWindowKind, string> = {
  rolling: '5 小时',
  weekly: '本周',
  monthly: '本月'
}

/**
 * 用量金额的最小单位：`go/status` 与 `usage/models` 的 `*MicroCents` 为 1e-8 USD 的整数字符串。
 * 唯一定义在 ./opencode-console-api —— 这里**转发**而非重定义（两份会漂）。
 * 转发是为了不改下游的 import 路径。
 */
export { USAGE_UNIT_SCALE } from './opencode-console-api'

/**
 * 控制台接口里的原始窗口数据（比渲染文本更精确）。
 * 现由 `parseGoStatus` 产出，字段与旧 SSR 版本保持一致，下游零改动。
 */
export interface SsrRawWindow {
  status?: string
  /** 精确百分比（可含小数） */
  usagePercent?: number
  /** 已用金额（1e-8 USD） */
  usage?: number
  /** 配额金额（1e-8 USD） */
  limit?: number
  resetInSec?: number
}


// ─── `go/status` 响应解析 ─────────────────────────────────────────────────────

/** 微美分级字符串 → 数字。端点把所有金额都发成字符串（避免 JS 精度丢失）。 */
function microCents(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v !== 'string' || v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** ISO 时间 → 距今秒数。缺字段（`month` 没有 `resetsAt`）返回 undefined。 */
function secondsUntil(iso: unknown, nowMs: number): number | undefined {
  if (typeof iso !== 'string' || !iso) return undefined
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return undefined
  return Math.round((t - nowMs) / 1000)
}

export interface GoStatusParse {
  windows: Partial<Record<UsageWindowKind, SsrUsageWindow>>
  raw: Partial<Record<UsageWindowKind, SsrRawWindow>>
  /**
   * 认不出的 meter 字段名 —— 站点改版时的早期信号。
   * 非空就说明 `METER_FIELDS` 需要更新，要打日志（别静默返回空：那会让
   * 快照悄悄退回本机估算，而界面看不出任何异常）。
   */
  unknownMeters: string[]
}

/**
 * 解析 `GET /console/api/go/status` 的响应。
 *
 * 真实响应（2026-09-26 实测，已脱敏）：
 * ```json
 * { "product": "go",
 *   "access": {
 *     "endsAt": "2026-10-21T01:25:47.000Z",
 *     "meters": {
 *       "fiveHour": { "startsAt": "…", "resetsAt": "2026-09-26T15:22:41.617Z",
 *                     "limitMicroCents": "1200000000", "usedMicroCents": "52000" },
 *       "week":     { "startsAt": "…", "resetsAt": "2026-09-28T00:00:00.000Z",
 *                     "limitMicroCents": "3000000000", "usedMicroCents": "505884411" },
 *       "month":    { "limitMicroCents": "6000000000", "usedMicroCents": "505884411" }
 * } } }
 * ```
 *
 * 三个要点：
 *  1. **限额由服务端下发**（`limitMicroCents`），不再依赖代码里硬编码的 $12/$30/$60。
 *  2. `month` **没有 `resetsAt`** —— 它的重置时间等于订阅周期末 `access.endsAt`。
 *     实测核对：`endsAt` 减当时 = 24 天 10 小时 41 分，与控制台页面显示的
 *     "Monthly usage … Resets in 24d 10h" 吻合。
 *  3. 金额是 1e-8 USD 尺度（microcents），与旧 SSR 的 `usage`/`limit` 同尺度。
 */
export function parseGoStatus(body: unknown, nowMs: number): GoStatusParse {
  const out: GoStatusParse = { windows: {}, raw: {}, unknownMeters: [] }
  if (!body || typeof body !== 'object') return out
  const access = (body as { access?: unknown }).access
  if (!access || typeof access !== 'object') return out
  const meters = (access as { meters?: unknown }).meters
  if (!meters || typeof meters !== 'object') return out

  const periodEndSec = secondsUntil((access as { endsAt?: unknown }).endsAt, nowMs)
  // 注意取 **键**（接口里的 meter 字段名），不是值（我们的窗口名）。
  // 取错了会把 fiveHour/week/month 全判成"未知计费项"——2026-09-26 就踩过这个。
  const known = new Set<string>(Object.keys(METER_FIELDS))

  for (const [field, value] of Object.entries(meters as Record<string, unknown>)) {
    if (!known.has(field)) {
      out.unknownMeters.push(field)
      continue
    }
    const kind = METER_FIELDS[field as keyof typeof METER_FIELDS]
    if (!value || typeof value !== 'object') continue
    const m = value as { limitMicroCents?: unknown; usedMicroCents?: unknown; resetsAt?: unknown }

    const limit = microCents(m.limitMicroCents)
    const usage = microCents(m.usedMicroCents)
    if (limit === undefined && usage === undefined) continue

    // month 没有 resetsAt，回落到订阅周期末（实测与页面显示一致）
    const resetInSec = secondsUntil(m.resetsAt, nowMs) ?? (PERIOD_END_RESET_FIELDS.has(field) ? periodEndSec : undefined)
    const usagePercent = limit !== undefined && limit > 0 && usage !== undefined ? (usage / limit) * 100 : undefined

    // 算不出百分比时**不能报 0%**。
    // 那会让界面显示「已用 $5.06 / 配额 $30 · 0%」—— 花了钱却显示 0%，是撒谎。
    // 做法：raw 照留（金额是真的），但不产出 `windows[kind]`，
    // 于是下游 `renderedPct` 为 null，优先级链会落到别的来源（官方 API），
    // 实在没别的来源时由 opencode.ts 给出「百分比不可用」的提示。
    if (usagePercent === undefined && (usage ?? 0) > 0) {
      out.raw[kind] = { status: 'percent-unavailable', usage, limit, resetInSec }
      continue
    }

    const pct = usagePercent === undefined ? 0 : Math.max(0, Math.min(100, Math.floor(usagePercent)))
    out.raw[kind] = { status: pct >= 100 ? 'rate-limited' : 'ok', usagePercent, usage, limit, resetInSec }
    out.windows[kind] = {
      kind,
      percent: pct,
      // 0 的含义是"重置时间未知"（month 无 resetsAt 且无 endsAt 时）。
      // 下游都判 `> 0` 才用，所以 0 = 倒计时不显示，而不是"还有 0 秒"。
      resetInSec: resetInSec ?? 0,
      status: pct >= 100 ? 'rate-limited' : 'ok'
    }
  }
  return out
}

// ─── Cookie 规范化（移植自 dsh-opencode-go-usage/src/config.ts）──────────────

/**
 * 规范化用户粘贴或抓取到的 cookie：
 *  - 解析所有 `name=value` 段（保留全部有效 cookie —— 浏览器就是全发的，
 *    只留 auth/oc_locale 会在站点新增依赖 cookie 时失效）
 *  - 定位 `auth=` 段（顺序无关）；裸 token 自动补 `auth=`
 *  - `oc_locale` 非法/缺失时补 `en`
 *  - 无 auth 段返回 null（拒绝持久化坏 cookie）
 */
export function normalizeCookie(input: string | undefined | null): string | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null

  const segments = trimmed.split(/[;\n]/).map((s) => s.trim()).filter(Boolean)
  const pairs = new Map<string, string>()
  for (const seg of segments) {
    const i = seg.indexOf('=')
    if (i <= 0) continue
    const name = seg.slice(0, i).trim()
    const value = seg.slice(i + 1).trim().replace(/^"|"$/g, '')
    if (!name || !value) continue
    // cookie 名只允许 token 字符（挡掉粘贴进来的注释/垃圾）
    if (!/^[\w.\-]+$/.test(name)) continue
    pairs.set(name, value)
  }

  // 裸 token（无 '=' 且长度足够）视为 auth 值
  if (!pairs.has('auth')) {
    const bare = segments.find((s) => !s.includes('=') && s.length >= 8)
    if (bare) pairs.set('auth', bare)
  }
  if (!pairs.has('auth') || !pairs.get('auth')) return null

  const locale = pairs.get('oc_locale')
  if (!locale || !/^[A-Za-z]{2,3}$/.test(locale)) pairs.set('oc_locale', 'en')

  return [...pairs.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

// ─── 抓取 ───────────────────────────────────────────────────────────────────

export interface CookieFetchResult {
  windows: Partial<Record<UsageWindowKind, SsrUsageWindow>>
  /** 接口里的精确数据（usage/limit 为 1e-8 USD 尺度） */
  raw: Partial<Record<UsageWindowKind, SsrRawWindow>>
  /** 抓取成功的时刻 */
  fetchedAt: number
  /**
   * 认不出的 meter 字段名（站点改版的早期信号）。
   * 非空说明端点结构变了 —— 上层应把它显示出来，别让快照静悄悄退回本机估算。
   */
  unknownMeters: string[]
}

/**
 * 用 cookie 读控制台的配额窗口（`GET /console/api/go/status`）并解析。
 * 任何失败都抛 Error（消息不含 cookie）。
 *
 * 错误分类刻意分三档，因为它们要**不同的用户动作**：
 *  · 401 → 会话没了，要用户点「一键授权」
 *  · 400 `org_required` → 缺 workspace id，要重新授权让它被发现
 *  · 其它非 2xx → 这条路暂时不通，够不着但不是用户能修的
 * 旧的笼统文案「cookie 已过期或无效」让用户看不出该做什么，已删除。
 */
export async function fetchUsageViaCookie(
  ctx: CollectContext,
  cookie: string,
  workspaceID: string,
  baseUrl = CONSOLE_ORIGIN,
  timeoutMs = 12_000
): Promise<CookieFetchResult> {
  const normalized = normalizeCookie(cookie)
  if (!normalized) throw new Error('Cookie 格式无效：未找到 auth= 段')
  const orgId = workspaceID.trim()
  if (!orgId) throw new Error('未配置 Workspace ID（请重新授权以自动发现）')

  const url = `${baseUrl.replace(/\/+$/, '')}${GO_STATUS_PATH}`
  try {
    // 出网、超时与可达性记账都由注入的能力负责（生产实现见 src/main/request.ts）——
    // 这里曾经自己 fetch 并直接 import ../net，那条依赖让整个 opencode 家族无法被单测加载。
    const res = await ctx.request({ url, headers: buildConsoleHeaders(normalized, orgId), timeoutMs })
    // 拿到响应即说明网络可达（4xx/5xx 属于凭据/服务问题，不算离线）
    if (res.status < 200 || res.status >= 300) {
      const auth = classifyConsoleStatus(res.status)
      const hint = consoleAuthMessage(auth)
      if (hint) throw new Error(hint)
      if (res.status === 400 && /org_required/.test(res.text)) {
        throw new Error('控制台要求指定工作区，但当前 workspace id 无效（请重新授权）')
      }
      throw new Error(`控制台接口返回 HTTP ${res.status}`)
    }

    let body: unknown
    try {
      body = JSON.parse(res.text)
    } catch {
      throw new Error('控制台接口返回的不是 JSON（站点可能改版或返回了错误页）')
    }

    const parsed = parseGoStatus(body, Date.now())
    const has = parsed.windows.rolling || parsed.windows.weekly || parsed.windows.monthly
    if (!has) {
      // 结构变了（METER_FIELDS 对不上）比"会话失效"更可能是原因，所以要说清楚
      throw new Error(
        parsed.unknownMeters.length
          ? `控制台接口结构已变（出现未知计费项：${parsed.unknownMeters.join(', ')}）`
          : '控制台接口未返回任何计费窗口（会话可能已失效，请重新授权）'
      )
    }
    return { ...parsed, fetchedAt: Date.now() }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`请求超时（${timeoutMs}ms）`)
    throw e
  }
}
