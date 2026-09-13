// OpenCode Go 控制台 SSR 页面解析 + cookie 抓取路径。
// 逻辑移植自 dsh-opencode-go-usage（MIT）：
//   https://github.com/v587d/dsh-opencode-go-usage
//
// 用途：当 API Key 路径不可用（未配置 / 403 EntitlementError）时，
// 用浏览器会话 cookie 抓取控制台页面，解析出与控制台完全一致的
// 三个窗口百分比与重置倒计时。
//
// 页面：GET https://opencode.ai/workspace/<workspaceID>/go
// 每个窗口渲染为 <div data-slot="usage-item"> 块，内部包含：
//   data-slot="usage-label"   → 窗口名（"Rolling Usage" / "滚动用量"）
//   data-slot="usage-value"   → 整数百分比
//   data-slot="reset-time"    → "Resets in 2 hours 29 minutes" / "重置于 2 小时 29 分钟"

import type { ProviderWindow } from '../../shared/types'
import { markNetResult, assertNetAvailable } from '../net'

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

/** 用量金额的最小单位：SSR payload 里 `usage`/`limit` 为 1e-8 USD 的整数 */
export const USAGE_UNIT_SCALE = 1e8

/**
 * 控制台 SSR payload 里的原始窗口数据（比渲染文本更精确）。
 * 序列化形态示例：
 *   rollingUsage:$R[34]={status:"ok",resetInSec:16137,usagePercent:0.2,usage:2511472,limit:1200000000}
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

/** 从序列化字符串里取数值字段 */
function pickNum(body: string, key: string): number | undefined {
  const m = body.match(new RegExp(`${key}:\\s*(-?[\\d.]+)`))
  if (!m) return undefined
  const n = Number(m[1])
  return Number.isFinite(n) ? n : undefined
}

/** 从序列化字符串里取字符串字段 */
function pickStr(body: string, key: string): string | undefined {
  const m = body.match(new RegExp(`${key}:\\s*"([^"]*)"`))
  return m ? m[1] : undefined
}

/**
 * 从控制台页面 HTML 的 SolidStart 序列化 payload 里提取三个窗口的**精确**数据。
 * 这是比渲染文本（`data-slot="usage-value"`）更权威的来源：
 * 它同时给出 `usagePercent`（小数）与 `usage`/`limit`（真实美元，1e-8 单位）。
 */
export function parseUsagePayload(html: string): Partial<Record<UsageWindowKind, SsrRawWindow>> {
  const out: Partial<Record<UsageWindowKind, SsrRawWindow>> = {}
  for (const kind of ['rolling', 'weekly', 'monthly'] as UsageWindowKind[]) {
    // 兼容 `kindUsage:$R[12]={...}` 与 `kindUsage:{...}` 两种序列化形态
    const m = html.match(new RegExp(`${kind}Usage:\\s*(?:\\$R\\[\\d+\\]\\s*=\\s*)?\\{([^{}]*)\\}`))
    if (!m) continue
    const body = m[1]
    out[kind] = {
      status: pickStr(body, 'status'),
      usagePercent: pickNum(body, 'usagePercent'),
      usage: pickNum(body, 'usage'),
      limit: pickNum(body, 'limit'),
      resetInSec: pickNum(body, 'resetInSec')
    }
  }
  return out
}

// ─── SSR 解析（移植自 dsh-opencode-go-usage/src/api.ts）─────────────────────

interface SsrItem {
  label: string
  percent: number
  resetsIn: string
}

/** 从 SSR HTML 中提取三个窗口，失败返回空对象 */
export function parseUsageHtml(html: string): Partial<Record<UsageWindowKind, SsrUsageWindow>> {
  // 每个 usage-item 是 <div data-slot="usage-item">...</div> 块，内部可能嵌套 div。
  // 不尝试用正则匹配闭合标签，而是按连续起始标签切片，保留整块内容。
  const itemStartRe = /<div[^>]*data-slot="usage-item"/g
  const starts: number[] = []
  let m = itemStartRe.exec(html)
  while (m !== null) {
    starts.push(m.index)
    m = itemStartRe.exec(html)
  }

  const items: SsrItem[] = []
  for (let i = 0; i < starts.length; i++) {
    const block = html.slice(starts[i], starts[i + 1] ?? html.length)
    const labelMatch = block.match(/data-slot="usage-label"[^>]*>([^<]+)</)
    // 百分比可能是小数（如 "2.8%"），接受整数与小数两种形态
    const valueMatch = block.match(/data-slot="usage-value"[\s\S]*?<!--\$-->\s*(\d+(?:\.\d+)?)\s*<!--\/-->/)
    // 重置短语随 UI 语言：英文 "Resets in" / 中文 "重置于"
    const resetMatch = block.match(
      /data-slot="reset-time"[\s\S]*?(?:Resets in|重置于)(?:<!--\/-->\s*)?([\s\S]*?)(?:<!--\/-->|<\/span>)/
    )
    if (!labelMatch || !valueMatch) continue
    items.push({
      label: (labelMatch[1] ?? '').trim(),
      percent: Number.parseFloat(valueMatch[1] ?? '0'),
      resetsIn: resetMatch ? stripHtmlComments(resetMatch[1] ?? '').trim() : ''
    })
  }

  const out: Partial<Record<UsageWindowKind, SsrUsageWindow>> = {}
  for (const item of items) {
    const kind = labelToKind(item.label)
    if (!kind) continue
    out[kind] = {
      kind,
      percent: clampPercent(item.percent),
      resetInSec: parseDurationToSec(item.resetsIn),
      status: item.percent >= 100 ? 'rate-limited' : 'ok'
    }
  }
  return out
}

function labelToKind(label: string): UsageWindowKind | undefined {
  const lower = label.toLowerCase()
  if (lower.startsWith('rolling')) return 'rolling'
  if (lower.startsWith('weekly')) return 'weekly'
  if (lower.startsWith('monthly')) return 'monthly'
  // 中文标签（zh locale）：滚动用量 / 每周用量 / 每月用量
  if (lower.startsWith('滚动')) return 'rolling'
  if (lower.startsWith('每周')) return 'weekly'
  if (lower.startsWith('每月')) return 'monthly'
  return undefined
}

function stripHtmlComments(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, '').trim()
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0
  // 保留一位小数（控制台可能显示 2.8% 这类精度）
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10))
}

/**
 * 把人类短语解析为秒数，中英文都支持：
 *   "2 hours 29 minutes" → 8940    "2 小时 29 分钟" → 8940
 *   "5 days" → 432000              "30 seconds" → 30
 *   "1 week" → 604800              "1 month" → 2592000
 */
export function parseDurationToSec(phrase: string): number {
  if (!phrase) return 0
  const cleaned = phrase.replace(/<!--[\s\S]*?-->/g, ' ')
  const p = cleaned.trim().replace(/\s+/g, ' ').toLowerCase()
  if (!p) return 0
  const re = /(\d+)\s*(?:个\s*)?(second|minute|hour|day|week|month|year|秒|分钟|小时|天|周|月|年)s?/g
  let total = 0
  let matched = false
  let m = re.exec(p)
  while (m !== null) {
    const n = Number.parseInt(m[1] ?? '0', 10)
    const unit = m[2] ?? ''
    matched = true
    switch (unit) {
      case 'second':
      case '秒':
        total += n
        break
      case 'minute':
      case '分钟':
        total += n * 60
        break
      case 'hour':
      case '小时':
        total += n * 3600
        break
      case 'day':
      case '天':
        total += n * 86400
        break
      case 'week':
      case '周':
        total += n * 604800
        break
      case 'month':
      case '月':
        total += n * 2592000 // 30 天（粗粒度，展示足够）
        break
      case 'year':
      case '年':
        total += n * 31536000
        break
    }
    m = re.exec(p)
  }
  return matched ? total : 0
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
  /** SSR payload 里的精确数据（usage/limit 为 1e-8 USD） */
  raw: Partial<Record<UsageWindowKind, SsrRawWindow>>
  /** 抓取成功的时刻 */
  fetchedAt: number
}

/**
 * 用 cookie 抓取控制台页面并解析。任何失败都抛 Error（消息不含 cookie）。
 * 页面在 cookie 失效时 302 到登录页，登录页解析为空 → 抛 'cookie 已过期或无效'。
 */
export async function fetchUsageViaCookie(
  cookie: string,
  workspaceID: string,
  baseUrl = 'https://opencode.ai',
  timeoutMs = 12_000
): Promise<CookieFetchResult> {
  const normalized = normalizeCookie(cookie)
  if (!normalized) throw new Error('Cookie 格式无效：未找到 auth= 段')
  if (!workspaceID.trim()) throw new Error('未配置 Workspace ID')

  const url = `${baseUrl.replace(/\/+$/, '')}/workspace/${encodeURIComponent(workspaceID.trim())}/go`
  assertNetAvailable()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Cookie: normalized, Accept: 'text/html' },
      signal: ctrl.signal
    })
    // 拿到响应即说明网络可达（4xx/5xx 属于凭据/服务问题，不算离线）
    markNetResult(true)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    const windows = parseUsageHtml(html)
    const raw = parseUsagePayload(html)
    if (!windows.rolling && !windows.weekly && !windows.monthly && !raw.rolling && !raw.weekly && !raw.monthly) {
      throw new Error('用量页面解析为空（cookie 已过期或无效？）')
    }
    return { windows, raw, fetchedAt: Date.now() }
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      markNetResult(false, e)
      throw new Error(`请求超时（${timeoutMs}ms）`)
    }
    markNetResult(false, e)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 把 cookie 路径的窗口转成 ProviderWindow。
 *  官方限额以美元定义，used = percent × limit 即服务端口径花费（权威）；
 *  tokens 由调用方用本机数据在窗口内补充（官方不提供）。 */
export function cookieWindowsToProvider(
  windows: Partial<Record<UsageWindowKind, SsrUsageWindow>>,
  nowMs: number,
  limits: { fiveHour: number; weekly: number; monthly: number }
): ProviderWindow[] {
  const limitFor: Record<UsageWindowKind, number> = {
    rolling: limits.fiveHour,
    weekly: limits.weekly,
    monthly: limits.monthly
  }
  const order: UsageWindowKind[] = ['rolling', 'weekly', 'monthly']
  const out: ProviderWindow[] = []
  for (const kind of order) {
    const w = windows[kind]
    if (!w) continue
    const limit = limitFor[kind]
    const resetInMs = w.resetInSec > 0 ? w.resetInSec * 1000 : 0
    // 5h 窗口 percent=0 且倒计时≈5h：占位值，当前无活跃窗口
    const isIdle = kind === 'rolling' && w.percent === 0 && resetInMs > 0 && Math.abs(resetInMs - WINDOW_SPANS.rolling) < 120_000
    out.push({
      name: WINDOW_NAMES[kind],
      used: (w.percent / 100) * limit,
      limit,
      unit: 'usd',
      percent: w.percent,
      resetAt: resetInMs > 0 && !isIdle ? new Date(nowMs + resetInMs).toISOString() : undefined,
      note: w.status === 'rate-limited' ? '已触发限流' : isIdle ? '当前无活跃窗口' : '控制台 cookie'
    })
  }
  return out
}
