// 把本机扫描的 worker 入口打成**真文件**（测试用）
//
// 为什么需要它：`new Worker()` 只认真实路径 —— `loadTs` 返回的是 `data:` URL 的模块实例，
// 当不了 worker 入口；而 `out/main/local-scan-worker.js` 是 `electron-vite build` 的产物，
// 单元测试不该依赖「先跑一次 build」。这里用 esbuild（vite 自带，load-ts.mjs 已在用）
// 打一份与 electron-vite 产物**同形**的 CJS：同一个入口、同一份 `opencode-local`。
//
// 打包态（asar / asarUnpack / 真实 Electron）的验证不在这里，在
// `scripts/verify-worker-packaged.mjs` —— 那件事只能在打包态测。

import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** 产出并返回 outFile（真文件路径） */
export async function buildWorker(outFile) {
  await build({
    entryPoints: [resolve(ROOT, 'src/main/adapters/local-scan-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: outFile,
    logLevel: 'silent'
  })
  return outFile
}
