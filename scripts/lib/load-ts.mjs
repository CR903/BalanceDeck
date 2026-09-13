// 在 node 里加载 src 下的 TS/TSX 模块（测试用）
//
// 为什么需要：Node 22.18+ 虽默认开启类型剥离，但要求 import 带扩展名，
// 而项目源码用的是 bundler 风格的裸导入（`./percent`）。这里用 esbuild（vite 自带）
// 打包成内存里的 ESM 再 import —— 无需临时文件，也不需要改源码写法。
//
// 用法：
//   import { loadTs } from './lib/load-ts.mjs'
//   const mod = await loadTs('src/shared/tray-text.ts')

import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export async function loadTs(relPath) {
  const result = await build({
    entryPoints: [resolve(ROOT, relPath)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    write: false,
    logLevel: 'silent'
  })
  const code = result.outputFiles[0].text
  const url = 'data:text/javascript;base64,' + Buffer.from(code, 'utf8').toString('base64')
  return import(url)
}
