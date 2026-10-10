# 2026-10-10 灵动岛替换水柱（复检 pass，待实机 `--uitest`/`--shots`）

## 起因

用户拍板 B 方案：收起态水球 + 12px 温度计水柱整体换成顶部灵动岛。
高保真原型（`prototype/dynamic-island-demo.html?variant=B`，截图逐帧验过）先行，
任务 `10-10-dynamic-island` 按原型进实现。

## 做了什么

- implement 子代理落地 13 改 + 2 新：`IslandView.tsx`（收起平铺/展开卡/mini-pill/顶内拖动落盘
  `ui:islandX`）、`island.css`（独立深黑样式）、`ISLAND_VIEW` 560×480 全链路、
  `peekHitbox` 改 pill、`waterColumn`/`COLUMN_W` 删除、单测与 `--uitest`/`--shots` 探针同步。
- `npm run typecheck` ✓，`npm test` 全绿（2595 ✓），反向注参验证断言非永真。

## check 结论：FAIL（3 blocker）

1. **R4/AC1 未完成**：水柱 DOM/CSS 一行未删（`PetBall.tsx` 旧分支 + `skins.css` 约 20 处规则全留），
   且 `data-fluid` 在 AC1（删）与 design 决策 5（保留相位同步）之间字面互斥，需用户裁决。
2. **窗口永久不可移动**：岛内拖动只改 `posX` 且 uitest 反向钉住不触发主进程拖拽，
   design 从未授权——R7「拖动移动不受影响」若指窗口移动则违反。待用户二选一
   （恢复拖拽分区 / PRD 签字确认不可移动）。
3. 本日志即补该门禁；P2 自检见下。

另：单击改义（单击=岛展开/收起，双击回卡片）待用户签字；AC2–AC5 的 `--uitest`/`--shots`
本环境无显示服务，标未验证，留用户环境执行。

## P2 沉淀自检（daily-to-knowledge 三问）

1. 通用坑？有：展开动画 `transform` 会冲掉定位 `translateX`（原型已踩，改独立 `scale` 属性修）。
   → 已在原型注释 + design 决策 5 记录；属本任务内知识，暂不进通用 knowledge。
2. 跨任务复用？`markColor() || 'currentColor'` 与 D6 阴影门禁均为既有规范重申，无新增。
3. 命名/口径漂移？`MINI_PILL` 几何唯一出处 `dock-hide.ts`（沿用 COLUMN_W 教训），单测已钉。
   → 无需更新 `knowledge/`。
