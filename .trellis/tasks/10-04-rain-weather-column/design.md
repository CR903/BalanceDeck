# R4返工 — 技术方案

## D1. 雨滴（R4-1，renderer only）

- 删 `.pour-stream` 单流；新增 `.pour-drop ×7`（固定表：left%、delay、duration、kind）。
  kind = center（触水 splash）/ wall（触水转 trickle，不挂 splash）。
- 位置确定性：JSX 内联 `left: X%` + `animation-delay`，表放 `skin-waves.ts` 旁新导出
  `POUR_DROPS`（单测 pin 住 7 滴 kind 分布与 left 范围；不 pin 具体随机——表是手写的）。
- 每皮可见数不同：CSS `[data-skin] .pour-drop:nth-child(n+K) {display:none}`（春雨5/海啸6/平静3/暴雨7/雾雨4）。
- drop 形状：3–5px 宽水滴（border-radius 50% 50% 50% 0 旋转45°经典形太贵，用椭圆+顶部小尖：`border-radius: 50%` 拉长即可，
  56px 尺度下足够）；下落 keyframes：translateY(-30px→surface)+opacity 首尾淡；
  时长用 `--drop-fall` 变量（暴雨快、海啸慢？海啸 pour 是帘式——海啸用宽而慢的 2 滴+大 slosh，见 D3）。
- trickle：左右各一条 `.pour-trickle`（1.5px 宽，scaleY 0→1 从 surfaceY 处向下长到杯底，
  600ms，opacity 随收），只在 pour 期间存在（JSX 与 drops 同条件挂载）。
- splash 复用现有 `.pour-splash`（中心滴落点 2–3 个，位置按 drop 表内联 top/left）。

## D2. 溢出+泡沫带（R4-2/R4-3，renderer only）

- `[data-fluid='edge-visible'] .petball-goo { clip-path: circle(27px at 28px 28px) }`。
  absorbing/revealing 不裁（桥要出圆）；hidden 稳态 goo filter 已关，无光晕，无需裁（加也无害，不加）。
  freeze 定帧：data-fluid 保持 edge-visible（现状如此）→ 自动被裁，5i/5j 不拍出界。
- 泡沫带：新函数 `waveBand(surfaceY, phase, A, L, depth=3)`，上沿同 A 参数、下沿 +depth，
  fill foam 色、opacity .9，画在 B/C 之后、surface 线之前；surface 线压在带上沿。
  冒头 ≤3px 被盖住（各皮 B/C 振幅 ≤ A 的 0.75，构造上冒头 ≤ ~2px，见单测用例 9 振幅表）。
- 灵动感：slosh 幅度变量化 `--slosh-amp`（candy 12px / dark 10px / aero 8px / ink 6px / minimal 4px），
  keyframes 用 var（Chromium 对元素 vars 解析，逐皮生效）。

## D3. 天气（R4-4）

| 皮 | 天气 | 波（已有） | 雨 | 幅 |
|---|---|---|---|---|
| aero | 春雨 | 快波高透 | 5 细滴、小 splash | 8px |
| dark | 海啸 | 大涌浪慢速 | 6 宽慢滴、大 ripple | 10px + 涌浪二次摆（slosh 周期拉长） |
| minimal | 平静 | 微澜 | 3 极细滴、无 splash（涟漪小圈） | 4px |
| candy | 暴雨 | 短弹大浪 | 7 大滴、大 splash、Q 弹 | 12px |
| ink | 雾雨 | 阔平 | 4 淡滴（低 opacity）、慢 | 6px |

- 变量：`--drop-w`、`--drop-fall`、`--splash-s`、`--slosh-amp`，:root 默认 + 逐皮覆盖（K9a 同口径断言）。
- 海啸二次摆：dark 的 slosh keyframes 多一段（单独 `@keyframes pour-slosh-dark`？不——同一 keyframes，
  用时长变量 `--slosh-dur` 拉长 + 幅度变量放大，波形同源，够用）。

## D4. 原地变柱（R4-5，主进程+渲染层）

- `hiddenBounds`：返回 docked 本身（窗口不动）。`landed()` 恒真（位置从未离开）。
  保留函数（调用方/单测入口不变，只改语义：注释与单测期望同步）。
- 隐藏态命中/可见：`peekHitbox` 改为返回边侧 12px 全高条（COLUMN_W=12）：
  left → {x:0,y:0,w:12,h}；right → {x:w-12,…}；top → {x:0,y:0,w,h:12}；bottom → {x:0,y:h-12,…}。
  即"柱子在哪、哪可点"。PILL_LEN（20px 水渍）退役？pill 已是水柱——检查 waterColumn/pillBox 引用，
  收敛到 12 全高（保留函数签名，改实现+注释+单测）。
- 渲染层：hidden 稳态 `.fluid-pill` 改 12px 宽、全高、贴边侧（left 边→left:0；
  当前 pill 在 left 边时 right:0 —— 方向要翻）。`--dx/--dy` 方向翻转（column 在边侧，
  球心→柱心的位移反号）。disc-absorb-h/v 终点位移改为柱心（∓22px）。
- 时序不变：morph 530ms → hidden（无位移）；revealing 反向。animateTo(to=docked) 原地零位移——
  直接 setPhase 跳过步进（零位移步进无意义，单测钉住"不动窗口"：setPosition 0 调用）。
- 影响面：test-dock-hide.mjs（hiddenBounds/peekHitbox 期望）、uitest dockHide/dockEdges/bounds、
  shots 5g/5n（5g 从"离屏证据"变为"原地柱证据"）、overlay 步进。逐项改，先红后绿。
- reduced-motion：直接显隐（旧路保留）。

## D5. 余额水（R4-6）

- `showWaves` 扩大到余额类；余额 `fluidLvl = 1`（满水，注释写明语义：钱足=满杯，
  与"用量比例"无关，不叫 pct）；`water` 取 accent（`readWaterAnchors` 加读 `--accent`，
  water-color.ts 加 `accentWater()`？不——直接复用：余额水色 = anchors.accent 实色，
  不插值。`resolveWaterAnchors` 加读 accent，缺省回退 aero #0a84ff）。
- lvl 语义：余额 ballLevel 保持 muted？水满但读数 muted——检查 ballLevel 对 balance 返回，
  读数色不动，只加水（用户要的就是"有效果"，等级语义不动）。
- 柱：余额 hidden 同样满柱（与球同源 fluidLvl=1）。
- 测试：uitest balance 分支改"有水满水"；`fail:fake-level` 仅保留 nodata/error；结构门同步。
