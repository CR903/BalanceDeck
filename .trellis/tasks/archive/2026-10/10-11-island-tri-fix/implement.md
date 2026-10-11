# implement.md — 灵动岛三修执行计划

## Checklist（按序）

1. R2 先行：`IslandView.tsx` 给 `.isl-confirm` 加 `confirmRef`，`reportHit` 并入确认条矩形（照 `PetBall.tsx:311-330`），依赖补 `alertText/notice`。
   - 验收：确认条出现时点“好的”一次消失，不触发展开/收起；关闭后命中回落。
2. R3 同体：去掉 `reportHit` 的静默早退（`:298`），量不到时上报兜底而非 return；与 R2 同一次验证长时点穿。
   - 验收：遮挡/布局抖动后岛仍可点；`petHitboxDebug` 与可见岛身一致。
3. R1 视觉：`NestedRings` 改回原型口径（每窗等级着色 + `#333` 轨道 + `data-lvl` 辉光），`uitest` 与 J4c 同步 revert 回 `waterColor` 期望。
   - 验收：环色与原型一致（“外橙内绿”可复现），缺失仍灰 `--`。
4. R4：锁顶（拖动只横向，松手回顶部）+ 修好中部拖（先定性断点再修，不改成移窗）+ 横向范围收窄到 `[0.25, 0.75]`（`ISLAND_POS_MIN/MAX`，单测同步）。
   - 验收见 AC4。
5. R5：找官方实心版 opencode 图形 + 定品牌色，改生成器后 regen，三处（岛/设置/托盘）截图目检。
   - 验收见 AC5。
6. R6：9 个无色 mark 各定品牌色（生成器 + regen，撞车检查）+ 嵌套家 combo logo 缩小（单环保持）。
   - 验收见 AC6。
7. 回归：`typecheck` + 相关单测 + 完整 `--uitest`（上轮两项红 `cardBack2`/`noDrift` 需定性：改动引入还是瞬态抖动，重跑验证）。

## Validation

```bash
npm run typecheck
npm run test:island-clip && npm run test:dock-hide && npm run test:fluid && npm run test:structure
npm run uitest   # 长（约3-4分钟），重点看 dockHide / islandPill / fail 项
```

## Risky files / Rollback

- `src/renderer/src/IslandView.tsx`（命中上报 + ref）：回滚即恢复只报 body。
- `src/renderer/src/island.css`（辉光层）：回滚即删 `drop-shadow`，保留轨道提亮。
- `src/main/overlay.ts`：本次不改；若 R3 需主进程侧补日志，另起小步、不动判定口径。

## Before start

- `implement.jsonl` / `check.jsonl` 已按 sub-agent 需要策展（见两文件）。
- 启动后先复现 R2（确认条出现 + 点不到），再动代码。
