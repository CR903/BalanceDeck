# BalanceDeck（余额板）设计文档

> 本文档是项目唯一权威设计来源。任何 AI / 开发者接手时，先读本文档再动代码。
> 状态：设计定稿（2026-09-06，与用户逐项确认）。**M1 已实现并通过验证**（详见 TASKS.md）。

## 1. 项目定位

一款 macOS / Windows 桌面组件软件，用于集中查看：

- **Coding plan 用量**：OpenCode Go、Claude Code、Codex、GitHub Copilot
- **Token plan / API 余额**：DeepSeek、Kimi(Moonshot)、智谱 GLM、MiniMax、通义千问(阿里云百炼)、硅基流动、火山方舟
- **国内订阅套餐**：GLM Coding Plan、Kimi 会员等（部分无官方 API，标实验性）

形态：**常驻悬浮卡片**（置顶、可拖动、可收起成小圆点）+ **系统状态栏/托盘**（图标可显示关键百分比，点击切换悬浮窗显隐）。

## 2. 技术栈（用户确认：选最成熟最常用方案，不迁就个人技术栈）

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | **Electron 37.x**（版本锁定） | 悬浮窗/托盘/密钥链 API 最成熟、社区资料最多，此类桌面组件事实标准（VS Code、Slack 同源）。**37 为实测上限**：更高版本强链接 macOS 13 的 SMAppService，在 macOS 12 (Monterey) 上 dyld 崩溃 |
| 语言 | **TypeScript**（全栈单语言，无 Go sidecar 双运行时） | 打包简单，AI 可维护性最好 |
| UI 框架 | **React 18** | 生态最大，皮肤系统用 CSS 变量 + 组件组合实现 |
| 构建 | **electron-vite** + electron-builder（dmg / nsis） | 官方推荐脚手架，开箱支持主/预加载/渲染三分层 |
| SQLite | **node:sqlite**（Node 22 内置） | 只读打开 opencode.db，无需原生依赖 |
| 密钥存储 | **Electron safeStorage**（macOS Keychain / Windows DPAPI） | 系统级加密，配置文件不落明文 |
| 状态管理 | Zustand（轻量） | 悬浮卡片数据流简单 |
| HTTP | 主进程 fetch / node-fetch 统一出口 | 便于超时、重试、限流控制 |

**已否决的备选**：Tauri（Rust 栈，Go 需 sidecar）、Wails v2（无原生托盘 API）、纯 Go Fyne（UI 精细度不足）。
**关系说明**：仓库 `../planmeter/` 是早期 Go TUI 调研原型，其**数据源结论已全部吸收进本文档第 4 节**，原型可随时删除，不参与主线。

## 3. 架构

```
┌─ 主进程 main ────────────────────────────────┐
│  TrayService      托盘图标（供应商 logo template）+ 动态标题/菜单 │
│  OverlayService   悬浮窗生命周期（置顶/拖动/收起点）│
│  Scheduler        单一频率采集（用户可调 10s–300s，默认 60s）│
│  providers.ts     供应商注册表（内置预设 + 自定义 CRUD）│
│  KeyStore         safeStorage 加密凭据读写      │
│  Scanner          凭据自动扫描（env + 工具配置）   │
│  adapters/        协议实现（= 内置供应商的采集逻辑）│
│    ├ opencode/claude/codex/copilot  → coding    │
│    ├ deepseek/kimi/zhipu/siliconflow/qwen/volc → balance │
│    ├ minimax → token                            │
│    └ custom.ts → 自定义供应商（协议驱动）         │
└────────────── IPC(push: state.snapshot) ──────┘
┌─ 渲染进程 renderer（悬浮窗 + 设置窗口共用）─────┐
│  CardView     主页卡片网格（点击进详情）          │
│  DetailView   单供应商用量统计（窗口/剩余/tokens/模型）│
│  SettingsView 供应商增删改 + 外观 + 频率 + 系统    │
│  PetBall 收起态 2D 小圆环（SVG 环 + 轮播 + 流体）│
│  SkinEngine   皮肤包加载（CSS 变量 + 令牌覆盖）    │
└───────────────────────────────────────────────┘
```

- 悬浮窗：`BrowserWindow{ frame:false, transparent:true, alwaysOnTop:true, skipTaskbar:true, resizable:false }`，拖动区用 `-webkit-app-region: drag`。
- 收起态：折叠成一块 56×56 的小窗（2D 小圆环，唯一的形态），
  主体以外的区域鼠标穿透，点击展开。
- 托盘：macOS 用 template 模板图标（**随主供应商切换 logo**），标题平铺展示该供应商的全部时限窗口（`5H 5% W 52.9% M 68.5%`）；**左键直接切换悬浮窗显隐，右键弹菜单**（macOS 上禁用 `setContextMenu`，否则左键会被菜单抢占）；Windows 托盘 hover tooltip 显示汇总。

### 3.2 数据可信度（诚实原则，2026-09-13 加入）

**问题**：断网时如果把「本机估算 / 上次的数值」当成实时官方数据展示，会误导用户
（实测：断网后 OpenCode 会退回本机 `opencode.db` 统计，百分比与官方口径不同，用户会以为官方就是那个数）。

**约定**（`src/shared/quality.ts`，纯函数、主进程/渲染层/单元测试共用）：

| dataQuality | 含义 | UI |
|---|---|---|
| `official` | 官方/权威源实时数据 | 正常展示 |
| `local` | 官方不可达，退回本机估算（口径不同） | 「本机」徽章 + 数字降调 + 详情页提示条 |
| `cached` | 本轮刷新失败，沿用上次官方数据 | 「缓存」徽章 + 相对时间 + 详情页提示条 + 托盘 ⚠ |

- **调度器「最后有效值」策略**：本轮 `error` / `local` → 沿用上次 official 快照并标记 `cached`（`dataAt` 保持为上次成功时间）；超过 **24 小时**不再展示；`nodata`（未配置）不缓存。
- **网络判定**：`net.isOnline()`（系统级）+ 连续 2 次以上网络类错误且期间无成功响应（`src/main/net.ts`）；HTTP 4xx/5xx **不算**离线（是凭据/服务问题）。
- **排障开关**：`BALANCEDECK_FORCE_OFFLINE=1`（或毫秒数）让所有出网请求立即失败，用于端到端验证离线路径。

### 3.1 供应商模型（实例 = 用户添加）

**供应商不是常驻列表**：内置预设也要通过设置页「添加提供方」显式加入。加入后形成一个**实例**，
同一预设可重复添加（不同 key / 不同中转站），可随时删除。

```
供应商实例 = 身份（id/名称/类别/启用）+ 协议（怎么查）+ 配置（baseUrl/key）
```

| 维度 | 内置预设实例 | 自定义实例 |
|---|---|---|
| 添加方式 | 「添加提供方」从预设目录选 | 「添加自定义提供方」选协议 + 填名称/地址/key |
| id | 迁移时保留旧 id；新增用 `inst:<time36>-<rand>` | 同左 |
| 协议 | 固定（= 特化适配器） | 从 9 种通用协议选择 |
| 名称 | 默认预设名，可改名 | 随意填写（可重名） |
| 重复 | **可重复添加** | **可重复添加** |
| 删除 | 可删除 | 可删除 |
| 类别 | balance / coding / token | 随协议（balance / token） |
| 幂等限制 | Claude/Codex/Copilot 为 `singleton`（本机文件型，重复无意义） | 无 |

**类别语义**：

| 类别 | 含义 | 展示 |
|---|---|---|
| `coding` | Coding Plan（订阅制） | 用量 % + 限额 + 重置时间 + 本机 tokens |
| `token` | Token Plan | 同上 |
| `balance` | 直连余额（按量付费） | 账户余额金额 |

**内置预设**（11 家）：OpenCode Go / Claude Code / Codex / GitHub Copilot（coding）、MiniMax（token）、
DeepSeek / Kimi / 智谱 GLM / 硅基流动 / 通义千问（百炼）/ 火山方舟（balance）。

**自定义协议目录**（9 种）：DeepSeek 兼容 / Moonshot 兼容 / 智谱兼容 / 硅基流动（国内·国际）/ OpenRouter /
OpenAI 计费 / MiniMax Token Plan / 通用 JSON（宽容解析，直接请求用户填的完整 URL）。

**存储**：

```
extras.providerInstances        → JSON 数组（ProviderInstance[]：id/name/presetId/protocol/kind/baseUrl/builtin/enabled/createdAt）
extras.provider:<id>:baseUrl    → 覆盖默认 API 地址
keys[<id>]                      → 凭据（safeStorage 加密）
```

**旧模型迁移**：首次读取时若不存在 `providerInstances`，把「已启用且已配置凭据」的内置供应商转为实例
（沿用原 id，因此凭据无需迁移）。未配置的不再常驻显示，需要用户主动添加。

**实例与适配器**：`buildAdapters()` 遍历实例；内置实例把基座适配器用 `wrapForInstance()` 绑定到实例
（凭据查找从基座固定 id 重定向到实例 id，baseUrl 覆盖读实例配置，快照 id/name 换为实例身份）。



## 4. 商家数据源清单（核心资产，逐家验证过）

> **核心原则：官方口径优先，本机数据只作补充。**
> Coding plan 的额度是**账号级、所有客户端共享**的（OpenCode TUI + DSH + 其他 agent 工具都算）。
> 本机 `~/.local/share/opencode/opencode.db`、`~/.claude`、`~/.codex` 只是**本机份额**，永远 ≤ 官方用量。
> 因此：**percent / 花费 / 重置时间一律以官方接口为准**；tokens 与每模型明细只有本机数据，必须标注"本机"。
> 校验方法：官方 percent × 限额 ≈ 本机同窗口 cost（差额即其他客户端的用量）。

### 4.1 Coding plan（本地数据 + 已知限额）

| 商家 | 数据源 | 关键字段 / 算法 | 限额 | 状态 |
|---|---|---|---|---|
| **OpenCode Go** | **①官方 API（权威）**：`GET https://opencode.ai/zen/go/v1/usage`（Bearer key，key 来自 `~/.local/share/opencode/auth.json` 的 `opencode-go` 条目，或 opencode.db `credential` 表 `integration_id='opencode'`），返回 rolling(5h)/weekly/monthly 三窗口 `{status, percent, resetsAt}`；**②控制台 SSR 抓取（精度增强）**：`GET https://opencode.ai/workspace/<wrk>/go`（会话 cookie），解析 `data-slot="usage-item"` 块，逻辑移植自 [dsh-opencode-go-usage](https://github.com/v587d/dsh-opencode-go-usage)；**③本机 opencode.db**（tokens/每模型明细，**仅本机**）。已知坑：①key 归属用户与订阅记录 userID 不一致时返回 403 EntitlementError → 需在控制台重新生成 Key 并在 TUI `/connect` 重连，或改用 cookie 路径；②opencode 1.x 起消息表由 `message` 迁移到 `session_message`（`type='assistant'`，模型在 `model.providerID`），**只读旧表会丢失新数据**；③官方额度为**所有客户端共享**（OpenCode + DSH + 其他工具），本机 db 只是本机份额；④**API 的 `percent` 是整数**（向下取整），控制台渲染一位小数 | **精度策略**：API 整数是控制台值的下界。配了 cookie → 用 cookie 的精确百分比（与控制台逐位一致）+ API 的精确 `resetsAt`；两者须落在同一整数带内才合并（防串窗）。只有 API → 诚实显示整数，**不伪造小数**。⚠️ **不要用本机 cost 反推百分比**（本机份额 + 滚动窗口滑动会回退 → 数值抖动）。tokens 取本机同窗口求和并标注"本机"；5h 窗口 percent=0 且 resetsAt≈now+5h 视为"当前无活跃窗口" | ✅ 已验证（实测 API 4/50/67 vs 控制台 4.3%/50.2%/67.2%；配上 cookie 后逐位一致） |
| **Claude Code** | `~/.claude/projects/**/*.jsonl` | 只取 `message.usage` 非空的 assistant 行；去重 key=`messageId|requestId|timestamp`；cost 优先 `costUSD`，否则按 token | 官方无 API；Pro/Max 限额用社区估算预设（可配置覆盖） | ✅ 已验证 |
| **Codex** | `~/.codex/sessions/**/rollout-*.jsonl` | `token_count` 事件的 `total_token_usage.total_tokens` 是**会话内累计值**，需做事件间增量；若事件带 `rate_limits.primary/secondary`（used_percent/resets_in_seconds）则**直接采用服务端真值** | 服务端真值优先，本地 token 估算兜底 | ✅ 已验证 |
| **Copilot** | 凭据 `~/.config/github-copilot/apps.json`（Windows: `%LOCALAPPDATA%\github-copilot\`） | `GET https://api.github.com/copilot_internal/v2/user`，头：`Authorization: token <ghu_…>`、`Editor-Version: vscode/1.96.2`；`quota_snapshots.{premium_interactions,chat,completions}`；`quota_reset_date` | 官方接口返回剩余/总量 | ✅ 已验证 |

**5 小时窗口算法（Coding plan 通用）**：按时间排序，窗口自首条记录起持续 5h；窗口结束后第一条记录开启新窗口（与 Claude Code 行为一致）。当前活跃窗口用量 + `窗口起点+5h` 即重置时间。周=滚动 7 天；月=滚动 30 天与自然月取大者（保守）。

### 4.2 Token plan / API 余额（官方接口）

| 商家 | 接口 | 认证 | 备注 |
|---|---|---|---|
| DeepSeek | `GET https://api.deepseek.com/user/balance` | Bearer key | 返回 `balance_infos[].total_balance`、`is_available` |
| Kimi (Moonshot) | `GET https://api.moonshot.cn/v1/users/me/balance` | Bearer key | 返回 `data.available_balance` 等 |
| 智谱 GLM | 开放平台余额接口（实现时以官方控制台/API 现核） | API key | ⚠️ 端点需实现期验证 |
| MiniMax | `GET https://api.minimax.chat/v1/query_balance?group=<group_id>` | Bearer key | ⚠️ 域名/参数实现期验证 |
| 通义千问(百炼) | 阿里云 BSS `QueryAccountBalance`（RPC 签名） | AccessKey（建议只读 RAM 子账号） | 签名复杂，单独适配器 |
| 硅基流动 | `GET https://api.siliconflow.cn/v1/user/info` | Bearer key | 返回 `data.balance` |
| 火山方舟 | 火山引擎计费 OpenAPI（火山签名） | AccessKey | 签名复杂，单独适配器 |

### 4.3 国内订阅套餐（实验性）

GLM Coding Plan、Kimi 会员等多数**无公开余额 API**。策略：能走开放平台 API 的走 API；其余标"实验性"，通过网页会话 Cookie 导入查询，失败时 UI 明确显示"暂无官方接口"，不做静默猜测。

## 5. 凭据方案（用户确认：自动扫描 + 手动补充 + 密钥链）

- 凭据扫描（只读）：环境变量（`DEEPSEEK_API_KEY` 等）+ opencode `auth.json` + opencode.db `credential` 表 + github-copilot `apps.json`；支持每商家**自定义 Base URL**（中转/聚合平台），存 `userData/secrets.bin` 的 extras。
2. **手动补充**：设置窗口内逐家粘贴 key，校验通过才保存。
3. **存储**：`safeStorage.encryptString()` 加密后存 `userData/secrets.bin`，磁盘无明文；扫描发现的仅做展示来源标记，可一键"收编"入密钥链。
4. 源码、示例、测试**禁止出现可用凭据字面量**（安全硬约束）。
5. **OpenCode 凭据三来源**（自动合并去重，失败自动 failover）：设置中的多账号（加密）→ `~/.local/share/opencode/auth.json` → opencode.db `credential` 表（`integration_id='opencode'`）。opencode 1.x 起凭据迁入数据库，**该来源的 key 通常是最新有效的**（auth.json 可能是旧 key，请求返回 403 EntitlementError）。
6. **OpenCode 控制台凭据（可选 · 高级设置）**：`opencodeCookie`（加密存储）+ `opencodeWorkspaceId`（extras）。

   用途：官方 API 只返回**整数**百分比，控制台页面渲染**一位小数**。配置后精度与控制台逐位一致；**不配置不影响使用**（只是整数精度）。因此收在设置页的「高级设置 · 控制台精度增强」折叠区里，默认不展开。

   获取方式（三选一）：
   - **一键授权（推荐）**：内嵌 `BrowserWindow`（`persist:opencode-auth` 分区）打开 opencode.ai 登录页，用户正常登录后主进程轮询该分区的 cookie，并从窗口 URL / 页面 HTML / 控制台首页三个来源解析 workspace id，成功后加密落盘。持久分区让再次授权免登录。
   - **手动粘贴**：在系统浏览器打开控制台（`shell.openExternal`，带 workspace 时直达用量页），从 DevTools 复制 cookie。
   - **自动复用**：若已使用 `dsh-opencode-go-usage` 插件并配置过 `$DSH_HOME/ocgo-usage.json`，直接读取其中的 cookie + workspaceID；也兼容环境变量 `OPENCODE_GO_COOKIE` / `OPENCODE_GO_WORKSPACE_ID`。

   **为什么不做"系统浏览器登录后跳回来"**：`auth` cookie 是 **HttpOnly + 域绑定**的 —— 浏览器只把它发给 `opencode.ai`，不会发给本地回调（`127.0.0.1`）；我们的页面也无法用 JS 读取它。要拿到它只能：(a) 在我们自己控制的会话里登录（即内嵌窗口方案，`session.cookies` 可读 HttpOnly），或 (b) 解密浏览器的 cookie 数据库（需钥匙串/完全磁盘访问权限，且每种浏览器实现不同，脆弱且侵入）。故采用 (a)，并保留手动粘贴作为备选。

   **3. 控制台「每模型用量明细」**（`src/main/opencode-details.ts`）

控制台每个窗口的「显示详情」展开后是一张 `模型 | 用量(US$) | 配额(US$) | %` 表。
该表**不在 SSR HTML 里**，是点击后由客户端 RPC（SolidStart server function，自定义 seroval 编码）拉取的。
与其逆向其私有 RPC 协议，不如**复用授权分区开隐藏窗口，驱动「点击展开 → 读取 DOM」** ——
这正是用户手动做的事，对站点改版更鲁棒。

- 抓取结果按 workspace 缓存 5 分钟；**非阻塞**（首轮用缓存/后台刷新，不拖慢采集；实测 ~7.5s）
- 与本机 tokens 按**归一化模型名**合并（控制台给权威用量/配额/%，本机补 tokens）
- 同名的两个控制台模型（如两个 "DeepSeek V4.1 Flash"）只消费一次本机数据，避免重复计数
- 快照字段：`modelsByWindow`（key = 窗口名）；详情页每个窗口下渲染可展开模型表

**抓取踩坑**（已在代码注释固化，改脚本前先读）：
1. 三个窗口**共享一个 expanded 状态** → 同时点三个只有最后一个生效，必须逐个展开
2. 展开内容渲染在**根级**（不在 `usage-item` 内）→ 需 `document.querySelector` 取，并用表头文字确认归属
3. 水合前点击会被丢弃 → 先留稳定期；重复点击会把已展开的收起 → 点一次后只等不点
4. 标签里的空格可能是 NBSP → 用 `\s` 正则而非普通空格

**排障工具**：`npm run details:test` 一次性抓取并打印；`BALANCEDECK_DEBUG=1` 写调度/自愈追踪到 `/tmp/balancedeck-scheduler.log`。

**抓取要点（踩坑记录）**：
   - **必须验证后再保存**：登录过程中会出现"中间态" cookie（实测长度 ~346 vs 最终 539），存下来请求会 302 到登录页。抓到 cookie + workspace 后要先请求一次用量页确认出现 `usage-item`，通过才算成功，否则继续轮询。
   - **按域全量发送**：只留 `auth` + `oc_locale` 会在站点新增依赖 cookie 时失效。取 `opencode.ai` 域的全部 cookie（排除 `auth.opencode.ai` 等子域）拼 Cookie 头。
   - **优先用授权分区的实时 cookie**：服务端在**每次响应**轮换 session cookie（iron-session 行为），保存的副本必然慢一步 → 下次请求必被判失效。分区由浏览器会话自动跟随轮换，是唯一可靠来源；保存值仅作手动粘贴场景兜底。
   - 诊断工具：`scripts/opencode-cookies-list.js`（列出分区 cookie）、`scripts/opencode-console-fetch.js`（用分区实时 cookie 直连控制台）。

## 6. 皮肤系统（用户确认：默认毛玻璃 + 5 套内置 + 可扩展）

- 皮肤 = 一个目录/包：`skin.json`（design tokens：颜色、圆角、背景、模糊度、字体）+ 可选布局预设（`compact` 单列 / `expanded` 明细 / `dashboard` 网格）。
- 实现为 CSS 变量注入 + 布局组件切换；**新增皮肤零代码**（放入 `userData/skins/<name>/` 即生效）。
- 内置 5 套：
  1. **原生毛玻璃**（默认）：macOS vibrancy / Windows acrylic，深浅色跟随系统
  2. **深色科技**：固定深色 + 高亮渐变进度条
  3. **极简白**：纯文本 + 细进度条，小窗体
  4. **渐变彩**：柔和渐变背景 + 大数字
  5. **壁纸皮肤**：自定义背景图 + 半透明面板
- 换肤入口：悬浮卡片右键菜单 + 设置页，即时生效。
- **令牌驱动**：所有组件消费语义变量（`--fg` / `--surface` / `--accent` / `--ok` / `--warn` / `--danger` / `--track` / `--radius-*` / `--ease`），皮肤 = 覆盖令牌。
- **实现注意**：`color: var(--fg)` 必须落在 `.app` 上，**不能在 `body` 上写** —— `data-skin` 挂在 `.app`，`body` 会先用 `:root` 的值解析 `color` 并形成继承屏障，导致皮肤文字色失效（已踩坑，见 `skins.css` 注释）。

## 7. 其他默认值（有惯例默认，未逐项询问，可在设置中改）

- 刷新：**统一单一频率**，可选 10 秒 / 15 秒 / 30 秒 / 1 分钟（默认）/ 2 分钟 / 5 分钟，即改即存并立即生效。
  （历史上分「套餐类 60s / 余额类 5min」两个旋钮，实测用户无法预期、也无必要 —— 采集一轮并行跑完，慢接口不拖累快接口。）
- 图标：内置供应商与自定义协议都有 logo（`scripts/gen-provider-icons.mjs` 构建期从 Iconify 内联，运行时零网络）；同一份单色 SVG 既作 UI 的 CSS mask（随品牌色/主题着色），又栅格化成 macOS 托盘 template 图。应用图标（`scripts/gen-icons.js`）遵循 **Apple 图标网格**：1024 画布内圆角方形占 824（四周留白 100），否则 Dock/访达里比系统图标大一圈；界面内徽标用同图形的满幅版 `build/badge.png`。
- 开机自启：默认关，设置页开关。**macOS 用 `~/Library/LaunchAgents/dev.zhouri.balancedeck.plist`（LaunchAgent）**，Windows 用 `app.setLoginItemSettings`。⚠️ macOS 上不要用 Electron 的 LoginItem API（macOS 12 + Electron 37 实测为空操作：写入不生效、旧登录项也删不掉，开关表现为失灵）；残留的旧登录项由设置页警示并指引用户到系统「登录项」手动删除。
- 更新：v1 不做自动更新。
- 隐私：一切数据本地计算与存储，仅余额 API 请求出网；无遥测。

## 7b. 悬浮球贴边自动隐藏（2026-10-03）

收起态 2D 球（56×56）拖到屏幕四边松手停留 1s 后，原生窗口滑出边框、只留 4px 痕迹；
光标在痕迹区停留 300ms 滑出恢复，离开球体 1.5s 后重藏。展开态卡片不参与。

- **几何唯一来源**：`src/shared/dock-hide.ts`（纯函数：边沿判定/隐藏偏移/痕迹命中区/常量），
  主进程状态机（`src/main/dockHide.ts`）与单测共用同一实现；渲染层不算几何。
- **跨层契约**：隐藏态下主进程以痕迹条覆盖命中区，不采信渲染层常规上报；
  恢复可见后重新采信。命中判定与隐藏偏移同源，否则"看得见点不着"。
- **三把计时器**（同一时刻最多一把存活）：隐藏停留 1000ms、唤出停留 300ms、离开重藏 1500ms；
  动画是主进程 16ms 步进（隐藏 300ms / 唤出 200ms，easeOutCubic），与 16ms 拖拽轮询互斥。
- **取消条件**（任何一条即复位到贴边全可见）：拖拽开始、展开/收起切换、显示器变化、
  开关关闭、隐藏计时期间光标进入球体、形态尺寸变化。
- **落点校验**（本机实测）：macOS 上沿（菜单栏）与下沿（Dock 在底部时）都不许窗口越界，
  对应边的隐藏会被 OS 夹回。动画落点与目标差 >1px 即算隐藏失败，回到贴边全可见 +
  idle —— 绝不停在"相位说藏了、窗口还在原位"的半态（否则球看得见、大部分点不着）。
  E2E 因此不断言"哪条边必须藏"（取决于用户 Dock 位置与平台），只断言"藏则位移精确、
  拒则干净无半态，且至少一边真藏"。左/右沿在本机正常隐藏。
- **开关默认开**：`extras.ui:dockHide`（缺失键视为开，判 `!== '0'`）+ 设置页"系统"分区 +
  球右键原生菜单；关闭即回滚到现行行为。`prefers-reduced-motion` 下跳动画、留计时；
  无 hover 设备点击痕迹唤出（痕迹态下单击走 `dock:reveal` 而非展开）。
- **持久化**：`state.json` 只增 `dock: {edge, hidden}`，坐标仍存贴边全可见位置；
  隐藏偏移每次按当前 `workArea` 重算，重启/显示器拔插不漂移。老文件无该字段视为未隐藏，零迁移。
- **平台约束**：macOS 可见窗口不许越过菜单栏（探针实测同步夹回）——上沿在 darwin 下由
  `isEdgeSupported` 确定性拒绝（overlay 注入，几何模块保持平台无关）；其它 OS 夹取
  （如 Dock 摆位）由动画落点校验 `landed()` 兜底 abort。uitest sweep 在 darwin 上沿断言
  拒绝签名（idle + edge null + 纹丝不动），其余边"藏或干净拒绝、至少一边真藏"（Dock 摆位因机器而异）。
- **测试**：`scripts/test-dock-hide.mjs`（132 项，纯函数 + 注入依赖的真计时状态机，含 reduced-motion 真计时/逐帧步进/动画期翻转/显示器重判/旧屏恢复/落点 abort/平台拒绝；左右/上下平局各弄坏一次验证红）；
  `--uitest` 新增 `dock*` 断言（debug 通道摆真实窗口，`BD_DOCK_FAST=1` 压缩计时）；
  `--shots` 新增 `5g-dock-hidden` / `5h-dock-revealed` 走查图。

## 7c. 流体隐藏（2026-10-03，路线 A：SVG gooey + 渐变 3D，零依赖零 WebGL）

slide 基线（§7b）保留为 reduced-motion 回退路径；全动效路径走本节。决策见任务
`design.md` Fluid 补充设计：否决 three.js 真 3D 球（+1.2MB chunk、WebGL 常驻、耗电，
与废除真人瘦身方向直接冲突）。

- **渲染结构**：`.petball-goo` 容器挂 `filter: url(#petball-goo)`
  （feGaussianBlur + feColorMatrix alpha 对比，滤镜区裁到 56×56 内），内部三元素 ——
  ① `.fluid-disc`（R8 渐变球）② `.fluid-waves`（R9 水满波浪）③ `.fluid-bridge`（液桥）
  ④ `.fluid-pill`（贴边水渍）。环/数字/标记在 goo 容器**之外**，读数永远 crisp。
- **状态驱动**：主进程 dockHide 经 `dock:fluid` 通道推送
  `edge-visible | absorbing | hidden | revealing`（唯一映射 `shared/fluid.fluidForPhase`），
  渲染层只切 CSS 类、不算几何。窗口位移仍走主进程 `setPosition` 步进，morph 与位移串行：
  吸入先播 morph（530ms）再滑，汇聚先滑回再播 morph 尾（400ms）。
- **R8 球体 3D 观感**：径向渐变（`--ball-bg` 为基、顶部 `--dot-top` 高光、底部
  `--dot-bottom` 内阴影、边缘 `--ball-rim` 描边），与 09-28 球形态令牌体系同源，换肤零代码。
- **R9 水满进度**：仅套餐类（`isPlan()` 为真）且算得出比例时挂波浪；球内 `<clipPath>` 圆形 +
  双层正弦波浪（3.2s vs 2s = 1:1.6 错速），液位 = `shared/fluid.level(percent)`
  （clamp 0–100 → 0–1，一位小数粒度，与环心读数逐位一致）；余额类保持素盘。
  波浪在隐藏态暂停，reduced-motion 下只显示静态液位。
- **morph 期命中区取并集**：球形态命中区本就是整窗，并集 = 整窗 = 不覆盖 ——
  `peekOverride` 只在隐藏落定后覆盖为痕迹条、唤出开始即清除，morph 窗内天然全窗可点。
- **取帧**：`window.__bd_fluid_freeze('stretch'|'bridge'|'stain')` 把 goo 定在 morph 帧
  （呈现层冻结，不动状态机），`'off'` 恢复；`debug:dock-fluid-freeze` 拦住主进程的
  `dock:fluid` 推送（复用 `debug:dock-freeze` 模式）。`--shots` 新增
  `5i-fluid-stretch` / `5j-fluid-bridge` / `5k-fluid-stain`。
- **测试**：`scripts/test-fluid.mjs`（44 项：时序/液位/水渍几何/相位映射，先弄坏验证）；
  `test-dock-hide.mjs` 增至 132 项（流体序列 + 全动效串行 + 左右/上下平局）；`test-structure.mjs` 新增
  J 门（setPhase 唯一出口 / 渲染层只消费 / CSS 降级真实存在 / E2E 覆盖存在）；
  `--uitest` 新增 `dockFluid{Goo,Hidden,Level,Reveal}`（落定态主副同源 + 波浪与填充弧同生同灭）。
- **回滚**：删 goo 容器恢复旧 `.petball-fallback` 即回 slide 版（R8/R9 可独立回滚：
  关水满只留渐变球）。goo 在透明窗口下合成异常则按走查结论硬开关回退 slide。

## 8. 界面结构（2026-09-13 全面重设计）

三个视图，共用同一个窗口（悬浮卡片即主视图）：

| 视图 | 内容 | 入口 |
|---|---|---|
| **主页 CardView** | 已启用且有数据的供应商卡片网格（套餐=环形仪表，余额=大号金额）；点击卡片进详情 | 默认视图 |
| **详情 DetailView** | 单供应商完整统计：hero（主窗口环 + 金额 + 重置 + 剩余）、用量窗口列表（% / 金额 / 剩余 / 本机 tokens / 数据来源 + 每窗口模型明细）、数据可信度提示条 | 点击主页卡片 |
| **设置 SettingsView** | 供应商管理（按类别分组 + logo + 状态点 + 行内编辑展开 + 删除二次确认 + 虚线添加按钮）、外观、刷新频率（单一入口）、系统 | 主页「设置」按钮 |

**主页交互**：
- **拖拽排序**：按住卡片移动 >6px 进入拖拽。**拖拽期间不改动 DOM 顺序**，只做 transform 预览（被拖卡片跟手抬起、其余卡片按槽位偏移让位），松手才提交新顺序 —— 目标槽位由「拖拽开始时捕获的静态几何」算出（纯函数），因此同一指针位置永远映射到同一槽位，不会来回抖。顺序 = 优先级，**状态栏取第一位展示**。键盘 `⌥←/⌥→` 等价；Escape / 窗口失焦 / 4 秒无移动都会安全落位（绝不留下悬空卡片）。
- **首屏骨架**：采集未返回时显示骨架卡（避免空荡与布局跳动）；空状态给「去添加」直达设置。
- **窗口切换**：多窗口套餐卡在标题下方渲染 `5H / W / M` 胶囊（含各窗口严重度着色），点击切换卡片展示的窗口；选择持久化于 `ui:cardWindow:<实例id>`（存窗口名，配置变化自动回退默认窗口）。
- **余额显隐**：标题栏眼睛按钮切换（`extras.ui:hideBalance`，即改即存）；开启后余额类卡片的金额显示为 `••••`，收起态圆点同步打码（套餐百分比不受影响）。
- **可信度可见**：卡片脚注出现「缓存 / 本机」徽章 + 相对时间，数字降调；离线时标题栏状态行变琥珀色并说明「离线 · N 项为缓存数据」。
- **刷新反馈**：刷新中图标旋转、主按钮变「刷新中…」。

**设计语言（Apple-like）**：克制的层次（发丝边框 + 极轻阴影）、克制的色彩（语义色仅用于状态）、克制的动效（200ms `cubic-bezier(0.32,0.72,0,1)`，只动 transform/opacity，尊重 `prefers-reduced-motion`）、系统字体栈、8px 间距节奏、12–18px 圆角。

**圆角与外框**：
- 窗口**全平台透明**（`transparent: true` + `backgroundColor: '#00000000'`）—— 形状即圆角矩形/圆形，四角之外完全透明。
- ⚠ **窗口内没有可采样的 backdrop**：页面内 `html/body/#root` 全是 `background: transparent`，所以 CSS `backdrop-filter` 在这套配置下履行不了「磨砂」的宣称（要么空操作，要么在透明窗口上渲出一块浅色）。收起态球盘上它已经被删掉（2026-09-28），要真磨砂得改到**主进程**侧合成。
- 不使用 macOS 原生 `vibrancy`：原生磨砂铺满窗口矩形，会在 CSS 圆角/圆形之外的区域露出磨砂底与一条发丝边（"透明角 + 白线"）。
- 窗口阴影用 `hasShadow: true`（macOS 跟随内容 alpha 形状，即圆角/圆形本身）。
- 自检：`python3 scripts/png-alpha.py <shot.png>` 可查四角 RGBA 的 alpha 是否为 0。

**收起态：2D 小圆环（唯一的形态）**（2026-09-15 两轮重做 + 2026-09-19 人物形态重做 + 2026-09-27 球形态回归 + 2026-10-03 人物形态下线）

第一轮反馈：① 圆点「有黑色边框、立体效果没做出来，只有毛玻璃皮肤有效果」；② 面板里的宠物模块不要了，
「整个悬浮圆球变成 3D 立体精灵，像桌宠一样时不时走动」。
第二轮反馈：① 悬浮球**默认回到 3D 圆球形态**，开启桌面宠物才是宠物形态；② 需要**置顶开关**；
③ 桌面宠物外面有个**四方形框**，且宠物不够真实（建议上网找 3D 素材）；④ 点击悬浮球弹了错误框。

第三轮反馈（2026-09-19）：「球形把人都框在球体里面，不要球形，悬浮的就是这个人物，不要进度条，
这样人就可以大点高点，现在面部表情都看不清楚」。

第四轮反馈（2026-09-27）：「默认状态下就一个小圆点」—— 第三轮只否掉了**框住人物的球**，
球形态本身一直没被否。但实测下来 3D 球的问题是**默认就占着 GPU**：它在 `scene.ts:151` 无条件
`new THREE.WebGLRenderer`，一个 56px 的读数不值得常驻一个 WebGL 上下文。于是球形态**整体退回首版
的 2D 小圆环**（SVG 环 + 环心百分比 + 56×56 窗口），**不建场景、不加载任何 3D 资源**。

第五轮（2026-10-03）：个性人物形态**整体下线** —— `pet3d/` 整目录（scene / human / gesture /
rig / tokens / clips）、`three` + `@types/three` 依赖与独立 chunk、`fetch-human-pets.mjs`
采集脚本与 `predist` 钩子、`bd-asset://` 素材协议（`human-assets.ts`）、`FIGURE_VIEW` 与主进程
形态分支、设置页「数字助理」分区（选人/改名/形态开关）、右键菜单换一位/改名项、`test:pet` /
`test:gesture` / `test:resource` 三个套件一并删除。老用户 `ui:pet === '1'` 由主进程 `primePrefs`
迁回 `'0'`，收起态恒为 56×56 小圆环。下面 `>` 引用块是人物形态存续期的设计记录
（已失效，保留为历史），之后是现行有效的条目。

**形态与窗口**（窗口尺寸 `shared/pet-view.ts` —— 只剩 `BALL_VIEW` 56×56）：

| 形态 | 触发 | 收起态窗口 | 内容 |
| --- | --- | --- | --- |
| 2D 小圆环（唯一的形态） | 恒成立 | 56×56 | SVG 用量环 + 环心百分比，**不建 WebGL 上下文**；套餐供应商恒显环，余额供应商不画环 |

> 以下三段是人物形态存续期的设计记录（已随 10-03 下线失效，保留为历史）：
> 形态表 `FORMS` 当时只有 `figure` 一项（球形态不建场景，也就没有机位可言）；
> 人物距离由「人物占窗口高度 68%」反算（`FIGURE_FILL`），213×293 下人物约 197px 高；
> 命中区按形态算（球 = 2D 环矩形，人物 = 包围盒八角投影外接矩形约 159×213px）。
> 出场/退场/随机小动作归 `gesture.ts` 编排（`test:gesture` 59 条断言已随之下线）；
> 素材走 `fetch-human-pets.mjs` → gitignored `resources/human-pets/` → `bd-asset://`
> 协议（`human-assets.ts`）→ `pet3d/human.ts`（FBXLoader 直读 + 按需加载剪辑）。

- **总在最前可关**：`ui:alwaysOnTop`（默认开）。`setAlwaysOnTop(on, 'floating')` 或 `'normal'`；
  球上的右键菜单与设置页「系统」都能切。
- **不要方框阴影**：收起态 `hasShadow = false`。透明窗口 + GPU 合成内容时，
  macOS 会按**窗口矩形**投一层阴影，实机表现就是「圆环外面套了个四方形框」；
  展开态（圆角卡片）仍然保留原生阴影。立体感由 CSS inset 阴影负责。
- **逐皮肤立体**：圆环所有颜色都走 CSS 令牌（`--ball-bg` / `--ball-rim` / `--ok` /
  `--warn` / `--danger` / `--track`），**新增皮肤零代码**生效。

> 以下两节是人物形态存续期的管线设计记录（已随 10-03 下线失效，保留为历史）：
>
> **3D 素材管线**（`pet3d/human.ts`，2026-09-19 起只有数字人一条路径）：
>
> > 历史：早期是自绘程序化角色（`rig.ts`），随后换成 Kenney「Cube Pets 2.0」（CC0，8 只 Q 版动物，
> > `models.ts` + base64 内联 + `thumbnail.ts`），用户要求「把宠物模块改成数字人模块，保留 aria 和 ray，
> > 动物都去掉」后全部下线（8 只 GLB、`glbInline()` 插件、内联缩略图器一起删除）。
>
> - 素材：**[Microsoft Rocketbox](https://github.com/microsoft/Microsoft-Rocketbox)（MIT）**，
>   商务装一女一男（aria / ray），每人 1 个模型 + 11 条动作；`npm run fetch:humans`
>   （`scripts/fetch-human-pets.mjs`）拉取 FBX + 动作剪辑，TGA 用系统 `sips` 转 PNG≤1024，
>   落到 gitignored 的 `resources/human-pets/`，打包走 `extraResources`（`predist` 钩子保证先拉取）。
>   README 第三方素材区同步署名。
> - 采集脚本**按文件幂等**：模型/贴图/每条动作各自 `existsSync` 判断，缺哪个补哪个。
>   只看 model.fbx 就整体跳过会让"动作目录增补"永远到不了已有安装（本次一次加了 7 条/人）；
>   反过来重跑也不会退化成"整包重下 160MB"。
> - 加载：运行时 FBX 直读（three 自带 `FBXLoader`，无需 blender 转换链），实例化必须
>   `SkeletonUtils.clone`（普通 clone 蒙皮会粘模板骨骼）；`bd-asset://` 协议
>   （`src/main/human-assets.ts`，限定目录 + 防穿越）供 `file://` 渲染层读取，打包后
>   走 `process.resourcesPath`，dev 走仓库 `resources/`；CSP 加 `bd-asset:`。
> - **按需加载**：`scene.ts` 用 `await import('./human')` 动态引入（human.ts 静态依赖 FBXLoader +
>   SkeletonUtils，约 118KB → 独立 chunk），且**球形态根本不调用** —— 默认形态启动不下载分包、
>   不解析任何 FBX（用户反馈「3D 效果导致启动变慢」的两处根因）。
> - **剪辑按需加载**：动作库每条 FBX 都自带整套骨骼+蒙皮（1.5–5MB），11 条一次性解析要好几秒。
>   现在只有 `BASE_CLIPS`（idle / walk / wave —— **出场那一刻就要用的三条**）随模型加载，
>   其余动作**第一次被抽到才解析**（`loadHumanClip` + `ensureClip`，解析好的 action 缓存复用）。
>   `talk`（4.77MB，只在 90 秒一次的播报里用）也被移出基础集：放进去等于让每次出场白等它。
> - 动画：`AnimationMixer` + action→clip 交叉淡化（idle 与 walk 循环，其余一次性播完定格）；
>   剪辑与模型同系、骨骼名天然对齐（`Bip01_Footsteps` 等非变形 helper 缺失是预期的，
>   mixer 静默跳过，`unbound` 会 console.warn）。
> - **剪辑自带根位移必须每帧抵消**：位移曲线挂在骨骼层根节点（Bip01）的 position 上，walk 一圈沿
>   局部 z 拖走 159.7cm（归一化后 ≈33 世界单位）、连 idle 都有 ≈12；不抵消角色会自己滑出去再被循环
>   边界瞬移回来。`rootMotion()` 观测点暴露「迄今抵消掉的峰值」，是「素材到底漂不漂」的现场证据。
> - 归一化（`instantiateHuman`）：居中 + 等比缩放到目标身高（`HUMAN_HEIGHT = 36` 世界单位）+
>   脚踩地面；**动画层与归一化层必须是两层 Group** —— 动画直接改外层容器的 scale 会把归一化缩放
>   覆盖掉（曾经因此把模型缩回原始尺寸而"看不见宠物"）。
> - 泡泡：DOM `.petball-bubble`（`PetBall.tsx`），切换问好 + 长按回应 + 90s 余额播报，
>   沿用余额显隐与缓存/估算口径；toast（`.petball-toast`）只用于冷却/改名这类短提示。
> - 设置页缩略图直接用采集期 `preview.png`（不占 WebGL 上下文，也不再需要临时渲染器）。
> - 踩坑：逐只拍摄必须等到 `petReady`（多段 FBX 解析比 Q 版慢，固定等待会拍到空画布）；
>   `dump` 钩子带 `self/parent` 可区分自身隐藏与祖先链隐藏。
>
> **动作编排**（`pet3d/gesture.ts` 纯函数 + `pet3d/clips.ts` 素材表，2026-09-20 新增）
>
> 用户诉求：「每个人要设计独立的进出场动作和平时随机动作（至少 5 个）」。三个模块各管一段：
>
> | 模块 | 管什么 | 为什么独立 |
> | --- | --- | --- |
> | `clips.ts` | 逻辑剪辑键 → 素材文件名（每位角色各一套，`Partial` 即"没有这个动作"） | 纯数据：测试能断言"目录里的动作都有素材" |
> | `gesture.ts` | **动作目录**（一个动作 = 若干步，每步一段剪辑 + 一段程序化体态）+ **调度** | 纯函数：调度与体态轨迹可单测，59 条断言 |
> | `human.ts` | 素材加载与 action 生命周期（含懒加载） | 唯一碰 three/FBX 的地方 |
>
> - **一个动作 = 若干步**：每步 = `{clip, span, motion}`。`span` 有三种口径 —— `'clip'`（用剪辑自身
>   时长，一次性动作）、`'travel'`（走动：时长 = 场外距离 ÷ 步幅速度）、显式秒数（裁剪）。
>   这个三分法就是"为什么进出场不能写死秒数"的答案。
> - **进出场**（长动作、两步）：进场 = 从场外左侧走入（`walk` 剪辑，面朝行进方向）→ 站定转正挥手；
>   退场 = 挥手告别 → 转身走出场外右侧。**走动的位移速度必须由 walk 剪辑的根位移反算**
>   （实测 ≈27.7 世界单位/秒 = 那 33 单位/圈的步幅 ÷ 一圈时长），否则脚下打滑（"月球漫步"）。
>   速度反算拿不到时退化为按身高估计并 `console.warn`，同时 `stride()` 观测点可核对。
> - **平时随机动作**（每位角色 5 个，池子 = 动作目录 ∩ 素材表，**不是写死的名单**）：
>   aria = 张望 / 伸懒腰 / 思考 / 捋头发 / 转脖子；ray = 张望 / 伸懒腰 / 耸肩 / 思考 / 甩手。
>   静息 5–11 秒后抽一个（加权、不连续重复），播完回静息。
> - **"就位"参与调度**：剪辑懒加载意味着"抽到的动作可能还没下载完"。调度器为此保留一个
>   `planned` 槽位 —— 回静息那一刻就选好下一个，场景用整个静息时长（5–11 秒）去预取；
>   到点若仍未就位就继续等，**而不是播一段空站立**。
> - **预取只在静息时做**：动作 FBX 自带整套骨骼+蒙皮，解析在主线程上（实测一条 581ms）。
>   放在动作播放中间做会看到人物卡住；静息时它只是在呼吸，这段停顿读不出来。
>   `clipParseMs` 观测点 + 超过 300ms 的 `console.warn` 是这条归因的现场证据：
>   每个人物会话里会出现几次（池子里的剪辑各解析一次），之后全部命中缓存。
> - **进场动画曾经从未被看到过**：老代码在 `petOn` 变化 300ms 后就请求进场，那时模型还没加载完，
>   请求被静默丢弃。现在进场由**场景在模型就位那一刻**自己排（`attachPet` 末尾 `queue('enter')`），
>   外部请求的动作一律排队等第一步剪辑就位后再开播。
> - **外部请求会兑现一个 Promise**（`playGesture` 在动作播完时 resolve），所以 App 的"退场播完再换人/
>   再收成球"是等真时长，不再写死 1600ms。场景已销毁时立即兑现 —— 展开态下 PetBall 已卸载，
>   但句柄还挂在 window 上，不处理就会让调用方永远干等。
> - 观感不可断言，**编排可以**：`gesture()` 观测点暴露当前/下一步/上一步/随机池，`pose()` 暴露体态，
>   `stride()` 暴露步幅速度。uitest 据此断言"动作池 ≥5""步幅来自剪辑""进场真的从场外走进来"
>   "退场真的走出窗口"。
>
**交互**：单击展开、拖动移动（抓取点跟随光标）、右键原生菜单（菜单模型由渲染层给出，
主进程只渲染并回传选中项 id）。收起态**滚轮**：上下切时限窗口、左右切供应商 ——
分轴累积 + 60px 门槛 + 250ms 冷却 + 150ms 断流清残量防触控板惯性连发（一次手势只跳 1 格），
手动切换后 8 秒内暂停 6 秒自动轮播；**自动轮播先在同一家里把时限窗口走完（5H → 周 → 月），
走完才换供应商**（单窗口供应商直接换人，不空转一步）—— 2026-09-28 改，此前它只换供应商、
且永远停在 `windows[0]`，用户看到的是「快速切供应商但从不切时限」。
切换时环心数字从 0 涨到目标值、平时刷新从旧值补到
（`hideBalance` 的 `••••` 与 `!`/`—`/`…` 不参与动画）。
**鼠标穿透**：渲染层量出 2D 小圆环的矩形（56×56 窗口里约 56×56，
渲染层把 `getBoundingClientRect` 持续上报给主进程），每 90ms 上报给主进程；主进程 90ms 光标轮询判定命中 →
`setIgnoreMouseEvents(ignore, { forward: true })`；**仅收起态运行轮询**，展开面板立即停止。

**指针状态机**（用户反馈"右键菜单后黏住光标乱动"）：

- 右键按下**不进入**按下状态（`e.button !== 0` 直接返回）；右键菜单弹出前后各 `resetPress()` 一次。
- `pointermove` 必须 `e.buttons & 1`（主键仍按着）才参与拖拽判定，否则视为指针状态失效并复位。
- window 级兜底：`pointerup` / `pointercancel` / `blur` 一律复位并结束主进程拖拽循环。
- 教训：原生菜单/系统弹窗会抢走事件序列，**"按下之后必然收到抬起"这个假设不成立**；
  合成测试事件也要带 `buttons`，否则真实事件的判定逻辑在测试里会失效。

**主进程健壮性**（用户反馈的"点击悬浮球弹错误框"）：

- 根因是拖拽定时器里的 `win.setPosition(nx, ny)` 收到了 `NaN`（`conversion failure`），
  而**定时器回调里抛异常会直接弹「Uncaught Exception」并终止应用**。
- 现在：渲染层传来的抓取点必须 `Number.isFinite` 才采用，光标坐标/目标坐标非有限值就跳过该帧，
  并且拖拽帧与光标轮询两处定时器整体 `try/catch`（异常只记一次日志，不终止进程）。
- 同类教训已写进测试：uitest 会断言「收起态无原生窗口阴影」「球外区域鼠标穿透」等行为。

> **助理管理曾在设置页「数字助理」分区**：选一位（缩略图）/ 改名 / 两个开关（个性人物、
> 定时播报含间隔）。面板只放 KPI。
> **养成体系已下线**（2026-09-21，用户要求「把宠物那套养成体系都去掉，现在定位是数字助理，不是宠物」）：
> `PetState` 只剩 `{id, name, createdAt}`；等级/经验/亲密度/饱食度/心情、撸一把/喂食、惰性衰减、
> 导出导入迁移（`pet:export`/`pet:import` 两个 IPC + 原生文件对话框）一并删除。
>
> 10-03 人物形态下线后，以上连同助理身份整体移除：`shared/pet.ts`（`PetId` / `PetState` /
> `decodePetState`）、设置页分区、右键菜单换一位/改名项全部删除。老用户磁盘上的
> `ui:petState` / `ui:pet` 残留不再被读取（`ui:pet === '1'` 由主进程 `primePrefs` 迁回 `'0'`）。

**持久化**：`ui:alwaysOnTop`（是否置顶）等界面偏好见 keystore `extras`；
`ui:pet` / `ui:petState` 为历史残留键（不再读写，`ui:pet === '1'` 启动时迁回 `'0'`）。

**自检工具**（见 README 脚本表）：`electron . --ballshot` 十几秒出图（只拍 2D 小圆环；
`BD_SKINS=1` 逐皮肤）；渲染层 `window.__bd_ball()` 暴露轮播索引（`idx` / `winIdx` /
`winCount`，纯数据 —— 返回值必须是可结构化克隆的，塞函数会让 `executeJavaScript`
结果回传失败）；`window.__bd_fluid_freeze()` 定住流体 morph 帧供 `--shots` 取帧。

**状态点语义**：灰=禁用 ｜ 琥珀=已启用但未配置 ｜ 绿=已启用且已配置。

## 9. 路线图

- **M1 核心可用** ✅：Electron 脚手架 + 悬浮卡片/托盘 + OpenCode Go 适配器（本地库）+ 4 家国内 API 余额（DeepSeek/Kimi/智谱/MiniMax）+ 凭据扫描与密钥链 + 默认毛玻璃皮肤。
- **M2 补全** ✅：Claude/Codex/Copilot 适配器、千问(BSS)/硅基流动/火山方舟、设置窗口、5 套皮肤、收起小圆点、供应商注册表（内置 + 自定义）、界面重设计。
- **M3 实验性**：国内订阅套餐（Cookie 方案）、皮肤市场目录、里程碑通知（如额度超 80% 弹提醒）。

## 10. 未决/需实现期验证事项

- 智谱、MiniMax 余额端点的最终 URL/参数（第 4.2 节标 ⚠️ 项）。
- 火山方舟、阿里云 BSS 的 AK 签名实现（各自独立适配器，不影响其他模块）。
- Windows 上 opencode 数据目录的实际探测路径（以 opencode 文档/实测为准）。
