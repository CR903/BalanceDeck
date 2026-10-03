# BalanceDeck 领域词汇

BalanceDeck（余额板）是一个悬浮在桌面上的仪表盘：它替用户去各家 AI 供应商问「我的 coding plan 用了多少、API 余额还剩多少」，并把每个数字的来路如实标出来。本文件是这块领域的词汇表 —— 写代码、写文档、提方案时用这里的词。

设计取舍与数据源清单见 [DESIGN.md](./DESIGN.md)；本文件只管「叫什么」。

## 供应商与查询

**供应商实例**（Provider Instance）：
用户显式添加的一条可查询记录 = 身份（id / 名称 / 类别 / 启用）+ 协议 + 配置（baseUrl / 凭据）。内置预设也必须被添加成实例才存在，同一预设可重复添加。
_Avoid_：供应商、provider、账号、account、数据源

**协议**（Protocol）：
唯一决定「查哪个端点、响应怎么读」的东西。内置预设与自定义实例解析到同一套协议。
_Avoid_：协议类型、provider type、connector、驱动、driver

**协议声明**（Protocol Declaration）：
协议的数据形态：端点事实（方法 / 路径 / 认证形状）+ 一个纯读取函数 + 该协议自己的提示语。能声明就不写代码。
_Avoid_：协议配置、descriptor、元数据、schema、配置项

**适配器**（Adapter）：
协议的两种实现形态之一。声明表达不了时（请求签名、浏览器会话、本机文件）用代码实现，同样注册在协议名下。
_Avoid_：插件、plugin、驱动、driver、provider 实现

**采集引擎**（Collection Engine）：
负责线上那一半的模块：发请求、超时、可达性记账、HTTP 状态到错误的映射、宽容取值、铸造快照。协议声明与代码适配器都从它这里取能力，不各写一遍。
_Avoid_：采集管线、pipeline、fetcher、采集服务、collector

## 数据与可信度

**快照**（Snapshot）：
一轮采集对一个供应商的结论：状态、用量窗口、可信度、数据时间。界面只渲染快照，不自行推算。
_Avoid_：结果、result、响应、response、数据、data

**可信度**（Data Quality）：
数字的来路，三选一 —— `official`（官方实时）/ `local`（官方不可达，退回本机估算，口径不同）/ `cached`（本轮失败，沿用上次官方数据）。必须显式声明，缺失即错误。
_Avoid_：数据来源、source、置信度、confidence、可信级别

**铸造**（Mint）：
把「值 + 它的来路」合成一个快照的那一步。身份与可信度在此一次性盖上，之后不被任何路径改写。
_Avoid_：组装、构造、assemble、build、拼装

**黄金样本**（Golden Sample）：
重构前冻结下来的旧行为期望（状态 / 窗口 / 可信度 / 提示语），用来机械验证新旧等价。
_Avoid_：快照测试、snapshot test、基准、baseline、录制

## 界面形态

**展开态**（Expanded）：
悬浮卡片本体，圆角矩形，承载主页 / 详情 / 设置三个视图。
_Avoid_：主面板、面板、panel、主窗口

**收起态**（Collapsed）：
展开态收起来的形态，一块 56×56 的透明小窗，内容是唯一的一颗 2D 小水球
（全屏水体做进度 + 环心读数）；**不建 WebGL 上下文**，不加载任何 3D 素材。
个性人物形态已于 10-03 下线；外圈用量环已于 10-04 退役（进度唯一载体是水位）。
_Avoid_：小圆点、dot、迷你模式、mini mode、收起球

**用量环**（Usage Ring，已退役，10-04）：
圆环形态里环心读数外圈的轨道 + 填充弧。**只有套餐（plan）类供应商画** —— 判定与主卡片共用
同一个 `isPlan()`（充值余额只留素圆盘 + 金额）；轨道与百分比解耦，算不出比例的窗口也有轨道。
没有开关：「显示用量环」（`ui:petRing`）已随 `09-27-dot-ring-scroll` 下线。多时限供应商的
窗口可上下滚轮逐个切换，左下角的短标签（`5H` / `W` / `M`）只在窗口数 > 1 时出现。
10-04 起进度改由**水位**表达（见「水满」），环的 CSS 与 JSX 已删除，`data-ring` kind 探针保留。
_Avoid_：显示用量环、petRing、环形进度条、progress ring

**水满**（Water Level，10-04 起的进度载体）：
球盘内全屏水体，液位 = `shared/fluid.level(percent)`（一位小数，与读数逐位一致），
水色跟 `lvl`（`--ok/--warn/--danger`，与托盘/卡片同一套阈值）；读数数字与角标保留
（颜色非唯一通道）。仅套餐且算得出比例时挂水（三层错速波 + 液面高光线），
余额/无比例时画素盘（不造假水位）。隐藏态缩成**水柱**（竖柱/横槽 + 柱内液 +
柱顶小波浪，几何与 `peekHitbox` 同源）。
_Avoid_：水球、水位计、temperature（水柱不是温度计）

**主供应商**（Primary Provider）：
卡片顺序里的第一位；顺序即优先级，托盘与该位置取它来展示。
_Avoid_：当前供应商、首选、current、default provider

**皮肤**（Skin）：
一套覆盖语义令牌的 CSS 变量 + 可选布局预设；新增皮肤零代码。
令牌按**归属**分族：页面/卡片族（`--bg`、`--surface`…）与**球形态族**（`--ball-bg` 表面、
`--ball-rim` 盘缘、`--track` 轨道（现为水柱槽底）、`--dot-top` 顶部高光、`--dot-bottom` 底部内阴影、
`--water-foam` 液面高光、`--water-deep` 水底深度罩）。
球形态**不借页面族**——盘的颜色由球自己的令牌逐皮肤给，且顶层 `:root` 必须有定义
（外部皮肤没写时靠它兜底；缺了球会变成完全透明，一个没有底的球比浅色的球更糟）。
_Avoid_：主题、theme、样式包、style pack

**球盘**（Ball Plate）：
圆环形态那块 56×56 的圆盘。`--ball-rim` 的方向必须与盘色**相反**（浅盘配深 rim 且
alpha ≥ 0.16，深盘配浅 rim 且 ≥ 0.12）—— 这是球在桌面上读作「一个物体」而不是
「一块底色」的唯一保证。⚠ 盘**没有** `backdrop-filter`：悬浮窗 `transparent: true`，
页面内没有可采样的 backdrop，它履行不了「磨砂」的宣称，留着是会骗人的注释。

**托盘**（Tray）：
macOS 菜单栏 / Windows 系统托盘的图标与标题，展示主供应商的时限窗口。
_Avoid_：状态栏、菜单栏图标、status bar、menubar

**贴边隐藏**（Dock Autohide）：
收起态悬浮球拖到屏幕边缘松手停留 1s 后滑入边框、只留一条痕迹的常驻行为。
几何唯一来源是 `shared/dock-hide.ts`；主进程状态机只做计时与动画，不算几何。
隐藏态的痕迹是一根**水柱**（左右边 4×56 竖柱 / 上下边 56×4 横槽，柱内液位与球内同源，
几何归 `shared/fluid.waterColumn`，与 `peekHitbox` 逐位一致）。
_Avoid_：自动隐藏、靠边隐藏、auto-hide（单独用时指代不明：展开态卡片不参与）

**痕迹**（Peek）：
隐藏后留在屏幕内的 4px 可见条。它仍可命中（主进程以痕迹条覆盖命中区），
悬停 300ms 滑出、无 hover 设备点击唤出。
_Avoid_：边缘条、残留、残影

**水渍**（Stain / Pill）：
流体隐藏形态下留在边沿的那枚痕迹 —— 沿边沿 20px × 探出 4px 的圆角水滴形，
是球被边沿"吸入"后剩下的那滴。几何在 `shared/fluid.pillBox`（与痕迹条同源），
呈现是 goo 容器的 `.fluid-pill`。
_Avoid_：水滴、pill（单独用时指代不明：它是贴边剩下的那枚，不是普通药丸按钮）

**液位**（Level）：
水满进度里液面高度占球的比例 = `shared/fluid.level(percent)`（0–1，一位小数粒度，
与环心读数逐位一致）。只在套餐类且算得出比例时存在；余额类没有液位（素盘）。
_Avoid_：水位（与"水渍"混淆）、百分比（那是环心读数，不是液面高度）

**流体相位**（Fluid Phase）：
`dock:fluid` 通道的四个呈现态 —— `edge-visible`（整球）/ `absorbing`（吸入 morph 中）/
`hidden`（水渍态）/ `revealing`（汇聚 morph 中）。主进程状态机经
`shared/fluid.fluidForPhase` 唯一映射后推送，渲染层只切 CSS 类。
_Avoid_：隐藏状态（那是 dockHide 的八相位状态机，不是这四个呈现态）
