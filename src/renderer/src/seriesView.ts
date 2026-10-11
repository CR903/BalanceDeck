// ═══════════════════════════════════════════════════════════════════════════════
// 用量趋势的「窗口驱动序列视图」—— **纯函数**模块
//
// 纯函数（无 electron / 无 DOM / 无 React / 不读自己的钟），`now` 一律由调用方传入。
//
// 口径：趋势不再是日历热力图，而是「窗口驱动的时间序列」——
//   · 官方数据（`usage/cost-by-day`）直接给桶（小时/日），本模块只做展示归一化；
//   · 官方不可达时退回本机采样（`usagePredict` 历史），按窗口粒度（5 小时→小时、
//     周/月→日）分桶，用窗口内累计 used 的**重置感知增量**估每桶花费，并显式标注
//     「本机估算」（标注在渲染层，本模块只给 `source` 的判据）。
//
// 三条不可让步的纪律：
//   1. 官方没有该窗口的序列（key 缺失）才退回本机；官方给了空数组是「该窗口无用量」，
//      不退回 —— 否则会把「官方确认没用」误标成「本机估算」。
//   2. 本机算不出的桶（首桶无基准 / 缺采样）cost = null → 显示「—」，**不补 0**。
//   3. 节点顺序 = 时间升序（图从左到右），记录表由渲染层反转成新近优先。
// ═══════════════════════════════════════════════════════════════════════════════

import type { UsageBucket } from '../../shared/types'
import type { UsagePoint } from '../../shared/usage-predict'
import { bucketByDay, bucketByHour } from './usageHistory'

export type SeriesGranularity = 'hour' | 'day'

/** 窗口名 → 序列粒度（与官方 `cost-by-day` 的 bucket 对齐） */
export const SERIES_GRANULARITY: Record<string, SeriesGranularity> = {
  '5 小时': 'hour',
  '本周': 'day',
  '本月': 'day'
}

/** 本机兜底时的窗口回看跨度（与 opencode 适配器 LOCAL_LIMITS/WINDOW_SPANS 同口径） */
export const LOCAL_SPAN_MS: Record<string, number> = {
  '5 小时': 5 * 3600_000,
  '本周': 7 * 86400_000,
  '本月': 30 * 86400_000
}

const DAY_MS = 86_400_000

/** 序列的一个节点（图的一根柱 + 记录表的一行） */
export interface SeriesNode {
  /** 桶起点（ISO）；React key 用 */
  t: string
  /** 展示标签：小时桶 'HH:00'，日桶 'MM-DD 周X'（本地时区） */
  label: string
  /** 该桶花费（USD）；null = 本机算不出 → 显示「—」 */
  cost: number | null
  /** 该桶 tokens（官方口径）；本机兜底恒 0 */
  tokens: number
  /** 该桶请求数（官方口径）；本机兜底恒 0 */
  requests: number
}

export function granularityOf(windowName: string): SeriesGranularity {
  return SERIES_GRANULARITY[windowName] ?? 'day'
}

const WEEKDAYS = '一二三四五六日'

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 桶起点 → 展示标签。小时桶 `HH:00`；日桶 `MM-DD 周X`。非法时间原样回显 */
export function nodeLabel(t: string, granularity: SeriesGranularity): string {
  const d = new Date(t)
  if (!Number.isFinite(d.getTime())) return t
  if (granularity === 'hour') return `${pad2(d.getHours())}:00`
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} 周${WEEKDAYS[(d.getDay() + 6) % 7]}`
}

/** 官方桶 → 节点（`UsageBucket` 已经是 USD，直接搬运） */
export function officialSeriesNodes(buckets: UsageBucket[]): SeriesNode[] {
  return (buckets ?? []).map((b) => ({
    t: b.t,
    label: nodeLabel(b.t, b.bucket),
    cost: Number.isFinite(b.cost) ? b.cost : null,
    tokens: Number.isFinite(b.tokens) ? b.tokens : 0,
    requests: Number.isFinite(b.requests) ? b.requests : 0
  }))
}

/** 'YYYY-MM-DD'（本地日）→ 本地零点的 ISO */
function dayToIso(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return day
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isFinite(d.getTime()) ? d.toISOString() : day
}

/**
 * 本机采样 → 节点（官方不可达时的降级路径）。
 *
 * 每桶的花费 = 该桶末尾累计 `used` 相对上一桶的**重置感知增量**（`cur < prev` 即换周期，
 * 取 `cur` 本身）。首桶没有基准 → cost = null（不补 0）。tokens / requests 本机没有 → 0。
 */
export function localSeriesNodes(points: UsagePoint[], windowName: string, now: number): SeriesNode[] {
  const gran = granularityOf(windowName)
  const spanMs = LOCAL_SPAN_MS[windowName] ?? 30 * DAY_MS

  // 统一成「每桶末尾累计 used」序列
  const raw: { t: string; lastUsed: number | null }[] =
    gran === 'hour'
      ? bucketByHour(points ?? [], Math.max(1, Math.round(spanMs / 3600_000)), now)
      : bucketByDay(points ?? [], Math.max(1, Math.round(spanMs / DAY_MS)), now).map((b) => ({
          t: dayToIso(b.day),
          lastUsed: b.lastUsed
        }))

  const out: SeriesNode[] = []
  let prev: number | null = null
  for (const b of raw) {
    const cur = b.lastUsed
    let cost: number | null = null
    if (cur != null && prev != null) cost = cur < prev ? cur : cur - prev
    out.push({ t: b.t, label: nodeLabel(b.t, gran), cost, tokens: 0, requests: 0 })
    if (cur != null) prev = cur
  }
  return out
}

/** 节点里的最大花费（柱高标尺）；没有任何已知花费 → 0 */
export function maxCostOf(nodes: SeriesNode[]): number {
  let m = 0
  for (const n of nodes) {
    if (n.cost != null && Number.isFinite(n.cost) && n.cost > m) m = n.cost
  }
  return m
}
