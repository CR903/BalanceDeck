import type { ProviderSnapshot, ProviderWindow } from '../../shared/types'
import { levelOfPercent, windowPercent, type Level } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// 供应商快照的读模型：**一个**回答「哪个窗口重要、多严重」的地方
//
// 为什么独立成模块：此前主页卡片、详情页、收起态悬浮球各写一套 —— 同一个概念四处实现
// （CardLevel / snapLevel / severity / ballLevel，外加两份「主窗口」选择）。阈值与口径
// 分头改就会互相不一致，而且没有一处能被测试直接盯住。
//
// 分工：阈值判定仍在 format.levelOfPercent（百分比计算在 shared/percent，主进程托盘与
// 渲染层共用）；这里只决定「拿哪个数去比」「按什么排序」。三处视图都必须从这里取答案。
// ═══════════════════════════════════════════════════════════════════════════════

/** 卡片 / 详情页的主窗口：第一个带限额的窗口，否则第一个 */
export function primaryWindowIndex(s: ProviderSnapshot): number {
  if (s.windows.length === 0) return 0
  const i = s.windows.findIndex((w) => w.limit != null && w.limit > 0)
  return i >= 0 ? i : 0
}

export function primaryWindow(s: ProviderSnapshot): ProviderWindow | undefined {
  return s.windows[primaryWindowIndex(s)]
}

/** 最接近限额的窗口：收起态悬浮球用它（球面只放得下一个数） */
export function worstWindow(s: ProviderSnapshot | undefined): ProviderWindow | undefined {
  if (!s || s.status !== 'ok' || s.windows.length === 0) return undefined
  let best: ProviderWindow | undefined
  let bestPct = -1
  for (const w of s.windows) {
    const p = windowPercent(w)
    if (p != null && p > bestPct) {
      bestPct = p
      best = w
    }
  }
  return best ?? s.windows[0]
}

/** 快照里最大的百分比；没有可比的窗口则 null */
export function maxPercent(s: ProviderSnapshot): number | null {
  const pcts = s.windows.map(windowPercent).filter((p): p is number => p != null)
  return pcts.length ? Math.max(...pcts) : null
}

/** 整张快照的等级：状态优先（error 危险 / 非 ok 静音），否则取最严重的窗口 */
export function snapshotLevel(s: ProviderSnapshot): Level {
  if (s.status === 'error') return 'danger'
  if (s.status !== 'ok') return 'muted'
  const max = maxPercent(s)
  return max == null ? 'ok' : levelOfPercent(max, 'ok')
}

/** 单个窗口的等级 */
export function windowLevel(w: ProviderWindow): Level {
  return levelOfPercent(windowPercent(w), 'ok')
}

/**
 * 排序用的严重度：越需要关注越靠前。
 * 阈值不在这里重写 —— 直接由 snapshotLevel 推导，避免第二份 85/60。
 */
export function severityRank(s: ProviderSnapshot): number {
  if (s.status === 'error') return 3
  if (s.status === 'nodata') return 4
  switch (snapshotLevel(s)) {
    case 'danger':
      return 0
    case 'warn':
      return 1
    default:
      return 2
  }
}

/**
 * 收起态悬浮球的等级：状态优先（error=危险 / 非 ok=静音），
 * 否则看它当前显示的那个窗口 —— 与 snapshotLevel 的差别在于**没有百分比时**：
 * 球显示不出百分比就应该是灰的（muted），而不是按「取最大百分比」判成 ok。
 */
export function ballLevel(s: ProviderSnapshot | undefined, w: ProviderWindow | undefined): Level {
  if (!s) return 'muted'
  if (s.status === 'error') return 'danger'
  if (s.status !== 'ok') return 'muted'
  return w ? windowLevel(w) : 'muted'
}
