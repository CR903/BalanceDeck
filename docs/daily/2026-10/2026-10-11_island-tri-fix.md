# 2026-10-11 灵动岛六修（环色/确认/点穿/锁顶/图标/配色，复检 pass，截图交付）

## 起因

用户连报 6 波：①嵌套环太暗要靓丽 → ②确认条“好的”点不到 → ③运行久了岛可见但点穿 →
④中部拖完全没反应（只有底部边缘可拖）→ ⑤opencode logo 与别家效果不一（不居中感）→
⑥岛内 logo 上色 + 嵌套家 logo 挡最内环。中间还插曲两轮方向往返：彩虹固定色（用户先定后撤，
改回原型等级色）与拖拽分区（用户纠正：岛永驻顶部、只许顶部横向滑，带子保留）。

## 改了什么（`10-11-island-tri-fix`，4 次提交）

- R1 环色（`1482557` 彩虹 → `68dcb8d` 回摆原型）：`NestedRings` 每窗等级着色
  （`waterColor`，截图“外橙内绿”可复现），轨道 `rgba(255,255,255,0.14)`→`#333`，
  辉光按 `data-lvl`；几何/顺序/尺寸不动。高度“偏高”经 shots 像素实测定性：
  布局 52px 与原型逐项一致，视觉 +8~12px 来自同栈投影+辉光呼吸，原型实拍亦然，保留。
- R2 确认条可点：`reportHit` 只报 body 是根因（确认条在命中区外被 OS 穿透），
  照 `PetBall.tsx:311-330` 并入可见确认条矩形；`notice` 不并入；手势防护不动。
- R3 长时点穿：去掉 `reportHit` 量不到就静默 `return`（旧 hitbox 永久陈旧），改报兜底顶条；
  主进程判定口径（pad=3/90ms/`forward:true`）不动。
- R4 锁顶 + 中间段（`68dcb8d`）：overlay 三处锁顶 `ny = wa.y`；`ISLAND_POS_MIN/MAX`
  `0.08/0.92`→`0.25/0.75`（宽度感知交集不动）；中部拖查清链路不断裂（旧构建手势挂
  `.isl-hit` 所致，R7 上根已修），补 `islComboDragJs` 真落点探针 + `dragTopPinned` 锁顶断言。
- R5 opencode 图标（`28299be`）：官方无单色实心版，回退 B 方案——内孔收窄壁厚 5→7
  （墨量 +25%，仍居中）+ 品牌绿 `#12B76A`；生成器 patch 未命中即抛错；其余 17 家零漂移。
- R6 配色 + 瘦身（`4ae35e4`）：9 个无色 mark 各定品牌色（官方色优先：Copilot 紫
  `#8534F3`/Cursor 橙 `#F54E00`/Gemini 浅蓝 `#8AB4F8`/Antigravity 黄 `#FBBC04`/Kimi 蓝
  `#00A1FF`/Codex·billing 白/OpenRouter slate/generic 灰，与 8 个已占色无撞车）；
  嵌套家 combo 中央盘 15→11（半径 5.5 < 内环内缘 6.0），单环/展开态不动。

## 波折

1. 彩虹往返：R1 先按用户要求做固定彩虹（含 uitest/J4c 同步），用户见原型截图后撤回，
   原样 revert——测试同步小步可逆是这轮没翻车的原因。
2. 中部拖“无断点”结论：CDP 实证链路全通，与用户实测矛盾；收敛为旧构建问题
   （手势挂位）+ 真落点探针回归锁定。若实机再现，按 zone/state/钳制三选一重开。
3. `cardBack2`/`noDrift` 两红：合成点击动不了真光标，edge 拖的真 `dragStop` arm 1s dwell
   把岛藏掉致连锁红；`setDockHideEnabled(false)` 包夹隔离后重跑全绿，系瞬态竞态。

## 验证

- `npm run typecheck` ✓；`test:island-clip` 37 / `dock-hide` 155 / `fluid` 115 /
  `structure` 447 / `tray` 98，全部 0 失败。
- 完整 `--uitest` **161 项 0 fail**（新鲜构建）；`--shots` 三处目检（岛收起七色并排、
  展开 7 cell、设置页）+ 像素探针（绿簇 779px、中心 x≈291）。
- 提交：`1482557` → `68dcb8d` → `28299be` → `4ae35e4`。

## 沉淀

- `.trellis/spec/frontend/component-guidelines.md` 新增命中上报两纪律（可见浮层必并入、
  量失败必报 fallback，禁止静默早退）。
- `docs/knowledge/frontend/overlay-hitbox.md` 新增（透明窗命中区三纪律 + dwell 隔离探针手法）。
- 待人工：品牌色观感实机目检（门只保唯一性不保好看）。
