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
//   replace — 把**相对路径**形式的依赖也换掉：[{ from: './net', to: 'scripts/lib/net-probe.mjs' }]。
//   为什么需要它：esbuild 的 alias 只认裸模块名（`./net` 会报 Invalid alias name），
//   而「被内联进 bundle 的私有副本」是实现层观测不到的 —— 例如 request.ts 里
//   那次 `markNetResult(true)` 是否被跳过。换成一个会把调用记进全局的替身，
//   这条断言才有下手处（用法见 scripts/test-seam.mjs 的 S10 段）。
//
// 纯新增：不传这两个参数时行为与从前逐字相同（既有 6 个使用方一个都没动）。

import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** electron 的最小替身（实现见 scripts/lib/electron-stub.mjs） */
export const ELECTRON_STUB = resolve(ROOT, 'scripts/lib/electron-stub.mjs')

export async function loadTs(relPath, { alias, replace } = {}) {
  const replacePlugin = {
    name: 'bd-replace',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (args) => {
        const hit = (replace ?? []).find((r) => r.from === args.path)
        return hit ? { path: resolve(ROOT, hit.to) } : null
      })
    }
  }
  const result = await build({
    entryPoints: [resolve(ROOT, relPath)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    write: false,
    logLevel: 'silent',
    ...(alias ? { alias } : {}),
    ...(replace ? { plugins: [replacePlugin] } : {})
  })
  const code = result.outputFiles[0].text
  const url = 'data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64')
  return import(url)
}
