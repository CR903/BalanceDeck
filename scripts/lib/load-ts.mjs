// 在 node 里加载 src 下的 TS/TSX 模块（测试用）
//
// 为什么需要：Node 22.18+ 虽默认开启类型剥离，但要求 import 带扩展名，
// 而项目源码用的是 bundler 风格的裸导入（`./percent`）。这里用 esbuild（vite 自带）
// 打包成内存里的 ESM 再 import —— 无需临时文件，也不需要改源码写法。
//
// 用法：
//   import { loadTs } from './lib/load-ts.mjs'
//   const mod = await loadTs('src/shared/tray-text.ts')
//
// 可选参数：
//   alias — 把裸模块名替换成指定的本地文件（如 { electron: ELECTRON_STUB }）。
//   electron 替身是给 src/main 下那些「经 net.ts 间接依赖 electron」的模块用的：
//   electron 的入口会 require('fs')，esbuild 打包成 ESM 后报
//   `Dynamic require of "fs" is not supported`，导致这些模块在纯 node 里根本加载不了。

import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** electron 的最小替身（实现见 scripts/lib/electron-stub.mjs） */
export const ELECTRON_STUB = resolve(ROOT, 'scripts/lib/electron-stub.mjs')

export async function loadTs(relPath, { alias } = {}) {
  const result = await build({
    entryPoints: [resolve(ROOT, relPath)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    write: false,
    logLevel: 'silent',
    ...(alias ? { alias } : {})
  })
  const code = result.outputFiles[0].text
  const url = 'data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64')
  return import(url)
}
