# 水色随用量连续变色

## Goal

球内水体与贴边水柱的颜色随用量百分比连续变化：用量越高水色越"烫"。
在 60/85 阈值处精确命中等级色（与卡片/托盘同源），段间平滑插值。

## Requirements

- 新增 `src/renderer/src/water-color.ts` 纯函数 `waterColor(pct, anchors)`：
  分段锚点 `0→ok → 60→warn → 85→danger → 100→danger深一档`，段间 RGB 线性插值；
  非法输入（NaN/越界）钳制到 0–100，不抛异常、不返回透明（无水时由调用方不渲染，而非返回透明色）。
- 锚点色运行时取自当前皮肤的 `--ok/--warn/--danger`（`getComputedStyle`，缓存；皮肤切换失效重读）；
  解析失败回退 aero 缺省三色；外部皮肤自动跟随，无需写任何新令牌。
- 消费点：三层波 `fill` + 柱内液 `background` 走内联 style；现有 `lvl-*` CSS 填充规则保留为兜底。
- 非套餐（余额类）与算不出比例时：无水、无柱液（现状 `showWaves` 纪律不变，不造假水位）。

## Acceptance Criteria

- [x] pct=0/30/60/70/85/100 六档水色单调"变烫"，60/85 处与等级色肉眼无差
  → 单测用例 7（锚点精确命中 + 三段中点连续性）80/80；e2e `petWaterLevel=ok`（10% 实机 computed-fill 与公式期望逐位一致）
- [x] 切换 5 皮肤，水色系跟随皮肤走（candy 偏粉系烫、dark 偏荧光系烫）
  → `resolveWaterAnchors` 读 `.app` computed 三令牌（单测 pin 住 `--` 口径）；`--shots` 5 皮肤球截图均正常出水；
  高 pct 下的橙/红水实机帧待 G2 目检（shots 夹具只有 5.2%）
- [x] `test-fluid.mjs` 新增：锚点精确命中 / 越界钳制 / 非法输入回退（先红后绿）
  → 用例 7 共 24 条；K3d 在旧版 PetBall 上双红验证非空洞
- [x] `test-structure.mjs` K 门更新：内联水色存在 + `lvl-*` 兜底仍在，不断言具体色值（色值是皮肤的）
  → K3d + J4c + G1c，148/148
- [x] `npm run test` + `npm run typecheck` 全绿
  → 全套件零失败；typecheck 双工程干净；`npm run build` 通过

## Notes

- 技术细节见父任务 `design.md` D1。本任务是柱水色与入场高光的同源输入，必须第一个做。
- 落地偏移（2026-10-04）：纯函数部分入 `src/shared/water-color.ts`（跨进程语义，levels.ts 同例），
  DOM 胶水 `readWaterAnchors` 留 PetBall 本地 —— 原定的 renderer 路径过不了 node 工程的 composite 门（TS6307）。
- e2e 修过一个真 bug：`waterColorWhy` 传裸键导致锚点解析恒 null（单测用的 `--` 键掩盖了口径不一致），
  已修 + 单测 pin 住 getter 口径；`petWaterLevel` 两次实机 e2e 从红转绿。
- 基线对照：HEAD 下 `dragReorder/dragSettles/grp*` 6 项同样红（环境/状态），与本改动零共享代码路径。
