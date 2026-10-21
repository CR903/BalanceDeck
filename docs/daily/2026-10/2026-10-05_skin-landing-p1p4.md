# 2026-10-05 皮肤视觉原型落地 P1–P4（skin-landing）

> 真相源（main checkout 只读）：`prototype/skin-applied.html` + `docs/daily/2026-10-05_skin-applied-mock.md`
> （waveSvg 双层浪 / ball::after 玻璃罩 / 柱样式 / A 区柱顶浪 / D 区 peek / V6 三段 morph 参数）。
> 工作区：`/Users/zhouri/project/BalanceDeck-skin`（分支 `skin-landing`，基线 main `eff0a0e`）。
> main checkout 与 main 分支零改动，未合并。

## 交付（P1–P4，P5 待 review 后定）

1. P1 V6 双层浪：泡沫带改深色后浪（fill `--water-foam`→`--water-deep`），白线退役
   （`.fluid-surface` 显示 `display:none`，DOM/动画声明保留，K2a/K2b/K9d 形状不断；
   倒水闪峰改走泡沫带），读数加文字阴影兜底对比。
2. P2 球体玻璃罩：fallback 自体 inset 加重（顶光 1px/1.5px→2px/5px、底缘 −6px/12px→
   −15px/24px + 环境黑一圈，颜色仍走令牌）+ 新增 `::after` 统一顶光/压暗渐变
   （原型 `.ball::after` 口径，无外阴影，D6 纪律守住）。
3. P3 水柱对齐 + A 柱顶浪常驻：柱顶小波时长走 `--wave-speed-a`（逐皮肤波性格）；
   新增柱内液光流 `.fluid-shimmer`（`--slosh-dur` 天气时钟，竖漂/横漂两套 keyframes）；
   hidden 暂停名单加泡沫带（球内四层照停，柱顶波 + 液光流保持动画，K8d3/K8j/K8k1/K8k2 新门）。
4. P4 D 悬停 peek：hidden 下命中层 hover 经 `:has` 显现完整波浪预览气泡
   （波浪 + 3 滴落雨 + 读数，复用本次渲染的 waveA/water/shownText）；
   `pointer-events:none` 不误触唤出；延迟 250ms < REVEAL_DWELL_MS(300，同源)；
   `data-freeze='peek'` 取帧态供像素对拍（K8m1/K8m2/K8m3 新门）。

## 改动（仅 worktree，4 个跟踪文件）

- `src/renderer/src/skins.css`：P1 泡沫/白线/读数阴影/闪峰改道；P2 inset 加重 + `::after`；
  P3 暂停名单（hidden/doc-hidden 加 foam/shimmer/peek-wave/drop）、柱顶波变量化、
  shimmer 整套、freeze/reduced-motion 同步；P4 peek 整套 + 取帧态。
- `src/renderer/src/PetBall.tsx`：注释更新（waveLine/waveBand 回滚点说明）；
  柱内加 `<i className="fluid-shimmer"/>`（与柱顶波同条件）；peek 气泡 JSX；
  freeze 钩子认 `'peek'`。零逻辑改动（无时序/几何/状态机）。
- `scripts/test-structure.mjs`：+7 门（K8d3/K8j/K8k1/K8k2/K8m1/K8m2/K8m3），
  P3/P4 均先红后绿（4 红→0、3 红→0）。

## 验证

- `test:fluid` 114/114，`test:structure` 212/212（基线 205），`typecheck` 双工程干净，
  `npm test` 全绿（EXIT:0），`npm run build` 通过（以上 10-05 在 worktree 内复测；
  uitest 自带 build 亦一次通过，见落盘日志头 56 模块 + 58 模块两段 ✓ built）。
- `--shots` EXIT:0（32 张）：5l 探针 7 滴/5 可见/splash5/trickle2、雨区均色≈水绿；
  5n 探针 hidden 12×56 柱、fillH 39.2（=70%）、gooFilter none；
  五皮波形极差各异（dark 5.94 / candy 5.88 / aero 4.28 / ink 3.04 / minimal 1.56）；
  png-probe 目检球圆角透明无方框、柱区独立（同 R4 基线口径）。
- `--uitest`（`/tmp/skinuitest.log`，EXIT:0）：160 键 / 136 exact-ok（`ok(` 前缀计 142）；
  `fail:` 前缀仅 2 项（`dragReorder`/`dragSettles`，需真实光标移动，headless 基线问题，
  grp 全绿，比 R4 基线 6 项还少 4 项）；`execErrors=none`，`consoleErrors=none`。
  任务要求的 14 键全 ok：petBallCenterValue/petWaterLevel/petNoRingOnBalance/petWaterColumn/
  dockFluidLevel/dockFluidHidden/dockFluidGoo/dockFluidReveal/dockHide/dockEdges/
  dockPeekSize/dockPassby/dockReveal/dockRehide（另 dockExpandCancel/dockSwitchOff、
  petBallSkinSurface/petBallRingDiag 亦 ok；RingDiag waves:3，surface DOM 保留符合 P1 回滚设计）。
- P2 注释修正一处实现期笔误：柱顶波 comment 曾写 candy 快，实际 `--wave-speed-a`
  最快的是 aero 2.6s，已按实测值改写（教训：写注释先查表）。

## P5 评估（未做，停下等 review）

V6 三段水 morph（原型修订4口径：熔化 450ms 晃+水涨顶 → 化浪 350ms 球散成行进波带 →
堆柱 ~600ms 波注入+液面过冲 pct+12/回落 pct-3+浪花 2.2+柱回弹两段；隐藏≈1.4s，
唤出反向泄柱→回浪→凝球≈0.9s；当前真机 530ms/400ms，约 2.6×/2.3× 放慢）。

blast 半径（实测 grep，先红清单）：
- `src/shared/fluid.ts`：ABSORB_STRETCH/MERGE/SETTLE（150/300/80）与 REVEAL_MS（400）
  全改 + ABSORB_TOTAL 530→~1400；test-fluid 用例 1 的 7 条 pin 值同步红。
- `src/main/dockHide.ts`：两处等待（:260 ABSORB_TOTAL_MS / :296 REVEAL_MS）跟涨；
  HIDE_DWELL 1000 / REVEAL_DWELL 300 与新时长叠加后，hover 即走 vs 看完 1.4s 秀的体感要重调。
- `src/main/qa/uitest.ts`：约 10 处 `sleep(400)` + §2347 注释钉住 530/400——
  改时序不改等待 = 全套 dock/fluid 键 flake；改等待 = e2e 口径又动一次（R4-5 刚动过）。
- `qa/shots` + `test-dock-hide`（155 项）+ 结构门：morph 取帧三态要加段内帧，
  原型修订4遗留的"波带暗底偏棕"（warn 橙 .85）落地时还要提亮/加发光，另起视觉债。
- 架构债：main 状态机目前不认皮肤；V6（=aero？）专属 1.4s 等于把皮肤概念捅进主进程，
  打破"渲染层只切类"分离。若全皮统一放慢，则 R4-5 已验收的 530ms 行为作废，G2 重验。

建议：**暂不做**。P1–P4（A 柱顶浪 + D 悬停 peek = 修订6推荐的 A+D）已覆盖"中间水浪变化"
的常驻表达；C（转换即展示 = P5）是加分秀场，不是信息缺口。等 G1（雨/天气/泡沫/余额色）+
G2（原地柱）人眼验收通过、确认要"更长的隐藏秀"再开 P5；开则先定分支策略
（V6 专属时长走渲染层自计时、main 只保底等待？还是全皮统一 1.4s？），再按
fluid 常量→dockHide 等待→uitest 等待→shots 取帧→三套单测/结构门的顺序先红后绿。

## 坑位（可沉淀）

1. 注释里的快慢断言必须按变量表实测值写（本次 candy/aero 笔误）。
2. peek 预览波不能复用 `.fluid-wave` 类名，否则 hidden 暂停名单连带停掉它 ——
   "暂停名单按类名前缀作用"时，新元素另起类名并单独列暂停表。
3. 命中层盖住全窗时，下层元素收不到 `:hover` —— 经 `.petball` 的 `:has(.petball-hit:hover)`
   读（与按压态同模式）。
