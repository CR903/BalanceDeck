import { buildAdapters, collectAll } from './adapters'
import { getKey, getExtra, setKey } from './keystore'
import { envValueFor, envExtraFor } from './scanner'
import { listInstances, listProviders } from './providers'
import { isOffline } from './net'
import { request } from './request'
import { applyCachePolicy } from '../shared/quality'
import { windowPercent } from '../shared/percent'
import { usageHistoryStore } from './usage-history'
import { createCollectLoop } from './collect-loop'
import {
  DEFAULT_RETENTION_DAYS,
  SNAPSHOT_INTERVAL_MS
} from './usageStore'
import type { StoreUsagePoint, UsagePoint } from '../shared/usage-predict'
import { PREDICT_KEYS } from '../shared/usage-predict'
import type { AppState, ProviderSnapshot, RefreshOutcome } from '../shared/types'

// ═══════════════════════════════════════════════════════════════════════════════
// 采集调度 —— 装配层
//
//   · 单一刷新频率（用户设置 10s–300s，默认 60s），一轮并行采集全部供应商
//   · 数据诚实（关键）：本轮失败时**沿用上次官方数据并标记 cached**，
//     绝不静默把"本机估算/过期数据"当成实时数据展示（会误导用户）
//
// 控制流（轮次预算 / 刷新语义 / 重入）不在这里，在 `collect-loop.ts`（纯逻辑，可单测）。
// 本文件只负责装配：构造轮体 `runRound`、接 `push` / `updateTray`、把对外导出接到循环上。
//
// 为什么抽出去（2026-10-18 任务 10-18-sync-collect-watchdog）：
//   旧控制流把「一轮」当成了不可中断的整体 —— `if (running) return` 一票否决、
//   整轮没有任何时间上界、两个来源各设一个定时器。真机症状是「同步 3 小时不动、
//   点刷新毫无反应，只能重启」；根因是 `running` 被一个永不 settle 的 await 永久卡死
//   （实测：落盘心跳冻结 + lsof 零连接 + 线程 99.4% 采样陷在 select()）。
// ═══════════════════════════════════════════════════════════════════════════════

type PushFn = (state: AppState) => void
type TrayFn = (snapshots: ProviderSnapshot[], meta: { offline: boolean }) => void

export const DEFAULT_INTERVAL = 60_000
export const MIN_INTERVAL = 10_000
export const MAX_INTERVAL = 300_000

/**
 * 轮次预算（R1）。取值依据 —— 单次出网超时 12s（`request.ts`），全部为串行 await：
 *   · opencode 官方 API 12s + 控制台 status 12s + billing 12s ≈ 36s
 *   · antigravity 的 postEachHost 是「3 host × 12s」× 2 条路径 ≈ 72s
 *   · `collectAll` 内部并行，取各适配器的最大值
 * → 2 分钟**显著大于**最坏合法轮次（避免误杀正常采集），同时把「永久卡死」
 *   降级为「最多卡 2 分钟 + 自动复位 + 可观测」。常量，不新增用户偏好（PRD Out of Scope）。
 */
export const COLLECT_BUDGET_MS = 120_000

/** 软阈值：超过只记一条「轮次偏慢」日志，**不打断**（用来判断将来是否该收敛串行请求） */
export const COLLECT_SLOW_WARN_MS = 45_000

let push: PushFn | null = null
let updateTray: TrayFn | null = null
let lastSnapshots: ProviderSnapshot[] = []
let lastSync: string | null = null

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
 * 统一的推送形状。`scanning` 的语义是「**有活要干**」（在飞或已排队），
 * 而不是「某一轮正在跑」—— 排队补跑的那一轮也要亮着，否则渲染层就得自己造一套
 * 乐观状态（两处状态机必然漂）。
 *
 * `lastTimeoutAt` 只在真的超时过之后才带上：缺失就是缺失，不拿空串/0 冒充
 * （data quality 纪律；UI 靠 `undefined` 决定要不要显示"本轮采集超时"）。
 * 它的**唯一持有者**是调度循环（超时那一刻由循环记下），这里只读不存 ——
 * 两处各存一份必然漂，而这一份的权威来源本就是「轮次被作废」这个事实。
 */
function stateWith(scanning: boolean): AppState {
  const at = loop.lastTimeoutAt()
  return {
    snapshots: lastSnapshots,
    lastSync,
    scanning,
    offline: isOffline(),
    ...(at ? { lastTimeoutAt: at } : {})
  }
}

/**
 * 轮体：「最后有效值」策略见 `src/shared/quality.ts`（纯函数，主进程/渲染层/测试共用）。
 * 这里只做调度侧的组合：上一轮快照 × 本轮结果 → 最终展示快照。
 *
 * ⚠ 两处 `current(epoch)` 是 R2 的闸门，**不许删**（`scripts/test-collect-loop.mjs` C8
 *   钉住「闸门出现在写入之前」）。超时那一轮仍在后台跑，它迟到回来时这里必须整个丢掉：
 *   否则看门狗复位后的新轮与旧轮会同时写 `lastSnapshots` / 推送 / 托盘。
 */
async function runRound(epoch: number, current: (e: number) => boolean): Promise<void> {
  debugLog(`collect start (epoch ${epoch})`)
  push?.(stateWith(true))
  try {
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

    if (!current(epoch)) {
      debugLog(`collect stale: epoch ${epoch} 已失效，丢弃 ${merged.length} 条迟到结果`)
      return
    }
    lastSnapshots = merged
    lastSync = now.toISOString()
    debugLog(
      `collect done: ${merged.length} 个供应商，cached=${merged.filter((s) => s.dataQuality === 'cached').length}，offline=${isOffline()}`
    )
  } catch (e) {
    debugLog(`collect error: ${(e as Error).message}`)
  } finally {
    // 收尾（历史采样 / 推送 / 托盘）同样在闸门之内：超时之后它们属于**旧轮** ——
    // 一推就会把 scanning:false 盖到新轮头上，还会把过期快照记成一条新的历史采样点。
    if (current(epoch)) {
      // 用量历史快照（P0-2）。放在收尾路径：采集**失败**的那几轮也照样有快照可记
      // （那正是 usage-predict 最需要数据的时刻），而这一段自身失败绝不能拖垮采集 ——
      // 所以是 `void … .catch()`，失败只落在 usageStore / sampleUsageHistory 的日志里。
      void sampleUsageHistory().catch(() => {})
      push?.(stateWith(false))
      updateTray?.(lastSnapshots, { offline: isOffline() })
    }
  }
}

// ─── 调度循环（唯一持有者）───────────────────────────────────────────────────

const loop = createCollectLoop({
  intervalMs: refreshIntervalMs,
  runRound,
  budgetMs: COLLECT_BUDGET_MS,
  slowWarnMs: COLLECT_SLOW_WARN_MS,
  /**
   * 超时收尾：本轮已被循环作废（epoch 失效），这里只如实推出状态。
   * **不伪造数据** —— 快照仍是上一轮那份，只是 `lastTimeoutAt` 记下这一刻，
   * 让状态行能说「本轮采集超时」而不是假装刚刷新过。
   */
  onTimeout: (_at, epoch) => {
    debugLog(`collect 超时（epoch ${epoch}）：本轮作废并复位，下一轮照常`)
    push?.(stateWith(false))
  },
  log: debugLog
})

export function startScheduler(onPush: PushFn, onTray: TrayFn): void {
  push = onPush
  updateTray = onTray
  loop.start()
}

/**
 * 立即刷新（手动）。返回 `started` / `queued` —— 渲染层据此知道「开始了」还是
 * 「已并入当前轮」（两者都不再是「静默丢弃」）。
 *
 * ⚠ 排队时必须**当场**推 `scanning: true`：正在跑的那一轮已经推过了，若这里不推，
 *   「点了没反应」会原样重现（UI 上没有任何东西变化）。
 */
export function refreshNow(): RefreshOutcome {
  const outcome = loop.requestRefresh()
  // R8：刷新的**结果**也要可观测。「被丢弃」是本次要修的症状之一，而它的另一副面孔是
  // 「日志里连一条记录都没有」—— 只推状态而不写日志，排障时就只能靠猜。
  debugLog(`刷新请求：${outcome}${outcome === 'queued' ? '（已并入当前轮，结束后立即补跑）' : ''}`)
  if (outcome === 'queued') push?.(stateWith(true))
  return outcome
}

/** 设置变更后重排节奏（频率改变立即生效，无需等下一轮） */
export function reconfigure(): void {
  loop.reconfigure()
}

/** 拖拽排序后按新顺序重排快照并立即推送（无需重新采集） */
export function resort(ids: string[]): void {
  const index = new Map(ids.map((id, i) => [id, i]))
  lastSnapshots = [...lastSnapshots].sort((a, b) => (index.get(a.id) ?? 999) - (index.get(b.id) ?? 999))
  push?.(stateWith(loop.isRunning()))
  updateTray?.(lastSnapshots, { offline: isOffline() })
}

export function currentState(): AppState {
  return stateWith(loop.isRunning())
}

/**
 * 排障/测试专用：直接推送一组快照。
 * 用途：`--uitest` 验证"缓存 / 本机估算 / 出错"等降级渲染分支（这些分支靠真实数据很难复现）。
 */
export function debugPush(snapshots: ProviderSnapshot[], offline = false): void {
  lastSnapshots = snapshots
  lastSync = new Date().toISOString()
  const at = loop.lastTimeoutAt()
  push?.({
    snapshots,
    lastSync,
    scanning: false,
    offline,
    ...(at ? { lastTimeoutAt: at } : {})
  })
  updateTray?.(snapshots, { offline })
}

export function stopScheduler(): void {
  loop.stop()
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
      // pct 不可知时写 null（**不写 0**）—— usageStore 也再兜一次，两处都守同一条纪律
      // used / unit 成对记：热力图下方的逐日明细要「当天具体用了多少钱」，
      // 只存 pct 的话用户在 $12 额度和 $120 额度上看的是同一个数
      points.push({
        providerId: s.id,
        window: w.name,
        pct: windowPercent(w),
        used: w.used,
        unit: w.unit,
        t: now
      })
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
