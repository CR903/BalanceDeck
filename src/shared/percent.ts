// 百分比计算与格式化（主进程托盘与渲染层共用，保证各端显示一致）

import type { ProviderWindow } from './types'

/** 数值四舍五入到一位小数（展示前的归一化，杜绝无限小数） */
export function roundPercent(p: number): number {
  return Math.round(p * 10) / 10
}

/**
 * 用量比例：`percent`（服务端真值）优先，否则由 `used/limit` 推算。
 * 结果统一归一化到一位小数 —— 各端（卡片/详情/托盘/圆点）显示必须一致。
 */
export function windowPercent(w: ProviderWindow): number | null {
  let raw: number | null = null
  if (w.percent != null && Number.isFinite(w.percent)) raw = w.percent
  else if (w.limit != null && w.limit > 0) raw = (w.used / w.limit) * 100
  if (raw == null) return null
  return roundPercent(Math.max(0, Math.min(100, raw)))
}

/**
 * 百分比显示规则：
 *   - 整数不带小数（`4%`）
 *   - 有位小数时保留一位（`4.3%`）
 *   - 多于一位小数四舍五入到一位（`4.53888625` → `4.5%`）
 */
export function formatPercent(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return '—'
  const rounded = roundPercent(p)
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`
}
