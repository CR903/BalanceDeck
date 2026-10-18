// ═══════════════════════════════════════════════════════════════════════════════
// 采集调度循环 —— 轮次预算 / 刷新语义 / 轮次失效（R1·R2·R4·R5·R6）
//
// 为什么单独成模块：调度是**纯逻辑**（不 import electron），而它此前与采集轮体
// 挤在 `scheduler.ts` 里，导致「重入」「超时后谁复位」「刷新被丢弃」这些判据
// 只能靠读代码，无法被单测加载。这里把控制流抽出来，`scheduler.ts` 只留装配。
//
// 与旧实现的三处结构性差别（每条都对应一个真实症状）：
//   1. **循环式而非定时器式**：`while + await sleep(delay)` 取代 `setTimeout`。
//      `scheduler.ts` 旧版有两个来源各调一次 `scheduleLoop()`，先设的句柄失去引用
//      → `stopScheduler()` 清不掉 → 定时器泄漏（R6）。循环里**结构上不存在**
//      「第二个句柄」：只有一个睡眠者，句柄是闭包局部量。
//   2. **轮次预算**：每轮都在 `withDeadline` 里跑，超时即复位并如实推出状态（R1）。
//   3. **epoch 失效**：超时那一刻该轮次号作废，轮体在任何写入/推送前必须问
//      `current(epoch)` —— 迟到结果被挡在门外（R2）。只复位 `running` 是不够的，
//      那会让两轮同时写状态。
//
// 纯逻辑模块，`scripts/test-collect-loop.mjs` 直接加载真源码跑。
// ═══════════════════════════════════════════════════════════════════════════════

import { withDeadline, type DeadlineOutcome } from './deadline'
import type { RefreshOutcome } from '../shared/types'

export interface CollectLoopOptions {
  /** 每轮开始前现读设置的自定义间隔（异步：要过一次 extras 读取） */
  intervalMs: () => Promise<number>
  /**
   * 轮体：真正做采集与推送的地方。两个入参都是契约的一部分 ——
   *   · `epoch` 是本轮次号；
   *   · `current(epoch)` 是**唯一的写入许可**：轮体在写快照 / 时间戳 / 推状态 / 推托盘
   *     之前必须问一次，得到 false 就把本轮结果整个丢掉（R2）。
   */
  runRound: (epoch: number, current: (e: number) => boolean) => Promise<void>
  /** 轮次预算（毫秒）。超时即作废该轮并复位 */
  budgetMs: number
  /** 软阈值：超过只记一条「轮次偏慢」，**不打断** */
  slowWarnMs: number
  /** 超时收尾回调（调用方负责推送 `scanning:false` + 记录超时时刻） */
  onTimeout: (at: string, epoch: number) => void
  log: (msg: string) => void
}

export interface CollectLoop {
  /** 幂等启动唯一调度循环 */
  start(): void
  /** 停循环（`stopScheduler` 用）；不打断在飞轮次，只保证不再排新轮 */
  stop(): void
  /** 立即跑下一轮（首轮、手动刷新、重配）；已在跑则记为「合并待跑」 */
  requestRefresh(): RefreshOutcome
  /** 设置变更后按新间隔重排（`reconfigure` 用） */
  reconfigure(): void
  /** 是否有活要干（在飞或已排队）。推送里的 `scanning` 与本值同义 */
  isRunning(): boolean
  /** 本轮是否仍是最新轮次 —— 轮体在**任何写入/推送前**必须问一次（R2） */
  isCurrent(epoch: number): boolean
  /** 最近一次轮次超时的时刻（ISO）；本进程还没超时过则为 null */
  lastTimeoutAt(): string | null
}

export function createCollectLoop(opts: CollectLoopOptions): CollectLoop {
  /** 单调递增的轮次号；**同时**是「谁是当前轮」的判据（R2） */
  let epoch = 0
  /** 本代循环的代号：stop 后再 start 时，让上一代在下一圈自行退出（不会两条循环并行） */
  let generation = 0
  let started = false
  let stopped = false
  let inFlight = false
  let pending = false
  let timeoutAt: string | null = null
  let wake: (() => void) | null = null
  let sleepTimer: ReturnType<typeof setTimeout> | null = null

  const isCurrent = (e: number): boolean => e === epoch

  /**
   * 可被 `wakeNow()` 提前结束的睡眠。
   *
   * 句柄只存在于本闭包：同一时刻只有一个睡眠者（循环唯一，`start()` 幂等），
   * 因此不存在「先设的句柄失去引用」这种泄漏 —— 这是 R6 的结构性解法，
   * 而不是靠再加一个卫兵标志去和重入赛跑。
   */
  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        if (sleepTimer) {
          clearTimeout(sleepTimer)
          sleepTimer = null
        }
        wake = null
        resolve()
      }
      wake = done
      sleepTimer = setTimeout(done, Math.max(0, ms))
    })
  }

  function wakeNow(): void {
    const w = wake
    wake = null
    if (w) w()
  }

  /** 跑一轮：预算内结束 = 正常；超时 = 作废该 epoch 再复位（R1/R2） */
  async function runOneRound(): Promise<void> {
    inFlight = true
    epoch += 1
    const myEpoch = epoch
    const t0 = Date.now()
    let outcome: DeadlineOutcome<void> | null = null
    try {
      outcome = await withDeadline(opts.runRound(myEpoch, isCurrent), opts.budgetMs)
    } catch (e) {
      // 轮体自己抛错**不代表**超时（超时走 `outcome.ok === false` 那条路）：
      // 记一条日志、本轮按「已结束」复位，循环继续 —— 调度权绝不能因为一次异常丢掉。
      opts.log(`轮次异常（epoch ${myEpoch}）：${(e as Error).message}`)
    } finally {
      inFlight = false
    }

    if (outcome && !outcome.ok) {
      // ⚠ 先作废 epoch，再回调：顺序反了的话，onTimeout 里那次推送与随后补跑的新轮
      //   会与「仍在后台跑的旧轮」共用同一个有效 epoch，两轮同时写状态。
      epoch += 1
      const at = new Date().toISOString()
      timeoutAt = at
      opts.log(`轮次超时（epoch ${myEpoch}，预算 ${opts.budgetMs}ms）：本轮作废，复位后继续`)
      opts.onTimeout(at, myEpoch)
      return
    }
    const spent = Date.now() - t0
    if (spent > opts.slowWarnMs) opts.log(`轮次偏慢：${spent}ms > ${opts.slowWarnMs}ms（epoch ${myEpoch}）`)
  }

  async function loopBody(myGeneration: number): Promise<void> {
    while (!stopped && myGeneration === generation) {
      try {
        if (!pending) {
          const delay = await opts.intervalMs()
          if (stopped || myGeneration !== generation) return
          // ⚠ 间隔读取是异步的（要过一次 extras）：其间可能刚好来了刷新。
          //   不再判一次的话，那次刷新要等满一个间隔才生效 —— 「点了没反应」的另一副面孔。
          if (!pending) await sleep(delay)
          if (stopped || myGeneration !== generation) return
        }
      } catch (e) {
        // 读设置失败不该让调度永久停摆（旧实现里 timer 断了就再也没有下一轮）
        opts.log(`调度循环读间隔失败：${(e as Error).message}`)
        await sleep(1_000)
        continue
      }
      pending = false
      // ⚠ 收尾/回调里的一次异常**绝不能**带走调度权：`onTimeout` 干的是 `push(...)`，
      //   而 `pushState` 会走 `getOverlay()?.webContents.send(...)` —— webContents 已销毁时
      //   它会抛（渲染进程崩溃、窗口正在销毁而 closed 还没处理）。抛出来就一路冒到
      //   `loopBody` 的末尾 → 循环退出 → 采集永久停摆，症状与本任务要修的
      //   「同步不动、只能重启」逐字相同，只是触发概率更低。
      //   这里吞掉是唯一正确的选择（该轮已经在 `runOneRound` 里复位过了），但必须留日志。
      try {
        await runOneRound()
      } catch (e) {
        opts.log(`轮次收尾异常（已复位，循环继续）：${(e as Error).message}`)
      }
    }
  }

  function start(): void {
    if (started && !stopped) return
    started = true
    stopped = false
    generation += 1
    // 首轮立即跑（与旧的 `scheduleLoop(0)` 同义）：置 pending 让循环跳过睡眠
    pending = true
    void loopBody(generation).catch((e) => opts.log(`调度循环退出：${(e as Error).message}`))
  }

  function stop(): void {
    stopped = true
    pending = false
    // 唤醒睡眠中的循环，否则要等到下个间隔才看见 stopped（退出路径上就是进程多活一轮）
    wakeNow()
  }

  function requestRefresh(): RefreshOutcome {
    if (!started) {
      start()
      return 'started'
    }
    if (stopped) return 'queued' // 退出路径：不再起新轮（产品里点不到，仅为语义完备）
    if (inFlight || pending) {
      // 合并：刷新请求的语义是「我要最新数据」，点 10 次与 1 次等价。
      // 队列深度 1 让成本有界（最多多跑一轮），且**不重置**自动节奏（R5）。
      pending = true
      return 'queued'
    }
    pending = true
    wakeNow()
    return 'started'
  }

  function reconfigure(): void {
    // 与旧实现同义（旧 reconfigure = refreshNow）：立即按新节奏跑一轮。
    // 间隔由循环每圈现读 `intervalMs`，所以「重排」不需要任何额外状态。
    requestRefresh()
  }

  return {
    start,
    stop,
    requestRefresh,
    reconfigure,
    isRunning: () => inFlight || pending,
    isCurrent,
    lastTimeoutAt: () => timeoutAt
  }
}
