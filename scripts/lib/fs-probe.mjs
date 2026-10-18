// fs 探针替身：把 `readdirSync` 的调用次数记到 globalThis，其余**透传真 fs**。
//
// 用途：断言"目录 mtime 未变时不再 readdir"（本任务 AC5）。给 loadTs 的 alias 用：
//   await loadTs('src/main/adapters/claude.ts', { alias: { fs: FS_PROBE } })
// 只替换 `fs` 这一个说明符，所以被内联进 bundle 的 scan-dir.ts 也一起被观测到 ——
// 这正是需要它观测的那一层（实现里改回 readdirSync 就该变红）。
//
// 为什么不是"内联一份 fs 实现"：这里不实现任何 fs 行为，只记数 + 转发（`export * from`
// 保证其余成员逐字是真 fs）。计数放在 globalThis 上，因为 test-local-scan.mjs 会多次
// loadTs（每次都是一个新模块实例），计数必须跨实例可见。

import * as real from 'node:fs'

export * from 'node:fs'

export function readdirSync(...args) {
  globalThis.__bd_readdir_calls = (globalThis.__bd_readdir_calls ?? 0) + 1
  return real.readdirSync(...args)
}
