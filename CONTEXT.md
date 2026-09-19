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
展开态收起来的形态，一块透明小窗，只有 3D 悬浮球（默认）或个性人物两种内容；WebGL 不可用时退回 2D 圆点。
_Avoid_：小圆点、dot、迷你模式、mini mode、收起球

**形态**（Form）：
收起态内容的两种取景之一（`pet3d/rig.ts` 的 `FORMS`），每种固定一套「窗口尺寸 + 机位 + 球体装饰可见性」；
球形态是玻璃球 + 用量环 + 环心读数，个性人物是**没有球壳、没有用量环**的独立人物 + 脚下读数胶囊。
_Avoid_：模式、mode、皮肤、样式、布局

**主供应商**（Primary Provider）：
卡片顺序里的第一位；顺序即优先级，托盘与该位置取它来展示。
_Avoid_：当前供应商、首选、current、default provider

**皮肤**（Skin）：
一套覆盖语义令牌的 CSS 变量 + 可选布局预设；新增皮肤零代码。
_Avoid_：主题、theme、样式包、style pack

**托盘**（Tray）：
macOS 菜单栏 / Windows 系统托盘的图标与标题，展示主供应商的时限窗口。
_Avoid_：状态栏、菜单栏图标、status bar、menubar
