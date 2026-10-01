# Implement: 资源占用优化

## Ordered Checklist

> ⚠ **顺序不可换**：R1（清死重）独立可先做；R2 的三步**必须**按
> 代码 → 实测复测 → 文案 走（design.md D6）。**未复测就改 README = 把一句假话换成另一句。**

### Phase 1: 清死重 R1（不改运行时）

- [x] **1.1** `scripts/fetch-human-pets.mjs`（`:111-119` 附近）：
      `sips` 把 `.tga` 转成 `textures/*.png` **之后删掉源 `.tga`**
  - [x] 删失败（权限/只读）→ **记一条日志**并继续，不让整个脚本失败
  - [x] ⚠ 这是 `predist:mac` / `predist:win` 的钩子，改完必须验证 `npm run fetch:humans` 能完整重跑
  - [x] ⚠ **不动 `PETS` 列表**（`:26-44`）—— 它决定下载哪些模型，与删源文件是两件事（design.md D3）
- [x] **1.2** `electron-builder.yml`（`:9-14`）的 `extraResources` 加 `filter`：
      `['**/*', '!**/*.tga', '!reyna-pilot/**']`
  - [x] ⚠ **`from` / `to` 一个字都不动**（`main/human-assets.ts:31` 依赖 `process.resourcesPath/human-pets`）
- [x] **1.3** 删除 `resources/human-pets/reyna-pilot/`（用户已确认「磁盘也清」）
  - [x] ⚠ 它**不在 `PETS` 里**，`fetch:humans` 不会重建它 —— 删了不可从脚本恢复
  - [x] 删除前把 `du -sh` 结果记进报告
- [x] **1.4** 实测 `resources/human-pets` 从 221 MB 降到 ~62 MB（**实测，不是估算**）

### Phase 2: three.js 动态 import R2-a（代码）

- [x] **2.1** `src/renderer/src/PetBall.tsx:11`：`import { createPet3dScene } from './pet3d/scene'`
      → 改为**动态 import**
  - [x] ⚠ **D5①**：`setReady(true)`（`:199`）必须挪到 `await import` 完成**之后**
        （现在 `createPet3dScene` 是同步返回，`:191` 直接 `handle = createPet3dScene(...)`）
  - [x] ⚠ **D5②**：新增的「chunk 加载失败」必须**复用现有的 WebGL 失败兜底**
        （`:192-197` 的 `catch` → `setFailed(true)` → 退回 2D 圆环）。
        **不能白屏** —— 动态 import 引入了一个新的失败模式，它的正确表现与 WebGL 失败相同。
- [x] **2.2** `electron.vite.config.ts` 加 `build.rollupOptions.output.manualChunks`，
      把 `node_modules/three` 固定成独立 chunk
  - [x] ⚠ **D4**：两条**都要**。只拆 chunk 不改 import 省不了内存（调研 `raw/06` 实测：
        球形态 `Runtime.getHeapUsage` 拆包前后 5.7 vs 5.4 MB，相同）；
        只改动态 import 不加 manualChunks，vite 可能因 `scene.ts` 与 `human.ts` 同时引用
        three 而把它并回入口
- [x] **2.3** 照仓库既有的动态 import 写法（`speechOut.ts:487`、`App.tsx:486`），
      注释写清**为什么**不能改回静态（vite 会退化成单块）

### Phase 3: 实测复测（**文案改之前必做**）

- [x] **3.1** `npm run build`，检查 `out/renderer/assets/`：
      - `index-*.js` **< 600 kB**（基线 1.70 MB）
      - 存在独立的 `three-*.js`
- [x] **3.2** 用 `research/probe-renderer.mjs`（**复用它，不要另起一套** —— 口径不同则数字不可比）
      复测球形态的 `Network.requestWillBeSent`：**0 条** `three-*.js` 请求
- [x] **3.3** 用 `research/measure-memory.mjs` 复测常驻内存与 CPU，与基线对比
      （基线：球形态 335–394 MB / 2.0–2.2 % 单核）
- [x] **3.4** 实机回归：`npm run ballshot`（人物形态）截图正常；`npm run uitest` 全绿
      ⚠ 改完 `uitest.ts` 或产品代码**必须先 build** —— `--uitest` 测的是 `out/`（本会话踩过）

### Phase 4: 改文案 R2-b（**必须在 Phase 3 之后**）

- [x] **4.1** `README.md:45-46`：按 Phase 3 的**实测结果**改写，
      不再含任何未经证实的断言
  - [x] ⚠ 如果 Phase 3 显示 three 仍在首屏（动态 import 没生效）→ **不要改这句**，
        先回去修代码，并把那句话降级为「不建 WebGL 上下文 / 不下载 3D 素材」
        （两句经 CDP 取证为真）
- [x] **4.2** ⚠ **`DESIGN.md:303` 不改** —— 调研确认它写得比 README 精确
- [x] **4.3** **不上整包体积数字**（D7）：清完仍余 ~342 MB，其中 262 MB 是 Electron
      运行时本身，而竞品大多不是 Electron（Tauri 主打 ~6 MB binary）—— 拿这个数宣传是误导
- [x] **4.4** 只写素材侧的数字（`resources/human-pets` 221 → 62 MB）与首屏 JS（1.70 → 514 kB），
      两者都有原始输出可指

### Phase 5: 测试

- [x] **5.1** 新建 `scripts/test-resource.mjs`（`loadTs` + 静态断言）
  - [x] `PetBall.tsx` 里 `./pet3d/scene` 是**动态** import（改回静态必须报红）
  - [x] `electron-builder.yml` 的 `from` / `to` 仍在，且 `filter` 含 `!**/*.tga` 与 `!reyna-pilot/**`
  - [x] `fetch-human-pets.mjs` 里存在删 `.tga` 的代码
  - [x] `electron.vite.config.ts` 里 `manualChunks` 含 three
  - [x] ⚠ 每条都要**前置断言**（找得到那段源码），否则负向断言会空洞通过
- [x] **5.2** `package.json` 加 `test:resource` 并接入 `test` 链（**只加自己那一行**，`edit` 精确匹配）

### Phase 6: spec

- [x] **6.1** 记录实测基线与优化后数字（两者都要可指到原始输出）
- [x] **6.2** 记录两条纪律：
      ①「动态 import 引入的新失败模式（chunk 加载失败）必须复用既有的失败兜底，不是白屏」
      ②「卖点文档与代码不一致时，**先改代码再改文案**」—— 本任务的 `README.md:45-46`
      从 commit `89d5f3b` 写下起就不准确（那一次提交里静态 import 已存在）

## Review Gates

- [x] `npm test` 通过（含新增 `test-resource.mjs`）
- [x] `npm run typecheck` 通过
- [x] **反验**：把 `PetBall.tsx` 的动态 import 改回静态 → 5.1 的守卫必须报红
- [x] **反验**：把 `electron-builder.yml` 的 `filter` 去掉 → 5.1 的守卫必须报红
- [x] **`npm run fetch:humans` 重跑验证**（Phase 1.1 改的是构建钩子，必须验它还能用）
- [x] **实机**：ballshot（人物形态）正常 + uitest 全绿
- [x] **实测数字齐**：`resources/human-pets` 体积、首屏 JS 体积、球形态无 three 请求、内存/CPU（→ `measurements.md`）
- [x] `trellis-check` 对照 prd.md 的 14 条 AC 逐条复核
      （结论见 `measurements.md` §八：**12 条通过 / 2 条部分通过**，2 条部分通过的
      都是「本机网络跑不完」而非配置或代码问题：
      AC「`.app` 整包体积下降」与 AC「`fetch:humans` 全新下载」——
      前者 `--dir` 两次 600s 超时（改用 `app-builder-lib` 的 `FileMatcher` 验 filter 语义，
      8 通过 / 0 失败 / 1 已知边界），后者 fetch 221MB 中断（已做对照实验：
      HEAD 原版同环境**同样** exit 1）。
      check 期间另修了 3 处空壳守卫（A4 / D6 / E4 + B3 坐标系）与 1 处日志说错话，
      断言 36 → 37；详见 `measurements.md` §七 / §八）

## Rollback

| 改动 | 回滚 |
|---|---|
| `fetch-human-pets.mjs` 删 `.tga` | 恢复脚本；`.tga` 需重跑 `fetch:humans` 重新下载（**gitignored，不可从 git 恢复**） |
| `electron-builder.yml` filter | 删掉 `filter` 字段 |
| `reyna-pilot/` 删除 | **不可恢复**（不在 `PETS` 里）—— 所以用户已明确确认才做 |
| `PetBall.tsx` 动态 import | 改回静态 import（单行），three 回到入口 chunk |
| `manualChunks` | 删掉该配置 |
| `README.md` 文案 | 改回原文（但那是一句假话 —— 回滚前想清楚） |

⚠ 回滚 `PetBall.tsx` 时注意：动态 import 那版改了 `ready` 时序（D5①），
**不能只回滚 import 那一行**，否则 `ready` 会早于 three 加载完成。