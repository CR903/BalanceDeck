# BalanceDeck 任务看板

> 配合 DESIGN.md 路线图使用。完成一项就把 `[ ]` 改 `[x]` 并注明日期。

## M1 核心可用（已完成 ✅ 2026-09-06）

- [x] Electron 37 + electron-vite + React 脚手架（版本经 macOS 12 兼容性实测锁定）
- [x] 悬浮卡片窗口：无边框/透明/置顶/可拖动/位置持久化/收起小圆点
- [x] 托盘：macOS 菜单栏显示 5h 百分比，点击切换显隐，右键菜单
- [x] OpenCode Go 适配器（node:sqlite 只读解析 opencode.db，5h 块 + 周/月窗口）
- [x] DeepSeek / Kimi / 智谱 / MiniMax 余额适配器（MiniMax 含新旧接口回退）
- [x] 凭据：safeStorage 密钥链 + 环境变量自动扫描 + 卡片内最小设置面板
- [x] 采集调度：plan 类 60s / balance 类 300s，IPC 推送
- [x] 默认 aero 毛玻璃皮肤 + 4 套备用皮肤 CSS
- [x] 图标生成脚本（纯 JS PNG/ICO 编码，无外部依赖）
- [x] 验证：typecheck / build / --smoke（含渲染进程存活检测）/ dist:mac / dist:win 全部通过

## M2 补全（已完成 ✅ 2026-09-13）

- [x] Claude Code / Codex / Copilot 适配器（算法见 DESIGN.md §4.1）
- [x] 通义千问（阿里云 BSS QueryAccountBalance 签名）、硅基流动、火山方舟适配器
- [x] 皮肤切换 UI（右键菜单 + 设置页）+ userData/skins 外部皮肤加载
- [x] 设置页：供应商增删改（内置 + 自定义）、刷新频率、开机自启、外观
- [x] 界面全面重设计：主页卡片网格 → 详情页 → 设置页（Apple-like，令牌驱动皮肤）
- [ ] 窗口置顶分级（frequent 点击穿透/全屏可见）与多显示器位置容错

### 早期同步模型重构（2026-09-13 上午）

- [x] **重构同步模型**：`ProviderWindow` 新增 `percent` 字段（0–100，官方 API 直报），UI 优先用它做环形进度图，比 `used/limit` 推算更精确
- [x] **OpenCode Go 适配器重构**：统一 sync 策略——官方 API 返回 `percent` + `resetAt`，本机 db 返回 `cost/tokens`，两者合并填满窗口
- [x] **Claude Code 适配器重构**：使用 `plan-utils.ts` 统一算法，为每个窗口附加 `percent`
- [x] **Codex 适配器重构**：服务端 `rate_limits` 直报 `percent` + `resetAt`；本地 token 兜底
- [x] **Copilot 适配器清理**：unit `'request'` → `'token'` 统一渲染，利用 `percent_remaining` 计算 `percent`
- [x] **UI 统一**：所有展示优先使用 `percent` 字段

## M3 实验性

- [ ] 国内订阅套餐（GLM Coding Plan / Kimi 会员，Cookie 方案，标注实验性）
- [ ] 额度阈值提醒（>80% 弹通知）
- [ ] 皮肤目录 / 主题包导入导出

## 2026-09-06 第二轮优化（用户反馈）

- [x] 界面重设计：参考 iStat 桌面组件风格——染色指标块网格 + 大号百分比 + 粗进度条 + 渐变主按钮；点击指标块展开明细
- [x] 背景虚化：macOS 原生 vibrancy（under-window）+ Windows acrylic，磨砂效果与桌面/背后窗口内容一致
- [x] 小圆点拖拽：主进程光标追踪（16ms 轮询），点击与拖拽按 6px 阈值区分，位置持久化
- [x] 收起态轮播：多供应商时每 5 秒轮换头条指标（用量% 或余额），带供应商名称标签 + 轮播圆点指示
- [x] 供应商启用/禁用开关（设置页，extras `enabled:<id>`，禁用后从展示中移除，随时可再启用）
- [x] OpenCode 多 API Key：设置页 textarea 每行一个（加密存储），可选当前账号；官方 API 调用按 active 顺序自动 failover，来源徽章显示 `账号N(尾号)`
- [x] 双平台安装包重新打包

## 2026-09-06 第三轮：bug 修复 + 界面 v2（用户反馈）

- [x] **修复**：收起小圆点点击不展开 / 假死。两个根因：①重构后标题栏按钮落在 `-webkit-app-region: drag` 区域内，真实点击被吞（CSS 已对 `.icon-btn` 强制 no-drag）；②主进程持久化收起态后，重启时窗口按小尺寸创建但渲染层仍渲染完整卡片（窗口尺寸与视图状态脱节）——加载完成后主进程现在会把收起态推送给渲染层同步。
- [x] **修复**：拖拽误判/不释放——阈值提到 8px + pointer capture + pointercancel 兜底，展开/收起时强制 dragStop。
- [x] **界面 v2**（参考 DiskCleanKit 弹窗风格）：头部徽标+标题+状态行（全部正常/接近限额/出错）+刷新按钮；plan 类供应商渲染为**环形进度仪表**三列网格（$用量与重置时间在环下方）；余额类渲染为横条行；底部渐变主按钮"立即刷新"+ 次级按钮"设置/收起"。
- [x] 渲染层 ErrorBoundary：异常显示"点击重载"，杜绝白屏假死。
- [x] 新增 `--uitest` 无头 UI 自动化：模拟点击/拖拽/刷新/设置流程，断言窗口尺寸与 DOM（13 项断言，含 bug 回归）；`npm run uitest` 可随时回归。
- [x] 双平台安装包重新打包。

## 2026-09-13 第五轮：OpenCode Go 统计口径重构（用户反馈"用量都不对"）

学习参考：[dsh-opencode-go-usage](https://github.com/v587d/dsh-opencode-go-usage)（DSH 插件，cookie 抓取控制台 SSR）

**根因（三个）**：
- [x] **本机 db 读错表**：opencode 1.x 起消息表由 `message` 迁移到 `session_message`（`type='assistant'`，模型位于 `model.providerID`）。旧实现只读 `message`，而该表自 2026-08-13 起已停止写入（392 条 vs 新表 8,850 条）→ 本机 tokens/花费长期失真
- [x] **凭据来源不全**：可用的 API key 存在 opencode.db 的 `credential` 表（`integration_id='opencode'`，`{"type":"key","key":"sk-…"}`），而 `auth.json` 里的旧 key 会 403 EntitlementError。旧实现只读 auth.json → 官方 API 路径整体失败，退化成本机估算
- [x] **口径错误**：官方额度为**所有客户端共享**（OpenCode + DSH + 其他工具），本机 db 只是本机份额。旧实现拿本机 cost 当"官方用量"，导致 percent 与金额自相矛盾（实测 weekly 48% 但本机仅 $0.16）

**重构内容**：
- [x] `loadLocal()` 兼容两代 schema：`session_message` + `message`，按 `(time, cost)` 去重取并集，31 天时间窗
- [x] `resolveKeys()` 三来源合并去重：设置中的多账号（`opencodeKeys`）→ `auth.json` → opencode.db `credential` 表；来源标签显示为 `账号N` / `auth.json(尾号)` / `本机凭据(尾号)`
- [x] `officialWindows()` 改为官方口径：`used = percent × limit`（限额以美元定义：5h $12 / 周 $30 / 月 $60），percent/resetAt 直接采用服务端真值；tokens 取本机同窗口求和（标注"本机"）
- [x] **Cookie 兜底路径**（新增 `opencode-cookie.ts`）：API Key 403/不可用时，抓取 `GET /workspace/<wrk>/go`，解析 `data-slot="usage-item"` 的 percent/reset-time；中英文双语支持；cookie 规范化（定位 `auth=` 段、丢弃 UI 偏好、保留 locale）
- [x] 5h 窗口 percent=0 且 resetsAt≈now+5h → 判定"当前无活跃窗口"，不再显示占位重置时间
- [x] 设置页新增 OpenCode Cookie + Workspace ID 输入（cookie 加密存储，仅回显尾 4 位）
- [x] 环境变量兼容：`OPENCODE_GO_COOKIE` / `OPENCODE_GO_WORKSPACE_ID`
- [x] UI：窗口明细新增"剩余 $X"（余额）与"本机 X.XM tok"（token 用量，明确标注本机口径）
- [x] 测试：`npm run test:ssr`（17 项断言，中英文页面/嵌套 div/登录页/时长短语）+ `npm run verify:opencode`（真实 DB + API 响应验证）

**实测验证**（2026-09-13，与控制台逐项对照）：
- 官方 API：5h 1% → $0.12/$12 ｜ weekly 48% → $14.40/$30 ｜ monthly 66% → $39.60/$60 ✓
- 本机 5h cost $0.14 ≈ 官方 1%×$12=$0.12 ✓ 口径对齐
- 本机 31 天 tokens：155.8M（monthly 窗口），每模型 Top: muse-spark-1.2-contributor / deepseek-v4-pro / deepseek-v4-flash

## 2026-09-13 第六轮：供应商体系重构 + 界面全面重设计（用户需求）

**供应商模型**（新增 `src/main/providers.ts` 注册表）：
- [x] 内置供应商 11 家（`BUILTIN_PROVIDERS` 预设）：coding（OpenCode Go / Claude Code / Codex / Copilot）、token（MiniMax）、balance（DeepSeek / Kimi / 智谱 / 硅基流动 / 千问 / 火山方舟）
- [x] **自定义供应商**：名称（随意填）+ 协议 + API 地址 + Key；**可重复添加**（同一协议多个中转站）；可删除（连带清理凭据与配置）
- [x] 自定义协议目录 9 种：DeepSeek 兼容 / Moonshot 兼容 / 智谱兼容 / 硅基流动（国内·国际）/ OpenRouter / OpenAI 计费 / MiniMax Token Plan / 通用 JSON（宽容解析，直接请求用户填的完整 URL）
- [x] 内置供应商凭据探测扩展：本机文件（Claude/Codex/Copilot）+ OpenCode 三来源（设置多 Key / auth.json / opencode.db credential 表）
- [x] 存储：`extras.customProviders`（JSON）+ `provider:<id>:enabled|baseUrl|name` + `keys[<id>]`（加密）；兼容旧 `enabled:<id>` / `baseUrl:<id>` 键名

**采集层**：
- [x] `buildAdapters(kind)` 每轮动态求值（设置页增删改即时生效）
- [x] `collectAll` 按适配器元数据填充 `kind` / `builtin`
- [x] 调度器：套餐类（coding+token）60s / 余额类 300s，快照按注册表顺序排序

**界面重设计**（Apple-like，令牌驱动）：
- [x] 三视图：主页卡片网格 → 详情页 → 设置页
- [x] 主页：套餐=环形仪表卡（环 + 金额/限额 + 重置倒计时），余额=大号金额卡；空状态引导
- [x] 详情：hero（大环 + 金额 + 剩余 + 重置）+ 用量窗口列表（% / 金额 / 剩余 / 本机 tokens / 数据来源）+ 模型明细表
- [x] 设置：供应商按类别分组 + 状态点语义（灰=禁用/琥珀=未配置/绿=已配置）+ 行内展开编辑 + 虚线「添加提供方 / 添加自定义提供方」
- [x] 设计系统：语义令牌（颜色/圆角/动效）+ 5 套皮肤（令牌覆盖）+ 内联矢量图标（无 emoji）+ `prefers-reduced-motion` 支持
- [x] **修复 CSS 定制属性继承屏障**：`color: var(--fg)` 从 `body` 移到 `.app`（皮肤令牌挂在 `.app`，`body` 会先用 `:root` 值解析并阻断继承）

**测试设施**：
- [x] `npm run shots`（`--shots`）：自动截取主页/详情/设置/自定义表单四张走查图到 `/tmp/balancedeck-shots/`
- [x] `npm run uitest` 更新为新 DOM：新增详情页开合、供应商列表、添加/删除自定义供应商断言（29 项，仅 `dragMoved` 为已知环境限制）

**验证**：typecheck ✓ build ✓ smoke ✓ uitest ✓（29 项）test:ssr ✓（17 项）

## 2026-09-13 第七轮：供应商实例化 + 视觉修复（用户反馈 6 项）

**1–3. 供应商改为「实例」模型**
- [x] 内置预设不再常驻显示：也要通过设置页「添加提供方」显式加入（空列表有引导文案）
- [x] 「添加提供方」目录 = 11 个内置预设（获取方式特殊且常用）+ 9 种自定义协议
- [x] 同一预设**可重复添加**（不同 key / 中转站），可随时删除（连带清理凭据与配置）
- [x] Claude/Codex/Copilot 标记 `singleton`（本机文件型数据源，重复无意义），添加过即从目录消失
- [x] 旧模型自动迁移：首次读取时把「已启用且已配置」的内置供应商转为实例（沿用原 id，凭据零迁移）
- [x] `wrapForInstance()`：把基座适配器的凭据查找重定向到实例 id，同一预设多实例各自独立 key

**4. OpenCode 百分比精度**
- [x] 官方 API 的 `percent` 是整数；真实用量落在 `[pct, pct+1)` 区间
- [x] 用本机 cost（真实用量下限）在区间内细化 `used` → `percent` 带小数，贴近控制台（区间外退回整数下界，不高估）
- [x] SSR 解析器支持小数百分比（`2.8%`），`clampPercent` 保留一位小数
- [x] UI 百分比格式化：整数不带小数、有小数保留一位（`fmtPercent`）

**5. 圆角与白线修复**
- [x] 根因：macOS 用非透明窗口 + 原生 `vibrancy`，磨砂铺满窗口矩形，在 CSS 圆角/圆形之外露出磨砂底与发丝边
- [x] 改为**全平台透明窗口** + CSS `backdrop-filter: blur(30px) saturate(180%)`；形状外完全透明
- [x] 验证：`scripts/png-alpha.py` 检查四角 RGBA alpha 全为 0（无残留、无白线）

**6. 收起态圆点重设计**（参考 ui-ux-pro-max：单 KPI → 环形 gauge + 数值文字）
- [x] 环形仪表 + 环心数值（带小数），环色 = 严重度
- [x] 显示**最接近限额的窗口**（数值与颜色同源，避免错位）
- [x] 多实例按严重度排序后轮播（最需要关注的先出现），底部细圆点指示位置
- [x] 余额类金额紧凑化（`¥500.67` → `¥500`）

**测试**：uitest 新增 `settingsAddPreset` / `settingsRemovePreset`（目录添加→删除内置实例）；`--shots` 新增收起态圆点与窗口圆角特写

## 2026-09-13 第八轮：百分比精度与抖动修复（用户反馈 2 项）

**1. 用量数值抖动（一会一个数）**
- [x] 根因：上一轮的"本机 cost 细化"不可靠 —— 本机 db 只是本机份额，且滚动窗口滑动时求和区间回退 → 数值来回跳
- [x] 移除该细化逻辑；官方 API 的整数 `percent` 本身稳定

**2. 详情比例与官方对不上**
- [x] 查明：**API 只返回整数**（4/50/67），**控制台渲染一位小数**（4.3%/50.2%/67.2%），两者同源、API 是下界
- [x] 精度策略：配了控制台 cookie → 用 cookie 的精确百分比 + API 的精确 `resetsAt`（落在同一整数带内才合并，防串窗）；只有 API → 诚实显示整数
- [x] 设置页 OpenCode 实例的编辑表单新增 **控制台 Cookie + Workspace ID**（cookie 加密存储，回显尾 4 位）
- [x] SSR 解析器支持小数百分比（`2.8%`），`clampPercent` 保留一位小数

**3. 托盘显示无限小数（4.53888625% 之类）**
- [x] 新增 `src/shared/percent.ts`：`formatPercent` / `windowPercent` / `roundPercent` —— **主进程托盘与渲染层共用同一实现**
- [x] 各适配器在写入快照前归一化 percent 到一位小数（源头治理）
- [x] 托盘摘要改为「全部实例里最接近限额的窗口」（不再写死 OpenCode），标题与 tooltip 都用 `formatPercent`
- [x] `npm run test:percent`（21 项断言：无限小数归一化、整数不带小数、边界/异常、clamp）

---

## 2026-09-13 第十一轮：控制台每模型明细 + 两个关键 bug（用户反馈）

**需求**：像控制台「显示详情」那样，在详情页看到**每个窗口**的每模型用量 / 配额 / 比例。

**实现（`src/main/opencode-details.ts`）**：
- [x] 复用授权分区（`persist:opencode-auth`）开隐藏窗口，逐个展开「显示详情」并读取表格
- [x] 抓取三个窗口（5 小时 / 本周 / 本月）的全部模型行，与本机 tokens 按归一化模型名合并
- [x] 快照新增 `modelsByWindow`（key = 窗口名）；详情页每个窗口下渲染可展开的模型表（仿控制台交互）
- [x] 5 分钟缓存 + **非阻塞**（首轮用缓存/后台刷新，不拖慢采集；实测抓取 ~7.5s）

**抓取踩坑（已在代码注释中固化）**：
- 三个窗口**共享一个 expanded 状态**（同时点三个只有最后一个生效）→ 必须逐个展开
- 展开内容渲染在**根级**（不在 `usage-item` 内）→ 需在 document 上取，并用表头文字确认归属
- 水合前点击会被丢弃 → 先留稳定期
- 标签里的空格可能是 NBSP → 用 `\s` 正则匹配

**两个关键 bug（本轮发现并修复）**：
- [x] **调度器空转**：`intervalFor()` 定义了却从未被调用，`.finally(() => scheduleLoop(kind))` 用默认 delay=0 → 循环每 3–5 秒打一次 API（这既导致"用量实时在变"，也在白白消耗配额）。现已显式使用 `intervalFor`，并让首轮立即采集（`scheduleLoop('plan', 0)`）
- [x] **保存的 cookie 永远过期**：服务端在**每次响应**轮换 session cookie（iron-session 行为），保存的副本必然慢一步 → 每次采集都走自愈。现改为**优先使用授权分区的实时 cookie**（分区由浏览器会话自动跟随轮换），保存值仅作手动粘贴场景的兜底

**新增排障工具**：
- `npm run details:test`（`--details-test`）：一次性抓取控制台明细并打印（含耗时与行数）
- `BALANCEDECK_DEBUG=1`：向 `/tmp/balancedeck-scheduler.log` 写调度与 cookie 自愈追踪
- `SMOKE_WAIT_MS=<ms>`：调整 `--smoke` 的采集等待时长（验证后台刷新用）

**实测**：`modelsByWindow` = 5 小时 1 行 / 本周 6 行 / 本月 12 行；与控制台截图逐位一致（DeepSeek V4 Flash $8.7316 / $30.00 / 29.1%）。

---

## 2026-09-13 第十二轮：产品化打磨（断网诚实 / 图标 / 状态栏 / 单频 / 拖拽排序）

**用户反馈**：断网后 OpenCode 仍显示数值（疑似兜底数据）→ 会误导用户；另提 4 项优化：
内置供应商图标、状态栏展示全部时限窗口、刷新频率合二为一（10s–5min）、卡片拖拽排序。
并要求以"这是产品，小错误会流失客户"的心态全面走查功能与 UI。

**1. BUG：断网仍显示数值（已修复并端到端验证）**
- [x] 根因：官方源不可达时 opencode 退回**本机 opencode.db 统计**，与官方口径不同却用同一套视觉展示
- [x] 数据可信度模型：`dataQuality: official | local | cached` + `dataAt` + `degradedReason`（`src/shared/quality.ts`，纯函数）
- [x] 调度器「最后有效值」策略：本轮失败/降级 → 沿用上次**官方**数据并标 `cached`（24h 上限；`nodata` 不缓存）
- [x] 网络判定：`net.isOnline()` + 连续网络类错误（HTTP 4xx/5xx 不算离线）→ `AppState.offline`
- [x] UI：卡片「缓存/本机」徽章 + 相对时间 + 数字降调；详情页提示条 + 重试；收起圆点角标；托盘 `⚠` 与 tooltip 说明
- [x] 端到端验证：`BALANCEDECK_FORCE_OFFLINE=1` 强制断网 → `offline=true`，opencode 保留官方缓存并标注、DeepSeek 保留余额并标注
- [x] `npm run test:quality`（32 项：缓存策略 / 展示语义 / 网络错误分类）

**2. 内置供应商图标**
- [x] `scripts/gen-provider-icons.mjs`：构建期从 Iconify 取 15 个单色 logo（simple-icons / thesvg / lucide）内联进 `provider-icons.ts`，运行时零网络
- [x] UI 用 CSS mask 着色（品牌色或主题前景），托盘用 canvas 栅格化成 macOS template PNG（1x/2x）
- [x] 卡片 / 详情 / 设置列表 / 目录选择器 / 托盘图标全部使用

**3. 状态栏展示全部时限窗口**
- [x] `src/shared/tray-text.ts`（纯函数）：`5H 5% W 52.9% M 68.5%`；余额类显示金额（万元以下保留两位，不再四舍五入成 ¥501）
- [x] 主供应商 = **卡片顺序第一位**（拖拽排序即优先级）；离线/缓存加 `⚠`
- [x] 托盘图标随主供应商 logo 切换（`nativeImage.addRepresentation` 1x/2x）
- [x] `npm run test:tray`（29 项：短标签 / 金额紧凑 / 离线前缀 / 主供应商选取）
- [x] smoke 输出 `tray.title / empty / size / iconKey` 作为回归观测点

**4. 刷新频率合二为一**
- [x] 单一 `refreshInterval`（10s–300s，默认 60s），设置页即改即存并立即重排定时器
- [x] 采集合并为一轮**并行**（慢接口不再拖累快接口）；opencode.db 解析按（db + wal + shm 时间戳）缓存 2 分钟
- [x] 旧 `interval:plan` 自动迁移

**5. 卡片拖拽排序**
- [x] 指针拖拽（>6px 触发、1.03× 抬起、FLIP 让位动画 200ms、落位持久化到实例注册表）
- [x] `⌥←/⌥→` 键盘排序 + Enter/Space 打开详情（可访问性）
- [x] 顺序同步影响设置页列表与托盘主供应商

**6. 走查中顺带修掉的真 bug**
- [x] **状态推送发错窗口**：`pushState` 用 `BrowserWindow.getAllWindows()[0]`，控制台明细抓取的隐藏窗口可能抢到推送 → 界面永远停在骨架屏（改为一律发给悬浮窗）
- [x] **「已保存」被上一次计时器提前熄掉**：连续操作时旧 timer 关掉了新 flash（改为 clearTimeout 复用）
- [x] **同步采集串行**：改 `Promise.all`（10s 频率下慢接口会拖垮整体）
- [x] 断网时本机估算无标注（见 1）
- [x] 余额紧凑写法把 `¥500.67` 四舍五入成 `¥501`（改为万元以下保留两位）

**7. 体验补强**
- [x] 首屏骨架屏、空状态「去添加」直达设置、刷新中旋转与「刷新中…」文案
- [x] 错误卡片「点击查看原因」+ 详情页「重试」按钮
- [x] 设置删除二次确认（防误删凭据）、Esc 返回主页、设置项即改即存
- [x] uitest 扩到 44 项：拖拽排序持久化、可信度三形态渲染、托盘文案、删除二次确认、频率即改即存
- [x] 新增实例排障工具 `scripts/instances-debug.mjs`（列出 / 去重 / 调整顺序）

**验证**：`typecheck ✓ build ✓ test:percent 21 ✓ test:ssr 17 ✓ test:quality 32 ✓ test:tray 29 ✓ uitest 43/44 ✓（仅 dragMoved 为合成事件限制）smoke ✓ shots ✓`

## 2026-09-13 第九轮：控制台精度增强改为高级设置 + 一键授权（用户反馈）

**需求**：cookie/workspaceID 的获取应作为**高级设置**（不需要这么精确就不用配）；并希望"打开浏览器登录后跳回来"。

**实现**：
- [x] 收进「高级设置 · 控制台精度增强」折叠区（默认关闭），带「可选」标签与说明文案
- [x] **一键授权**：内嵌 `BrowserWindow`（`persist:opencode-auth` 分区）打开 opencode.ai 登录页，登录后主进程轮询分区 cookie，并从 **窗口 URL / 页面 HTML / 控制台首页** 三个来源解析 workspace id；成功后加密保存、自动刷新
- [x] 持久分区 → 再次授权免登录；支持 OAuth 弹窗（`setWindowOpenHandler` 限定白名单域名）
- [x] **打开控制台**：`shell.openExternal` 在系统浏览器打开（有 workspace 时直达用量页），供手动复制 cookie
- [x] **自动复用 dsh-opencode-go-usage 配置**：读取 `$DSH_HOME/ocgo-usage.json` 的 cookie + workspaceID（用户已配置过则无需重复填写）
- [x] 取消/超时（5 分钟）处理；授权窗口关闭即取消

**为什么不是"系统浏览器跳回来"**：`auth` cookie 是 HttpOnly + 域绑定，浏览器不会发给本地回调，页面 JS 也读不到。只能在我们自己控制的会话里登录（内嵌窗口可读 HttpOnly cookie），或解密浏览器 cookie 数据库（需钥匙串/完全磁盘访问，脆弱且侵入）。已在 DESIGN.md §5 记录该取舍。

## 2026-09-13 第十轮：授权后精度仍为整数 —— cookie 抓取修复（用户反馈）

**现象**：完成授权登录后，详情仍显示整数（5% / 50% / 67%），来源为「官方 API」，控制台是 5.7% / 50.8% / 67.4%。

**诊断过程**（新增两个诊断脚本）：
- `scripts/opencode-cookies-list.js`：列出授权分区里的全部 cookie
- `scripts/opencode-console-fetch.js`：用分区实时 cookie 直接请求控制台页面
- 结论：**分区的实时 cookie 有效**（HTTP 200，`usage-item=true`），**但保存下来的 cookie 无效**（302 → `/auth/authorize`）
- 对比长度：保存的 auth 值 ≈346 字符，分区实时值 **539** 字符 —— 登录过程中抓到了**中间态 cookie**

**根因与修复**：
- [x] **验证后再保存**：抓到 cookie + workspace 后，先请求一次用量页确认 `usage-item` 存在，通过才收工；否则继续轮询等最终态（`verifyCookie`）
- [x] **保留该域全部 cookie**：只留 `auth` + `oc_locale` 会在站点新增依赖 cookie 时失效；现在按域（`opencode.ai`，排除 `auth.opencode.ai` 子域）全量拼装 Cookie 头
- [x] `normalizeCookie` 同步放宽：解析并保留所有合法 `name=value` 段（不再只留两个），仍要求 `auth` 存在
- [x] **自愈**：已保存的 cookie 若被服务端轮换失效，采集时静默从授权分区读取实时 cookie，验证通过后回写密钥链（`CollectContext.setKey`），用户无感
- [x] 中间态防护：`verifyCookie` 失败不结束流程，继续轮询直到真正可读

**实测**（修复后）：
```
source: 控制台（精确） + API · 本机凭据(…9dFe)
  5 小时: 0%      $0.00    当前无活跃窗口
  本周:   50.9%   $15.27   控制台
  本月:   67.5%   $40.50   控制台
```
与控制台小数位一致（细微差异为时间推移用量增长）。

## 2026-09-13 第十三轮：拖拽两个实机 bug（用户反馈）

**用户反馈**：① 面板拖拽导致页面错乱；② 按住不松手拖拽排序时，面板左右快速闪动。

**症状②（闪动）根因**：旧实现每次 `pointermove` 都用 `document.elementFromPoint` 命中目标卡片
并**立即重排 DOM** → 布局在指针下方反复变化 → 下一次命中又变回去 → 每帧来回重排（视觉上左右高频闪动）。

**症状①（错乱）根因**：拖拽依赖卡片自身的 `pointerup` + `setPointerCapture`，
一旦捕获丢失（拖动中窗口失焦、指针移出、元素被状态推送重建）就**永远收不到 pointerup** →
被拖卡片带着 `scale(1.03)` + 阴影停在半空，看起来就是页面错乱。

**修复（`CardView.tsx` 拖拽重写）**：
- [x] **拖拽期间绝不改 DOM 顺序**：只做 transform 预览（被拖卡片跟手、其余卡片按槽位让位），松手才提交
- [x] 目标槽位由「按下时捕获的静态几何」算出（到矩形距离最小的纯函数）→ 同一指针位置恒定映射同一槽位，不再抖
- [x] 事件改为 **window 级监听**（不用 setPointerCapture）：移动/抬起/取消/失焦/Escape/4 秒无移动兜底，全部安全落位
- [x] 点击抑制改用**时间窗**（原来用布尔标记，pointerup 落在卡片外时会残留 → 吞掉下一次点击）

**顺带挖出的 CSS 层叠坑（重要）**：
- [x] `.pcard { animation: card-in ... both }` 的 `fill-mode: both` 会让结束帧 `transform:none`
  **永久生效**，而动画层叠优先级高于内联样式 → 拖拽预览的 `transform` 被无声吞掉
  （表现为"被拖卡片跟手、其余卡片不让位"）。已改为 `backwards`，并在 CSS 注释中固化原因。
- [x] 回归测试：`dragPreviewShift` 断言 `getComputedStyle(card).transform !== 'none'`（正是这个坑的检测点）

**新增回归断言（uitest 46 项）**：
- `dragNoFlicker`：拖拽过程中 DOM 顺序必须与按下时一致
- `dragSettles` / `dragReorder`：松手必须落位且顺序正确
- `dragPreviewShift`：让位位移必须真的生效（计算样式校验）
- `dragPersist`：顺序必须写进实例注册表
- `dragEscapeCancel`：Escape 取消后顺序不变、无悬空卡片
- `--shots` 新增 `8-drag-preview` / `8b-drag-cancelled` 走查截图

## 已知注意事项
- Electron 必须 ≤37（macOS 12 兼容），升级前先跑 `npm run smoke`。
- 智谱余额端点为社区验证版本（`/api/paas/v4/users/me/balance`），响应格式变化时适配器会报"响应格式未识别"，属预期自愈提示。
- MiniMax 新平台接口失败会自动回退旧接口（需要 GroupID）。

## 2026-09-06 追加修复（用户反馈）

- [x] opencode 用量与官方控制台对不上 → 改为官方 `zen/go/v1/usage` API 优先（服务端真值），本机 db 仅兜底与每模型/tokens 明细；403（key 与订阅用户不匹配）时给出重新生成 key 的操作指引
- [x] tokens 统计 → 窗口行显示 token 消耗（含 cache read，与官方计费口径一致），每模型明细表
- [x] DeepSeek 401 → 支持 Base URL 自定义（中转平台）；401 报错带修复指引；`npm run keystore:debug`（`npx electron scripts/keystore-debug.js`）可查已存 key 掩码
- [ ] 用户侧待办：opencode 控制台重新生成 API Key 并 `/connect` 重连（解锁官方真值）；DeepSeek key 核实来源（官方 35 位 / 中转短 key + Base URL）

## 2026-09-06 第四轮修复（用户反馈 + 录屏验证）

- [x] **修复悬浮圆点漂移**：旧逻辑收起锚定右上角、展开锚定左上角，每开合一轮圆点右移 328px 直至出屏。现改为 `dotAnchor` 记录展开前圆点位置、收起时精确还原；所有落点统一夹回工作区，可自愈历史漂移位置
- [x] **修复面板 logo 不显示**：标题栏徽标此前只是渐变色块，现嵌入应用图标（`?inline` 内联 data URL，CSP 安全）；设置页同步
- [x] **修复 opencode 5小时/周/月"消失"**：数据一直在（官方 API 403 时本机统计兜底），是仪表卡只渲染 `windows[0]`。现仪表卡直接展示其余窗口迷你行（名称+迷你进度条+百分比），无需展开即见 5h/周/月；凡带限额窗口的供应商均适用
- [x] uitest 新增 `noDrift`（两轮开合位置逐像素一致）/ `logoBadge` / `gaugeSubRows` 断言，共 21 项
- [x] 录屏验证：CDP 驱动真实 IPC 链路 3 轮开合，窗口位置分毫未动（1296,25）；截图确认 logo 与三窗口显示正常
- [ ] 打包：按用户要求暂缓，功能齐后统一 `dist:mac` / `dist:win`（环境注意：本机默认 node v14 跑不动工具链且 build 会**静默失败**留旧产物，需 `export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"`；electron 下载走 `export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 并临时清空 `*_proxy`）
