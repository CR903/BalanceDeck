import { createHash } from 'crypto'
import { writeFileSync } from 'fs'
import { buildSnapshot, type ExportSnapshot } from './export-snapshot'
import type { AppState } from '../../shared/types'

// ═══════════════════════════════════════════════════════════════════════════════
// 导出快照的**常驻侧写盘**（纯逻辑，**不依赖 electron**）
//
// 为什么是「常驻进程写、CLI 纯读」而不是 CLI 自己采一轮（design.md D1）：
//   · `scheduler.currentState()` 是模块级内存（scheduler.ts:33-38），且全仓**没有**
//     `requestSingleInstanceLock` —— 两个进程完全隔离，CLI 读不到常驻进程的状态。
//   · CLI 自己采会经 `usageStore.ts:99` 的每进程内存 cache + `:121` 整文件覆写，
//     **抹掉常驻进程累积的历史采样**（趋势图直接出现空档）。
//   · 还会顺带通过 `scheduler.ts:74` 注入的 setKey 重写 secrets.bin。
//   → 纯读：零出网、零副作用、不碰凭据、不碰历史存储。
//
// 为什么不落 extras（design.md D3）：`store.ts:92-97` 的 setExtra 每次都全量重写整个
// secrets.bin（凭据在内），而这个快照每轮采集都要写一次。
// scripts/test-usage-store.mjs 已经把「不得走 extras」钉成机制守卫，这里同理。
//
// 写盘点挂在 index.ts 的 pushState 上（**不碰 scheduler.ts**）：pushState 是每次状态
// 推送都会走的路径，挂在那里天然与采集同步，改动面也最小。
// ═══════════════════════════════════════════════════════════════════════════════

/** 调试追踪（BALANCEDECK_DEBUG=1 时写入 /tmp/balancedeck-export.log） */
function debugLog(msg: string): void {
  if (!process.env.BALANCEDECK_DEBUG) return
  // 与 scheduler.ts:49-54 同一写法：动态 import 而不是顶层 require，
  // 免得这个纯逻辑模块在打包口径上多一个 require 依赖
  void import('fs')
    .then(({ appendFileSync }) => {
      appendFileSync('/tmp/balancedeck-export.log', `${new Date().toISOString()} ${msg}\n`)
    })
    .catch(() => {
      // 日志写不进去就算了，绝不能因此影响采集
    })
}

/**
 * 内容哈希。**刻意不算 `generatedAt`**：它每次推送都变，算进去就等于没有去重，
 * 常驻应用（默认 60s 一轮）会变成每天 1440 次写盘。
 */
function bodyHash(snap: ExportSnapshot): string {
  return createHash('sha1')
    .update(JSON.stringify({ offline: snap.offline, providers: snap.providers }))
    .digest('hex')
}

export interface ExportWriter {
  /** 快照没变就不写盘；写失败只记日志、**不抛**（导出是增值功能，不能拖垮采集） */
  maybeWrite(state: AppState, now: number): void
  /** 上次写入的内容哈希（测试与诊断用） */
  lastHash(): string | null
}

export function createExportWriter(opts: { filePath: () => string }): ExportWriter {
  const { filePath } = opts
  let last: string | null = null

  return {
    maybeWrite(state, now) {
      let snap: ExportSnapshot
      let hash: string
      try {
        snap = buildSnapshot(state, now)
        hash = bodyHash(snap)
      } catch (e) {
        debugLog(`build 失败：${(e as Error).message}`)
        return
      }
      if (hash === last) return
      try {
        writeFileSync(filePath(), JSON.stringify(snap, null, 2), 'utf-8')
        last = hash
      } catch (e) {
        // ⚠ 写失败**不能抛**：采集是主路径，导出只是给外部脚本的增值通道
        // （与竞品 opencode-quota 同一纪律：write error is logged, does not break the app）
        debugLog(`写盘失败：${(e as Error).message}`)
      }
    },
    lastHash() {
      return last
    }
  }
}