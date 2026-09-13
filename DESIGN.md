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
│  CollapsedDot 收起态轮播圆点                    │
│  SkinEngine   皮肤包加载（CSS 变量 + 令牌覆盖）    │
└───────────────────────────────────────────────┘
```

- 悬浮窗：`BrowserWindow{ frame:false, transparent:true, alwaysOnTop:true, skipTaskbar:true, resizable:false }`，拖动区用 `-webkit-app-region: drag`。
- 收起态：折叠为 56×56 小圆点（显示轮播指标），点击展开。
- 托盘：macOS 用 template 模板图标（**随主供应商切换 logo**），标题平铺展示该供应商的全部时限窗口（`5H 5% W 52.9% M 68.5%`）；Windows 托盘 hover tooltip 显示汇总。

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
- 图标：内置供应商与自定义协议都有 logo（`scripts/gen-provider-icons.mjs` 构建期从 Iconify 内联，运行时零网络）；同一份单色 SVG 既作 UI 的 CSS mask（随品牌色/主题着色），又栅格化成 macOS 托盘 template 图。
- 开机自启：默认关，设置页开关（`app.setLoginItemSettings`）。
- 更新：v1 不做自动更新。
- 隐私：一切数据本地计算与存储，仅余额 API 请求出网；无遥测。

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
- **可信度可见**：卡片脚注出现「缓存 / 本机」徽章 + 相对时间，数字降调；离线时标题栏状态行变琥珀色并说明「离线 · N 项为缓存数据」。
- **刷新反馈**：刷新中图标旋转、主按钮变「刷新中…」。

**设计语言（Apple-like）**：克制的层次（发丝边框 + 极轻阴影）、克制的色彩（语义色仅用于状态）、克制的动效（200ms `cubic-bezier(0.32,0.72,0,1)`，只动 transform/opacity，尊重 `prefers-reduced-motion`）、系统字体栈、8px 间距节奏、12–18px 圆角。

**圆角与外框**：
- 窗口**全平台透明**（`transparent: true` + `backgroundColor: '#00000000'`），磨砂由 CSS `backdrop-filter: blur(30px) saturate(180%)` 完成 —— 形状即圆角矩形/圆形，四角之外完全透明。
- 不使用 macOS 原生 `vibrancy`：原生磨砂铺满窗口矩形，会在 CSS 圆角/圆形之外的区域露出磨砂底与一条发丝边（"透明角 + 白线"）。
- 窗口阴影用 `hasShadow: true`（macOS 跟随内容 alpha 形状，即圆角/圆形本身）。
- 自检：`python3 scripts/png-alpha.py <shot.png>` 可查四角 RGBA 的 alpha 是否为 0。

**收起态圆点（56×56）**：环形仪表 + 环心数值。
- 单一 KPI 对目标值 → 环形 gauge（chart 指南）；数字置于环心（小尺寸下最易读）。
- 显示**最接近限额的窗口**（数值与环形颜色同源，避免"数值是 5h、颜色是月度"的错位）。
- 多实例时按**严重度排序**后每 5 秒轮播（最需要关注的先出现），底部 3px 圆点指示位置。
- 缓存/本机估算时右上角出现小时钟角标，环形与数字降调。
- 余额类实例的金额用紧凑写法（`¥500.67`）保证可读。

**状态点语义**：灰=禁用 ｜ 琥珀=已启用但未配置 ｜ 绿=已启用且已配置。

## 9. 路线图

- **M1 核心可用** ✅：Electron 脚手架 + 悬浮卡片/托盘 + OpenCode Go 适配器（本地库）+ 4 家国内 API 余额（DeepSeek/Kimi/智谱/MiniMax）+ 凭据扫描与密钥链 + 默认毛玻璃皮肤。
- **M2 补全** ✅：Claude/Codex/Copilot 适配器、千问(BSS)/硅基流动/火山方舟、设置窗口、5 套皮肤、收起小圆点、供应商注册表（内置 + 自定义）、界面重设计。
- **M3 实验性**：国内订阅套餐（Cookie 方案）、皮肤市场目录、里程碑通知（如额度超 80% 弹提醒）。

## 10. 未决/需实现期验证事项

- 智谱、MiniMax 余额端点的最终 URL/参数（第 4.2 节标 ⚠️ 项）。
- 火山方舟、阿里云 BSS 的 AK 签名实现（各自独立适配器，不影响其他模块）。
- Windows 上 opencode 数据目录的实际探测路径（以 opencode 文档/实测为准）。
