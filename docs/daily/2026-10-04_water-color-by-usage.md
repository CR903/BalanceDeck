# 2026-10-04 水色随用量连续变色（10-04-water-color-by-usage）

## 交付

球内三层波 + 贴边柱内液颜色随用量连续插值：`0→ok → 60→warn → 85→danger → 100→danger深一档`，
阈值处精确命中等级色（与卡片/托盘同源），段间 RGB 线性插值。锚点运行时读皮肤 `--ok/--warn/--danger`，
换肤自动跟随；CSS `lvl-*` 保留为兜底。

## 改动

- 新增 `src/shared/water-color.ts`（跨进程纯函数：parse/shade/waterColor/resolve/default，与 levels.ts 同例）
- `PetBall.tsx`：三层波 `fill` + 柱内液 `background` 走内联水色；`readWaterAnchors` 本地胶水 + 换肤 MutationObserver
- `src/main/qa/uitest.ts`：`waterColorWhy` 改按同实现算期望（删 `lvlToken/hexToRgb` 第二份公式）
- 单测 `test-fluid.mjs` 用例 7（24 条）+ 结构门 K3d/J4c/G1c

## 落地偏移

纯函数原定放 renderer，被 node 工程 composite 门（TS6307）拦下 → 搬 `src/shared/`，DOM 胶水留调用方。

## 真 bug（e2e 修）

`waterColorWhy` 传裸键（ok）而 `resolveWaterAnchors` 要 `--ok`，锚点恒 null。
单测用的 `--` 键掩盖了口径不一致 → 单测 pin 住 getter 口径（`seen==['--ok','--warn','--danger']`）。

## 验证

- `test:fluid` 80/80，`test:structure` 148/148，`typecheck` 双工程干净，`npm test` 全套件零失败，`npm run build` 通过
- K3d 在旧版 PetBall 上双红（非空洞）；实机 e2e `petWaterLevel=ok`（10% computed-fill 与公式期望逐位一致）
- 基线对照（HEAD worktree）：`dragReorder/dragSettles/grp*` 6 项同样红，属环境/状态，与本改动零共享路径

## 坑位（可沉淀）

1. **goo 会吃掉淡 alpha**：`--track`（alpha 0.18）的 pill 进 `feColorMatrix(18,-7)` 后归零 ——
   隐藏态屏上 4px 条实际是球底色盘缘，不是水柱（5g 解码实证）。edge-sip-column 必须让柱色不透明或移出 goo。
2. **隐藏态落盘不藏**：`.petball-fallback` 本体在 hidden 无隐藏规则，只有 goo 内元素收敛。
3. **顶部 macOS 菜单栏夹回**：贴边隐藏被干净拒绝是设计（uitest 有专门断言），不是 bug；底部看 Dock 位置。
4. **窗口永不缩放**：`hiddenBounds` 只改 x/y 不改宽高，四边一致。
