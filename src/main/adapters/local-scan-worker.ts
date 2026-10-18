// ═══════════════════════════════════════════════════════════════════════════════
// 本机用量扫描的 worker 入口 —— 只做「读库 → 产出全量行快照」
//
// 为什么单独成一个入口：`node:sqlite` 只有同步 API，全量扫描（~265MB `data` 页读取）
// 在主线程上是一次 0.7–4.4s 的同步阻塞。本文件**只**把那一件事搬到子线程里做。
//
// 三条边界（刻意如此，改之前先想清楚）：
//   · **不含任何 electron / 装配依赖** —— 它只 import `./opencode-local`（口径的唯一来源）
//     与 `./local-scan-host` 的**类型**（消息契约的唯一持有者，type-only 会被擦除）；
//   · **不复制第二份投影 SQL**：`openLocalDb` / `scanFullSnapshot` 与主线程降级路径是
//     同一份实现 —— 复制一份等于埋一颗「两边慢慢漂」的雷；
//   · **失败不抛**：任何异常都回 `{ ok: false, error }`，由宿主转成降级（主线程回退）。
//     抛进 worker 的未捕获异常只会让线程死掉，主进程那边就只剩一个 timeout 可等了。
//
// 增量**不在这里**：它只有 1–30ms，移出去只多一次往返与一条新的失败路径（design.md §4）。
// ═══════════════════════════════════════════════════════════════════════════════

import { parentPort } from 'node:worker_threads'
import { openLocalDb, scanFullSnapshot } from './opencode-local'
import type { WorkerRequest, WorkerResponse } from './local-scan-host'

if (!parentPort) throw new Error('local-scan-worker 必须在 worker 线程里运行（parentPort 为空）')
const port = parentPort

port.on('message', (msg: WorkerRequest) => {
  void handle(msg)
})

async function handle(msg: WorkerRequest): Promise<void> {
  const reply = (r: WorkerResponse): void => port.postMessage(r)
  try {
    const db = await openLocalDb(msg.dbPath)
    try {
      const snap = scanFullSnapshot(db, msg.sinceMs)
      reply({ seq: msg.seq, ok: true, tables: snap.tables, rows: snap.rows })
    } finally {
      try {
        db.close()
      } catch {
        // 关不掉无所谓：连接对象就要丢了（与主线程 closeConn 同款容忍）
      }
    }
  } catch (e) {
    reply({ seq: msg.seq, ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
