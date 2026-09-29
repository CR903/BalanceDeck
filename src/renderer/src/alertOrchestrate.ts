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
  historyCap: number
  /** 本轮时刻（epoch ms）—— 纯函数不读自己的钟 */
  now: number
}

export interface Decision {
  /** 要念的那一句；null = 本轮不播（锁存拦下 / 展开态挡下例行 / 剔除后什么都不剩） */
  text: string | null
  /** 有紧急命中则整条按紧急插队（speechOut 会打断例行）；text 为 null 时恒为 false */
  urgent: boolean
  /** 下一轮的历史。与 ctx.history 同一引用 = 本轮没有新采样，调用方不必落盘 */
  nextHistory: HistoryPoint[]
  /** 下一轮的锁存集合：只含**实际进入播报判定**的那批键 */
  nextLatched: Set<string>
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

  // ④ 合并去重成一条；有紧急就整条按紧急插队（speechOut 会打断例行）
  const text = mergeHits(fresh, ctx.format, { hideBalance: ctx.hideBalance })
  return { text, urgent: fresh.some((h) => h.level === 'urgent'), nextHistory: next, nextLatched }
}
