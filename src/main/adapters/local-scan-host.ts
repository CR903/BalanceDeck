// ═══════════════════════════════════════════════════════════════════════════════
// 本机用量扫描的 worker 宿主 —— 把「首次全量」移出主线程
//
// 为什么需要它（2026-10-18 实测）：`node:sqlite` **只有同步 API**（`DatabaseSync`），
// 所以主线程里跑一次全量就是一次 0.7–4.4s 的同步阻塞（隔离热页冷启动三次重测
// 1222 / 2971 / 4418 ms，三次全部越过 900ms 红线）。投影 + 增量已经把稳态压到
// 22–49ms，但省不掉 ~265MB `data` 页的读取 —— 那是**结构性**的，主线程内无解。
//
// 本模块是**纯传输层**，刻意不 import electron、也不 import `./opencode-local`：
//   · 不认识 SQL、不认识口径 —— 降级路径（主线程同步实现）由调用方注入；
//   · 换 `worker_threads` ↔ `utilityProcess` 时只换本文件的传输，调用方一行不动；
//   · 可被 `scripts/test-local-scan-host.mjs` 用 `loadTs` 加载，且测试里的「假 worker」
//     是**真的子线程**（临时目录里的真 .mjs 入口），不是 mock。
//
// 三条纪律（每条都有断言，见该测试套件）：
//   ① **降级必须留痕**：`via='main'` 时 `degradedReason` 必须有值并经 `log()` 写出。
//      静默降级 = 本任务白做：用户看到的还是秒级卡顿，而没人知道为什么。
//   ② **超时按整次扫描计**（不是按消息往返）：worker 卡在 sqlite 页读取上时也必须能回退。
//   ③ **迟到结果丢弃**：超时/停机之后 worker 才回来的结果**不得**覆盖已采用的结果
//      （与 `collect-loop.ts` 的 epoch 闸门同一纪律，也是 `deadline.ts` 的同一课）。
// ═══════════════════════════════════════════════════════════════════════════════

import { existsSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { LocalPoint } from './opencode-local'

// ─── 跨层消息契约（**唯一持有者**：worker 入口只 import 这里的类型）────────────

/** 一行的快照：`tc` 是 `time_created` **列**（窗口裁剪用它），`p` 是投影后的点 */
export interface ScanRow {
  tc: number
  p: LocalPoint
}

/** 一张表的行快照：`rowid → 行`。**rowid 是身份**，增量游标按它累积 */
export interface ScanTable {
  name: string
  rows: Map<number, ScanRow>
}

/**
 * 全量扫描的产物。
 *
 * ⚠ **为什么回传的是「行快照」而不是 `LocalStats`**（design.md §3 初稿写的是
 *   `{ pts, byModel }`）：主线程的增量游标按 **rowid** 累积
 *   （`.trellis/spec/adapters/local-db-scan.md` §3「Cursor」），而 `pts` 里没有 rowid。
 *   只回传 `{ pts, byModel }` 会让主线程的**下一轮增量失去行快照** —— 那会直接
 *   把结果清空（不是慢，是错）。派生的 `LocalStats` 由主线程用**同一份** `deriveStats`
 *   算出，口径仍然只有一处；这也是「口径不许漂」这条硬约束下唯一安全的形状。
 */
export interface ScanResult {
  tables: ScanTable[]
  /** 本次读到的原始行数（诊断用，与主线程的 `lastRun().rows` 同义） */
  rows: number
}

export interface ScanRequest {
  dbPath: string
  sinceMs: number
}

/** 主进程 → worker。`seq` 让迟到结果可被识别并丢弃（与请求一一对应） */
export interface WorkerRequest extends ScanRequest {
  seq: number
}

/** worker → 主进程。失败走 `ok:false`（由宿主转成降级），**不把异常抛进主线程** */
export type WorkerResponse =
  | { seq: number; ok: true; tables: ScanTable[]; rows: number }
  | { seq: number; ok: false; error: string }

// ─── 宿主契约 ────────────────────────────────────────────────────────────────

export interface ScanHostRun {
  via: 'worker' | 'main'
  ms: number
  /** 仅 `via='main'` 且**是降级**时存在（正常的主线程全量没有这个字段） */
  degradedReason?: string
}

export interface ScanHost {
  /** 全量扫描。worker 不可用/超时/抛错 → 回退 `fallback()`（主线程同步实现） */
  runFull(
    req: ScanRequest,
    fallback: () => Promise<ScanResult | null>
  ): Promise<{ result: ScanResult | null; via: 'worker' | 'main' }>
  /** 停机：终止 worker；幂等 */
  stop(): Promise<void>
  /** 诊断：本次走了哪条路、耗时、降级原因 */
  lastRun(): ScanHostRun | null
}

/**
 * 全量实测最坏 4.4s（load 17）；20s 留足余量。
 * **超时按整次扫描计**（postMessage → 收到结果），不是按消息往返 —— 见文件头 ②。
 */
export const DEFAULT_SCAN_TIMEOUT_MS = 20_000

type AskOutcome =
  | { kind: 'ok'; result: ScanResult }
  | { kind: 'error'; reason: string }
  | { kind: 'timeout' }

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function createScanHost(opts: {
  workerPath: string
  timeoutMs?: number
  log: (msg: string) => void
}): ScanHost {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS

  let worker: Worker | null = null
  /**
   * 非 null ⇒ **这个 worker 不能再用了**（抛错 / 意外退出 / 上次请求超时）。
   * 同步 sqlite 读没法取消，卡住的线程只能换掉 —— 下次 `runFull` 先终止它。
   */
  let workerBad: string | null = null
  let pending: { seq: number; w: Worker; timer: ReturnType<typeof setTimeout>; resolve: (o: AskOutcome) => void } | null =
    null
  let seqNo = 0
  let stopped = false
  let last: ScanHostRun | null = null
  /** 请求串行化：任一时刻至多一个在飞（迟到判据才有唯一答案） */
  let chain: Promise<unknown> = Promise.resolve()

  /** 丢弃一条**迟到**的 worker 结果，并留痕（否则「静默丢数据」无从排查） */
  function discard(msg: unknown, why: string): void {
    const seq = (msg as { seq?: unknown } | null)?.seq
    opts.log(`本机扫描：丢弃 worker 的迟到结果（seq=${typeof seq === 'number' ? seq : '?'}，${why}）`)
  }

  /** 只结算「属于这个 worker」的在飞请求 —— 换 worker 时旧线程的 exit 不能打中新的 */
  function failFrom(w: Worker, reason: string): void {
    const p = pending
    if (!p || p.w !== w) return
    clearTimeout(p.timer)
    pending = null
    p.resolve({ kind: 'error', reason })
  }

  function onMessage(msg: WorkerResponse): void {
    if (typeof msg !== 'object' || msg === null || typeof (msg as { seq?: unknown }).seq !== 'number') {
      // 「未知形状要有出口」：不认识的回包既不能当成成功，也不能静默吞掉
      opts.log(`本机扫描：worker 回了不认识的形状，已忽略（${JSON.stringify(msg)?.slice(0, 120)}）`)
      return
    }
    const p = pending
    if (!p || p.seq !== msg.seq) {
      discard(msg, p ? `本轮在等 seq=${p.seq}` : '本轮已回退（超时或停机）')
      return
    }
    clearTimeout(p.timer)
    pending = null
    if (msg.ok) {
      p.resolve({ kind: 'ok', result: { tables: msg.tables ?? [], rows: msg.rows ?? 0 } })
    } else {
      p.resolve({ kind: 'error', reason: `worker 报错：${msg.error}` })
    }
  }

  function makeWorker(): Worker {
    const w = new Worker(opts.workerPath)
    w.on('message', (msg: WorkerResponse) => {
      if (worker === w) onMessage(msg)
    })
    // `new Worker()` 对不存在的入口**不同步抛**，而是异步发 'error'（实测 ERR_MODULE_NOT_FOUND）
    w.on('error', (e) => {
      const reason = `worker 抛错：${msgOf(e)}`
      if (worker === w) workerBad = reason
      failFrom(w, reason)
    })
    w.on('exit', (code) => {
      const reason = `worker 线程退出（code=${code}）`
      if (worker === w) {
        worker = null
        workerBad = reason
      }
      failFrom(w, reason)
    })
    worker = w
    workerBad = null
    return w
  }

  async function killWorker(): Promise<void> {
    const w = worker
    worker = null
    workerBad = null
    if (!w) return
    try {
      await w.terminate()
    } catch {
      // 已经退出的线程 terminate 会 reject —— 目标状态已经达成，不是错误
    }
  }

  async function ensureWorker(): Promise<Worker> {
    if (worker && !workerBad) return worker
    if (worker) await killWorker()
    return makeWorker()
  }

  function ask(w: Worker, req: ScanRequest): Promise<AskOutcome> {
    return new Promise<AskOutcome>((resolve) => {
      const seq = ++seqNo
      const timer = setTimeout(() => {
        const p = pending
        if (!p || p.seq !== seq) return
        pending = null
        p.resolve({ kind: 'timeout' })
      }, timeoutMs)
      pending = { seq, w, timer, resolve }
      try {
        const message: WorkerRequest = { seq, dbPath: req.dbPath, sinceMs: req.sinceMs }
        w.postMessage(message)
      } catch (e) {
        // 数据不可克隆 / 线程已死：当场降级，不必白等一个超时
        const p = pending
        if (p && p.seq === seq) {
          clearTimeout(p.timer)
          pending = null
          p.resolve({ kind: 'error', reason: `postMessage 失败：${msgOf(e)}` })
        }
      }
    })
  }

  /** 降级：**先留痕再回退**，且无论 fallback 成败都记下 via='main' */
  async function degrade(
    fallback: () => Promise<ScanResult | null>,
    reason: string,
    t0: number
  ): Promise<{ result: ScanResult | null; via: 'main' }> {
    opts.log(`本机扫描降级：${reason} ⇒ 回退主线程同步扫描`)
    try {
      const result = await fallback()
      return { result, via: 'main' }
    } finally {
      last = { via: 'main', ms: Math.round(performance.now() - t0), degradedReason: reason }
    }
  }

  async function doRunFull(
    req: ScanRequest,
    fallback: () => Promise<ScanResult | null>
  ): Promise<{ result: ScanResult | null; via: 'worker' | 'main' }> {
    const t0 = performance.now()
    if (stopped) return degrade(fallback, '宿主已停机（stop() 之后不再起 worker）', t0)
    if (!opts.workerPath) return degrade(fallback, '未配置 worker 入口路径', t0)

    let w: Worker
    try {
      w = await ensureWorker()
    } catch (e) {
      return degrade(fallback, `worker 起不来：${msgOf(e)}`, t0)
    }

    const outcome = await ask(w, req)
    if (outcome.kind === 'ok') {
      last = { via: 'worker', ms: Math.round(performance.now() - t0) }
      return { result: outcome.result, via: 'worker' }
    }
    // 超时 ⇒ 这个线程卡在同步读里，换掉再谈下一次；报错/退出由 makeWorker 的 handler 记进 workerBad
    if (outcome.kind === 'timeout') {
      workerBad = `worker 在 ${timeoutMs}ms 内没有返回（超时按整次扫描计）`
    }
    const reason = outcome.kind === 'timeout' ? workerBad! : outcome.reason
    return degrade(fallback, reason, t0)
  }

  return {
    runFull(req, fallback) {
      // 串行化：`opencode-local.ts` 的 scan() 本来就串行，这里再兜一层 ——
      // 「迟到的结果属于哪一轮」只有在一个在飞时才有唯一答案。
      const r = chain.then(() => doRunFull(req, fallback))
      chain = r.catch(() => {})
      return r
    },
    async stop() {
      stopped = true
      const p = pending
      if (p) {
        clearTimeout(p.timer)
        pending = null
        p.resolve({ kind: 'error', reason: '宿主已停机' })
      }
      await killWorker()
    },
    lastRun() {
      return last
    }
  }
}

/** worker 产物文件名（与 `out/main/index.js` 同目录，由 electron.vite.config.ts 的第二个 input 产出） */
export const WORKER_FILE_NAME = 'local-scan-worker.js'

/** 打包态：asarUnpack 过的文件真实存在于 `app.asar.unpacked/...`，优先它 */
function preferUnpacked(p: string): string {
  const unpacked = p.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
  return unpacked !== p && existsSync(unpacked) ? unpacked : p
}

/**
 * 产品路径上的 worker 入口解析。四件事都要处理，每一件都是踩过的：
 *
 *   · **`__dirname` 不是「out/main」**。本模块会被 rollup 与 `opencode-local.ts` 一起放进
 *     `out/main/chunks/*.js`（两个入口共享这份代码），此时 `__dirname` 是那个 chunks 目录。
 *     实测过一次，日志里是 `Cannot find module '…/out/main/chunks/local-scan-worker.js'` ——
 *     一个只在构建产物布局上才看得见的坑。所以按「同级 → 上一级」两处找。
 *   · **找不到时返回同级那个候选**（而不是 `''`）：`new Worker()` 会报出真实路径，
 *     降级因此**留痕**；返回空串会变成「没配 worker」的静默降级，那正是本任务要消灭的东西。
 *   · **纯 node 测试里没有 `__dirname`**（`loadTs` 用 `data:` URL 加载 ESM）⇒ 返回 `''`，
 *     宿主据此不起 worker（`design.md` §4 的「无 host」分支），不是抛异常。
 *   · **打包态 worker 若被 `asarUnpack`**，`new Worker()` 走的是 worker 自己的模块加载器，
 *     asar 内的路径**不保证**能读（这正是 AC3 要实测的那件事）⇒ 存在的 unpacked 副本优先。
 *
 * 另有 **`BD_LOCAL_SCAN_WORKER`** 覆盖（与 `BD_USER_DATA` 同一族的调试缝）：
 * `scripts/verify-worker-packaged.mjs` 的负向验证就是靠它把路径指到一个不存在的文件。
 */
export function defaultWorkerPath(): string {
  const override = process.env.BD_LOCAL_SCAN_WORKER
  if (override) return override
  let here: string
  try {
    here = __dirname
  } catch {
    // ESM（data: URL）里 `__dirname` 未定义：纯 node 环境一律不起 worker
    return ''
  }
  for (const dir of [here, dirname(here)]) {
    const p = join(dir, WORKER_FILE_NAME)
    if (existsSync(p)) return preferUnpacked(p)
  }
  return preferUnpacked(join(here, WORKER_FILE_NAME))
}
