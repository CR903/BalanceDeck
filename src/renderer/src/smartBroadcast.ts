import type { ProviderSnapshot } from '../../shared/types'
import { formatPercent, roundPercent } from '../../shared/percent'
import { isPlan } from '../../shared/quality'
import { maxPercent, worstWindow } from './read-model'
import { lastSeen, statsFor, type HistoryPoint } from './history'

// ═══════════════════════════════════════════════════════════════════════════════
// 智能播报：5 个场景的判定 + 播报文案
//
// 为什么判定与文案放一处：判定产出 Hit，文案只从 Hit 生成 —— 播出去的每个字都能指回一个
// 命中的场景。拆到 App.tsx / 语音模块里就会出现「念了但没命中」「命中了但没念」两种对不
// 上的状态，而 TTS 每日有配额，念错就是浪费。
//
// 纯函数（无 electron / 无 DOM），scripts/test-trigger-engine.mjs 经 loadTs 跑同一份源码。
//
// 三条不可让步的约定：
//   1. **缺失值不填 0**（type-safety.md）。balance / percent 为 null 时该场景不触发 ——
//      宁可漏报，也不拿「不知道」冒充「余额 0」去吓用户。
//   2. **分级**：余额 / 波动 / 耗尽 = urgent（用户没盯屏时最该听到的就是它）；
//      未使用 / 异常 = routine（面板开着时屏幕上已经看得见）。表在 TRIGGER_LEVEL。
//   3. **同轮合并**：一次刷新里的多个命中合成**一条**播报（AC12），逐条念完等于没分级。
//
// hist 传的是**上一轮**的采样（不含本轮）：波动量与「多久没动过」都要拿它和当前快照比，
// 先把本轮塞进 hist 的话波动量恒为 0。本轮采样由调用方在判定之后 appendPoint。
// ═══════════════════════════════════════════════════════════════════════════════

export type TriggerKind = 'balance' | 'fluctuation' | 'exhaustion' | 'idle' | 'abnormal'

/** 播报分级（父 prd 的分级表） */
export type TriggerLevel = 'urgent' | 'routine'

/** 五个阈值字段，抽出来给覆盖表复用 —— 否则 Record 会自嵌套 */
interface TriggerConfigBase {
  /** 余额预警阈值（元）：可用余额低于它就报 */
  balanceLow: number
  /**
   * 单次增长阈值。余额型供应商比**元**（两次采样之间花掉多少），
   * 套餐型在限额未知时退化为**用量率百分点** —— 两种口径的量纲不同，
   * 所以播报文案会带上各自的单位，不让听者以为说的是同一种数。
   */
  fluctuation: number
  /** 用量耗尽阈值（%）：用量率高于它就报 */
  exhaustionPct: number
  /** 长时间未使用阈值（小时）：用量没有变化超过这么久就报 */
  idleHours: number
  /** 异常倍数：用量率高于历史均值 × 它就报 */
  abnormalMul: number
}

/** 单个供应商的阈值覆盖（只列被覆盖的字段） */
export type ProviderOverride = Partial<TriggerConfigBase>

/**
 * 阈值字段名 ↔ TriggerKind 的映射。加场景时这张表必须一起改 ——
 * Record 穷举，漏改即编译错误（比运行时静默用错字段强）。
 */
export const THRESHOLD_FIELD: Record<TriggerKind, keyof TriggerConfigBase> = {
  balance: 'balanceLow',
  fluctuation: 'fluctuation',
  exhaustion: 'exhaustionPct',
  idle: 'idleHours',
  abnormal: 'abnormalMul'
}

export interface TriggerConfig extends TriggerConfigBase {
  /** 按供应商覆盖全局阈值（只覆盖列出的字段） */
  perProvider?: Record<string, ProviderOverride>
}

/** 父 prd 的默认阈值（余额预警 10，用量波动 10） */
export const DEFAULT_TRIGGER_CONFIG: TriggerConfig = {
  balanceLow: 10,
  fluctuation: 10,
  exhaustionPct: 90,
  idleHours: 24,
  abnormalMul: 2
}

export interface Hit {
  id: string
  name: string
  kind: TriggerKind
  level: TriggerLevel
  /** 播报从句，形如「余额不足，剩余 8 元」；永远只引用确实存在的数 */
  detail: string
}

/** 场景 → 分级。与 TRIGGER_RANK 配对：加一个场景必须同时改这两张表（Record 穷举，漏改即编译错误） */
export const TRIGGER_LEVEL: Record<TriggerKind, TriggerLevel> = {
  balance: 'urgent',
  fluctuation: 'urgent',
  exhaustion: 'urgent',
  idle: 'routine',
  abnormal: 'routine'
}

/** 同一轮里的播报顺序：紧急在前，且「余额」永远排第一 —— 用户最想先听到的就是它 */
const TRIGGER_RANK: Record<TriggerKind, number> = {
  balance: 0,
  fluctuation: 1,
  exhaustion: 2,
  idle: 3,
  abnormal: 4
}

/** 播报里会念出金额的场景（隐藏余额时整条剔除：数字和单位一起消失，不能只去符号） */
const MONEY_KINDS: readonly TriggerKind[] = ['balance', 'fluctuation']

/** 与 App.tsx 现有的隐藏余额播报同一口径（`${name}，余额已隐藏`） */
const HIDDEN_BALANCE = '余额已隐藏'

const HOUR = 3600_000

/**
 * 阈值是否可用。
 *
 * 配置是从 extras 读回来的（state-management 要求读取处重新校验），脏值必须落到
 * 「不触发」而不是「乱触发」：NaN 让所有比较为假（安全），负数则会让「余额 ≥ 0」永远
 * 低于阈值，于是每次刷新都报「余额不足」。
 */
function positive(v: number): boolean {
  return Number.isFinite(v) && v > 0
}

/** 元：四舍五入到分并去掉多余的零（`8.00` → `8`） */
function yuan(v: number): string {
  return String(Math.round(v * 100) / 100)
}

/** 「还能用多少」—— 余额预警与波动量比的都是这个数。
 *
 *   · 充值余额型（kind === 'balance'）：账户余额窗口的数值**本身就是**剩余 ——
 *     适配器（volc.ts:106、qwen.ts:108、adapters/types.ts:57 的 balanceWindow）都把
 *     `used` 填成账户余额，没有「已用 / 限额」这一层。
 *   · 套餐型（coding / token）：窗口里的 usd/cny 是**已用掉多少**，方向与「余额不足」
 *     正好相反，所以取最紧张那个窗口的剩余额度（limit − used）。
 *   · 两者都拿不到（没有货币窗口 / 限额未知）→ null：不知道还剩多少就说不知道。
 *
 * 套餐/余额的判据用 shared/quality 的 isPlan —— 卡片、详情页、收起态球都是这一个口径，
 * 不在这里重写第二份。
 */
export function balanceOf(s: ProviderSnapshot): number | null {
  if (!isPlan(s)) {
    const w = s.windows.find((x) => x.unit === 'cny' || x.unit === 'usd')
    return w ? w.used : null
  }
  const w = worstWindow(s)
  if (!w || w.limit == null || w.limit <= 0) return null
  return w.limit - w.used
}

/** 一次「单次增长」：金额口径优先（与阈值默认的「元」同量纲），金额不可知时退到用量率 */
function spendSince(
  prev: HistoryPoint | undefined,
  bal: number | null,
  pct: number | null
): { amount: number; money: boolean } | null {
  if (!prev) return null
  if (bal != null && prev.balance != null) {
    const d = prev.balance - bal
    if (d > 0) return { amount: d, money: true }
  }
  if (pct != null && prev.percent != null) {
    const d = pct - prev.percent
    if (d > 0) return { amount: d, money: false }
  }
  return null
}

/** 供应商生效的阈值：全局 + 该供应商的覆盖。覆盖表**类型上**不含 perProvider，但这份配置是从
 *  extras 的 JSON 里读回来的，类型在那条边界上不作数（state-management：读取处一律重新校验），
 * 所以运行时仍要剥掉多带进来的那一层。 */
export function resolveConfig(base: TriggerConfig, id: string): TriggerConfig {
  const over = base.perProvider?.[id]
  if (!over) return base
  const { perProvider: _nested, ...rest } = over as Partial<TriggerConfig>
  return { ...base, ...rest }
}

/**
 * 检查一轮里 5 个场景各有没有命中。
 *
 * 边界一律取「严格越过」：余额**低于**阈值、增长**大于**阈值、用量率**高于**阈值、
 * 静默**超过**阈值。这样「刚好等于阈值」与「刚好差一点」落在不同侧，AC9 才谈得上
 * 「恰好播报一次」—— 若用 >=，用户在阈值上会收到两条只差 0.01 元的重复播报。
 */
export function checkTriggers(
  snapshots: ProviderSnapshot[],
  hist: HistoryPoint[],
  cfg: TriggerConfig,
  now: number
): Hit[] {
  const out: Hit[] = []
  for (const s of snapshots) {
    // 非 ok / 无窗口一律不判：这一轮没有可信数据，播报只会把上一轮的旧闻再说一遍
    if (s.status !== 'ok' || s.windows.length === 0) continue

    const c = resolveConfig(cfg, s.id)
    const name = s.name || s.id
    const bal = balanceOf(s)
    const pct = maxPercent(s)
    const mine = hist.filter((p) => p.id === s.id)
    const prev = mine.length ? mine[mine.length - 1] : undefined
    const push = (kind: TriggerKind, detail: string): void => {
      out.push({ id: s.id, name, kind, level: TRIGGER_LEVEL[kind], detail })
    }

    // ① 余额预警：缺余额不判（null ≠ 0）
    if (bal != null && positive(c.balanceLow) && bal < c.balanceLow) {
      push('balance', `余额不足，剩余 ${yuan(bal)} 元`)
    }

    // ② 用量波动：只比**相邻两次**采样，中间隔了几轮都算「单次」
    const spend = spendSince(prev, bal, pct)
    if (spend != null && positive(c.fluctuation) && spend.amount > c.fluctuation) {
      push('fluctuation', spend.money
        ? `单次用量增长 ${yuan(spend.amount)} 元`
        : `用量率单次上涨 ${roundPercent(spend.amount)} 个百分点`)
    }

    // ③ 用量即将耗尽
    if (pct != null && positive(c.exhaustionPct) && pct > c.exhaustionPct) {
      push('exhaustion', `用量已用 ${formatPercent(pct)}`)
    }

    // ④ 长时间未使用：lastSeen 判不出活动（无历史 / 全是缺失值）时沉默
    const seen = lastSeen(hist, s.id, now)
    if (seen != null && positive(c.idleHours) && now - seen > c.idleHours * HOUR) {
      push('idle', `已 ${Math.floor((now - seen) / HOUR)} 小时无用量变化`)
    }

    // ⑤ 异常使用模式：statsFor 在样本 < MIN_POINTS_FOR_ANOMALY 时返回 null，
    //    这里 null 即跳过 —— 冷启动没有「历史平均」，拿 1 个点当基线必然误报（AC10）
    const st = statsFor(hist, s.id)
    if (st != null && pct != null && positive(c.abnormalMul) && pct > st.avg * c.abnormalMul) {
      push('abnormal', `用量高于历史平均 ${c.abnormalMul} 倍`)
    }
  }
  return out
}

// ─── 播报锁存（AC9：恰好播报一次）────────────────────────────────────────────

/**
 * 锁存键：一条「播报事件」的身份 = 供应商 × 场景。
 *
 * 用空格拼而不是 ':'：供应商 id 形如 `inst:xxx`（见 ipc.ts 的实例 id 约定），
 * 再拼一个冒号会让人分不清哪一段是 id、哪一段是场景。空格也不会歧义 ——
 * 场景名取自上面那个 5 值枚举、非空，id 结尾多塞几个空格只可能让键更长，不会撞上另一条。
 */
export function hitKey(h: Hit): string {
  return `${h.id} ${h.kind}`
}

/**
 * 滤出**还没播过**的命中（相对上一轮的锁存集合）。
 *
 * 为什么必须去重：一次采集一推就评估一轮（触发源是数据不是时间），而「余额不足」这种
 * 状态会**连续几十轮都成立**。不锁存的话，刷新间隔 60s 就变成每分钟念一遍同一句话，
 * 一天上千次 TTS 调用 —— AC8 的频率闸门只能把它压到 10 次/小时，压不到「不重复」。
 *
 * 锁存的是「播过」，不是「发生过」：条件一旦解除，键就从集合里消失，下次再越过阈值
 * 会重新播。否则用户充了钱又花光，就再也听不到第二次预警了。
 */
export function freshHits(hits: Hit[], latched: Iterable<string>): Hit[] {
  const seen = new Set(latched)
  return hits.filter((h) => !seen.has(hitKey(h)))
}

/** 下一轮的锁存集合 = 本轮**实际进入播报判定**的那批命中的键 */
export function latchKeys(hits: Hit[]): string[] {
  return Array.from(new Set(hits.map(hitKey)))
}

/** 命中排序：紧急在前，同级按 TRIGGER_RANK。mergeHits 不信任调用方给的顺序 */
function byRank(a: Hit, b: Hit): number {
  if (a.level !== b.level) return a.level === 'urgent' ? -1 : 1
  return TRIGGER_RANK[a.kind] - TRIGGER_RANK[b.kind]
}

/**
 * 同一轮的多命中合并成**一条**播报（AC12：合并去重，不逐条罗列）。
 *
 *   · 一个供应商只出现一次 —— 名字念两遍正是「逐条念」的典型症状。
 *   · simple 每个供应商只说最高优先级的那一条（余额命中时就是「仅余额信息」）；
 *     detailed 把该供应商这一轮所有命中连成一句。
 *   · hideBalance 时凡是会念出金额的场景整条剔除（不能只把 ¥/元 符号藏起来），
 *     一条能说的都不剩就如实说「余额已隐藏」—— 与 App.tsx 现有播报同一口径，
 *     连用量都没有时不拿「0 元」凑数。
 *
 * 返回 null 表示这一轮没什么可播的（空输入，或剔除后什么都不剩）。
 */
export function mergeHits(
  hits: Hit[],
  format: 'simple' | 'detailed',
  opts: { hideBalance?: boolean } = {}
): string | null {
  if (hits.length === 0) return null
  const hide = opts.hideBalance === true

  // 先按供应商归并，再排序 —— 顺序以「最严重的那条命中」为准，与传入顺序无关
  const groups = new Map<string, { name: string; hits: Hit[] }>()
  for (const h of hits) {
    const g = groups.get(h.id)
    if (g) g.hits.push(h)
    else groups.set(h.id, { name: h.name || h.id, hits: [h] })
  }

  const sentences: string[] = []
  for (const g of groups.values()) {
    const usable = g.hits.filter((h) => !hide || !MONEY_KINDS.includes(h.kind)).sort(byRank)
    if (usable.length === 0) {
      if (hide) sentences.push(`${g.name} ${HIDDEN_BALANCE}`)
      continue
    }
    const details = Array.from(new Set(usable.map((h) => h.detail)))
    sentences.push(`${g.name} ${format === 'simple' ? details[0] : details.join('，')}`)
  }
  return sentences.length ? sentences.join('；') : null
}
