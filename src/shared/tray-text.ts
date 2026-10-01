import type { ProviderSnapshot, ProviderWindow } from './types'
import { formatPercent, windowPercent } from './percent'
import { ANSI_RESET, ansiColor, levelOfPercent, stripAnsi } from './levels'

// ═══════════════════════════════════════════════════════════════════════════════
// 状态栏（托盘）文案
//
// 展示 = **卡片顺序第一位**的供应商（用户拖拽排序即优先级）：
//   · 多个时限窗口（Go 的 5 小时/周/月）→ 全部平铺：`5H 2.7% W 51.9% M 67.9%`
//   · 单窗口余额 → 金额：`$12.34`
//   · 数据为缓存/本机估算，或系统离线 → 前缀 ⚠
//
// 纯函数（不依赖 electron），主进程与单元测试共用。
// ═══════════════════════════════════════════════════════════════════════════════

/** 窗口名 → 状态栏短标签（5 小时 → 5H；本周 → W；本月 → M） */
export function shortWindowLabel(name: string): string {
  const n = name || ''
  if (/5\s*小时|5\s*h/i.test(n)) return '5H'
  if (/小时|hour/i.test(n)) return 'H'
  if (/周|week/i.test(n)) return 'W'
  if (/月|month/i.test(n)) return 'M'
  if (/天|日|day/i.test(n)) return 'D'
  if (/余额|balance/i.test(n)) return '$'
  return n.slice(0, 2)
}

/**
 * 金额紧凑写法（状态栏空间有限）。
 * 余额是用户最关心的数字之一，**宁可长一点也要准**：
 * 万元以下保留两位小数，只有很大时才用 k/M 缩写。
 */
export function compactAmount(w: ProviderWindow): string {
  const v = w.used
  const fmt = (sym: string): string => {
    if (v >= 1e6) return sym + (v / 1e6).toFixed(1) + 'M'
    if (v >= 1e4) return sym + (v / 1e3).toFixed(1) + 'k'
    return sym + v.toFixed(2)
  }
  if (w.unit === 'usd') return fmt('$')
  if (w.unit === 'cny') return fmt('¥')
  if (w.unit === 'token') {
    if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B'
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
    if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K'
    return String(Math.round(v))
  }
  if (w.unit === 'percent') return formatPercent(v)
  return String(Math.round(v))
}

/**
 * 摘要的**分段**形式：每段带自己的百分比（没有则 null）。
 *
 * 为什么不直接返回字符串：托盘标题要给每段单独上色（按各自的百分比判等级），
 * tooltip 又必须拿到**纯文案**。两份拼装必然漂移 —— 一旦有人改了措辞，标题和
 * tooltip 就会一个说「M 67.9%」另一个说「本月 67.9%」。所以先出分段，渲染方式两种。
 */
function summaryParts(s: ProviderSnapshot): { text: string; pct: number | null }[] {
  if (s.status === 'error' || s.status === 'nodata' || s.windows.length === 0) return []
  const pctWindows = s.windows.filter((w) => windowPercent(w) != null)
  if (pctWindows.length >= 2) {
    return pctWindows.map((w) => ({
      text: `${shortWindowLabel(w.name)} ${formatPercent(windowPercent(w)!)}`,
      pct: windowPercent(w)
    }))
  }
  const w = pctWindows[0] ?? s.windows[0]
  if (!w) return []
  const pct = windowPercent(w)
  if (pct != null) {
    return [{ text: `${pctWindows.length ? shortWindowLabel(w.name) + ' ' : ''}${formatPercent(pct)}`, pct }]
  }
  return [{ text: compactAmount(w), pct: null }]
}

/** 某个供应商在状态栏里的摘要：多窗口全展示，单窗口按百分比/金额（tooltip 用这份） */
export function providerSummary(s: ProviderSnapshot): string {
  return summaryParts(s)
    .map((p) => p.text)
    .join(' ')
}

/** 主供应商：卡片顺序里第一个有数据的；都没有则第一个 */
export function primarySnapshot(snapshots: ProviderSnapshot[]): ProviderSnapshot | undefined {
  return snapshots.find((s) => s.status === 'ok' && s.windows.length > 0) ?? snapshots[0]
}

/**
 * 托盘标题（状态栏文字）。
 *
 * 文案结构与措辞**逐字未变**，只是把每段用 ANSI 包裹（等级由**该段百分比**决定，
 * 阈值来自 shared/levels.ts 的唯一一份 levelOfPercent）。ok 档拿到空串转义，
 * 于是输出与改动前**逐字节相同** —— 正常用量的用户不该看到任何变化。
 * ⚠ 颜色不表达数据源：cached / local 由已有的 ⚠ 前缀表达，混在一起会让人以为
 *   「缓存的颜色就是另一种颜色」。
 * ⚠ 段与段之间的空格与 ⚠ 前缀**不着色**（reset 之后 attributes 被清空）。
 */
export function trayTitle(snapshots: ProviderSnapshot[], offline: boolean): string {
  const s = primarySnapshot(snapshots)
  const parts = s ? summaryParts(s) : []
  const body = parts
    .map((p) => {
      const color = ansiColor(levelOfPercent(p.pct, s?.status ?? 'ok'))
      return color ? `${color}${p.text}${ANSI_RESET}` : p.text
    })
    .join(' ')
  if (!body) {
    if (snapshots.length === 0) return ''
    return snapshots.some((x) => x.status === 'ok') ? '✓' : ''
  }
  const stale = s?.dataQuality === 'cached' || s?.dataQuality === 'local'
  return `${offline || stale ? '⚠ ' : ''}${body}`
}

/**
 * 剥掉转义后的托盘标题 —— **纯文案**。
 * 单元测试读它：那条路径上没有任何终端，拿到 `\x1b[33m` 只会显示成乱码。
 * 存在的意义是让「加了色但一个字没改」这条断言有个可执行的对象。
 *
 * ⚠ 生产路径**不**走它：tooltip 由 `tray.ts` 用 `providerSummary`（纯文本）逐行拼，
 *   本函数只服务测试。托盘标题本身走 `trayTitle`（带色，macOS 才 `setTitle`）。
 */
export function stripAnsiTitle(snapshots: ProviderSnapshot[], offline: boolean): string {
  return stripAnsi(trayTitle(snapshots, offline))
}

/** 可信度后缀（tooltip 用） */
export function qualitySuffix(s: ProviderSnapshot): string {
  if (s.dataQuality === 'cached') return '（缓存）'
  if (s.dataQuality === 'local') return '（本机估算）'
  return ''
}
