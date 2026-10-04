# 2026-10-04 贴边吸溜水柱温度计（10-04-edge-sip-column）

## 交付

贴边隐藏变成"吸溜"：球内水下沉流向贴边（drain）+ 液桥按边拉宽成流道（bridge-absorb-h/v）
+ 柱从空灌到满（column-rise 位移演，高度恒 = fluidLvl）；隐藏态柱顶波持续动荡、
球内波静止；温度计三件套（液头弯月 + 管壁三刻度 + 管壁侧光）；唤出水淡回（waves-fill）。

## 改动

- `PetBall.tsx`：`.fluid-ticks` 刻度元件；注释更新（温度计结构、rise/sink 取舍）
- `skins.css`：drain/rise/fill/h/v 双套关键帧；hidden 暂停名单删柱波 + 球内水 opacity 0；
  **hidden 稳态关 goo 滤镜（K8h）**；reduced-motion 扩展新位移层
- `shots.ts`：`5n-column-70` 定量帧 + 自描述探针；`fixtures.ts`：`column70Snapshot()`（单家 70%，无轮播）
- 结构门 K8a–K8h（旧版 6/6 红）；test-fluid 无新增（rise/drain 纯 CSS，无 shared 口径可钉）

## 验证

- `test:structure` 164/164，`npm test` 全绿，`typecheck` 干净，`npm run build` 通过
- e2e 流体全绿（petWaterLevel/Column、dockFluid*、dockHide/Edges）
- 5n 定量对拍：探针 `fillH=39.2px=70%×56` + 像素橙水 y32–108（≈76px ≈ 78px 期望）+ 弯月 + 三刻度全可见
- 5g（balance 夹具）：整条空槽无假水，覆盖液位 0 分支

## 真 bug（离屏 SVG 滤镜）

hidden 稳态 goo 开着时，柱盒/颜色全对但像素透明（5n 取证）。根因：离屏窗口 SVG 滤镜子树画不出；
fallback 盘（滤镜外）正常。修：hidden 稳态关 goo（无可融合形状，morph 仍走 goo ——
morph 与位移串行，morph 时窗口全程在屏内）。教训：e2e 的 fillH/style 断言是样式级，
像素级需 shots 对拍；绿色阈值检测器对橙水全盲，须按期望色分类。

## 坑位

1. revealing 不做反向 sink（柱由 pill-reveal 整根缩走；反向位移末帧弹跳）。
2. `animation` 优先级高于 transform：定帧/稳态覆盖必须先停 animation。
3. K 编号：K5（波浪暂停）与 K7（倒水）撞号先例，本次从 K8 起。
