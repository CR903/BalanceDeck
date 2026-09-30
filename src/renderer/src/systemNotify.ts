import type { ProviderSnapshot, ProviderWindow } from '../../shared/types'
import { formatPercent, windowPercent } from '../../shared/percent'
import { staleLabel } from '../../shared/quality'
import { humanDur } from './format'
import { maxPercent, worstWindow } from './read-model'

// ═══════════════════════════════════════════════════════════════════════════════
// 系统通知（macOS 通知中心 / Windows Toast）的判定与文案
//
// 为什么要独立成一个模块，而不是复用 smartBroadcast 的触发引擎：语音播报与系统通知
// 是**两条互相独立的输出通道**，用户可能只想开其中一条；阈值也必须能分开配
// （默认 >80% 弹通知、>90% 才播报）。挂在播报引擎上会让「关掉语音」顺手关掉通知，
// 而把两套阈值塞进同一张表则迟早互相覆盖（design.md D1）。
//
// 纯函数（无 electron / 无 DOM / 无 React）：now 由调用方传入 —— 同 alertOrchestrate，
// 纯模块不读自己的钟，这样 scripts/test-system-notify.mjs 能经 loadTs 跑同一份源码。
//
// 三条纪律，与播报侧同源：
//   1. **缺失值不填 0**：没有百分比、没有 resetAt 就**不通知**，不拿「不知道」冒充数据。
//   2. **数据诚实**：cached / local 必须在正文里标注（buildNotifyBody 的来源标注）。
//   3. **恰好一次**：靠 freshNotifies / notifyLatchKeys 的上升沿锁存（见 D3），
//      条件持续成立期间只弹一次；用量回落后键自动消失，再次越过才重新弹。
// ═══════════════════════════════════════════════════════════════════════════════

/** 通知档位。`Record<NotifyLevel, …>` 穷举（下面两张表），加档位即编译错误 */
export type NotifyLevel = 'warn' | 'high' | 'reset'

/**
 * 档位全集。主进程 `ipc.ts` 的校验表与它**逐项对齐** —— 那边写不出共享模块
 * （文件所有权不许新增 shared 文件），所以由 test-system-notify.mjs 静态比对两侧字面量。
 */
export const NOTIFY_LEVELS: readonly NotifyLevel[] = ['warn', 'high', 'reset']

/**
 * 同一轮多档时的取舍顺序。
 *
 * 告警 > 提醒 > 重置临近：前两者是「额度正在被烧掉」，后者是「还有时间」。
 *
 * ⚠ 取舍是**每家每轮只留最严重的那一条**（`checkNotify` 的契约，见 D2），所以两者同轮
 *   成立时用户只看到更严重的那件；「即将重置」这一档要等用量回落到 pctWarn 以下
 *   （候选清空 → 锁存键随之消失）之后的下一轮才会单独弹一次。**它不是「下一轮就补上」**
 *   —— 那种写法会让人以为两件事都会提醒，而实际上「用量 85% 且 30 分钟后重置」这个
 *   最该说清的场景里，用户只会收到用量提醒（正文里仍带倒计时，所以信息没丢）。
 *   scripts/test-system-notify.mjs 的 F6/F6b 把这个优先级钉住。
 */
const NOTIFY_RANK: Record<NotifyLevel, number> = { high: 0, warn: 1, reset: 2 }

const HOUR = 3600_000

/** 三个阈值字段；单位见各字段注释 */
export interface NotifyConfig {
  /** 提醒阈值（%）：用量率**高于**它就弹一次提醒 */
  pctWarn: number
  /** 强提醒阈值（%）：用量率高于它就弹告警 */
  pctHigh: number
  /** 重置临近阈值（小时）：距重置不超过它就提醒「即将重置」 */
  resetSoonHours: number
}

/** 出厂默认：>80% 提醒、>95% 强提醒、重置前 1 小时提醒（prd.md 需求 2） */
export const DEFAULT_NOTIFY_CONFIG: NotifyConfig = { pctWarn: 80, pctHigh: 95, resetSoonHours: 1 }

/** 一条系统通知的完整内容（渲染层判定，主进程只负责弹出） */
export interface NotifyPayload {
  id: string
  name: string
  title: string
  body: string
  level: NotifyLevel
}

/** 标题里的档位措辞。`Record<NotifyLevel, …>` 穷举 */
const NOTIFY_TITLE_TAIL: Record<NotifyLevel, string> = {
  warn: '用量提醒',
  high: '用量告警',
  reset: '即将重置'
}

/**
 * 阈值是否可用（类型守卫）。
 *
 * 沿用 smartBroadcast 的 `positive()` 那条纪律：脏值必须落向「不触发」而不是「乱触发」——
 * NaN 让所有比较为假（安全），负数会让「用量 0%」也越线，于是每轮都弹一次。
 *
 * ⚠ 这里**不复用** smartBroadcast 里那个同名函数（也没从那儿导出）：系统通知是与 TTS
 *   独立的一条通道，为了省一行谓词去依赖播报引擎，正好把 D1 划的边界抹掉。
 */
function positive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

/**
 * 读取处校验：extras 里的 JSON 可能被旧版本或手改写成任意值，脏值逐字段回退默认
 * （state-management.md 的「读取处一律重新校验」）。
 *
 * ⚠ `pctHigh <= pctWarn` 是**互相矛盾**的一对：用户会把 `warn` 调到 96、`high` 留 95，
 *   于是「提醒」那一档永远不可能触发，而界面上看不出任何异常。所以钳制之后还要**收口**：
 *   仍然倒挂就把强提醒抬到刚好越过提醒（用量率上限 100，所以抬到 100 = 强提醒不触发，
 *   这与「没有数据」是两回事，且不会凭空造出一个假的百分比）。
 */
export function resolveNotifyConfig(raw: Partial<NotifyConfig> | null | undefined): NotifyConfig {
  const r = raw ?? {}
  const pctWarn = positive(r.pctWarn) ? r.pctWarn : DEFAULT_NOTIFY_CONFIG.pctWarn
  const high = positive(r.pctHigh) ? r.pctHigh : DEFAULT_NOTIFY_CONFIG.pctHigh
  const resetSoonHours = positive(r.resetSoonHours) ? r.resetSoonHours : DEFAULT_NOTIFY_CONFIG.resetSoonHours
  return {
    pctWarn,
    pctHigh: high > pctWarn ? high : Math.min(100, pctWarn + 1),
    resetSoonHours
  }
}

/** 数据来源标注。**判定**哪一档由 shared/quality 的 staleLabel 独家负责（design.md D4），
 *  这里只把它的两档结果翻译成通知里的措辞 —— 卡片徽章、托盘、TTS 都走同一个 staleLabel，
 *  不在新模块里写第二份「哪些算非官方」的判断。 */
function sourceText(s: ProviderSnapshot): string {
  const stale = staleLabel(s)
  if (stale === '缓存') return '⚠ 缓存数据'
  if (stale === '本机') return '⚠ 本机估算'
  return '官方数据'
}

/** 取不到指定窗口时按档位自己挑一个（`checkNotify` 总是显式传窗口，这里只服务直接调用方） */
function defaultWindow(s: ProviderSnapshot, level: NotifyLevel): ProviderWindow | undefined {
  if (level !== 'reset') return worstWindow(s)
  return s.windows.find((w) => typeof w.resetAt === 'string')
}

/**
 * 距重置不超过 `hours` 小时的窗口；没有就是没有。
 *
 * 两条边界都是踩过坑才定下来的：
 *   · **已过点的 resetAt 一律不算**（要求 `left > 0`）。适配器给的窗口重置时间在数据过期
 *     （cached）时会落在过去，那条记录会变成「每 30 秒弹一次重置临近」的永动机。
 *   · 上界用 `<=`：正好还剩 1 小时也算「即将重置」—— 用户听到的是「马上要重置了」，
 *     差这一分钟毫无意义（对比用量率那侧取「严格越过」：80% 整不该既不提醒又当提醒）。
 */
function resetSoonWindow(
  s: ProviderSnapshot,
  hours: number,
  now: number
): ProviderWindow | undefined {
  if (!positive(hours)) return undefined
  for (const w of s.windows) {
    if (!w.resetAt) continue
    const t = Date.parse(w.resetAt)
    if (!Number.isFinite(t)) continue
    const left = t - now
    if (left > 0 && left <= hours * HOUR) return w
  }
  return undefined
}

/** 同一轮内的档位排序：告警 → 提醒 → 重置临近 */
function byRank(a: NotifyLevel, b: NotifyLevel): number {
  return NOTIFY_RANK[a] - NOTIFY_RANK[b]
}

/**
 * 通知正文：窗口 + 百分比 + 重置倒计时 + **数据来源**。
 *
 * 为什么逐项都可能缺席：正文里出现的每一个数都必须有来源（type-safety「缺失值保持缺失」）。
 * 判不出百分比就不写百分比，判不出重置时间就不写倒计时 —— 只有来源标注是永远在的，
 * 因为它是「这些数有多可信」的说明而不是某个数本身。
 *
 * @param win 触发通知的那个窗口（`checkNotify` 一定显式传，省得这里再猜一次）
 * @param now 本轮时刻；不给就不写倒计时（纯函数不读自己的钟）
 */
export function buildNotifyBody(
  s: ProviderSnapshot,
  level: NotifyLevel,
  win?: ProviderWindow,
  now?: number
): string {
  const w = win ?? defaultWindow(s, level)
  const winName = w?.name ?? ''
  const pct = w ? windowPercent(w) : null
  const leftMs = w && w.resetAt && now != null ? Date.parse(w.resetAt) - now : NaN
  const left = Number.isFinite(leftMs) && leftMs > 0 ? humanDur(leftMs) : ''
  const parts: string[] = []
  if (level === 'reset') parts.push(left ? `${winName}${left}后重置` : `${winName}即将重置`)
  else if (pct != null) parts.push(`${winName}已用 ${formatPercent(pct)}`)
  // 重置倒计时也放进 warn / high 的正文：AC1 要求「重置时间」看得见，而用量告警
  // 恰恰是用户最想知道「还剩多久能再冲一次」的那条
  if (level !== 'reset' && left) parts.push(`${left}后重置`)
  return parts.concat(sourceText(s)).join(' · ')
}

/**
 * 判一轮里每家供应商该不该弹通知。**每家最多一条**（同轮两条 = 同一个名字弹两次）。
 *
 * 跳过条件（与播报引擎同口径）：`status !== 'ok'` 或没有窗口 —— 这一轮没有可信数据，
 * 拿上一轮的旧闻当新闻发出去，比不发更糟。
 */
export function checkNotify(
  snapshots: ProviderSnapshot[],
  cfg: NotifyConfig,
  now: number
): NotifyPayload[] {
  const out: NotifyPayload[] = []
  for (const s of snapshots) {
    if (s.status !== 'ok' || s.windows.length === 0) continue
    const c = resolveNotifyConfig(cfg)
    const name = s.name || s.id

    const cands: { level: NotifyLevel; win: ProviderWindow }[] = []
    const pct = maxPercent(s)
    if (pct != null) {
      const worst = worstWindow(s)
      if (worst) {
        // 严格越过：正好等于阈值不算（与 checkTriggers 的边界一致，用户不会收到两条
        // 只差 0.01 的重复通知）
        if (positive(c.pctHigh) && pct > c.pctHigh) cands.push({ level: 'high', win: worst })
        else if (positive(c.pctWarn) && pct > c.pctWarn) cands.push({ level: 'warn', win: worst })
      }
    }
    const soon = resetSoonWindow(s, c.resetSoonHours, now)
    if (soon) cands.push({ level: 'reset', win: soon })
    if (cands.length === 0) continue

    cands.sort((a, b) => byRank(a.level, b.level))
    const top = cands[0]
    out.push({
      id: s.id,
      name,
      title: `${name} ${NOTIFY_TITLE_TAIL[top.level]}`,
      body: buildNotifyBody(s, top.level, top.win, now),
      level: top.level
    })
  }
  return out
}

// ─── 去重锁存（prd.md 需求 4：同一供应商 + 窗口 + 阈值只提醒一次）────────────

/**
 * 锁存键：一条「通知事件」的身份 = 供应商 × 档位。
 *
 * ⚠ 供应商 id 形如 `inst:xxx-yyy`（ipc.ts 的实例 id 约定），里面本来就有冒号，所以这个键
 *   拼出来是有歧义的 —— 无妨：它只做集合相等比较，从不被解析（`hitKey` 用空格是为了
 *   人类读日志时能一眼分清两段，那是另一回事）。
 *
 * 键里带 level 是有意的：用量越过 80% 与「30 分钟后重置」是**两件事**，各自的键各自锁存，
 * 互不吞掉（同 NOTIFY_RANK 那条注释：同轮只弹最严重的一条，剩下那条要等条件解除后
 * 才有自己的回合，但它的键从没被误记成「弹过了」）。
 */
export function notifyKey(p: NotifyPayload): string {
  return `notify:${p.id}:${p.level}`
}

/**
 * 滤出**还没弹过**的候选（相对上一轮的锁存集合）。
 *
 * 不去重的话：一次采集一推就评估一轮（触发源是数据不是时间），而「用量超 80%」会连续
 * 几十轮都成立 —— 刷新间隔 60s 就变成每分钟弹一次同一条通知，通知中心直接被静音。
 *
 * 锁存的是「弹过」不是「发生过」：条件一解除，键就从集合里消失，再次越过才会重新弹
 * （充了额度又花光仍要看得见，AC5）。
 */
export function freshNotifies(payloads: NotifyPayload[], latched: Iterable<string>): NotifyPayload[] {
  const seen = new Set(latched)
  return payloads.filter((p) => !seen.has(notifyKey(p)))
}

/** 下一轮的锁存集合 = 本轮**真正弹出去**的那批键 */
export function notifyLatchKeys(payloads: NotifyPayload[]): string[] {
  return Array.from(new Set(payloads.map(notifyKey)))
}

/** 多个候选里最该弹的那一条（告警 > 提醒 > 重置临近）；null = 没有候选 */
export function worstNotify(payloads: NotifyPayload[]): NotifyPayload | null {
  let best: NotifyPayload | null = null
  for (const p of payloads) {
    if (best === null || byRank(p.level, best.level) < 0) best = p
  }
  return best
}
