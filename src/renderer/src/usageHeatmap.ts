// ═══════════════════════════════════════════════════════════════════════════════
// 用量热力图的**纯函数**：把「每天末值」桶算成「每天增量」格
//
// 纯函数模块（无 electron / 无 DOM / 无 React / 不读自己的钟），
// scripts/test-usage-heatmap.mjs 经 loadTs 加载本文件跑真源码。`now` 不需要 ——
// 输入已经是按日历日分好的桶（usageHistory.bucketByDay），这里只做桶间差分。
//
// 三条不可让步的纪律（每条下面都有断言钉住）：
//   1. 缺样本的天**不补 0**：cur 或 prev 任一未知 → delta = null → 空格。
//      用 0 补会让「应用没跑」看上去像「那天没用」，与 usageHistory 同一条诚实纪律。
//   2. 窗口重置天不断 streak：cur < prev 即视为重置（用量不会自己下降），
//      delta = cur（新周期当天的增量），而不是负数。负增量会把重置那天判成「倒退」,
//      紧接着的 streak 就全断了。
//   3. 强度分档是**相对**的：maxDelta 取本轮 active 窗口的最大 delta，不跨窗口比。
//      绝对阈值（如 10pp 一档）会让小额度窗口永远最浅、大窗口永远最深。
// ═══════════════════════════════════════════════════════════════════════════════

import type { Unit } from '../../shared/types'
import type { DayBucket } from './usageHistory'

/** 热力图的一格：一天 */
export interface HeatDay {
  /** 本地日历日 'YYYY-MM-DD'（与 DayBucket 同口径） */
  day: string
  /** 当天末值 pct；未知 = null → 空格 */
  lastPct: number | null
  /** 当天日增量（百分点）；未知 = null → 空格；重置天 = cur 本身 */
  deltaPp: number | null
  /**
   * 当天**绝对**用量增量。口径与 `deltaPp` 完全一致（reset 感知）：
   * `cur < prev` 视为换周期，delta = cur 本身而不是负数。
   * `null` = 无法算（首日无基准，或那天没记绝对量）。
   */
  deltaUsed: number | null
  /** 当天末值对应的**累计**绝对用量（窗口周期内）；用于 tooltip 与首日回退 */
  lastUsed: number | null
  /** `deltaUsed` / `lastUsed` 的单位；缺失时调用方显示「—」 */
  unit?: Unit
}

/** 强度档：0 = 空格（无数据），1 = 持平/零增量，2/3/4 = 由浅到深 */
export type Intensity = 0 | 1 | 2 | 3 | 4

/** `pct` 可知才算数：null / 非有限数一律视为「没采到」（与 usageHistory 同口径） */
function known(p: number | null): p is number {
  return typeof p === 'number' && Number.isFinite(p)
}

/**
 * 桶序列 → 热力格序列。
 *
 * 第一格没有前一天可比，deltaPp 恒为 null（不是 0 —— 「刚开始记录」不是「这天没用」）。
 * 入参不被就地修改：只读遍历，返回新数组。
 */
export function heatmapOf(buckets: DayBucket[]): HeatDay[] {
  const out: HeatDay[] = []
  let prev: number | null = null
  let prevUsed: number | null = null
  for (const b of buckets ?? []) {
    if (!b || typeof b.day !== 'string') continue
    const cur = known(b.lastPct) ? (b.lastPct as number) : null
    let delta: number | null = null
    if (cur != null && prev != null) {
      delta = cur < prev ? cur : cur - prev
    }
    // 绝对量走**同一条** reset 口径：used < prevUsed 必是换周期（用量不会自己下降），
    // 那天用量就是 cur 本身而不是负数。两条口径必须一致，否则会出现「热力图这天最深、
    // 明细这天用量是负的」这种自相矛盾的显示。
    const cu = known(b.lastUsed) ? (b.lastUsed as number) : null
    let deltaUsed: number | null = null
    if (cu != null && prevUsed != null) {
      deltaUsed = cu < prevUsed ? cu : cu - prevUsed
    }
    out.push({
      day: b.day,
      lastPct: cur,
      deltaPp: delta,
      deltaUsed,
      lastUsed: cu,
      unit: b.unit
    })
    // 缺样本天不更新 prev / prevUsed：前后两天的差分都保持 null，
    // 而不是把「没采到」当成 0 去和邻居相减。
    if (cur != null) prev = cur
    if (cu != null) prevUsed = cu
  }
  return out
}

/** 本轮格序列的最大 delta（强度分档的相对标尺）；没有正增量 → 0 */
export function maxDelta(days: HeatDay[]): number {
  let m = 0
  for (const d of days ?? []) {
    if (d && typeof d.deltaPp === 'number' && Number.isFinite(d.deltaPp) && d.deltaPp > m) m = d.deltaPp
  }
  return m
}

/**
 * 增量 → 强度档。
 *
 * null → 0（空格）；<=0 → 1（有记录但没涨）；正增量按 max 的三分位落 2/3/4。
 * max 不合法（<=0 / 非有限）时正增量落 2 —— 「有增量」至少比「没增量」深一档，
 * 而不是因为标尺坏了就回空格。
 */
export function intensityOf(delta: number | null, max: number): Intensity {
  if (typeof delta !== 'number' || !Number.isFinite(delta)) return 0
  if (delta <= 0) return 1
  if (!(max > 0) || !Number.isFinite(max)) return 2
  if (delta <= max / 3) return 2
  if (delta <= (max * 2) / 3) return 3
  return 4
}

export interface Streak {
  /** 截至最后一格连续 delta>0 的天数；遇 null/<=0 即断 */
  streak: number
  /** lastPct 可知的天数（「N 天有记录」） */
  sampledDays: number
  /** 最后一格的 delta（徽标用）；null 时调用方改显示末值 */
  todayDelta: number | null
  /** 最后一格的末值（徽标回退用） */
  todayPct: number | null
}

/**
 * streak 统计：只看格序列的尾巴。
 *
 * 空输入 → 全零（调用方据此不画头，而不是画「0 连击」）。
 */
export function streakOf(days: HeatDay[]): Streak {
  let sampledDays = 0
  for (const d of days ?? []) {
    if (d && known(d.lastPct)) sampledDays++
  }
  let streak = 0
  for (let i = (days ?? []).length - 1; i >= 0; i--) {
    const d = (days as HeatDay[])[i]
    if (!d || typeof d.deltaPp !== 'number' || !Number.isFinite(d.deltaPp) || d.deltaPp <= 0) break
    streak++
  }
  const last = (days ?? []).length > 0 ? (days as HeatDay[])[(days as HeatDay[]).length - 1] : null
  return {
    streak,
    sampledDays,
    todayDelta: last && typeof last.deltaPp === 'number' && Number.isFinite(last.deltaPp) ? last.deltaPp : null,
    todayPct: last && known(last.lastPct) ? (last.lastPct as number) : null
  }
}
