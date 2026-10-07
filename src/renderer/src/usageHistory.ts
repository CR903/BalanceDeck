// ═══════════════════════════════════════════════════════════════════════════════
// 用量趋势的**纯函数**：把本机快照的原始采样序列聚合成「每天一根柱」
//
// 纯函数模块（无 electron / 无 DOM / 无 React / 不读自己的钟），scripts/test-usage-history.mjs
// 经 loadTs 加载本文件跑真源码。`now` 一律由调用方传入 —— 缺了这条，「同一天」就成了
// 运行环境的函数，测试与生产会对不上（usageStore 的 dayKey 是同一纪律）。
//
// 为什么单独一个文件而不是塞进 usagePredict.ts：预测要的是「速率 → 什么时候用完」，
// 趋势图要的是「哪天是几 %」。两者连口径都不共享（预测按重置点切段，趋势图按日历日分桶），
// 混在一个模块里会让「估算」与「绘图」两件不相干的事互相牵连。
//
// 三条不可让步的纪律（每条下面都有断言钉住）：
//   1. 每根柱 = 那天**最后一个已知** pct。末尾可能是采样失败记下的 null —— 要跳过它
//      继续往前找，**不是**取数组最后一个，也**不是**按 0 处理。
//   2. 缺样本的天**不补 0**，桶还在但 lastPct = null → 不画柱（缺口可见）。用 0 补齐的话，
//      用户会看到「那 5 天用量是 0」并据此得出「我这几天没用」的错误结论，而真实原因是
//      **采集没跑**（type-safety 第 2 条：缺失值必须保持缺失）。
//   3. 纵轴固定 0..100，**不随数据缩放**。否则「上周 90%、本周 20%」两张图形状一样。
// ═══════════════════════════════════════════════════════════════════════════════

import type { UsagePoint } from '../../shared/usage-predict'
import type { Unit } from '../../shared/types'

/** 一次取回的历史里，两个视图共用的上限（`sample:usageHistoryDays` 默认 30） */
export const TREND_MAX_DAYS = 30

export interface DayBucket {
  /** 本地日历日 'YYYY-MM-DD' */
  day: string
  /** 该天最后一个**已知** pct（末尾是 null 时不取它）；无已知值 = null → 不画柱 */
  lastPct: number | null
  /** 该天峰值（画柱内高亮 / 参考线用）；无已知值 = null */
  maxPct: number | null
  /**
   * 该天最后一个**已知**绝对用量（窗口周期内累计）。
   * `null` = 那天没记到（升级前的旧采样，或采样本身没有这个字段）—— **不是 0**。
   */
  lastUsed: number | null
  /** `lastUsed` 的单位；必须成对，缺了单位那个数没法解释 */
  unit?: Unit
}

// ─── 日历日 ───────────────────────────────────────────────────────────────────

/**
 * 本地时区的 `YYYY-MM-DD`。
 *
 * 刻意与 `usageStore.dayKey` 同一口径（同一条纪律的两处实现）：用户的心智是「今天」，
 * 跨时区切成 UTC 日会在每天早上把最近 8 小时的采样归到「昨天」，于是日分桶名不副实。
 */
export function dayKey(t: number): string {
  const d = new Date(t)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * 「回看 days 天」对应的最早分桶键。
 *
 * 用**日历**减法（`new Date(y, m, d - n)`）而不是 `now - n * 86400_000`：后者跨夏令时会差出
 * 一个小时，恰好把边界那一天算进或漏掉。日历减法交给 Date 自己处理。
 * 零填充的 `YYYY-MM-DD` 字典序即时间序，所以边界就是一次字符串比较。
 */
export function cutoffDayKey(now: number, days: number): string {
  const d = new Date(now)
  return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1)).getTime())
}

// ─── 按天分桶 ─────────────────────────────────────────────────────────────────

/** `pct` / `used` 可知才算数：null / undefined / 非有限数一律视为「没采到」 */
function known(p: number | null | undefined): p is number {
  return typeof p === 'number' && Number.isFinite(p)
}

/** 归一到某个刻度的天数（脏值落向 1，不落向「不画」） */
function spanOf(days: number): number {
  return typeof days === 'number' && Number.isFinite(days) && days >= 1 ? Math.floor(days) : 1
}

/**
 * 按**本地日历日**把采样聚合成「每天一根柱」。
 *
 * 桶的天数 = 从**第一天有采样**到今天，两头都被可见天数夹住。所以：
 *   · 刚装 2 天 → 2~3 个桶（**不**为了好看伪造 30 天空柱）；
 *   · 中间断采 5 天 → 断档那几天**仍有桶**但 `lastPct = null` → 不画柱 → 缺口可见，
 *     而这正是「那天应用没跑」的诚实表达；
 *   · 窗口之外（比 cutoff 更早）的点直接丢掉。
 *
 * ⚠ 入参**不被就地修改**：只读遍历 + 复制成新数组再排序（见下面「末值」那条）。
 *
 * 空历史 → `[]`（而不是 30 个空桶）：调用方据此「什么都不显示」，而不是画一张 30 天全空的图。
 */
export function bucketByDay(points: UsagePoint[], days: number, now: number): DayBucket[] {
  const span = spanOf(days)
  const cut = cutoffDayKey(now, span)

  // 复制后排序：入参是 IPC 过来的对象数组，「最后一个已知值」必须按**时刻**判定而不是按
  // 数组位置 —— 复制这一步同时保证了就地修改不可能发生
  const inRange: UsagePoint[] = []
  for (const p of points ?? []) {
    if (!p || typeof p.t !== 'number' || !Number.isFinite(p.t)) continue
    if (dayKey(p.t) < cut) continue
    inRange.push({ t: p.t, pct: p.pct, used: p.used, unit: p.unit })
  }
  if (inRange.length === 0) return []
  inRange.sort((a, b) => a.t - b.t)

  const end = new Date(now)
  end.setHours(0, 0, 0, 0)
  const cur = new Date(inRange[0].t)
  cur.setHours(0, 0, 0, 0)

  const out: DayBucket[] = []
  for (; cur <= end && out.length < span; cur.setDate(cur.getDate() + 1)) {
    out.push({ day: dayKey(cur.getTime()), lastPct: null, maxPct: null, lastUsed: null })
  }
  if (out.length === 0) return []

  const byDay = new Map(out.map((b) => [b.day, b]))
  for (const p of inRange) {
    const b = byDay.get(dayKey(p.t))
    if (!b) continue
    // 末值 = 最后一个**已知** pct：null **不清空**它（末尾可能是采样失败记下的 null）
    if (known(p.pct)) {
      b.lastPct = p.pct
      b.maxPct = b.maxPct == null || p.pct > b.maxPct ? p.pct : b.maxPct
    }
    // 绝对量**独立**判据：pct 读不到时 used 可能仍是好的（官方 API 的百分比与绝对
    // 用量是两份字段，坏一个不必然坏另一个）。同样只取最后一个已知值，缺失不清空。
    if (known(p.used)) {
      b.lastUsed = p.used
      if (p.unit) b.unit = p.unit
    }
  }
  return out
}

/** 有历史点位的窗口名（供切换控件）。没点位的窗口不列 —— 切过去只能看到空图 */
export function windowsWithHistory(pointsByWindow: Record<string, UsagePoint[]>): string[] {
  return Object.keys(pointsByWindow ?? {}).filter((name) => (pointsByWindow[name] ?? []).length > 0)
}