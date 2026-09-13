import type { ProviderWindow } from '../../shared/types'

// Coding plan 类共用算法：5 小时块窗口 + 滚动周/月窗口（与 opencode 适配器同口径）。

export interface PlanPoint {
  t: number // epoch ms
  cost: number
  tokens: number
  model: string
}

export interface PlanLimits {
  fiveHour: number
  weekly: number
  monthly: number
}

/** 5 小时窗口（块）算法：窗口自首条记录起持续 5h，结束后首条新记录开新窗 */
export function activeBlockRange(pts: PlanPoint[], now: number, spanMs = 5 * 3600_000): { start: number; end: number } | null {
  if (pts.length === 0) return null
  let start = pts[0].t
  for (const p of pts) {
    if (p.t >= start + spanMs) start = p.t
  }
  const end = start + spanMs
  if (now >= end) return null
  return { start, end }
}

export function sumSince(pts: PlanPoint[], sinceMs: number, pick: (p: PlanPoint) => number): number {
  let s = 0
  for (const p of pts) if (p.t >= sinceMs) s += pick(p)
  return s
}

/** 解析 "5h,周,月" 逗号限额串（设置 extras limits:<id>），非法项回退默认 */
export function parseLimits(raw: string | null | undefined, def: PlanLimits): PlanLimits {
  if (!raw) return def
  const parts = raw.split(',').map((s) => parseFloat(s.trim()))
  const pick = (v: number | undefined, d: number): number =>
    v !== undefined && Number.isFinite(v) && v > 0 ? v : d
  return {
    fiveHour: pick(parts[0], def.fiveHour),
    weekly: pick(parts[1], def.weekly),
    monthly: pick(parts[2], def.monthly)
  }
}

/** 三窗口（5小时/本周/本月）：月窗取滚动 30 天与自然月用量较大者（保守） */
export function planWindows(pts: PlanPoint[], now: number, limits: PlanLimits): ProviderWindow[] {
  const windows: ProviderWindow[] = []
  const blk = activeBlockRange(pts, now)
  const blkPts = blk ? pts.filter((p) => p.t >= blk.start) : []
  windows.push(
    blk
      ? {
          name: '5 小时',
          used: blkPts.reduce((s, p) => s + p.cost, 0),
          tokens: blkPts.reduce((s, p) => s + p.tokens, 0),
          limit: limits.fiveHour,
          unit: 'usd',
          resetAt: new Date(blk.end).toISOString()
        }
      : { name: '5 小时', used: 0, limit: limits.fiveHour, unit: 'usd', note: '当前无活跃窗口' }
  )
  const wkStart = now - 7 * 86400_000
  windows.push({
    name: '本周（7天）',
    used: sumSince(pts, wkStart, (p) => p.cost),
    tokens: sumSince(pts, wkStart, (p) => p.tokens),
    limit: limits.weekly,
    unit: 'usd'
  })
  const moRollStart = now - 30 * 86400_000
  const moCalStart = new Date(now)
  moCalStart.setDate(1)
  moCalStart.setHours(0, 0, 0, 0)
  const moRoll = sumSince(pts, moRollStart, (p) => p.cost)
  const moCal = sumSince(pts, moCalStart.getTime(), (p) => p.cost)
  const moStart = moCal > moRoll ? moCalStart.getTime() : moRollStart
  windows.push({
    name: '本月',
    used: Math.max(moRoll, moCal),
    tokens: sumSince(pts, moStart, (p) => p.tokens),
    limit: limits.monthly,
    unit: 'usd',
    note: moCal > moRoll ? '自然月' : '滚动 30 天'
  })
  return windows
}

/** 每模型 30 天明细（Top N） */
export function planModelRows(stats: { byModel: Map<string, { cost: number; tokens: number }> }, topN = 6) {
  const rows = []
  for (const [model, v] of stats.byModel) rows.push({ model, cost: v.cost, tokens: v.tokens })
  return rows.sort((a, b) => b.cost - a.cost).slice(0, topN)
}
