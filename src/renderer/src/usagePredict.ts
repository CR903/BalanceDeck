import type { ProviderSnapshot, ProviderWindow } from '../../shared/types'
import { isPlan, staleLabel } from '../../shared/quality'
import { windowPercent } from '../../shared/percent'
import {
  DEFAULT_PREDICT_CONFIG,
  LOW_CONFIDENCE_POINTS,
  LOW_CONFIDENCE_SPAN,
  MIN_POINTS_FOR_RATE,
  resolvePredictConfig,
  type Confidence,
  type PredictConfig,
  type UsagePoint
} from '../../shared/usage-predict'
import { humanDur } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// 用量预测：按本机历史快照的消耗速率，估算各窗口「预计什么时候用完」
//
// 纯函数（无 electron / 无 DOM / 无 React）：`now` 一律由调用方传入，不读自己的钟 ——
// scripts/test-usage-predict.mjs 经 loadTs 跑同一份源码（design.md D1）。
//
// 三条纪律，全部来自本仓已有的先例，不是新发明的：
//   1. **缺失值保持缺失**：窗口百分比算不出来就没有该窗口的预测，**不按 0 处理**
//      （type-safety 第 2 条）。「按 0 算」会造出一条「速率正常」的假曲线。
//   2. **样本不足不硬算**：点数 / 跨度不够就整条不显示（AC10 同款纪律，与
//      history.ts 的 MIN_POINTS_FOR_ANOMALY 一致）。一个刚启动 30 分钟的安装，
//      界面必须什么都不显示，而不是显示「还剩 40 天」—— 那是在编造。
//   3. **数据诚实**：文案必须含「估算」，且 cached / local 走 shared/quality 的 staleLabel
//      追加标注（不在本模块写第二份「哪些算非官方」的判断与字符串）。
//
// 最容易写错的一处是 D2 的**重置点切段**：pct 序列在窗口重置时骤降（100 → 0），
// 直接对整段回归，斜率会被那些负跳变拉到 ≈ 0，表现为「怎么用都不快，预测永远说用不完」。
// ═══════════════════════════════════════════════════════════════════════════════

const HOUR = 3600_000
const DAY = 24 * HOUR

// 跨进程契约（形状 / 默认值 / 键名）住在 shared，这里转出去一份 —— design.md 的
// Contracts 段把 UsagePoint / DEFAULT_PREDICT_CONFIG 记在 usagePredict.ts 的导出上。
export {
  DEFAULT_PREDICT_CONFIG,
  LOW_CONFIDENCE_POINTS,
  LOW_CONFIDENCE_SPAN,
  MIN_POINTS_FOR_RATE,
  resolvePredictConfig
} from '../../shared/usage-predict'
export type { Confidence, PredictConfig, UsagePoint } from '../../shared/usage-predict'

/** 一条预测的完整内容（详情页直接渲染它） */
export interface Prediction {
  providerId: string
  /** 窗口名（'5 小时' / '本周' / '本月'…）—— 5H / W / M 的速率不同，混成一条是错的 */
  windowName: string
  /** 预计耗尽时刻（epoch ms） */
  runsOutAt: number
  /** 距现在还有多久（= runsOutAt − 调用时的 now）。文案用**它**而不是 runsOutAt − last.t */
  leftMs: number
  /** 斜率，百分点/小时（恒 > 0，否则不产出预测） */
  perHour: number
  confidence: Confidence
  /** 数据源降级标注（'' = 官方数据）。取自 staleLabel，**不在这里写第二份字符串** */
  qualityLabel: string
  /** 该窗口的重置时刻（epoch ms，取自快照 window.resetAt）。缺失/非法/已过 → null（此时按窗口名兜底周期判定） */
  resetAt: number | null
  /**
   * 按当前速率能否在本周期重置前用完。false = 本周期内用不完。
   *
   * 为什么需要它：线性外推到 100% 完全不看重置，慢速窗口会算出「本周约 198 天后用完」这种
   * 超出周期的数 —— 本周最多 7 天、本月最多 30 天，超出的数字没有意义。false 时文案不再报
   * 「X 天后用完」，而是报「本周期内用不完」。
   */
  exhaustsBeforeReset: boolean
}

// ─── ①a 周期上限（resetAt 缺失时的兜底）──────────────────────────────────────

/**
 * 按窗口名推断一个周期的最大长度。resetAt 缺失 / 非法 / 已过时用它兜底，
 * 否则「本周 198 天后用完」这种数在无 resetAt 的窗口上依然会出现。
 *
 * 取值（用户确认：月按 30 天算）：
 *   · 含 '5小时' → 5 小时（含 '5 小时' / 'Gemini Models · 5小时' 等前后缀）
 *   · 含 '24小时' → 24 小时
 *   · 含 '本周' → 7 天（含 '本周（7天）'）
 *   · 含 '本月' → 30 天（含 '本月套餐'）
 *   · 其他（'Token Plan' 等无周期名）→ null（不兜底，原样显示）
 */
export function windowCycleMs(windowName: string): number | null {
  const n = windowName.replace(/\s+/g, '')
  if (n.includes('5小时')) return 5 * HOUR
  if (n.includes('24小时')) return 24 * HOUR
  if (n.includes('本周')) return 7 * DAY
  if (n.includes('本月')) return 30 * DAY
  return null
}

// ─── ① 重置点切段（D2 的核心）─────────────────────────────────────────────

/**
 * 取「最后一段单调不降」的序列 —— 也就是**当前这个窗口周期**里已经消耗掉的那一段。
 *
 * 判据只有一条：`p[i] < p[i-1]` 即视为窗口重置，在该点断开（重置点本身属于新的一段）。
 *
 * 为什么只取最后一段而不是整段回归：预测问的是「**从现在往后**」。更早的段属于上一个窗口
 * 周期，它携带的是「上一个周期你用了多少」而不是「你现在多快」——5H 窗口 7 天里重置 33 次，
 * 整段回归等于把 33 个负跳变均摊进斜率。
 *
 * 为什么不用更聪明的办法（把重置点当成 censored observation 单独建模）：那要引入循环计数
 * 假设与更多参数，而这里要回答的问题只有一个「最近这一段有多陡」。段内单调不降是重置的
 * **充分**判据 —— 用量不会自己下降（下降只可能来自重置或数据口径切换），所以漏判的情况是
 * 「上一次采样就正好落在重置点之后」，那反而是正确切分。
 *
 * 顺带把 `pct === null` 的点剔除：它们没有斜率信息，而 `p[i] < p[i-1]` 的比较在 null 上
 * 既不成立也不失败（null < 30 是 false、null < 0 是 false），留着会让断点判据静默偏移。
 * **剔除不等于填 0** —— 未知就是未知，只是它对斜率没有贡献。
 */
export function lastMonotonicRun(points: UsagePoint[]): UsagePoint[] {
  const known = points.filter((p) => typeof p.pct === 'number' && Number.isFinite(p.pct))
  if (known.length === 0) return []
  let start = 0
  for (let i = 1; i < known.length; i++) {
    if ((known[i].pct as number) < (known[i - 1].pct as number)) start = i
  }
  return known.slice(start)
}

// ─── ② 速率：最小二乘线性回归（百分点/小时）────────────────────────────────

/**
 * 最小二乘斜率，**不做样本量门槛**（`ratePerHour` 才加门槛）。
 *
 * 单独导出来是因为它与门槛是两件事，混在一起就没法单独测「两点是否也算得出斜率」——
 * 回归公式在 n=2 上完全有定义（两点连成一条线，斜率 = Δpct/Δt），
 * 而 `ratePerHour` 出于诚实要拒绝 n<4。把两道闸门合成一道，就只能测其中一道。
 *
 * 横轴先减去 `t0` 再换算成小时：t 是 epoch 毫秒（1.7e12 量级），直接进平方和会把
 * 浮点有效位吃掉一大半，斜率的相对误差会随「机器时钟起点」漂。
 *
 * 返回 null 的两种情况：没有可用的点、或者所有点落在同一时刻（横轴没有方差，斜率无定义 ——
 * 那通常意味着 usageStore 里的 t 全被写坏了，此时报一个「速率」比沉默更危险）。
 */
export function slopePerHour(points: UsagePoint[]): number | null {
  const seg = lastMonotonicRun(points)
  if (seg.length < 2) return null
  const t0 = seg[0].t
  let mx = 0
  let my = 0
  for (const p of seg) {
    mx += (p.t - t0) / HOUR
    my += p.pct as number
  }
  mx /= seg.length
  my /= seg.length
  let sxy = 0
  let sxx = 0
  for (const p of seg) {
    const dx = (p.t - t0) / HOUR - mx
    sxy += dx * ((p.pct as number) - my)
    sxx += dx * dx
  }
  if (!(sxx > 0)) return null
  const slope = sxy / sxx
  return Number.isFinite(slope) ? slope : null
}

/**
 * 消耗速率（百分点/小时）。样本不足或斜率 ≤ 0 → **null**（不产出预测）。
 *
 * ⚠ 斜率 ≤ 0 一律不预测：「按当前速率永远用不完」这句话没有信息量（用量持平 = 没在用），
 *   而显示一个精确到小时的「还剩 200 天」是在拿精度冒充确定性。同 design.md D4。
 */
export function ratePerHour(points: UsagePoint[]): number | null {
  const seg = lastMonotonicRun(points)
  if (seg.length < MIN_POINTS_FOR_RATE) return null
  const slope = slopePerHour(seg)
  if (slope === null || slope <= 0) return null
  return slope
}

/**
 * 预计耗尽时刻。`perHour ≤ 0`、当前百分比未知、或**已经没有剩余**（pct ≥ 100）→ null。
 *
 * 目标固定是 100%：这条预测问的是「这个窗口的额度什么时候用完」，而窗口的百分比口径就是
 * 已用比例（`shared/percent.ts` 的 windowPercent 把它钳在 0..100）。
 */
export function estimateRunsOutAt(last: UsagePoint, perHour: number): number | null {
  if (!Number.isFinite(perHour) || perHour <= 0) return null
  if (typeof last.pct !== 'number' || !Number.isFinite(last.pct)) return null
  const left = 100 - last.pct
  if (!(left > 0)) return null
  const at = last.t + (left / perHour) * HOUR
  return Number.isFinite(at) ? at : null
}

// ─── ③ 样本可信度 ─────────────────────────────────────────────────────────

/**
 * 样本可信度；**null = 不显示**（与 statsFor 样本不足返回 null 是同一条纪律）。
 *
 * 判据看的是**当前这一段**（与速率同一份数据）：拿 7 天的总点数去给「最近 45 分钟那段」
 * 盖章可信度，是拿旧数据替新数据背书 —— 一次窗口重置就能让 7 天的点数看着很足，
 * 而实际能用的只有重置之后那 4 个点。
 */
export function confidenceOf(points: UsagePoint[]): Confidence | null {
  const seg = lastMonotonicRun(points)
  if (seg.length < MIN_POINTS_FOR_RATE) return null
  if (seg.length < LOW_CONFIDENCE_POINTS) return 'low'
  if (seg[seg.length - 1].t - seg[0].t < LOW_CONFIDENCE_SPAN) return 'low'
  return 'mid'
}

// ─── ④ 完整预测 ───────────────────────────────────────────────────────────

/**
 * 一个窗口的完整预测。任一判据不满足 → **null**（不显示，而不是显示一个没有依据的数）。
 *
 * @param s 快照取 id / dataQuality（数据源标注）+ windows（按窗口名找 resetAt，找不到/非法则按窗口名兜底周期）
 * @param windowName 窗口名，进 Prediction 供 UI 说明「说的是哪个窗口」
 * @param points 该窗口的历史采样（**原样传入**，本函数不修改入参）
 * @param now 本轮时刻：既是回看窗口的起点，也是「预测时刻已过」判据的参照
 * @param cfg 回看天数 / 保留天数（内部会 resolve，脏值落向默认）
 */
export function predictWindow(
  s: Pick<ProviderSnapshot, 'id' | 'dataQuality'> & { windows?: Pick<ProviderWindow, 'name' | 'resetAt'>[] },
  windowName: string,
  points: UsagePoint[],
  now: number,
  cfg: PredictConfig
): Prediction | null {
  const c = resolvePredictConfig(cfg)
  // ① 回看窗口：更早的点属于「上一个周期」的消耗，问「从现在往后」时不该算进来
  const recent = points.filter((p) => typeof p.t === 'number' && p.t >= now - c.windowDays * DAY)
  const seg = lastMonotonicRun(recent)
  if (seg.length === 0) return null
  // ② 速率与可信度都取自同一段（confidenceOf / ratePerHour 各自再算一次切段，
  //    但输入相同 → 结果一致；这里显式复用 seg 只是为了不重复表达「同一段」这件事）
  const perHour = ratePerHour(recent)
  if (perHour === null) return null
  const confidence = confidenceOf(recent)
  if (confidence === null) return null
  // ③ 耗尽时刻；已经算作过去（额度其实已经用完 / 数据早于现在一个周期）→ 不显示
  const runsOutAt = estimateRunsOutAt(seg[seg.length - 1], perHour)
  if (runsOutAt === null || !(runsOutAt > now)) return null
  // ④ 周期判定：耗尽时刻落在重置之后 → 本周期内用不完（不再报「198 天后用完」）。
  //    resetAt 优先（服务端真值）；缺失/非法/已过则按窗口名兜底（本周 7 天 / 本月 30 天 / 5 小时 5 小时）；
  //    都没有则不判定（无周期名的窗口如 'Token Plan'，原样显示）。
  const win = Array.isArray(s.windows) ? s.windows.find((w) => w.name === windowName) : undefined
  let resetAt: number | null = null
  const raw = win?.resetAt
  if (typeof raw === 'string' && raw) {
    const t = Date.parse(raw)
    if (Number.isFinite(t) && t > now) resetAt = t
  }
  const cycle = windowCycleMs(windowName)
  const deadline = resetAt ?? (cycle != null ? now + cycle : null)
  const exhaustsBeforeReset = deadline == null ? true : runsOutAt <= deadline
  return {
    providerId: s.id,
    windowName,
    runsOutAt,
    // 文案用「距 now」而不是「距 last.t」：最后一个采样点最多比现在早 15 分钟，
    // 用 last.t 会把「还剩多久」系统性地多说 15 分钟
    leftMs: runsOutAt - now,
    perHour,
    confidence,
    qualityLabel: staleLabel(s),
    resetAt,
    exhaustsBeforeReset
  }
}

/**
 * 逐窗口预测。**余额类一律返回空数组**（D5）：余额型没有「窗口」也没有「限额」，
 * 速率估算的整个前提（会触顶）不成立 —— `limit` 恒缺省，算出来的「用完时刻」是假的。
 *
 * 判据取 `isPlan(s)`（shared/quality 独家），不重写 `kind !== 'balance'`：
 * 2026-09-27 卡片与圆环各写一份的后果就是「卡片说是余额、球说是套餐」。
 */
export function predictAll(
  s: ProviderSnapshot,
  pointsByWindow: Record<string, UsagePoint[]>,
  now: number,
  cfg: PredictConfig
): Prediction[] {
  if (!isPlan(s)) return []
  const c = resolvePredictConfig(cfg)
  const out: Prediction[] = []
  for (const w of s.windows) {
    // 限额未知 → 算不出「用完」的时刻（error matrix：limit 缺省 / ≤ 0 不预测）
    if (w.limit == null || !(w.limit > 0)) continue
    // 当前百分比算不出来 → 这个窗口没有可信读数，不拿历史里的旧值冒充现在
    if (windowPercent(w) == null) continue
    const pts = pointsByWindow[w.name]
    if (!Array.isArray(pts) || pts.length === 0) continue
    const p = predictWindow(s, w.name, pts, now, c)
    if (p) out.push(p)
  }
  return out
}

/**
 * 展示文案。**必含「估算」**（prd AC3）—— 措辞不能是「3 天后用完」这种断言式表达，
 * 那是把一个拟合出来的斜率说成了事实。
 *
 * 文案只在这里生成一处：详情页的环形仪表下方与每个窗口行复用同一个函数，
 * 将来卡片若要展示也是同一句 —— 与 staleLabel 的单一出处是同一条纪律。
 */
export function buildPredictionText(p: Prediction, windowDays: number): string {
  const c = resolvePredictConfig({ windowDays })
  // 本周期内用不完：不再报「198 天后用完」这种超出周期的数（本周 ≤7 天 / 本月 ≤30 天）。
  // 仍保留「估算」二字（AC3）与样本/数据源后缀。
  const head = p.exhaustsBeforeReset
    ? `按近 ${c.windowDays} 天速率估算，约 ${humanDur(p.leftMs)}后用完`
    : `按近 ${c.windowDays} 天速率估算，本周期内用不完`
  const parts = [head]
  if (p.confidence === 'low') parts.push('样本较少')
  // ⚠ 取自 staleLabel（'' / '缓存' / '本机'），不写第二份「哪些算非官方」的判断
  if (p.qualityLabel) parts.push(`⚠ ${p.qualityLabel}`)
  return parts.join(' · ')
}

/** 排序：会耗尽的按耗尽时刻从近到远排前面，本周期内用不完的沉底（仍按耗尽时刻排） */
export function bySoonest(a: Prediction, b: Prediction): number {
  if (a.exhaustsBeforeReset !== b.exhaustsBeforeReset) return a.exhaustsBeforeReset ? -1 : 1
  return a.runsOutAt - b.runsOutAt
}
