// ═══════════════════════════════════════════════════════════════════════════════
// 用量预测（P0-2）的**跨进程**契约：快照的形状、配置与三个 extras 键
//
// 为什么单独一个 shared 文件：这个形状同时出现在三个进程侧 —— 主进程的 usageStore 写/读它、
// preload 的 usagePredict 声明它的返回类型、渲染层的 usagePredict.ts 算它。`src/shared/**/*`
// 在 tsconfig.node.json 与 tsconfig.web.json 两边都 include（type-safety.md），这是唯一能让
// 一处定义、三处引用的位置。
//
// ⚠ 各写一份的后果不是「重复劳动」而是**无声漂移**：preload 手写一份 `pct: number | null` 之后，
//   某天 usageStore 把它改成可选字段，两边类型**照样都过**（结构类型），于是 null 与 undefined
//   在 IPC 上混着走，而渲染层把 undefined 当成「未知」—— 界面上是一行空白，没有任何报错。
//   同一个道理适用于 DEFAULT_PREDICT_CONFIG：主进程读 ui:predictConfig 拿到脏值时要有地方回退，
//   两处各写一份 '7'，改了一处另一处就静默按别的天数裁历史。
//
// 这里只放**跨进程都要用**的东西（形状 / 键名 / 默认值 / 读取处校验）。估算算法不在这里 ——
// 那是渲染层纯函数 usagePredict.ts 的事（design.md D1）。
// ═══════════════════════════════════════════════════════════════════════════════

const HOUR = 3600_000

/** 保留期的合法上限。超过它只会让单文件无节制地长，所以钳在这里而不是相信 extras */
export const MAX_RETENTION_DAYS = 365

// ─── 采样点 ───────────────────────────────────────────────────────────────────

/** 一个窗口在某一时刻的用量率采样 */
export interface UsagePoint {
  /** 采样时刻（epoch ms） */
  t: number
  /**
   * 该窗口的用量百分比。
   * **不可知 = null，绝不填 0**（type-safety 第 2 条：缺失值必须保持缺失）。
   * 填 0 会让「这个窗口刚重置」与「这个窗口读不到」变成同一个数，而速率会照着这个 0 算。
   */
  pct: number | null
}

/** 落盘用的一条采样：UsagePoint + 它属于哪家的哪个窗口 */
export interface StoreUsagePoint extends UsagePoint {
  providerId: string
  /** 窗口名（'5 小时' / '本周' / '本月'…） */
  window: string
}

// ─── 配置 ─────────────────────────────────────────────────────────────────────

export interface PredictConfig {
  /** 速率回看天数（默认 7） */
  windowDays: number
  /** 本地快照保留天数（默认 30） */
  retentionDays: number
}

export const DEFAULT_PREDICT_CONFIG: PredictConfig = { windowDays: 7, retentionDays: 30 }

/**
 * 速率估算的最小样本数；不足则不预测。
 *
 * 为什么不为 2：两点连成一条线**永远**是平的确定性结果 —— 任何噪声都会被当成趋势，
 * 而「用量在涨」这个结论一旦编出来，详情页就会显示一个精确到分钟的用完时刻。
 * 4 个点（按 15 分钟采样 ≈ 1 小时）才够看出「这是一条斜线而不是抖动」。
 * 与 `history.ts` 的 MIN_POINTS_FOR_ANOMALY 是同一条纪律：样本不足不硬算。
 */
export const MIN_POINTS_FOR_RATE = 4

/** 低可信度的样本数上限（< 它则标「样本较少」）。`Record<Union, …>` 式的穷举由字面量常量承担 */
export const LOW_CONFIDENCE_POINTS = 8

/** 低可信度的时间跨度下限（毫秒） */
export const LOW_CONFIDENCE_SPAN = 6 * HOUR

export type Confidence = 'low' | 'mid'

/**
 * 阈值是否可用（类型守卫）。
 *
 * 沿用 smartBroadcast / systemNotify 的同名纪律：脏值必须落向「保守」而不是「乱算」——
 * NaN 让所有比较为假，负数会让「回看 -3 天」这种查询把**全部**历史都拉进来算速率。
 */
function positive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

/**
 * 读取处校验：extras 里的 JSON 可能被旧版本或手改写成任意值，脏值逐字段回退默认
 * （state-management.md「读取处一律重新校验」）。
 *
 * 渲染层与主进程**共用**这一份（两侧都要用它把脏值落向默认：渲染层决定显示，主进程决定
 * 读多少天历史）。各写一份 `v > 0 ? v : 7` 就等于两份默认值各活各的。
 */
export function resolvePredictConfig(raw: Partial<PredictConfig> | null | undefined): PredictConfig {
  const r = raw ?? {}
  return {
    windowDays: positive(r.windowDays) ? Math.min(MAX_RETENTION_DAYS, Math.floor(r.windowDays)) : DEFAULT_PREDICT_CONFIG.windowDays,
    retentionDays: positive(r.retentionDays)
      ? Math.min(MAX_RETENTION_DAYS, Math.floor(r.retentionDays))
      : DEFAULT_PREDICT_CONFIG.retentionDays
  }
}

/**
 * 三个 extras 键（design.md D7）。
 *
 * ⚠ `retention` **故意不是 `ui:` 前缀** —— `ipc.ts` 的 `extras:set` 对含非 `ui:` 键的 patch
 *   会调 `refreshNow()` 触发一次全量重采集。保留期是**采集侧**的配置，归主进程所有，
 *   所以由主进程自己的 `usage:setRetention` 通道写（渲染层不经过 `setExtras`），
 *   `test-structure.mjs` 的 E8（App 里所有 extras 键必须是 ui: 前缀）因此仍然是绿的。
 *   前缀决定副作用这条分界不能反：把三个键统一成 `ui:` 就会让「改采样参数」静默不生效。
 *
 * ⚠ **它必须是唯一的出处，不能只声明不用**。三个键分散在 App（读 + 写 ui: 两键）、
 *   scheduler（读 retention）、ipc（写 retention）三处；各写一份字面量的话，
 *   改键名要同时改三个文件，漏一个的症状是「改了设置没反应」—— 不抛不红，只是静默失效。
 *   `test-usage-predict.mjs` 的 I 段把「三处都引这份常量、且没有残留字面量」钉住。
 */
export const PREDICT_KEYS = {
  /** 总开关（界面偏好 → ui:） */
  on: 'ui:predictOn',
  /** { windowDays }（界面偏好 → ui:；**不含** retentionDays —— 那个归下面的键，写两份只会漂） */
  config: 'ui:predictConfig',
  /** 保留天数（采集侧配置 → 非 ui:，主进程持有；也是界面显示保留期的**唯一**来源） */
  retention: 'sample:usageHistoryDays'
} as const
