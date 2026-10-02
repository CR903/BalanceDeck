# Research 06 · 踩坑预判与优雅降级

- **Query**: 限流 / 特定 header / 未公开端点改版频率有多高？失效时如何优雅降级？
- **Scope**: internal + external
- **检索日期**: 2026-10-01

---

## 1. 轮询压力：本仓库默认 60s，远高于第三方工具

`src/main/scheduler.ts:29-31`：

```ts
export const DEFAULT_INTERVAL = 60_000    // 默认 60 秒
export const MIN_INTERVAL     = 10_000    // 用户最小可设 10 秒
export const MAX_INTERVAL     = 300_000   // 最大 5 分钟
```

`src/main/scheduler.ts:117-127`：

> 「**按间隔记，不按采集记**（`SNAPSHOT_INTERVAL_MS` = 15 分钟）。采集默认 60s…」

→ **采集（= 真正的 HTTP 请求）跑在 60s**；15 分钟的节流只管快照落盘。

用户若把间隔调到 `MIN_INTERVAL` = 10s，就是**每 10 秒打一次
`chatgpt.com/backend-api/wham/usage`**。

### 对照：竞品怎么做

| 竞品 | 策略 |
|---|---|
| CodexBar | 「Configurable cost-usage scans … background timer with a 15-minute minimum (30 in Low Power Mode)」。另有专门的 **Adaptive refresh** 与后台刷新 **coalescing**（把多次请求合并成一次），`codexbar serve` 供外部组件共用同一份数据 |
| 社区 Raspberry Pi 实践 | 轮询 `wham/usage`，但用 ESP32 间接驱动（避免高频直连） |

### 429 是有先例的

- `GET /backend-api/wham/rate-limit-reset-credits` → **429 Too Many Requests**，
  **同时影响 ChatGPT 桌面 app 与网页**（Pro 订阅）
  https://github.com/openai/codex/issues/37934
  → 说明 `chatgpt.com/backend-api/*` 这一族**有服务端限流**，且限流命中时
  **连官方客户端都一起受影响**。我们若在后台高频轮询，
  可能被判定为异常并**影响用户正常使用 ChatGPT**。

### 结论（供实现参考）

| 建议 | 理由 |
|---|---|
| **不要为它单独做限速器**，但**必须遵守现有 60s 默认值**，不为它破例 | 改动最小，且 60s 对一个只读额度端点是合理的 |
| **不要引入 `MIN_INTERVAL` 之外的更短默认值** | 10s × 多实例 = 风险 |
| **401/403/429 一律不自动重试** | `.trellis/spec/guides/external-api-integration.md` Step 7：「don't retry 401/403 — those are session problems」 |
| 429 的文案要**区分于** 401 | 用户动作不同：429 等一等，401 去登录 |
| 如果未来要加 `reset-credits` / `monthly-usage` 端点，**串行 + 失败即跳过**，不要 `Promise.all` | 同 host 并发会被丢（`guides` Step 7 实测教训） |

---

## 2. 未公开端点的改版频率 —— 有直接同域证据

本仓库自己刚付过一次学费：`opencode.ai` 控制台从 SSR 重写成纯客户端 SPA，
一次性打死了**两条**路径（`opencode-console-api.ts:5-22`）：

```
旧的 GET /workspace/<wrk>/go → 302 /console/login，页面只剩 1565 字符空壳、0 个 data-slot
靠解析 SSR HTML 的 opencode-cookie.ts  ← 失效
靠驱动窗口点「显示详情」的 opencode-details.ts ← 失效
数据 API 反倒在公开 bundle 里声明并标了 stable
```

→ **推论**：`chatgpt.com/backend-api/*` 同为「SPA 背后的数据端点」，
同类改版风险**客观存在**。区别是 opencode 那次改的是「页面渲染方式」，
`wham/usage` 是「数据端点」，被改的概率略低但不为零。

已有旁证：CodexBar 的 `wham/usage` 解析逻辑因为**字段位置变更**
（`individual_limit` 从根级移到 `spend_control`）而打了两个补丁
（PR #2737、issue #2900）—— 字段层面的漂移**已经在发生**。

### 「失效时如何优雅降级」的具体形态

按本仓库既有纪律，失效要**可见**而不是静默：

| 失效形态 | 检测点 | 表现 |
|---|---|---|
| 端点 404 / 410 | HTTP 状态 | `status:'error'`，文案「该端点为未公开接口，可能已变更」 |
| 路径改名 | 404 | 同上。**不要**自动去猜新路径 |
| Cloudflare 拦截 | `JSON.parse` 失败 | 文案「响应不是 JSON（可能被 Cloudflare 拦截或端点已变更）」 |
| 字段改名 | 解析不出任何窗口 | 文案带**未知字段名列表**（`unknownMeters` 模式） |
| 字段位置移动（如 issue #2900） | 已知字段解析出 `null` | 记日志 + `note` 说明，不要把 `null` 当 0 |
| 429 | HTTP 429 | 「请求过于频繁，请稍后再试」，不重试 |

**必须做的两件事**（对齐 `opencode-cookie.ts:106-111`）：

1. **解析器返回未知字段名列表**，上层记日志。
   没有它，一次部分改名会悄悄少一个窗口而界面看不出异常。
2. **自愈成功后仍要报改版信号**（`opencode.ts:737-741` 的注释记录了 2026-09-26
   评审发现的这个 bug）。

---

## 3. 特定 header 要求

| Header | 必要性 | 来源 / 状态 |
|---|---|---|
| `Authorization: Bearer <access_token>` | **必需** | CodexBar `docs/codex.md` + gist + 多个第三方实现一致 |
| `ChatGPT-Account-Id: <account_id>` | **强烈建议必带** | gist、Simon Willison、langchain `ChatOpenAICodex`、pi `pi-codex-token` 全部带。CodexBar 文档未提，但多 workspace 账号必需 |
| `Accept: application/json` | 建议 | 本仓库 `protocol-adapter.ts:71` 统一带 |
| `User-Agent` | **未验证** | CodexBar 用原生 URLSession/浏览器，无自定义 UA |
| `Origin` / `Referer` | **未验证** | 第三方实现均未提及 |
| `Cookie` | **不需要**（主路径） | 这是本任务最重要的结论 |

⚠ **`ChatGPT-Account-Id` 大小写不一致**： gist 与 Simon Willison 用
`ChatGPT-Account-ID`（大写 D），pi 用 `chatgpt-account-id`。HTTP 头名大小写不敏感，
但**值必须精确等于 `tokens.account_id`**。

---

## 4. 多实例 / 多账号

- `auth.json` 是**单账号**的（一个文件一套 token）。
- 多账号需要多套 `CODEX_HOME`。
  CodexBar 的解法：`codexProfileHomePaths` 配置多个 Codex home（`docs/codex.md`）。
- 本仓库已有 `ProviderInstance` 多实例机制（`shared/types.ts:130-147`，
  `providers.ts:54-150` 每个预设可重复添加，各自独立凭据）。
- 但 **`CODEX_HOME` 是进程级环境变量**，不是实例级 → 多 Codex home 在本仓库里
  **当前无法无歧义支持**。这是已知限制（见 `07-open-questions.md` Q3）。

---

## 5. 本机文件读取的安全性

| 风险 | 现状 |
|---|---|
| 读 `~/.codex/auth.json` 算不算「读用户凭据」 | 是。CodexBar 把「读别的应用的 OAuth 文件」做成**默认关闭**的开关并明写 "This cross-application credential access defaults off" |
| 打包后的 macOS 应用能否读 `~/.codex` | ✅ 能（同用户 home 目录）。若 App Sandbox 开启则**读不到** —— 本仓库其它适配器（`codex.ts` / `claude.ts` / `copilot.ts`）已经在读 `~/.codex`、`~/.claude`、`~/.config`，说明打包配置**没有**阻断此路径 |
| 日志泄漏 | `opencode-cookie.ts:249`「任何失败都抛 Error（消息不含 cookie）」。`opencode.ts` 有 `debugLog`。新适配器必须遵守 |
| 测试读真实 `~/.codex` | ⚠ **必须用 `CODEX_HOME` 环境变量重定向到临时目录**（`codex.ts:41-43` 已支持）。测试绝不能碰用户真实凭据文件（`store.ts:13`） |

---

## 6. 风险登记（按严重度）

| # | 风险 | 严重度 | 缓解 |
|---|---|---|---|
| R1 | `wham/usage` 未公开、无 SLA、改版即失效 | **高** | 降级可见（04 §4.2）；解析器报未知字段；不要在文档里承诺稳定 |
| R2 | 高频轮询触发 429，**可能影响用户正常使用 ChatGPT** | **高** | 守住 60s 默认值；不重试 429；文案区分 |
| R3 | access_token 过期 → 用户必须跑 `codex login`（我们不能代劳） | 中 | 401 文案明确给出可操作命令；`nodata` 文案预先说明安装/登录步骤 |
| R4 | 与既有 `codex` 卡片**显示同一份额度**（口径重复） | 中 | 见 `07-open-questions.md` Q1 |
| R5 | `auth.json` 结构变化 | 低 | 只读 `tokens.access_token` / `tokens.account_id` 两个字段；结构不对 → `nodata` 而不是崩溃 |
| R6 | 与其它三家子任务在同一共享文件（`index.ts` / `test-adapters.mjs` / `gen-provider-icons.mjs`）上冲突 | 中 | 串行合并或一次合并提交 |
| R7 | `openai-billing` 端点可能已废弃（`01-current-state-openai-billing.md` §3） | 中 | 本任务不修；发现后单独上报 |
| R8 | 误把「读 auth.json」包装成「登录」诱导用户交出密码 | 低 | UI 文案只说「读取 Codex CLI 的登录凭据」，**绝不**要求输入密码 |

---

## 相关文件

| 路径 | 行 | 作用 |
|---|---|---|
| `src/main/scheduler.ts` | 29-31, 117-127 | 刷新间隔 / 快照节流 |
| `src/main/adapters/opencode-console-api.ts` | 5-22, 92-107 | 改版事故的完整记录 |
| `src/main/adapters/opencode-cookie.ts` | 106-111, 249, 296-306 | 改版信号 / 不含凭据的错误 / 分档错误 |
| `src/main/adapters/opencode.ts` | 737-741 | 自愈后仍要报改版信号 |
| `.trellis/spec/guides/external-api-integration.md` | Step 1, 3, 7 | 观测真实产品 / 逐字段映射 / 同 host 串行 |
| `.trellis/spec/adapters/index.md` | 23-36 | 层内六条规则（尤其第 3 条「未知形状要有出口」） |