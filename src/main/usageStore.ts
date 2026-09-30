import { existsSync, readFileSync, writeFileSync } from 'fs'
import {
  DEFAULT_PREDICT_CONFIG,
  MAX_RETENTION_DAYS,
  type StoreUsagePoint,
  type UsagePoint
} from '../shared/usage-predict'

// ═══════════════════════════════════════════════════════════════════════════════
// 用量历史快照的落盘存储（**不依赖 electron**）
//
// electron 只出现一样东西，由装配层（usage-history.ts）注入：文件路径。生产是
// app.getPath('userData')，必须**惰性**求值 —— BD_USER_DATA 在 app ready 前才 setPath，
// 而模块导入早于模块体求值（与 store.ts 同一理由与同一写法）。
//
// 磁盘格式（version 1）：
//   { version: 1, days: { 'YYYY-MM-DD': { <providerId>: { window, t, pct }[] } } }
//
// ⚠ 为什么**不走 extras**（design.md B2）：`store.ts` 的 setExtra 每次都 persist() →
//   writeFileSync 整个文件。30 天 × 60s × N 供应商的分窗口快照约 8–12MB，
//   每 60s 全量重写一次 ≈ **每天 200GB 写盘**。按 15 分钟采样降到约 600KB 仍不可接受。
//   独立文件 + 独立的键空间，B2 的问题在结构上不存在。
//   test-usage-store.mjs 有一条负向断言守着这个前提（不得 import extras / keystore）。
//
// 纯逻辑（格式 / 切天 / 裁剪 / 损坏重建）都在这里，可被 scripts/test-usage-store.mjs 经
// loadTs 跑真源码；它**不读自己的钟** —— now 一律由调用方传入。
// ═══════════════════════════════════════════════════════════════════════════════

/** 本地快照保留天数（默认 30 天，可配） */
export const DEFAULT_RETENTION_DAYS = DEFAULT_PREDICT_CONFIG.retentionDays

/**
 * 快照采样间隔（毫秒）。默认 **15 分钟**（design.md B3）。
 *
 * 为什么独立于采集频率（默认 60s）：消耗速率不需要秒级精度，而 60s 采样在 30 天保留期下
 * 体积不可接受（B2）。15 分钟粒度对「按当前速率预计何时用完」完全够用
 * （7 天 = 672 个点），体积降到 1/60。
 */
export const SNAPSHOT_INTERVAL_MS = 15 * 60_000

const DAY = 86_400_000

/** 磁盘上的一条采样：`window` 完整落盘，读历史的人不必回头查代码才知道那列是什么 */
interface DayPoint {
  window: string
  t: number
  pct: number | null
}

interface UsageFile {
  version: 1
  days: Record<string, Record<string, DayPoint[]>>
}

export interface UsageStore {
  /** 追加一批采样；只动各自那一天的分桶，并裁掉超出保留期的分桶 */
  appendBatch(points: StoreUsagePoint[], now: number, retentionDays?: number): void
  /** 读回某供应商最近 N 天的采样，按窗口分组（`{ 窗口名: UsagePoint[] }`，按 t 升序） */
  loadRecent(providerId: string, days: number, now: number): Record<string, UsagePoint[]>
  /** 立即按保留期裁剪（设置改完后不等下一轮采样） */
  prune(now: number, retentionDays?: number): void
  /** 清空（删掉全部历史）。预测是增值功能，没有历史只是不显示 */
  clear(): void
}

// ─── 切天与裁剪 ─────────────────────────────────────────────────────────────

/** 本地时区的 `YYYY-MM-DD`。用本地日而不是 UTC 日：用户的心智是「今天」，而跨时区切成
 *  UTC 日会在每天早上把最近 8 小时的采样归到「昨天」，于是日分桶名不副实。 */
function dayKey(t: number): string {
  const d = new Date(t)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * 「保留 keepDays 天」对应的最早分桶键。
 *
 * 用**日历**减法（`new Date(y, m, d - n)`）而不是 `now - n * 86400_000`：后者跨夏令时
 * 会差出一个小时，恰好把边界那一天算进或漏掉。日历减法交给 Date 自己处理。
 * 零填充的 `YYYY-MM-DD` 字典序即时间序，所以裁剪就是一次字符串比较。
 */
function cutoffDayKey(now: number, keepDays: number): string {
  const d = new Date(now)
  return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (keepDays - 1)).getTime())
}

/** 保留期脏值（NaN / 0 / 负数 / 超过上限）一律落向默认 —— 绝不落向「不裁」 */
function keepDaysOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return DEFAULT_RETENTION_DAYS
  return Math.min(MAX_RETENTION_DAYS, Math.floor(v))
}

// ─── 工厂 ───────────────────────────────────────────────────────────────────

export function createUsageStore(opts: { filePath: () => string }): UsageStore {
  const { filePath } = opts
  let cache: UsageFile | null = null

  function load(): UsageFile {
    if (cache) return cache
    try {
      const p = filePath()
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, 'utf-8')) as UsageFile
        if (raw?.version === 1 && raw.days && typeof raw.days === 'object') {
          cache = raw
          return cache
        }
      }
    } catch {
      // 损坏则重建（与 store.ts 的 load() 同一纪律：不抛，预测是增值功能）
    }
    cache = { version: 1, days: {} }
    return cache
  }

  function persist(): void {
    if (!cache) return
    writeFileSync(filePath(), JSON.stringify(cache), 'utf-8')
  }

  function dropExpired(now: number, keepDays: number): void {
    if (!cache) return
    const cut = cutoffDayKey(now, keepDays)
    for (const k of Object.keys(cache.days)) {
      if (k < cut) delete cache.days[k]
    }
  }

  return {
    appendBatch(points, now, retentionDays) {
      if (!Array.isArray(points) || points.length === 0) return
      const keep = keepDaysOf(retentionDays)
      const f = load()
      let added = 0
      for (const p of points) {
        if (!p || typeof p.providerId !== 'string' || !p.providerId) continue
        if (typeof p.t !== 'number' || !Number.isFinite(p.t)) continue
        // 按**点自己的时刻**分桶而不是按 now：一批采样理论上都在同一时刻，
        // 但按点分桶在跨零点时也不会把那一刻的点错记到前一天。
        const day = (f.days[dayKey(p.t)] ??= {})
        const arr = (day[p.providerId] ??= [])
        // pct 不可知时写 null，**不写 0**（缺失值保持缺失）
        arr.push({
          window: typeof p.window === 'string' ? p.window : '',
          t: p.t,
          pct: typeof p.pct === 'number' && Number.isFinite(p.pct) ? p.pct : null
        })
        added++
      }
      if (added === 0) return
      dropExpired(now, keep)
      persist()
    },

    loadRecent(providerId, days, now) {
      const f = load()
      if (typeof providerId !== 'string' || !providerId) return {}
      const cut = cutoffDayKey(now, keepDaysOf(days))
      const out: Record<string, UsagePoint[]> = {}
      for (const k of Object.keys(f.days).sort()) {
        if (k < cut) continue
        const arr = f.days[k]?.[providerId]
        if (!Array.isArray(arr)) continue
        for (const d of arr) {
          if (!d || typeof d.t !== 'number' || !Number.isFinite(d.t)) continue
          const w = typeof d.window === 'string' ? d.window : ''
          ;(out[w] ??= []).push({
            t: d.t,
            pct: typeof d.pct === 'number' && Number.isFinite(d.pct) ? d.pct : null
          })
        }
      }
      // 合并多天分桶后按 t 升序：回归对点的顺序敏感（切段就靠顺序），
      // 而 JSON 对象的键序是插入序、`days` 的键又是日序，跨天时未必天然有序
      for (const w of Object.keys(out)) out[w].sort((a, b) => a.t - b.t)
      return out
    },

    prune(now, retentionDays) {
      load()
      dropExpired(now, keepDaysOf(retentionDays))
      persist()
    },

    clear() {
      cache = { version: 1, days: {} }
      persist()
    }
  }
}
