import { buildAdapters, collectAll } from './adapters'
import { getKey, getExtra, setKey } from './keystore'
import { envValueFor, envExtraFor } from './scanner'
import { listInstances, listProviders } from './providers'
import { isOffline } from './net'
import { request } from './request'
import { applyCachePolicy } from '../shared/quality'
import { windowPercent } from '../shared/percent'
import { usageHistoryStore } from './usage-history'
import {
  DEFAULT_RETENTION_DAYS,
  SNAPSHOT_INTERVAL_MS
} from './usageStore'
import type { StoreUsagePoint, UsagePoint } from '../shared/usage-predict'
import { PREDICT_KEYS } from '../shared/usage-predict'
import type { AppState, ProviderSnapshot } from '../shared/types'

// ═══════════════════════════════════════════════════════════════════════════════
// 采集调度
//
//   · 单一刷新频率（用户设置 10s–300s，默认 60s），一轮并行采集全部供应商
//   · 数据诚实（关键）：本轮失败时**沿用上次官方数据并标记 cached**，
//     绝不静默把"本机估算/过期数据"当成实时数据展示（会误导用户）
// ═══════════════════════════════════════════════════════════════════════════════

type PushFn = (state: AppState) => void
type TrayFn = (snapshots: ProviderSnapshot[], meta: { offline: boolean }) => void

export const DEFAULT_INTERVAL = 60_000
export const MIN_INTERVAL = 10_000
export const MAX_INTERVAL = 300_000

let push: PushFn | null = null
let updateTray: TrayFn | null = null
let lastSnapshots: ProviderSnapshot[] = []
let lastSync: string | null = null
let timer: NodeJS.Timeout | null = null
let running = false

/** 每轮动态读取设置的自定义间隔（extras refreshInterval，秒）；兼容旧的 interval:plan */
export async function refreshIntervalMs(): Promise<number> {
  const raw = (await getExtra('refreshInterval')) ?? (await getExtra('interval:plan'))
  const n = raw ? parseFloat(raw) * 1000 : NaN
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, n))
}

/** 调试追踪（BALANCEDECK_DEBUG=1 时写入 /tmp/balancedeck-scheduler.log） */
function debugLog(msg: string): void {
  if (!process.env.BALANCEDECK_DEBUG) return
  void import('fs').then(({ appendFileSync }) =>
    appendFileSync('/tmp/balancedeck-scheduler.log', `${new Date().toISOString()} ${msg}\n`)
  )
}

/**
 * 「最后有效值」策略见 `src/shared/quality.ts`（纯函数，主进程/渲染层/测试共用）。
 * 这里只做调度侧的组合：上一轮快照 × 本轮结果 → 最终展示快照。
 */
async function collect(announce = false): Promise<void> {
  if (running) return
  running = true
  debugLog('collect start')
  try {
    if (announce) {
      push?.({ snapshots: lastSnapshots, lastSync, scanning: true, offline: isOffline() })
    }
    const now = new Date()
    const adapters = buildAdapters(await listInstances())
    const fresh = await collectAll(adapters, {
      now,
      getKey: async (id) => (await getKey(id)) ?? envValueFor(id),
      getExtra: async (k) => (await getExtra(k)) ?? envExtraFor(k),
      setKey: async (id, v) => setKey(id, v),
      // 出网能力：生产实现（fetch + 超时 + 可达性记账）。测试给它桩，适配器即可单测。
      request
    })

    // 被禁用/删除的供应商从展示中移除；顺序按注册表（= 用户拖拽排序）
    const registry = await listProviders()
    const activeIds = registry.filter((p) => p.enabled).map((p) => p.id)
    const prevById = new Map(lastSnapshots.map((s) => [s.id, s]))
    const freshById = new Map(fresh.map((s) => [s.id, s]))
    const merged: ProviderSnapshot[] = []
    for (const id of activeIds) {
      const next = freshById.get(id)
      if (next) merged.push(applyCachePolicy(prevById.get(id), next))
    }

    lastSnapshots = merged
    lastSync = now.toISOString()
    debugLog(
      `collect done: ${merged.length} 个供应商，cached=${merged.filter((s) => s.dataQuality === 'cached').length}，offline=${isOffline()}`
    )
  } catch (e) {
    debugLog(`collect error: ${(e as Error).message}`)
  } finally {
    running = false
    // 用量历史快照（P0-2）。放在 finally 里：采集**失败**的那几轮也照样有快照可记
    // （那正是 usage-predict 最需要数据的时刻），而这一段自身失败绝不能拖垮采集 ——
    // 所以是 `void … .catch()`，失败只落在 usageStore / sampleUsageHistory 的日志里。
    void sampleUsageHistory().catch(() => {})
    push?.({ snapshots: lastSnapshots, lastSync, scanning: false, offline: isOffline() })
    updateTray?.(lastSnapshots, { offline: isOffline() })
  }
}

// ─── 用量历史快照（P0-2）─────────────────────────────────────────────────────

/** 上一次记快照的时刻。null = 还没记过（首轮立即记一条） */
let lastSnapshotAt: number | null = null

/**
 * 把本轮快照写成一条历史采样。
 *
 * 三条纪律：
 *   1. **按间隔记，不按采集记**（SNAPSHOT_INTERVAL_MS = 15 分钟）。采集默认 60s，
 *      而消耗速率不需要秒级精度 —— 30 天保留期下每 60s 记一条会让快照文件
 *      涨到十几 MB（design.md B2/B3）。**不新增任何网络请求**（AC4）。
 *   2. **只记可信的**：status !== 'ok' 的快照不进历史。没有可信数据时写一条
 *      「没有」，会让速率回归出一条平线，看起来像「用量停了」。
 *   3. **写入失败不抛**：预测是增值功能，它坏了不该让采集跟着一起坏。
 *      这里只 debugLog —— 症状是「详情页不显示预计耗尽时间」，而不是应用起不来。
 */
async function sampleUsageHistory(): Promise<void> {
  const now = Date.now()
  if (lastSnapshotAt !== null && now - lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return
  lastSnapshotAt = now
  if (lastSnapshots.length === 0) return
  const points: StoreUsagePoint[] = []
  for (const s of lastSnapshots) {
    if (s.status !== 'ok') continue
    for (const w of s.windows) {
      // 百分比不可知时写 null（**不写 0**）—— usageStore 也再兜一次，两处都守同一条纪律
      points.push({ providerId: s.id, window: w.name, pct: windowPercent(w), t: now })
    }
  }
  if (points.length === 0) return
  try {
    const retention = await readRetentionDays()
    usageHistoryStore.appendBatch(points, now, retention)
    debugLog(`usage snapshot: ${points.length} 条，保留 ${retention} 天`)
  } catch (e) {
    debugLog(`usage snapshot error: ${(e as Error).message}`)
  }
}

/**
 * 保留期从 extras 读（`sample:usageHistoryDays`，**非 ui: 前缀**）。
 *
 * 每 15 分钟读一次磁盘是刻意接受的：extras 读一次要过一次 IPC 与 JSON 解析，
 * 而保留期是用户几乎不改的值。为了它每轮采集（60s）都读不值得。
 * 脏值落向默认（`usageStore` 的 keepDaysOf 还会再兜一层，两处都守同一条纪律）。
 */
async function readRetentionDays(): Promise<number> {
  const raw = await getExtra(PREDICT_KEYS.retention)
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS
}

/** 供 IPC 用：读回某供应商最近 N 天的分窗口采样（不落盘、无副作用） */
export function loadUsageHistory(providerId: string, days: number, now: number): Record<string, UsagePoint[]> {
  return usageHistoryStore.loadRecent(providerId, days, now)
}

/** 供 IPC 用：设置改了保留期之后立刻裁一次（不必等下一轮 15 分钟采样） */
export function pruneUsageHistory(now: number, retentionDays: number): void {
  usageHistoryStore.prune(now, retentionDays)
}

/**
 * 自续定时循环：首轮用 initialDelay，之后每轮按最新设置取间隔。
 * ⚠️ 曾经写成 `.finally(() => scheduleLoop(kind))`，默认 delay=0 → 循环空转
 * （每几秒打一次 API，数值看起来"实时在变"）。这里显式用 refreshIntervalMs。
 */
function scheduleLoop(initialDelay?: number): void {
  void (async () => {
    const delay = initialDelay ?? (await refreshIntervalMs())
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void collect()
        .catch(() => {})
        .finally(() => scheduleLoop())
    }, delay)
  })()
}

export function startScheduler(onPush: PushFn, onTray: TrayFn): void {
  push = onPush
  updateTray = onTray
  scheduleLoop(0) // 首轮立即采集
}

/** 立即刷新（手动）；同时把自动刷新计时重置为完整间隔 */
export function refreshNow(): void {
  void collect(true).finally(() => scheduleLoop())
}

/** 设置变更后重排节奏（频率改变立即生效，无需等下一轮） */
export function reconfigure(): void {
  refreshNow()
}

/** 拖拽排序后按新顺序重排快照并立即推送（无需重新采集） */
export function resort(ids: string[]): void {
  const index = new Map(ids.map((id, i) => [id, i]))
  lastSnapshots = [...lastSnapshots].sort((a, b) => (index.get(a.id) ?? 999) - (index.get(b.id) ?? 999))
  push?.({ snapshots: lastSnapshots, lastSync, scanning: running, offline: isOffline() })
  updateTray?.(lastSnapshots, { offline: isOffline() })
}

export function currentState(): AppState {
  return { snapshots: lastSnapshots, lastSync, scanning: running, offline: isOffline() }
}

/**
 * 排障/测试专用：直接推送一组快照。
 * 用途：`--uitest` 验证"缓存 / 本机估算 / 出错"等降级渲染分支（这些分支靠真实数据很难复现）。
 */
export function debugPush(snapshots: ProviderSnapshot[], offline = false): void {
  lastSnapshots = snapshots
  lastSync = new Date().toISOString()
  push?.({ snapshots, lastSync, scanning: false, offline })
  updateTray?.(snapshots, { offline })
}

export function stopScheduler(): void {
  if (timer) clearTimeout(timer)
  timer = null
}
