# 资源占用优化：清死重 + 兑现 three.js 卖点

## Goal

把两件**已经测出来的事**做掉，让对外表述与实现一致：

1. **安装包与磁盘里躺着 159 MB 从来不会被读取的 3D 素材**（`.tga` ×10 = 128 MB +
   `reyna-pilot/model.glb` = 31 MB）。清掉，纯收益，不改任何运行时行为。
2. **`README.md:45-46` 的「默认形态不加载 three.js」是假的** —— `PetBall.tsx:11` 静态
   import `pet3d/scene`，`scene.ts:1` 静态 import `three`，three.js 占入口 chunk 的
   **76%（1,298,574 B / 1,699,669 B）**。**先改代码让它变成真的，再写文案**。

## Background

竞品 `quota-viewer` 直接拿「Go+Wails ~50MB vs Electron 200MB+」做卖点，Electron 工具的
「太重」是普遍攻击点。本任务的价值不是「让数字变小」，而是**让文档说的和代码做的一致** ——
一句假的卖点比没有这句更糟：它一旦被用户在 DevTools 里验证，损失的是可信度。

调研原文与逐字原始输出：`.trellis/tasks/10-01-p1-5-resource/research/`
（`00-summary.md` / `01-baseline-measurements.md` / `02-optimization-candidates.md` / `raw/`）

## Requirements

### R1 · 清掉 159 MB 从不被读取的素材（用户已决策：**磁盘也清**）

1. **`.tga` ×10（128.0 MB）**：运行时从不被读取。FBX 里记的是 `xxx.tga`，但取 URL 时
   按 basename 换成 `textures/<base>.png`（`pet3d/human.ts:27-33`）；`main/human-assets.ts:39-44`
   的 MIME 表**没有 `.tga`**；CDP 实测抓到 7 条贴图请求**全是 `.png`**、`bd-asset://` 里 0 条 `.tga`。
   根因是 `fetch-human-pets.mjs:111-119` 用 `sips` 转成 PNG 后**不删源文件**。
2. **`reyna-pilot/model.glb`（31.0 MB）**：全仓库零引用、不在 `fetch-human-pets.mjs` 的
   `PETS` 列表里（`:26-44` 只有 aria/ray）、MIME 表没有 `.glb`。它是更早的 GLB 原型遗留
   （`README.md:208` 的 Roadmap 还留着「外部 GLB 模型加载」）。
3. 目标：`resources/human-pets` 从 **221 MB → ~62 MB**。

### R2 · 让「默认形态不加载 three.js」变成真的（用户已决策：**先改代码兑现**）

4. `PetBall.tsx:11` 的 `./pet3d/scene` 静态 import → **动态 import**，
   并加 `manualChunks` 把 `node_modules/three` 固定成独立 chunk。
5. 目标：首屏 JS **1,699,669 B → ~514,469 B（−71%）**。
6. **文案顺序不可反**：先改代码 → **实测复测** → 再改 `README.md:45-46`。
   未复测就改文案等于把一句假话换成另一句假话。

### R3 · 实测数字必须可复现

7. 优化前后各测一次，用**同一套脚本与口径**（`research/measure-memory.mjs`、`probe-renderer.mjs`），
   产出可对比的原始输出。
8. 文档里的每个数字都要能指到一份原始输出。

## Constraints

- **不碰运行时行为**：R1 的两个目录运行时从不被读取，删掉不改任何行为；
  R2 只改加载时机，3D 效果与交互必须完全不变。
- **`fetch-human-pets.mjs` 是构建钩子**：`package.json` 里 `predist:mac` / `predist:win`
  都调它。改动必须保证 `npm run fetch:humans` 仍能重新生成完整的 12 张贴图。
- **`electron-builder.yml` 的 `from`/`to` 不能动**：`main/human-assets.ts:31` 依赖
  `process.resourcesPath/human-pets` 这个落点。只加 `filter`。
- **`reyna-pilot/` 删了不可恢复**：它不在 `PETS` 列表里，`fetch:humans` 不会重新生成它。
  删除前**必须**确认用户已同意（用户已明确选「磁盘也清」）。
- **只做低风险项**：本任务**不做**调研里的 #3（主进程 QA 动态 import）、#4（90ms 轮询，
  调研列为中风险）、#5（React.lazy）、#7（依赖移到 devDependencies）——
  它们各自需要单独评估，不塞进本轮。
- **安装包整包数字不上文档**：`Contents/Frameworks` 的 262 MB 是 Electron 运行时本身，
  清完死重仍余 ~342 MB，而竞品大多不是 Electron（Tauri 主打 "~6 MB binary"）。
  拿整包数字宣传「我们也很小」是打不赢的误导，不做。

## Acceptance Criteria

- [ ] `resources/human-pets` 从 221 MB 降到 ~62 MB（实测，不是估算）
- [ ] `.tga` 在转成 PNG 后**被删除**，且 `npm run fetch:humans` 仍能完整重跑
- [ ] `reyna-pilot/` 已从磁盘与打包产物移除
- [ ] `electron-builder.yml` 的 `from`/`to` 未变，只加了 `filter`
- [ ] 打包产物 `.app` 体积下降且**运行时 3D 仍正常**（`--ballshot` / `--uitest` 的人物形态）
- [ ] 首屏 JS 从 ~1.70 MB 降到 ~514 kB（构建产物实测）
- [ ] **球形态的 CDP 取证显示 three.js chunk 不在首屏**（用 `probe-renderer.mjs` 复测）
- [ ] 切到个性人物时 three.js 正常加载、3D 场景正常渲染（无白屏、无回归）
- [ ] **chunk 加载失败时退回 2D 圆环**（不是白屏）—— 现有 WebGL 失败兜底要一并覆盖这个路径
- [ ] `README.md:45-46` 改为**实测复测后**的表述，且不再含未经证实的断言
- [ ] `DESIGN.md:303` **不改**（调研确认它写得比 README 精确）
- [ ] 优化后的常驻内存 / CPU 有实测数字，与基线对比
- [ ] `npm test` 与 `npm run typecheck` 通过
- [ ] **反验实测**：把 `PetBall.tsx:11` 改回静态 import → 某条守卫必须报红

## Notes

- 用户已拍板的两项决策：① 「改采集脚本，磁盘也清」；② 「先改代码兑现」。
- 本任务与「像素宠物瘦身」**不是同一件事**（用户在 P1 批次立过判断：没有合适的 2D 宠物素材
  就等于废掉整个数字助理）。本任务**不替换任何素材**，只删除**本来就没被读取过**的文件。
- 常驻内存基线（调研实测，`phys_footprint` 口径）：球形态 335–394 MB / 人物形态 485–568 MB；
  CPU 球形态 2.0–2.2 % 单核、人物形态 25–29 % 单核。**本任务不动 CPU 那两项**（候选 #4 列为中风险）。
- `measure-memory.mjs` / `probe-renderer.mjs` 是调研子代理留在 `research/` 下的取证脚本，
  **本任务复用它们**产出优化后数字，不要另起一套（口径不同则数字不可比）。
- `research/measure-memory.mjs` 与 `probe-renderer.mjs` 曾在另一个会话被提前 commit 过
  （`6c81361`），**checkout 该 commit 会拿到坏掉的中间态**；工作区版本才是产出 `raw/` 的可用版本。
- Tauri 迁移评估（兄弟任务）已判定**不迁移**，理由之一正是「478 MB 里 221 MB 是素材，
  87% 的体积收益与框架无关」。本任务是这个判断的**低成本验证**。