# 全息悬浮球

## Goal

把收起态球体升级为 3D 全息风格（参考效果图）：蓝色半透明全息光效，点云 + 网格线科技外壳，
环绕能量粒子与数据流；球上叠加 HUD 数据卡（Token Plan / Coding Plan / Direct Charge），
慢速自转 + 悬浮浮动，数字滚动更新，hover 高亮/加速、click 展开详情。科技感拉满。

**Phase 0（本任务当前范围）：只做原型验证** —— 用可丢弃原型证明性能与可读性达标，
输出数字 + go/no-go 结论；不进主干（见 Key Decisions）。

## Background（已确认事实）

- 现收起态是 56×56 纯 DOM/SVG 圆环（`src/renderer/src/PetBall.tsx:893,902-917`），零 WebGL；
  fluid goo 版（渐变球 + 水满 + 吸入/汇聚）在 `feat/dock-autohide` 落地。
- three ^0.177.0 仍在依赖中（`package.json:63`，独立 chunk 约 1.18MB），目前仅个性人物形态动态加载；
  `remove-human` 子任务正在移除人物管线（后台执行中）—— 原型期间 three 保留，最终去留待 go/no-go。
- Hover/点击基础设施现成：`pet:cursor` 悬停通道 + 命中区上报 + `setIgnoreMouseEvents` 穿透
  （`src/main/overlay.ts:402-447`）；数字递增动画 09-27 已做过。
- ui-ux-pro-max 实测：liquid-glass（fluid morph，a11y 条件）可转用；“球内旋转文字”无条目——
  文字随球转不可读是已知 UX 反模式，卡片必须做成不转的 HUD 浮层（billboard），球只转背景层。
- 56×56 装不下三块数据卡；HUD 版需要 200×210 级窗口（玻璃球时代尺寸），命中/穿透/拖拽/uitest 重调。
- EGL/软件渲染提示：受限环境（无 GPU）下 WebGL 走 SwiftShader，帧率另计—— 原型必须在真机双平台实测，
  沙盒数据仅参考。

## Key Decisions（用户已定）

- **每皮肤不同特效（2026-10-03）**：球体颜色、粒子、光效必须随皮肤令牌变化，5 套皮肤各有观感
  （新增皮肤零代码，沿用球令牌族 `--ball-bg/--ball-rim/--dot-top/--dot-bottom` + 新增粒子/光晕令牌）。
- **Phase 0 先原型验证（2026-10-04）**：性能（帧率/显存）+ 可读性（HUD 对比度/hover/click）spike，
  达标才进主干；原型可丢弃，不污染产品代码。

## Requirements（原型范围）

- **P1 场景**：点云 + wireframe 双层球壳慢速自转；≥2 轨道能量粒子 + 数据流字符带；200×210 级透明窗口。
- **P2 HUD**：三块数据卡（余额+进度条 / 环形百分比 / 金额），billboard 不随球转；静态代表数据即可
  （验证可读性，暂不接实时采集）；数字滚动播一次。
- **P3 皮肤**：至少 2 套皮肤令牌接线（粒子色/光晕随皮肤变），证明“每皮肤不同”机制成立。
- **P4 测量**：帧率（`rAF` 计数）、显存（`renderer.info`）、macOS + Windows 双平台截图；
  reduced-motion 静态帧一并取证。
- **P5 结论**：输出 go/no-go（阈值：M 系 ≥50fps、显存 <150MB、HUD 文字对比度 ≥4.5:1；任一不达标即 no-go
  并记录瓶颈），写入本任务 `research/`。

## Acceptance Criteria（原型）

- [ ] 原型可独立启动（不污染主干，可丢弃）
- [ ] 帧率/显存/双平台截图/HUD 对比度数据齐全并写入 `research/report.md`
- [ ] go/no-go 结论明确；若 go，列出主干化改造清单（窗口尺寸/命中/uitest/three 去留）
- [ ] 主干零改动（`git status` 仅任务目录脏）

## Out of scope（原型）

- 实时数据接入、hover 加速/click 展开（只验证静态可读性与通道存在）
- 个性人物形态；球内旋转文字（永不做）；粒子编辑器
- 主干接入（go 之后另起 planning）

## Risks

- three 去留取决于 go/no-go：no-go 则 remove-human 照常删 three；go 则改保留（另起主干化 planning）。
- remove-human 后台执行中：原型不得引用 `pet3d/`（它会被删），自建最小场景。
- 透明窗口 + WebGL 在部分 Windows 驱动下合成异常 → 原型必须在真机 Windows 取证，沙盒通过不算通过。
