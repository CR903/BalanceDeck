import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// main 侧需要**两个**入口：`new Worker()` 只认真实文件，不能是内联进 index.js 的代码。
// 第二个入口产出 `out/main/local-scan-worker.js`，与 `local-scan-host.ts` 的
// `defaultWorkerPath()`（`join(__dirname, 'local-scan-worker.js')`）是同一个约定 ——
// 改了名字两边一起改，`scripts/verify-worker-packaged.mjs` 会实测这个文件真的被加载。
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'local-scan-worker': resolve(__dirname, 'src/main/adapters/local-scan-worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()]
  }
})
