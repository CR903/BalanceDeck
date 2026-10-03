# 技术设计：小圆球全屏水满（holo 删除后）

## 边界

收起态只剩 `ball` 56×56 单形态、零 WebGL。先删 holo（步 0），再做水满（步 1–5）。
不新增依赖，不引入 canvas/WebGL 水体模拟，全部 DOM/SVG/CSS。

## 步 0：holo 删除清单

- 删 `src/renderer/src/holo/` 整目录、`scripts/test-holo.mjs`；
  `package.json` 去 `three`/`@types/three`，`electron.vite.config.ts` 去 three chunk。
- `shared/pet-view.ts`：删 `HOLO_VIEW`/`HOLO_STAGE_H`/`PetForm`/`petFormFor`/`viewFor`
  （留 `BALL_VIEW` 唯一尺寸）；`overlay.ts` 回单尺寸收起态；`PetBall.tsx` 删 holo 分支、
  `HoloForm` 引用、`webglFailed` 降级分支（无 WebGL 可失败，整条退役）。
- uitest/shots/ballshot 去 holo 键与 holo 帧；`skins.css` 去 `--holo-*` 令牌。
- 门：`grep -ri "holo\|three" src/ scripts/` 零残留（注释说明除外）；
  `typecheck` + `npm test` 绿。

## R2 水满：结构与颜色

- 删 `dot-ring-track/fill` 外圈（SVG + `skins.css:2129-2144` 环色规则退役，
  `lvl-*` 类改驱动水体色）。
- 球盘内全屏水体：`clipPath` 圆内矩形水 + 三层波浪 path（见 R3），液位沿用
  `fluidLevel(pct)`（`shared/fluid.ts:71`，一位小数粒度，无浮点抖动）。
- 水色按 `lvl`：`lvl-ok/warn/danger/muted` → 水体渐变（深底浅顶，顶部一条液面高光线）；
  读数数字 + 角标/图标保留（颜色非唯一通道，ux Color Only）。
- 非套餐（`!isPlan`）与算不出比例（`pct == null`）：画静水素盘（无液位语义，不造假水位）。

## R3 波浪真实化（CSS/SVG 内）

- 三层正弦波：振幅/波长/速度各异（如 2.2/28 快层、1.6/36 慢层反向、0.9/18 细纹层），
  错峰 phase；顶层带 1px 液面高光 + 泡沫明暗（同色高 alpha 细线）。
- 常翻滚：三层无限位移动画（`transform: translateX` 循环，首尾波形无缝）；
  暂停条件只有三处：`fluidPhase === 'hidden'`、document.hidden、reduced-motion
  （沿用现有停波模式，不新增第四种）。
- 性能：SVG path 逐帧改 `d` 换成 CSS 位移循环（只位移、不重算路径），56×56 内零布局开销。

## R5 贴边水柱

- 几何不动：`hiddenBounds`/`peekHitbox`（`PEEK=4`）与三计时器沿用，命中区同源。
- 渲染替换：隐藏态的水渍 pill 改为**水柱** —— 左右边：4px 宽 × 56 高竖柱，
  柱内液高 = 同一液位，柱顶一条小波浪；上下边：56×4 横槽，槽内液宽 = 同一液位。
  水柱色同样跟 `lvl`。水柱波浪与常态波浪同一套动画（一直翻滚）。
- 痕迹可点击/唤出路径不变（`dockReveal`）。

## R4 皮肤

- 新增水体令牌（如 `--water-deep/--water-top/--water-foam`），5 套皮肤各自调色，
  新增皮肤零代码；`:root` 必须有兜底（外部皮肤没写时不出现透明水）。

## 兼容与回滚

- 老偏好 `ui:pet` 键：单形态后不再读（行为恒为 ball），不删用户键，只停用。
- reduced-motion：静态液位 + 波浪位移全停（计时类保留）。
- 回滚：水满独立 commit（与 holo 删除 commit 分开），`git revert` 即回环+水渍版。
