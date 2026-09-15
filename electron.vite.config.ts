import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Plugin } from 'vite'

/**
 * 把 `*.glb?inline` 变成 base64 data URL 模块。
 *
 * 为什么需要：Vite 自带的 `?inline` 对二进制资源是「原样内联成字符串」，
 * Rollup 拿到二进制内容会按 JS 解析而报错；而打包后渲染层是 file:// 页面，
 * fetch 本地 .glb 会被 Chromium 拦掉（跨源）。这里显式转 base64，
 * 由 GLTFLoader 从 data URL 解析 —— 零网络、零跨源，且每个模型可独立分包。
 */
function glbInline(): Plugin {
  const SUFFIX = '.glb?inline'
  return {
    name: 'balancedeck:glb-inline',
    enforce: 'pre',
    resolveId(source: string, importer?: string) {
      if (!source.endsWith(SUFFIX)) return null
      const file = resolve(importer ? dirname(importer) : process.cwd(), source.slice(0, -'?inline'.length))
      return `${file}?inline`
    },
    load(id: string) {
      if (!id.endsWith(SUFFIX)) return null
      const file = id.slice(0, -'?inline'.length)
      const b64 = readFileSync(file).toString('base64')
      return `export default ${JSON.stringify(`data:model/gltf-binary;base64,${b64}`)}`
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [glbInline(), react()]
  }
})
