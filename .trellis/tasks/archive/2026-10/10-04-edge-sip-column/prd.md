# 贴边吸溜水柱温度计

## Goal

贴边隐藏时：球里的水被屏边"吸溜"走（水面下降、流向贴边侧），屏边升起一根温度计形水柱；
隐藏期间柱里的水一直在轻轻动荡，唤出时水再流回球里。

## Requirements

- `absorbing` 阶段：`.fluid-waves` 加 `drain`（整水体下沉 + 向贴边侧偏移，复用 `--dx/--dy`），
  被 clip 圆裁出"水面下降被吸走"；`bridge` 拉宽成流道；柱内液经 `--lvl` 变量（与 `fluidLvl` 同源）
  从 0 灌到满——柱是被灌满的，不是淡入的。
- `hidden` 态：球内波保持暂停（省电），**柱顶波与柱内涌动保持动画**（与现状 J3b 不同，单测同步更新）。
- 温度计形状：柱体 + 顶部圆泡（`::before` 圆头）+ 侧面高光线 + 3 格刻度线（默认开，可评审关闭）。
- 液位 0（余额类/无比例）时只留空槽，不造假水位。
- `revealing` 阶段反向：柱液降回 0 → 流道 → 球回弹成形（复用现有 400ms 反向结构，只换位移曲线）。
- reduced-motion：直接显隐（现有纪律不变）。

## Acceptance Criteria

- [x] 贴边录屏：看得出"水面下降 → 被吸向边 → 柱从空灌到满"三段，不是球整体缩小
  → `waves-drain`（下沉 26px + 贴边 22px + 淡出）+ `bridge-absorb-h/v`（按边拉宽成流道）
  + `column-rise`（位移演灌满，高度恒 = fluidLvl）；harness 无视频，动态三段需人眼终验
- [x] hidden 态走查：柱顶波一直在动，球内波静止
  → K8d（hidden 暂停名单无 column）+ K8d2（doc-hidden 仍停柱波）；e2e `dockFluidHidden=ok`
- [x] 隐藏态水柱液高 == 球内液位（同一 `fluidLvl`，逐值对拍 0/30/60/100）
  → K8f 绑定 + 自描述探针 `fillH=39.2px=70%×56` + 5n 像素对拍（橙水 y32–108 ≈ 76px ≈ 78px 期望，
  弯月 + 三格刻度 + 柱顶波全可见）；0% 空槽由 5g（balance 夹具整条空槽无假水）覆盖
- [x] 唤出录屏：水流回球里，末段有轻微回弹
  → `waves-fill` 淡入回升 + 既有 disc-reveal 回弹；e2e `dockFluidReveal=ok`；动态需人眼终验
- [x] J3b/K 门单测同步更新（先红后绿）；`npm run test` + `npm run typecheck` 全绿
  → K8a–K8h（旧版 6/6 红）；全套件零失败；typecheck 干净；e2e 流体全绿

## Notes

- 技术细节见父任务 `design.md` D3。顺序在水色任务之后（柱液颜色与 `--lvl` 都复用它的输出）。
- 落地偏移（2026-10-04）：① 灌满不用 `--lvl` 变量，改用自身高度百分比位移演（高度是数据的、位移是演的）；
  revealing 不做反向 sink（柱由 pill-reveal 整根缩走，反向位移末帧弹跳）。
  ② 圆泡改液头弯月（fill `::before` + `:not(:empty)` 守门，`background:inherit` 吃水色）。
  ③ **hidden 稳态关 goo 滤镜**（K8h）：离屏窗口 SVG 滤镜子树画不出，5n 取证（盒与颜色全对但像素透明）。
  morph（absorbing/revealing）仍走 goo —— morph 与位移串行，morph 时窗口全程在屏内。
- 探针教训：绿色阈值检测器对橙水（70% = rgb(255,123,29)）全盲，连续水色时代必须按期望色分类像素。
