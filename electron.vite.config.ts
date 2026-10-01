import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()],
    build: {
      rollupOptions: {
        output: {
          // three.js 本体固定成一个独立 chunk（实测 1,182,414 B —— 它原先占入口 chunk
          // 1,699,669 B 的 76%）。改后入口 489,106 B。
          //
          // ⚠ 与 PetBall.tsx 里 `./pet3d/scene` 的动态 import **必须同时存在**，缺一无效：
          //   · 只拆 chunk 不改 import：静态 import 照样在首屏解析 three —— 实测拆包前后
          //     球形态 V8 堆 5.7 vs 5.4 MB，相同（拆 chunk 只管何时*下载*，不管何时*解析*）
          //   · 只改 import 不拆 chunk：three 被 scene.ts 与 human.ts **同时**引用，
          //     vite 会把它并回入口块，退化成单块（构建时会给 dynamic-import 警告）
          manualChunks: {
            three: ['node_modules/three']
          }
        }
      }
    }
  }
})
