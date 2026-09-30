import type { ProviderSnapshot } from '../../shared/types'
import { maxPercent } from './read-model'
import {
  balanceOf,
  checkTriggers,
  freshHits,
  latchKeys,
  mergeHits,
  type TriggerConfig,
  type TriggerKind
} from './smartBroadcast'
import { appendPoint, type HistoryPoint } from './history'

// ═══════════════════════════════════════════════════════════════════════════════
// 播报编排：一轮评估该**说什么、什么时候说、说完把记忆记成什么样**
//
// 为什么独立成模块：这 6 步此前写在 App.tsx 的 evaluateAlerts 里，而它是整个仓库里
// 盲审出 3 个致命 bug 的地方 —— 判定时序颠倒（相邻两差恒为 0，波动场景静默失效）、
// 锁存缺失（每 60s 数据推送重播同一句）、按供应商覆盖被丢弃。引擎（smartBroadcast.ts）
// 被 test-trigger-engine.mjs 覆盖得很好，但「调用方有没有按对的顺序把东西喂进去」
// 一直在测试之外：引擎答得了「给定快照与历史能不能判出命中」，答不了「谁先谁后」。
//
// 纯函数（无 electron / 无 DOM / 无 React）：now 由调用方传入，不读 Date.now()、
// 不碰 extras、不读 ref，因此 scripts/test-alert-orchestration.mjs 经 loadTs 跑同一份源码。
//
// 第二段职责是**确认状态机**（AC7「重复提醒直到确认」）：播一次只是开头，用户没确认之前
// 要按间隔重播，确认（或超窗 / 条件解除）才停。它住在同一模块里，因为它要答的正是
// 「这一轮该播什么」—— 与上面的锁存是同一条时间线上的两个阶段：播 → 未确认则重复 → 确认停止。
//
// ⚠ 与 design.md 的一处**刻意偏差**（行为要求，不是笔误）：
//   design 写的是「evaluate 返回 null 表示本轮不播」。但「不播」的那几轮（被 AC9 锁存
//   拦下 / 展开态挡下例行）**仍然必须记历史** —— 原代码在 `if (fresh.length === 0) return false`
//   之前就已经 persistHistory 了。不记的话 statsFor 永远攒不够 10 个点，异常检测静默失效。
//   所以把「不播」收进 Decision.text = null，evaluate 的 null 只留给「整轮无变更」
//   （没有快照：既不记历史也不动锁存）。字段名与 design 一致，只有这一处语义不同。
// ═══════════════════════════════════════════════════════════════════════════════

/** 一轮评估的输入。一份不可变快照：编排不读实时值、不闭包（定时器契约靠 App 的 ref 镜像）。 */
export interface AlertContext {
  /** 本轮的采集结果 */
  snapshots: ProviderSnapshot[]
  /** **上一轮**的采样。本轮采样不得提前入参 —— 否则「相邻两次之差」恒为 0（历史 bug #1） */
  history: HistoryPoint[]
  config: TriggerConfig
  triggerOn: Record<TriggerKind, boolean>
  format: 'simple' | 'detailed'
  hideBalance: boolean
  /** 不播报的供应商 id（空 = 全部播报） */
  muted: string[]
  /** 收起态才放行例行项（展开面板时屏幕上已经看得见，AC15） */
  collapsed: boolean
  /** 已播过的键集合（上升沿锁存，AC9） */
  latched: Iterable<string>
  /**
   * 已播但**还没被确认**的批次（AC7）。内存态，不落盘：用户重启应用说明他已经看到过屏幕，
   * 「上次播过」不该跨重启成立（同 alertLatchRef 的理由）。
   */
  pending: PendingAlert[]
  historyCap: number
  /** 本轮时刻（epoch ms）—— 纯函数不读自己的钟 */
  now: number
}

/** 一条待确认的播报批次（一轮里的所有命中合成一批，AC12） */
export interface PendingAlert {
  /** 这一批涉及的命中键。条件解除的判据：任一键不再命中，整批作废 */
  keys: string[]
  /** 首播的原文。重复时**原样复用**（不重算）——重算会把「还剩 8 元」说成别的数 */
  text: string
  urgent: boolean
  /** 首次播报时刻。自动确认窗口从它起算，不是从最后一次重复起算 */
  firstSpokenAt: number
  lastSpokenAt: number
  /** 用户点「知道了」的时刻；null = 还没确认。confirm() 标记，evaluate() 裁掉 */
  confirmedAt: number | null
}

/** 重复间隔：未确认期间每隔这么久重播同一条（用户裁定 5 分钟） */
export const REPEAT_MS = 5 * 60_000

/**
 * 自动确认窗口：从**首次播报**起算，超时自动确认（用户裁定 15 分钟 = 3 个重复周期）。
 *
 * ⚠ 必须**大于** REPEAT_MS，否则 AC7 是一座空房子：窗口比间隔短时，重复永远等不到 ——
 * 首播后不到 5 分钟就自动确认了，用户离开电脑边时只听得到 1 次，与「不重复」无异。
 * 「1 分钟自动确认」+「5 分钟重复」这两个数字曾经同时写在计划里，正是这一对矛盾。
 */
export const AUTO_CONFIRM_MS = 15 * 60_000

export interface Decision {
  /** 要念的那一句；null = 本轮不播（锁存拦下 / 展开态挡下例行 / 剔除后什么都不剩） */
  text: string | null
  /** 有紧急命中则整条按紧急插队（speechOut 会打断例行）；text 为 null 时恒为 false */
  urgent: boolean
  /** 下一轮的历史。与 ctx.history 同一引用 = 本轮没有新采样，调用方不必落盘 */
  nextHistory: HistoryPoint[]
  /** 下一轮的锁存集合：只含**实际进入播报判定**的那批键 */
  nextLatched: Set<string>
  /**
   * 下一轮的待确认批次。与 ctx.pending 同一引用 = 本轮一个批次都没动，调用方不必 setState
   * （与 nextHistory 同一约定：引用即信号）
   */
  nextPending: PendingAlert[]
  /** 本次播报是「新命中」还是「到期重复」——UI 据此决定要不要亮确认条 */
  reason: 'new' | 'repeat' | null
}

/**
 * 批次还「待确认」吗？三个死因，任何一条成立就整批作废：
 *   · 已确认 —— 用户点过「知道了」（FR3）
 *   · 超窗   —— 超过自动确认窗口（FR4）
 *   · 条件解除 —— 本轮命中里已经没有它的键了（FR6，充值之后不再重复提醒）
 *
 * 条件解除这一条是**解锁**的前提：它作废批次的同时，键也会从 nextLatched 消失，
 * 于是下次再越过阈值就是一轮全新的「新命中」（AC5）。
 */
function stillPending(b: PendingAlert, speakableKeys: Set<string>, now: number): boolean {
  if (b.confirmedAt !== null) return false
  if (now - b.firstSpokenAt >= AUTO_CONFIRM_MS) return false
  return b.keys.every((k) => speakableKeys.has(k))
}

/**
 * 跑一轮播报编排。返回 null 表示**整轮无变更**：没有快照，因此既不记历史也不动锁存。
 */
export function evaluate(ctx: AlertContext): Decision | null {
  if (ctx.snapshots.length === 0) return null

  // ① 判触发：沿用上一轮的历史；只判用户开着的场景，已静音的供应商不参与
  const hits = checkTriggers(ctx.snapshots, ctx.history, ctx.config, ctx.now)
    .filter((h) => ctx.triggerOn[h.kind] !== false)
    .filter((h) => !ctx.muted.includes(h.id))

  // ② 记历史：本轮采样在判定之后落库，供**下一轮**比对
  //    ⚠ 顺序不能反：先把本轮塞进 hist 的话，「相邻两次采样之差」恒为 0 —— 波动场景永远
  //    命中不了（AC4 静默失效），异常检测的均值也会被当轮自己拉偏。
  let next = ctx.history
  for (const s of ctx.snapshots) {
    if (s.status !== 'ok') continue
    next = appendPoint(
      next,
      { t: ctx.now, id: s.id, balance: balanceOf(s), percent: maxPercent(s) },
      ctx.historyCap
    )
  }

  // ③ 分级 + 锁存（AC9「恰好一次」）：条件持续成立期间只播一次。
  //    锁存的是**本轮进入播报判定的那批**（speakable），不是全部命中 —— 否则展开面板
  //    时被 AC15 挡下的例行项也被记成「播过了」，等用户收起面板就再也听不到。
  const speakable = ctx.collapsed ? hits : hits.filter((h) => h.level === 'urgent')
  const fresh = freshHits(speakable, ctx.latched)
  const nextLatched = new Set(latchKeys(speakable))

  // ④ 待确认批次（AC7）：先裁掉死的（已确认 / 超窗 / 条件解除），再看有没有到期的。
  //    什么都没裁时返回**入参那个引用**，与 nextHistory 同一约定。
  //    判据直接用 nextLatched —— 它就是本轮仍在成立的命中键集合。
  const alive = ctx.pending.filter((b) => stillPending(b, nextLatched, ctx.now))
  const kept = alive.length === ctx.pending.length ? ctx.pending : alive

  // ⑤ 本轮该说什么：**新命中优先**（FR8：出现新内容立刻播），没有新命中时才复用
  //    到期批次的原文（不重算）。一轮里多批同时到期时先播最久没播的那批，不饿死旧的。
  const freshText = mergeHits(fresh, ctx.format, { hideBalance: ctx.hideBalance })
  const due = alive
    .filter((b) => ctx.now - b.lastSpokenAt >= REPEAT_MS)
    .sort((a, b) => a.lastSpokenAt - b.lastSpokenAt)[0]

  let text: string | null = null
  let urgent = false
  let reason: 'new' | 'repeat' | null = null
  let nextPending = kept
  if (freshText !== null) {
    text = freshText
    urgent = fresh.some((h) => h.level === 'urgent')
    reason = 'new'
    nextPending = kept.concat({
      keys: latchKeys(fresh),
      text: freshText,
      urgent,
      firstSpokenAt: ctx.now,
      lastSpokenAt: ctx.now,
      confirmedAt: null
    })
  } else if (due) {
    text = due.text
    urgent = due.urgent
    reason = 'repeat'
    nextPending = kept.map((b) => (b === due ? { ...b, lastSpokenAt: ctx.now } : b))
  }

  // ⑥ 合并去重成一条；有紧急就整条按紧急插队（speechOut 会打断例行）
  return { text, urgent, nextHistory: next, nextLatched, nextPending, reason }
}

/**
 * 当前该由用户确认的那一批：**最后一次播报**时间最新的那批（已确认的不算）。
 *
 * 为什么取「最近播的」而不是「最早开批的」：用户点的「知道了」回应的是**他刚听到的那一句**。
 * 它同时天然满足 AC6 —— 一次确认只标记一批，另一批的计时原封不动。
 */
export function latestPending(pending: PendingAlert[]): PendingAlert | null {
  let best: PendingAlert | null = null
  for (const b of pending) {
    if (b.confirmedAt !== null) continue
    if (best === null || b.lastSpokenAt > best.lastSpokenAt) best = b
  }
  return best
}

/**
 * 用户点了「知道了」：给**最近播的那一批**打上确认时刻，其余批次原样保留。
 *
 * 只标记不删除：批次要留到下一轮 evaluate 才被裁掉，这样「刚点了确认」与「已确认」在
 * 数据上是同一件事，不靠 App 侧再维护一份「刚才确认过哪些」的名单。
 */
export function confirm(pending: PendingAlert[], now: number): PendingAlert[] {
  const target = latestPending(pending)
  if (!target) return pending
  return pending.map((b) => (b === target ? { ...b, confirmedAt: now } : b))
}

/** 距自动确认还剩几秒（0 = 已到期）。给 UI 显示「它会自己停」 */
export function pendingCountdown(b: PendingAlert, now: number): number {
  return Math.max(0, Math.ceil((b.firstSpokenAt + AUTO_CONFIRM_MS - now) / 1000))
}

/**
 * 确认气泡内可用的文字宽度（px）：气泡 max-width 190px 减左右 padding 各 11px。
 */
export const CONFIRM_LINE_WIDTH = 168

/**
 * 确认气泡字号 11px 下单个字符的近似宽度：全角/CJK 约占满字号宽，拉丁与数字约占半宽。
 *
 * ⚠ 为什么按像素而不是按字符数收口：气泡里的文案是「拉丁供应商名 + 中文明细」的混排，
 * 「OpenCode Go 余额不足，剩余 12 元」是 24 个字符、但约 185px；而「DeepSeek 余额不足，剩余 8 元」
 * 是 20 个字符、约 160px。按字符数取一个统一预算时，要么前者砍成「OpenCode Go 余额不足」
 * （丢掉金额这个最该看见的结论），要么后者溢出气泡被 CSS 静默裁掉。
 *
 * 这两个数是按 Chrome 实测（-apple-system / PingFang SC，11px/600）反着取的：
 * 「DeepSeek 余额不足，剩余 8 元」实测 159.7px、按这里算是 168px —— 估算偏高约 5%，
 * 是刻意的保守方向：宁可早砍一刀，也不要放行一句实际溢出的文案。
 */
const CHAR_W_FULL = 12
const CHAR_W_HALF = 6

const lineWidth = (s: string): number =>
  [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0xff ? CHAR_W_FULL : CHAR_W_HALF), 0)

/**
 * 确认气泡上显示的那一句：把播报原文收敛成**不会截断**的短句。
 *
 * 为什么收敛（2026-09-30 线上截图）：原实现直接把播报原文塞进 190px 的条子里配
 * `text-overflow: ellipsis`，长句必然被截成 "OpenCode Go …" —— 而"余额不足""已用 92%"
 * 这类最该看见的都在省略号里。完整内容已经通过 TTS 念给耳朵了，气泡只需要给一句
 * 「这条提醒是关于什么」的标题。
 *
 * 收口规则：累计宽度超出可用宽度时，在**预算内最后一个「，」**处断开。不在逗号中间硬砍，
 * 砍出来仍是完整短语；也不追加省略号 —— 加了就又变回那个吓人的截断感，而"后面还有内容"
 * 这件事耳朵已经知道。明细之间是「，」，明细自身也可能含「，」（如「余额不足，剩余 12.4 元」），
 * 所以这个粒度是近似的而非语义边界；好在它只会砍掉尾部次要内容。
 * 预算内没有逗号时原样返回，交给 CSS 的 nowrap + overflow:hidden 静默裁掉 —— 砍出一个半句
 * 比一句完整的话更糟。
 */
export function confirmLine(text: string, width = CONFIRM_LINE_WIDTH): string {
  const s = text.trim()
  if (!s) return ''
  if (lineWidth(s) <= width) return s
  let acc = 0
  let lastComma = -1
  for (let i = 0; i < s.length; i++) {
    // ⚠ 逗号是**切割边界**，必须记在超宽判断之前：切掉的那一刀就落在逗号前面，
    // 所以「恰好顶到边界的逗号」也要算进来。反验踩过这个坑 —— 把这句
    // 「DeepSeek 余额不足，剩余 8 元」加一个尾巴后，整句正好 168px 装得下，但循环在
    // 判断 acc + 12 > 168 时先 break 了，逗号没被记录，结果砍成「DeepSeek 余额不足」，
    // 把金额这个最该看见的结论丢了。
    if (s[i] === '，') lastComma = i
    const cw = s.charCodeAt(i) > 0xff ? CHAR_W_FULL : CHAR_W_HALF
    if (acc + cw > width) break
    acc += cw
  }
  return lastComma <= 0 ? s : s.slice(0, lastComma)
}
