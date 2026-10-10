# 执行计划：灵动岛替换水柱

## 有序清单

1. **shared 层**：`dock-hide.ts` 加 mini-pill 几何（替换 `peekHitbox` 的 COLUMN_W 分支）、删 `COLUMN_W`；`fluid.ts` 删 `waterColumn`（保留 `fluidForPhase`/`level`/时序常量）；`pet-view.ts` 加 `ISLAND_VIEW`（如 560×480）。
2. **main 层**（`overlay.ts`）：窗口改 `ISLAND_VIEW`；`isActive` 尺寸门同步；隐藏态 `peekOverride` 改 pill 区；其余（`safeSend`、dwell 计时、R7 开关）不动。
3. **renderer**：新 `IslandView.tsx`（收起平铺 + 展开卡 + 顶内拖动 + 落盘 `ui:islandX`），原型 CSS/结构迁移；`PetBall` 收起分支切岛（单点开关）；`App.tsx` 接线（`App.tsx:115-122,500,1012-1016` 的 dock 状态透传）。
4. **样式**：岛样式独立文件；删 `skins.css` 的 `fluid-pill` / `[data-fluid]` 水柱规则。
5. **单测同步**：`test-fluid.mjs` 删水柱用例、`test-dock-hide.mjs` 改 pill 用例；先改断言看红，再实现看绿（质量铁律：loadTs 真源）。
6. **验证**：`npm run typecheck` + `npm test`；`--uitest` / `--shots` 摆拍收起/展开/隐藏三帧，目检。

## 验证命令

```bash
npm run typecheck
npm test
npm run build && electron . --uitest   # 状态机 + 探针回归
npm run build && electron . --shots    # 三帧摆拍
```

## 风险文件 / 回滚点

- `src/main/overlay.ts`（窗口尺寸 + 命中轮询）：改前 commit；窗口尺寸回滚即回 56×56。
- `src/renderer/src/PetBall.tsx`（收起分支切换点）：保留旧分支注释开关一个版本。
- `src/shared/dock-hide.ts` + `scripts/test-dock-hide.mjs`：几何与断言同 commit。
- 水柱删除（`fluid-pill` JSX/CSS、`COLUMN_W`、`waterColumn`）独立 commit，可单独 revert。
- `git status` 现有 dirty（`prototype/`、`.playwright-mcp/`）不动，不纳入本任务 commit。

## `task.py start` 前复核

- [ ] prd 无阻塞 open question（Q1 已决：保留隐藏→A 式 mini-pill）
- [ ] design/implement 已评审通过（等用户批最终总结）
- [ ] implement.jsonl / check.jsonl 已填实（本任务已填，见 1.3）
