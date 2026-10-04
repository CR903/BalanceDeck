# 皮肤差异化3D与水效重设计

## Goal

5 套皮肤各有自己的球体质感与水波性格，一眼可辨；全部走 CSS 变量，新增皮肤零代码。

## Requirements

- 引入 6 个水效变量（`:root` 给默认值，ext 皮肤自动退化为统一默认水效）：
  `--wave-speed-a/b/c`（漂移时长）、`--wave-opacity-a/b/c`（层透明度）、
  `--wave-layers`（显示层数）、`--ball-gloss`（高光强度）、`--ball-depth`（底部深度）、
  `--column-style`（槽底质感）。
- 振幅/波长 JS 侧保持统一（无缝循环数学只有一套，不开第二套口径）；皮肤性格走速度/透明度/
  层数/高光/球面结构，不动 `waveD` 参数。
  → 返工 R1（2026-10-04 用户打回）推翻本条：振幅/波长逐皮肤各一套（`SKIN_WAVES` 表 + `--wave-len-*`
  漂移距离同步），无缝循环数学仍只有一套（距离恒 = 波长整数倍，由单测跨钉 JS 表与 CSS 变量）。
- 5 皮肤性格（初版方向，评审可调）：
  - aero：玻璃水球——高光强、快波、高透
  - dark：霓虹深海——暗底、荧光水感、慢波
  - minimal：扁平纯净——弱阴影、低透明、细线波
  - candy：果冻糖浆——高饱和、慢大波、Q 弹回弹曲线
  - ink：水墨宣纸——纸纹底、墨色水、缓波、只开 2 层
- 水色系差异免费获得：水色插值的锚点色本来就读自各皮肤的 `--ok/--warn/--danger`。
- 换肤即时生效（变量切换无 JS 状态，无闪烁中间态）。

## Acceptance Criteria

- [x] 5 皮肤整球并排走查：质感与波速/透明度肉眼可区分，串盲测能认出 4/5 以上
  → 5c 实机像素：dark 盘 21（深）/ minimal 近乎平坦（244/244/235）/ candy 粉底 236,230,248
  + 饱和底 204,192,235 / ink 纸面 + 无 C 层 / aero 双高光玻璃；速度差异需人眼动态确认（静态帧不可见）
- [x] 换肤录屏：无闪烁、无中间态，水色系跟随切换
  → 变量继承切换（无 JS 状态）；水色锚点本就读自各皮肤令牌（子任务 1 已证）
- [x] ext 皮肤（随便拷一个只改名的）走查：默认水效完整可用，不透明不错位
  → `:root` 全套默认值（K9a 含 root）；K9e 断言波动数学不出 JS（无皮肤可绕过）
- [x] K 门补充"水体令牌逐皮肤"断言覆盖 6 个新变量；`npm run test` + `npm run typecheck` 全绿
  → K9a–K9e（旧版 3/3 红）；全套件零失败；typecheck 干净；e2e 流体全绿无回归

## 返工验收（2026-10-04 用户打回，原 AC 作废重验）

- [x] R1 各皮肤波形不一样：`5c-wave` 实机极差≈2A（aero 4.28/4.4、dark 5.94/6.0、
  minimal 1.56/1.6、candy 5.88/6.8、ink 3.04/3.2），5 档 distinct；单测用例 9 跨钉表与 CSS 变量
- [x] R2 细水长流：5l 像素 y10–22 窄条（5→13px 射流）+ y28–38 ripple + y44–48 衰减 +
  y102–108 球内水；整坨 pour-fill 已删（K7c2）；K2d 改判变量表达式
- [x] R3 整球吸入变形：`5i-probe` disc matrix(1.4,0,0,0.7) aspect 2.0（拉丝）；
  K8i 断言 h/v 两套 + 旧单套已删；revealing 不动
- [x] `npm run test` 全绿 + `typecheck` 干净 + e2e 流体全绿（petWater*/dockFluid*/dockHide/dockEdges）
- [ ] 用户人眼动态终验（波形性格 / 射流观感 / 吸入拉丝，静态帧不可见）← review gate

## Notes

- 技术细节见父任务 `design.md` D4。最后一个做，覆盖前三个任务落定的默认水效。
- 返工轮（2026-10-04，用户验收打回，原 AC 作废重验）：
  - R1 各皮肤波形也要不一样：`SKIN_WAVES` 表（renderer 本地，ext 回退默认）+ `--wave-len-*`
    漂移距离同步 + 单测跨钉表与变量；柱顶小波保持统一（细节，不开洞）。
  - R2 倒水改细水长流：整坨 `pour-fill` 下落删除，换 `.pour-stream` 细射流（clip 圆内生长/回收）
    + `.pour-splash` 触水 ripple + 水位静默（56px 下 600ms 的液位爬升不可辨，流 +  ripple + slosh 承载效果）；
    保留冲顶 overshoot（G1 原要求）与三段总时长口径（POUR_* 不动数值，只换 phase 映射）。
  - R3 整球吸入变形：`disc-absorb` 单套改 h/v 两套（沿边轴拉长成液线再没入，球先变形再消失）；
    revealing 不动；柱灌满逻辑不动（已是 bottom-up + 波随液头）。
  - R2/R3 原属已归档子任务（pour-in-slosh / edge-sip-column）， deviation 记在这里，不重开归档任务；
    落盘 commit 仍挂当前任务名下，关闭时三处 AC 一并重验。
- 落地偏移（2026-10-04）：变量精简为速度×3 + 透明度×3（`--wave-layers/--ball-gloss/--ball-depth/--column-style`
  不单独立令牌 —— 球面整组覆盖 + ink C 层显隐 + 刻度 opacity 覆盖，表达力更强，
  新皮肤仍零代码 via `:root` 默认）；minimal 也有显式值（静与淡本身即性格，顺带满足 K9a 全覆盖）。
- R9 注释纠偏：B 层时长 2s、C 层 5.2s（注释曾写反，代码为准，变量化时对齐）。
