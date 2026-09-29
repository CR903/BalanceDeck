// ═══════════════════════════════════════════════════════════════════════════════
// 播报用的历史采样（智能触发的「记忆」）
//
// 为什么独立成模块：5 个触发场景里有 2 个（异常模式、长时间未使用）根本没法只看当前
// 快照判断 —— 必须知道「之前是什么样」。采样、封顶、统计三件事只能有一个实现，否则
// 采集侧与检测侧对「多少条算够」「缺失值算不算 0」的理解迟早漂移。
//
// 纯函数（无 electron / 无 DOM），scripts/test-trigger-engine.mjs 经 loadTs 跑同一份源码。
//
// 两条不可让步的约定（type-safety.md）：
//   1. **缺失就是缺失**：balance / percent 拿不到时保持 null。0 是一个事实（确实用完了），
//      不是「不知道」—— 把它当 0 会同时造出假的「余额不足」和被拉低的均值。
//   2. **样本不足就不判**：statsFor 少于 MIN_POINTS_FOR_ANOMALY 条时返回 null，由调用方
//      跳过（AC10 宁漏不误报），而不是拿 9 个点硬算一个「历史平均」。
// ═══════════════════════════════════════════════════════════════════════════════

export interface HistoryPoint {
  /** 采集时刻（epoch ms） */
  t: number
  /** 供应商 id */
  id: string
  /** 可用余额（元）；无数据 = null，**不得填 0** */
  balance: number | null
  /** 用量率（%）；无数据 = null，**不得填 0** */
  percent: number | null
}

/** 历史条数上限（父 prd D6：`ui:ttsHistoryCap` 默认 100，AC13） */
export const DEFAULT_HISTORY_CAP = 100

/** 异常检测的最小样本量：少于这个数一律不判异常（AC10：冷启动不误报） */
export const MIN_POINTS_FOR_ANOMALY = 10

/**
 * 追加一条采样，超出上限时丢弃最旧的。
 *
 * cap 非法（0 / 负数 / NaN）时**退回默认上限**而不是当成 0：上限写成 0 的后果是历史
 * 立刻清空、异常检测永远不触发 —— 那是「静默失效」，比多存 100 条更糟（state-management
 * 要求读取处重新校验阈值，校验的语义是「回到已知安全的值」）。
 */
export function appendPoint(
  hist: HistoryPoint[],
  p: HistoryPoint,
  cap: number = DEFAULT_HISTORY_CAP
): HistoryPoint[] {
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_HISTORY_CAP
  const next = hist.concat(p)
  return next.length > limit ? next.slice(next.length - limit) : next
}

export interface HistoryStats {
  /** 用量率均值（%） */
  avg: number
  /** 用量率峰值（%） */
  peak: number
  /** 用量率标准差（总体标准差，÷n） */
  stddev: number
  /** 实际参与统计的样本数（null 不计入） */
  n: number
}

/**
 * 某供应商的用量率统计；样本不足返回 null（调用方据此跳过异常检测）。
 *
 * 为什么统计的是**用量率**而不是余额：余额是随消费单调下降的**存量**，对它求均值得到
 * 的是趋势而不是常态，拿它当「异常基线」比不出异常（每天都在降）。用量率才是同一量纲
 * 下可比的水平量。
 *
 * null 一律不参与计算 —— 既不进 n，也不当 0 拉低 avg（否则 10 条里 9 条没采到会被读成
 * 「这个供应商一直只用 10%」）。
 *
 * peak / stddev 目前没被 checkTriggers 用到，但父 prd 允许用户把异常基线换成峰值或标准差，
 * 三个数一起算出来比在检测侧临时重扫一遍历史更省事，口径也只此一处。
 */
export function statsFor(hist: HistoryPoint[], id: string): HistoryStats | null {
  const vals = hist.filter((p) => p.id === id).map((p) => p.percent).filter((v): v is number => v != null)
  if (vals.length < MIN_POINTS_FOR_ANOMALY) return null
  const avg = vals.reduce((s, v) => s + v, 0) / vals.length
  const sq = vals.reduce((s, v) => s + (v - avg) * (v - avg), 0)
  // 不用 Math.max(...vals)：条数由用户的 cap 决定，展开成参数会在上限调大时爆栈
  let peak = vals[0]
  for (const v of vals) if (v > peak) peak = v
  return { avg, peak, stddev: Math.sqrt(sq / vals.length), n: vals.length }
}

/**
 * 两条采样之间是否观测到了「用量变化」。
 *
 * 缺失值不是 0：null 与有值之间**不算变化**（那是数据没了，不是用过了），两边都缺更不算。
 * 少了这条，一次采集失败就会被当成「用量归零」，进而报出一条根本不存在的「余额不足」。
 */
function changed(a: HistoryPoint, b: HistoryPoint): boolean {
  if (a.balance != null && b.balance != null && a.balance !== b.balance) return true
  if (a.percent != null && b.percent != null && a.percent !== b.percent) return true
  return false
}

/**
 * 该供应商「最后一次被观测到用量活动」的时刻（epoch ms）；判不出来返回 null。
 *
 * 只认**相邻两条的差** —— 每次刷新都记一条，所以「最新一条的 t」是刷新时刻而不是
 * 使用时刻，拿它算「多久没动过」永远是 0。父 prd 说历史数据就是给「长时间未使用」用的，
 * 指的正是这个差。
 *
 * 全部采样都没变化时返回**最早那条有数据的** t：我们只能证明「到那时为止没有变化」，
 * 更早的事落在 cap 之外、证明不了，不外推（宁可晚报一小时，不谎报「一个月没用过」）。
 *
 * t 晚于 now（渲染时钟略旧于数据）时钳到 now：负的「距今」会算出一句荒谬的播报。
 */
export function lastSeen(hist: HistoryPoint[], id: string, now: number): number | null {
  const pts = hist.filter((p) => p.id === id)
  for (let i = pts.length - 1; i > 0; i--) {
    if (changed(pts[i - 1], pts[i])) return Math.min(pts[i].t, now)
  }
  for (const p of pts) {
    if (p.balance != null || p.percent != null) return Math.min(p.t, now)
  }
  return null
}
