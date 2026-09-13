import type { ProviderWindow, Unit } from '../../shared/types'
import { formatPercent, windowPercent } from '../../shared/percent'

// 数值格式化与窗口语义解析（UI 共用）
// 百分比计算与格式化在 shared/percent.ts —— 主进程托盘与渲染层共用同一实现
// 数据可信度判定在 shared/quality.ts —— 与调度器/单元测试共用同一实现

export { windowPercent }
export const fmtPercent = formatPercent
export { dataTime, isStale, staleLabel } from '../../shared/quality'

export function fmtAmount(v: number, unit: Unit): string {
  switch (unit) {
    case 'usd':
      return '$' + v.toFixed(2)
    case 'cny':
      return '¥' + v.toFixed(2)
    case 'token': {
      if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B'
      if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
      if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
      return v.toFixed(0)
    }
    case 'request':
      return v >= 1000 ? (v / 1e3).toFixed(1) + 'K' : v.toFixed(0)
    case 'percent':
      return v.toFixed(0) + '%'
    default:
      return v.toFixed(0)
  }
}

/** 时间距离（毫秒 → "2小时29分"） */
export function humanDur(ms: number): string {
  if (ms <= 0) return '已重置'
  const m = Math.round(ms / 60000)
  if (m < 1) return '<1分钟'
  if (m < 60) return `${m}分钟`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时${String(m % 60).padStart(2, '0')}分`
  const d = Math.floor(h / 24)
  return `${d}天${h % 24}小时`
}

export type Level = 'ok' | 'warn' | 'danger' | 'muted'

/** 阈值分级：≥85% 危险，≥60% 警告 */
export function levelOfPercent(pct: number | null, status: string): Level {
  if (status !== 'ok') return 'muted'
  if (pct == null) return 'muted'
  if (pct >= 85) return 'danger'
  if (pct >= 60) return 'warn'
  return 'ok'
}

export function timeAgo(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const d = now - t
  if (d < 5000) return '刚刚'
  if (d < 60000) return `${Math.round(d / 1000)} 秒前`
  if (d < 3600000) return `${Math.round(d / 60000)} 分钟前`
  return `${Math.round(d / 3600000)} 小时前`
}

/**
 * 紧凑相对时间（卡片角落用）：`刚刚` / `3分前` / `2时前` / `1天前`。
 * 注意 d<0（渲染时钟略旧于数据时间）也算"刚刚"，避免出现"已重置"这种错乱文案。
 */
export function shortAgo(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const d = now - t
  if (d < 60_000) return '刚刚'
  if (d < 3600_000) return `${Math.floor(d / 60000)}分前`
  if (d < 86400_000) return `${Math.floor(d / 3600_000)}时前`
  return `${Math.floor(d / 86400_000)}天前`
}
