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

/** 一次取回的历史里，两个视图共用的上限（`sample:usageHistoryDays` 默认 30） */
export const TREND_MAX_DAYS = 30

export interface DayBucket {
  /** 本地日历日 'YYYY-MM-DD' */
  day: string
  /** 该天最后一个**已知** pct（末尾是 null 时不取它）；无已知值 = null → 不画柱 */
  lastPct: number | null
  /** 该天峰值（画柱内高亮 / 参考线用）；无已知值 = null */
  maxPct: number | null
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

/** `pct` 可知才算数：null / 非有限数一律视为「没采到」 */
function known(p: number | null): p is number {
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
    inRange.push({ t: p.t, pct: p.pct })
  }
  if (inRange.length === 0) return []
  inRange.sort((a, b) => a.t - b.t)

  const end = new Date(now)
  end.setHours(0, 0, 0, 0)
  const cur = new Date(inRange[0].t)
  cur.setHours(0, 0, 0, 0)

  const out: DayBucket[] = []
  for (; cur <= end && out.length < span; cur.setDate(cur.getDate() + 1)) {
    out.push({ day: dayKey(cur.getTime()), lastPct: null, maxPct: null })
  }
  if (out.length === 0) return []

  const byDay = new Map(out.map((b) => [b.day, b]))
  for (const p of inRange) {
    const b = byDay.get(dayKey(p.t))
    if (!b) continue
    // 末值 = 最后一个**已知**值：null **不清空**它（末尾可能是采样失败记下的 null）
    if (!known(p.pct)) continue
    b.lastPct = p.pct
    b.maxPct = b.maxPct == null || p.pct > b.maxPct ? p.pct : b.maxPct
  }
  return out
}

// ─── 坐标换算（全部是纯函数，可单测）─────────────────────────────────────────

/**
 * 纵轴：百分比 → 像素 y（0 在底、100 在顶）。
 *
 * ⚠⚠ **固定 0..100，不随数据缩放**。这是本文件最重要的一条：不缩放的话「上周 90%」与
 *   「本周 20%」两张图的形状完全一样，用户读不出差异 —— 而「按天对比」正是趋势图
 *   存在的理由。宁可图矮，不可比错。
 *
 * 脏 pct（NaN / 超范围）落向 0..100 的边界，与 `Ring` / `Bar` 的钳位同一口径。
 */
export function scaleY(pct: number, height: number): number {
  const v = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0
  return height - (v / 100) * height
}

/**
 * 横轴：第 i 根柱（0..count-1）的**中心** x。
 *
 * 等距铺满 width。`count <= 1` 返回 width / 2 —— 落在「除以零」上会得到 NaN，而 SVG 属性里
 * NaN 静默不渲染，症状是「一根柱凭空消失」，不报错。
 */
export function xOf(index: number, count: number, width: number): number {
  if (!(count > 1)) return width / 2
  const slot = width / count
  return slot * index + slot / 2
}

/** 有历史点位的窗口名（供切换控件）。没点位的窗口不列 —— 切过去只能看到空图 */
export function windowsWithHistory(pointsByWindow: Record<string, UsagePoint[]>): string[] {
  return Object.keys(pointsByWindow ?? {}).filter((name) => (pointsByWindow[name] ?? []).length > 0)
}