# 2026-10-04 皮肤差异化返工 R1–R3（10-04-skin-fluid-redesign）

## 起因

用户验收打回：① 各皮肤波浪要不一样 ② 倒水像一坨往下掉，要细水长流
③ 贴边收缩像水直接进边缘，要整球变水流被吸进去、水柱从底下灌满长高。
原 AC 作废重验；R2/R3 属已归档子任务的 deviation，不重开归档任务。

## 交付

- R1：`src/renderer/src/skin-waves.ts` 五皮波形表（振幅/波长）+ `--wave-len-*` 漂移距离同步；
  高光线与 A 层同参数；ext 回退默认。
- R2：删整坨 `pour-fill`，换 `.pour-stream` 5px 细射流 + `.pour-splash` 触水 ripple；
  水位静默（56px 下 600ms 液位爬升不可辨）；冲顶/slosh 时序映射微调，POUR_* 数值不动。
- R3：`disc-absorb` 单套改 h/v 两套（沿边轴拉长成液线再没入）；revealing 不动；
  柱灌满逻辑不动（已是 bottom-up + 波随液头，用户要的"从底下长高"本来就有）。

## 验证

- `test:fluid` 115/115（含用例 9：表合法性 + CSS 跨钉），`test:structure` 185/185，
  `typecheck` 干净，`npm test` 全绿，`npm run build` 通过
- 实机：5c-wave 极差≈2A（aero 4.28/4.4、dark 5.94/6.0、minimal 1.56/1.6、candy 5.88/6.8、ink 3.04/3.2）；
  5l 射流窄条 + ripple + 球内水；5i disc matrix(1.4,0,0,0.7) aspect 2.0；
  5n 温度计探针回归（fillH 39.2px）
- e2e 流体全绿；剩余 6 项为基线已知失败（drag/grp，HEAD 已对照）

## 坑位

1. goo 开时像素颜色漂移，跨滤镜开关的像素对比不可比 —— morph 取证用 DOM 探针（computed transform），不用像素。
2. 绿色阈值检测器对低饱和/橙水盲（minimal/aero 在 40% 下绿数=0 但水区均值对）—— 按期望色分类像素。
3. uitest 偶发整体超时（>10min 无输出），重跑即恢复；属 harness flake，非回归。
4. K2d 旧断言读死像素位移，变量化后改判表达式 + 单测跨钉数值（门要跟着重构一起改，不能只改源码）。
