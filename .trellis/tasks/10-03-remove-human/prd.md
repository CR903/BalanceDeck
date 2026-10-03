# 废除真人相关功能

## Goal

彻底移除数字真人（Aria/Ray）相关功能：收起态只留 2D 悬浮球（环 / goo 流体）。
删 three.js（如 holo-sphere 落地则保留 three、只删人物管线——见 holo Q1 结论再定）、
删 Rocketbox 素材管线与人物渲染/动作/测试/文档，还原干净的单形态收起态。

## Background（已确认事实）

- 人物管线：`src/renderer/src/pet3d/`（scene/human/gesture/rig/tokens/clips，`scene.ts:151` 建 WebGL），
  `PetBall.tsx:196-246` 动态 import（figure 才加载）。
- 形态尺寸：`src/shared/pet-view.ts:19-28` `FIGURE_VIEW` 213×293；主进程 `overlay.ts:20-21,47-51`
  `petFigure`/`setPetFigure`；窗口 56×56（环）vs 213×293（人物）双尺寸。
- 素材管线：`scripts/fetch-human-pets.mjs` + `predist` 钩子（`package.json:40-41`）+ `resources/human-pets`
  （gitignored，实测 62MB 真读）；`three` + `@types/three`（`package.json:55,63`）；
  `electron.vite.config.ts:24-26` three 独立 chunk。
- 设置/菜单：`PetSection.tsx` 个性人物开关、`PetBall` figure 分支与人物泡泡、`ipc.ts` 相关菜单项。
- 测试：`test:pet`/`test:gesture`（人物动作）、uitest 人物形态键、shots 人物帧、ballshot `BD_PET` 系列。
- 文档：`README.md:40-85` 人物章节、`CONTEXT.md:58-90` 数字助理/动作/静息/就位词条、`DESIGN.md`/`TASKS.md` 相关轮次。
- 用户数据：`ui:pet`=`1` 的老用户收起态切回环形态（`decodePetState` 式迁移先例，养成字段已忽略过一次）。

## Requirements

- **R1 删除**：`pet3d/` 整目录、`fetch-human-pets.mjs`、`predist` 人物钩子（保留钩子位若 holo 需素材位则注明）、
  `FIGURE_VIEW`、`petFigure`/`setPetFigure` 双尺寸分支（窗口恒 56×56）、人物泡泡/动作/ Walker 残留。
- **R2 依赖**：删 `three` + `@types/three` + three 独立 chunk（holo 若落地则保留，见下 Risks）。
- **R3 设置与菜单**：删个性人物开关/换人/人物菜单项；`ui:pet` 老值迁移为环形态。
- **R4 测试**：删人物动作测试（`test:gesture` 人物部分），保留 dock/fluid 可复用部分；
  更新 uitest/shots/ballshot 去人物键；`npm test` 全绿。
- **R5 文档**：README/CONTEXT/DESIGN/TASKS 去人物章节（CONTEXT 数字助理词条改写或删除）。
- **R6 无回归**：环/goo/dock-hide/fluid、展开态、托盘、采集全不受影响；`typecheck` + 全测试 + uitest 绿。

## Acceptance Criteria

- [ ] `grep -ri "figure\|human\|aria\|ray\|three" src/ scripts/` 零残留（测试夹具注释除外，需逐条说明）
- [ ] 老用户 `ui:pet=1` 启动后为环形态，不崩不丢其他偏好
- [ ] 包体积/依赖清单变化记录；`typecheck` + `npm test` + uitest 绿（人物键已删，先弄坏验证剩余键）

## Out of scope

- holo-sphere 实现（独立子任务）；dock-hide/fluid 功能改动（只保活）。
- `09-18-human-realism` / `09-18-vroid-hub` 归档（父任务收尾时处理）。

## Risks

- three 去留取决于 holo Q1：默认实现**删 three**；若 holo 批准确立保留，则改删人物管线、保留 three + chunk，
  本 AC 的 grep 项相应放宽（`three` 豁免，记录在案）。
