# Design: 资源占用优化

## Architecture

```
┌─ R1 清死重（不改运行时）─────────────────────────────────────────────┐
│                                                                       │
│  fetch-human-pets.mjs :111-119                                       │
│    sips .tga → textures/*.png                                        │
│    ⚠ 原本「转完不删源文件」 ← 128 MB 死重的根因                        │
│  → 改为转完即删（unlink）                                             │
│                                                                       │
│  electron-builder.yml :9-14  extraResources                          │
│    from: resources/human-pets, to: human-pets   ← 这两个字段不能动      │
│    filter: ['**/*', '!**/*.tga', '!reyna-pilot/**']   ← 新增          │
│                                                                       │
│  reyna-pilot/  ← 人工确认后从磁盘删除（不可由 fetch:humans 重建）        │
└───────────────────────────────────────────────────────────────────────┘

┌─ R2 让 three.js 变懒加载（改加载时机）─────────────────────────────────┐
│                                                                       │
│  现状（球形态也会加载）                                                │
│    App.tsx:7 ─┐                                                      │
│                ├→ PetBall.tsx:11  import { createPet3dScene }        │
│    PetBall.tsx:11 ─→ pet3d/scene.ts:1 ─→ import * as THREE from 'three'│
│    ⇒ three 打进入口 chunk（1.70 MB 里 1.30 MB = 76%）                │
│                                                                       │
│  改后                                                                   │
│    PetBall.tsx  const { createPet3dScene } = await import('./pet3d/scene')│
│    + electron.vite.config.ts: build.rollupOptions.output.manualChunks │
│        把 node_modules/three 固定成独立 chunk                           │
│    ⇒ 首屏 index-*.js ≈ 514 kB；three-*.js 只在切人物形态时加载          │
└───────────────────────────────────────────────────────────────────────┘
```

## Technical Decisions

### D1 · R1 两条路径都做（用户决策「磁盘也清」）

`fetch-human-pets.mjs` 转完删 `.tga`（磁盘干净 + 以后重跑也不会再生）
**＋** `electron-builder.yml` 加 `filter`（打包产物干净，防任何漏网的）。

**为什么要两条都做**：只做 A（filter）的话磁盘上仍留 221 MB，而用户下次跑
`fetch:humans` 还会重新生成；只做 B（脚本）的话打包产物仍可能带上历史残留。
两条各自独立生效，缺一不可。

### D2 · `from`/`to` 一个字都不能动

`src/main/human-assets.ts:31` 用 `process.resourcesPath/human-pets` 取素材。
`electron-builder.yml` 的 `to: human-pets` 正是让这个路径成立的那个映射。
**改它等于改运行时寻址** —— 而本任务明确「不改运行时行为」。

### D3 · `fetch-human-pets.mjs` 的 `PETS` 列表不动

删 `.tga` 是**转完删源文件**，不是改 `PETS` 列表。理由：`PETS`（`:26-44`）决定
**下载哪些模型**，而 `reyna-pilot/` 从来不在里面（调研已核实）。动 `PETS` 会让
`fetch:humans` 去下载原本不下载的东西 —— 那是行为变更，不属于本任务。

⚠ `fetch:humans` 是 `predist:mac` / `predist:win` 的钩子（`package.json`），
所以改动必须保证「重跑能完整生成 12 张 PNG」。验收里专门有一条。

### D4 · three.js 动态 import + `manualChunks` 两者都要

调研实测（`raw/08`）：**只拆 chunk 不改 import，省不了内存** ——
`raw/06` 显示球形态 `Runtime.getHeapUsage` usedSize 5.7 MB，与不拆的 5.4 MB 相同。
因为拆 chunk 只影响**何时下载**，不影响**何时解析**：静态 import 照样在首屏解析 three。

反之，只改动态 import 不加 `manualChunks`：vite 可能因 `scene.ts` 与 `human.ts`
**同时**引用 three 而把它并回入口。所以两条一起做才成立。

### D5 · `ready` 状态与失败兜底要跟着改（最容易漏的一处）

`createPet3dScene` 现在是**同步**返回 `Pet3dHandle`（`PetBall.tsx:191` 直接
`handle = createPet3dScene(...)`）。改成 `await import(...)` 后多一个 await 空窗：

- `ready` 状态与 `setReady(true)`（`:199`）必须跟着挪 —— 否则会在 three 加载完之前报 ready
- 现有 WebGL 失败兜底（`:192-197` 的 `catch` → `setFailed(true)` → 退回 2D 圆环）
  **必须一并覆盖「chunk 加载失败」**，否则 CDN/文件缺失时会**白屏**而不是退回 2D

后者是本决策的核心：动态 import 引入了一个新的失败模式（网络/文件缺失），
而那个失败模式的**正确表现**与 WebGL 失败相同 —— 退回 2D。

### D6 · 文案顺序：代码 → 实测复测 → 文案

`README.md:45-46` 那句假话是 commit `89d5f3b` 加的，且**那一次提交里静态 import 就已存在**
（调研用 `git show 89d5f3b` 核实过）—— 所以它从写下起就不准确，不是后来退化的。

改法上两条路可选：改代码让它为真（用户选了这条），或改文案降级为「不建 WebGL 上下文 /
不下载 3D 素材」（两句经 CDP 取证为真）。用户选了前者，代价是要处理 D5 的两处。

⚠ **顺序不可反**：先改代码、实测确认，再动文案。未复测就改文案 = 把一句假话换成另一句。

### D7 · 整包体积数字不上文档

`.app` 实测 520 MB，清完 159 MB 仍余 **~342 MB**，其中
`Contents/Frameworks` 的 **262 MB 是 Electron 运行时本身**。而竞品里大多数不是 Electron
（quota-viewer 是 Go+Wails、Tauri 主打 "~6 MB binary"）。**这个赛道打不过**。

拿 342 MB 宣传「我们也很小」是误导（对手根本不用比这个数），
而拿 62 MB（素材）说事是准确且有意义的 —— **只写后者**。

## Contracts

### electron-builder.yml（只加 filter）

```yaml
extraResources:
  - from: resources/human-pets
    to: human-pets
    filter: ['**/*', '!**/*.tga', '!reyna-pilot/**']   # 新增；from/to 不变
```

### PetBall.tsx（动态 import + 失败兜底）

```tsx
// ⚠ 形状由 design.md D5 约束；实现时保证：
//   ① await import 的 reject（chunk 加载失败）→ 与 WebGL 失败同路：setFailed(true)
//   ② setReady(true) 移到 import 完成之后
const mod = await import('./pet3d/scene')
handle = mod.createPet3dScene(...)
setReady(true)
```

### electron.vite.config.ts（manualChunks）

```ts
build: { rollupOptions: { output: { manualChunks: {
  three: ['node_modules/three']          // 把 three 本体固定成独立 chunk
}}}}
```

## Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| `.tga` 源文件在转 PNG 后仍存在 | 视为未完成（AC2），并**记一条日志**说明为什么删不掉 |
| `reyna-pilot/` 仍被打进产物 | filter 没生效（AC4 红） |
| 切人物形态 three.js chunk 404 | **退回 2D 圆环**，不白屏（D5②） |
| 球形态 three.js chunk 被首屏加载 | 动态 import 没生效或被 vite 并回入口（D4） |
| `npm run fetch:humans` 重跑后缺贴图 | 转 PNG 的流程被破坏（R1 违反了 D3 的前提） |
| 3D 场景渲染异常 | 立即 `setFailed(true)` 退回 2D，**不吞异常** |

## Good / Base / Bad Cases

- **Good**：`.app` 从 520 MB 降到 ~361 MB；首屏 JS 1.70 MB → 514 kB；
  球形态 CDP 取证显示 `index-*.js` 里已无 three；切人物形态 three chunk 正常加载、3D 正常。
- **Base**：切人物形态时 chunk 加载失败 → 退回 2D 圆环 + 提示（与今天 WebGL 失败的表现一致）。
- **Bad**：只做 `filter` 不删源文件 → 用户下次跑 `fetch:humans`，128 MB 死重**全部回来**，
  而开发机上还看不出问题（打包产物是干净的）。这是「只做一半」最典型的形态。

## Tests Required

1. **静态守卫**：把 `PetBall.tsx:11` 改回静态 import → 必须报红（验收标准里已列）
2. **静态守卫**：`electron-builder.yml` 的 `from` / `to` 字段仍在（防有人为了省事改了寻址）
3. **静态守卫**：`fetch-human-pets.mjs` 里 `unlink`/`rm` `.tga` 的代码存在
4. **构建产物实测**：`out/renderer/assets/` 里 `index-*.js` < 600 kB，且存在独立的 `three-*.js`
5. **CDP 复测**：`probe-renderer.mjs` 在球形态抓 `Network.requestWillBeSent`，
   **0 条** `three-*.js` 请求；切人物形态后有 1 条
6. **实机**：`--ballshot`（人物形态）截图正常；`--uitest` 全绿
7. **回归**：`npm test` / `npm run typecheck` 全绿

## Wrong vs Correct

#### Wrong
先把 `README.md` 那句话删掉，代码以后再说：

- 用户看到的卖点与实现的差距还在，只是从「说了假话」变成「不敢说这个优点」；
- 而真正该修的三处（`.tga` 死重、`reyna-pilot` 死重、three 静态 import）
  一处没动 —— **文档不是修复，代码才是**。

#### Correct
按 D6 的顺序：改代码（D4/D5）→ 实测复测（Tests Required 4/5）→ 再改文案。
顺带清掉 159 MB 死重（D1–D3），而后者与 three.js 那件互不依赖，可以各自独立交付。