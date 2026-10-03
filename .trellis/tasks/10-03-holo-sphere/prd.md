# 全息悬浮球 → 水球（pivot，2026-10-04）

## Goal

收起态回到**小圆球**（56×56，零 WebGL），去掉外圈滚动进度环，改**全屏水满**做进度：
液位 = 用量百分比，水色随水位走警告色（沿用 `lvl` 阈值），波浪更真实且**常翻滚**；
贴边隐藏时缩成**单根水柱**（像温度计但不是温度计），同样带水波进度显示。
科技感通过立体光影 + 水体质感表达，而不是把球做大。

## Background（已确认事实）

- 现收起态默认 `holo`（232×444，常驻 WebGL，`src/renderer/src/holo/` + three 已加回；
  `shared/pet-view.ts:35-64` `HOLO_VIEW`/`petFormFor`/`viewFor`），用户实测“太大、脱离产品、不起重要意义”。
- 旧形态 `ball`（56×56 纯 DOM/SVG，`BALL_VIEW`）仍在：外圈 `dot-ring-track/fill`（r=22）+
  `fluid-waves` 双层正弦（幅 2.2 / 波长 28 / 1:1.6 错速，`PetBall.tsx:65-74`）+
  渐变球盘（`skins.css:2044-2116` inset 三层立体光影，无 outer shadow）。
- 等级口径现成：`ballLevel()`（`read-model.ts:241-246`，error→danger / 非 ok→muted /
  否则跟随窗口 `levelOfPercent`）→ `lvl-ok/warn/danger/muted` 已驱动环色
  （`skins.css:2132-2144`），水色可沿用同一 `lvl`。
- 贴边隐藏现成：`dock-hide.ts`（`PEEK=4` 痕迹、`hiddenBounds`/`peekHitbox` 同源，
  1000/300/1500ms 三计时）+ `fluid.ts`（pill 20×4 水渍 + `fluidForPhase` 相位映射）。
- ui-ux-pro-max 转用指导（2026-10-04 实测）：
  - gauge/bullet 适用于单 KPI 目标进度，thermometer 为备选；阈值区必须明确区分
    （chart 域，转用）。
  - **颜色不能是唯一信息通道**（ux Color Only, High）：水色变色必须配数字/图标/文字，
    环心读数与 `lvl` 文案保留。
  - 无限动画易分心（ux Continuous Animation）：常翻滚波浪保持小幅 + 藏起/不可见/
    reduced-motion 时暂停（现有 `hidden` 停波 + `visibilitychange` 模式沿用）。

## Key Decisions（用户已定）

- 回到 56×56 小圆球；holo 不做默认形态。
- 去掉外圈滚动进度条（`dot-ring-track/fill` 删除，轨道/填充弧逻辑一并退役）。
- 全屏水满做进度；水位高度映射警告色（阈值沿用 `lvl`，不另立第二份 85/60）。
- 波浪更真实 + 任何状态下一直翻滚荡漾（hidden/不可见/reduced-motion 暂停除外）。
- 贴边时缩成单根水柱（非温度计），同样显示水波进度。
- **holo 代码删除（2026-10-04）**：删 `src/renderer/src/holo/`、three 依赖与 chunk、
  `HOLO_VIEW`/`petFormFor` 双形态判定与相关 uitest/shots，分支回到干净 56 小球再做水满。

## Requirements（草案，待 design/implement 落字）

- **R1 形态**：默认收起态回 `ball` 56×56；holo 去留见 Open questions。
- **R2 水满**：删 `dot-ring` 外圈；球盘内全屏水体（clip 圆内），液位 = `fluidLevel(pct)`；
  水色按 `lvl`（ok/warn/danger/muted）走渐变，数字/图标仍保留（颜色非唯一通道）。
- **R3 波浪真实化**：三层错速波 + 表面高光线 + 液面泡沫/明暗（CSS/SVG 内实现，
  零 WebGL）；幅度小、常动；`hidden` 暂停沿用。
- **R4 皮肤**：5 套皮肤水体各异（沿用球令牌族 + 新增水体令牌，新增皮肤零代码）。
- **R5 水柱**：贴边隐藏态的水渍 pill 改为**竖向单根水柱**（左右边）/
  横向水槽（上下边），柱内液位 = 同一 `lvl`/液位，柱顶带小波浪；命中区与
  `peekHitbox` 同源重算。
- **R6 reduced-motion**：静态液位 + 无波浪位移（计时器保留，motion 降级）。
- **R7 测试**：`typecheck` + `npm test` + uitest（新增水满/水柱断言，每条先弄坏验证）；
  走查 5 皮肤 × 常态/水柱 + reduced-motion 静态帧。

## Acceptance Criteria（草案）

- [ ] 收起态默认 56 小球，无外圈进度环，全屏水满液位与百分比一致
- [ ] 水色随 `lvl` 变，数字/图标同步可读（非颜色唯一通道）
- [ ] 波浪常翻滚（三层错速 + 高光），5 皮肤各异
- [ ] 贴边水柱显示同进度 + 柱顶波浪，可点击/唤出
- [ ] reduced-motion 静态液位；三套测试绿

## Out of scope

- holo 全息球继续做大（已 pivot；去留见 Open questions）
- 球内旋转文字（永不做）；canvas/WebGL 水体模拟
- 新阈值体系（沿用 `lvl`）

## Open questions

- **Q1（最高价值）**：分支上已落地的 holo 实现（`src/renderer/src/holo/` +
  three 依赖 + `HOLO_VIEW` + 相关 uitest/shots）怎么处理？
