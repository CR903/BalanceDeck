# 水球流体视觉重设计 — 执行计划

## 顺序（依赖写死，不靠树形位置暗示）

1. `10-04-water-color-by-usage` —— 水色插值函数 + 内联消费 + 单测。柱水色同源输入，必须最先。
2. `10-04-pour-in-slosh` —— 依赖 1（冲顶闪用的高光色与水色同源；独立播也行，但合在一起验省一次走查）。
3. `10-04-edge-sip-column` —— 依赖 1（柱液颜色与灌满 `--lvl` 都复用 1 的输出）。
4. `10-04-skin-fluid-redesign` —— 依赖 1、2、3（皮肤变量覆盖前面三步落定的默认水效）。

## 每个子任务的固定 checklist

- [ ] 按子任务 prd.md 实现（含 design.md 引用的对应章节）
- [ ] `npm run test` 全绿（含本次更新的单测，先红后绿留记录）
- [ ] `npm run typecheck` 通过（typecheck 不在 test 里，必须单独跑）
- [ ] 5 皮肤 × 相关态截图走查（`--shots`，新增取帧见 design.md）
- [ ] reduced-motion 退化验证（动画类断言 + 肉眼一帧）
- [ ] 子任务内 review gate：向用户展示走查截图/录屏，确认后再 `archive`

## Review Gates（门禁，不跳过）

- G1：本计划 + 4 子任务 prd 评审（当前这轮）→ 才能 `start` 子任务 1。
- G2：子任务 1 走查（连续变色录屏 + 换肤跟随）→ 才能 `start` 子任务 2、3。
- G3：子任务 2、3 走查（入场录屏 + 贴边录屏）→ 才能 `start` 子任务 4。
- G4：全量走查 + 父任务跨子任务验收 → `archive` 全部。

## 验证命令

```bash
npm run test            # 全部单测 + 结构门
npm run typecheck       # tsc 双工程
npm run shots           # 取帧走查（需屏幕权限环境）
```

## 回滚点

- R1（子任务 1 后）：摘 `waterColor` 内联 style 即回三档（CSS 兜底仍在）。
- R2（子任务 2 后）：摘 `data-pour` 挂载即无入场。
- R3（子任务 3 后）：`drain`/柱灌满 keyframes 独立命名，删除即回旧 morph。
- R4（子任务 4 后）：皮肤变量删除即回统一默认水效。
