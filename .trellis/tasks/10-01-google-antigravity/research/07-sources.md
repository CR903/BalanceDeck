# Research: 信息源清单（含许可）

- **Date**: 2026-10-01（检索日期；所有网络检索均在此日完成）

## 许可速查

| 仓库 / 包 | 许可 | 可否复用代码 |
|---|---|---|
| `robinebers/openusage` | **MIT** | ✅ 可（附声明） |
| `steipete/CodexBar` | **MIT** | ✅ 可（附声明） |
| `slkiser/opencode-quota` | **MIT** | ✅ 可（附声明） |
| `Ainsley0917/opencode-token-monitor` | **MIT** | ✅ 可（附声明） |
| `frieser/opencode-antigravity-quota` | **MIT** | ✅ 可（附声明） |
| `luisleineweber/usagebar-fork-archive` | MIT（fork 自 openusage） | ✅ 可（附声明） |
| `jackwener/open-antigravity` | ❓ 未验证 | ⚠ 只读思路 |
| `daviddallet/antigravity-tools-linux` | ❓ 未验证 | ⚠ 只读思路 |
| `can1357/oh-my-pi` | ❓ 未验证 | ⚠ 只读思路（issue #9940 是最好的坑位地图） |
| `NoeFabris/opencode-antigravity-auth` | ❓ 未验证 | ⚠ 只读思路 |
| `nesszer/Win-CodexBar` | ❓ 未验证 | ⚠ 只读思路 |
| npm `pi-antigravity` | ❓ 未验证 | ⚠ 只读思路 |
| crate `quotas` | ❓ 未验证 | ⚠ 只读思路（含唯一 live fixture） |
| `tddworks/ClaudeBar` | ❓ **未验证**（raw LICENSE 404） | ⚠ 只读思路 |
| **`aqua5230/usage`** | ⛔ **AGPL-3.0-only** | ⛔ **禁用**。协议形状是事实可读，代码不可抄 |

---

## 官方文档（Google）

| 文档 | URL | 取用内容 |
|---|---|---|
| Plans | https://antigravity.google/docs/plans | 额度三档（baseline/Pro/Ultra）、5h+weekly 刷新、只给形容词不给数字、AI credits 超额机制、明确「不支持 BYOK」 |
| Model Quotas (`/usage`) | https://antigravity.google/docs/cli/commands/usage/ | CLI 有 `/usage`（别名 `/quota`）主动刷新后端配额 |
| Status Line Customization | https://antigravity.google/docs/cli/statusline/ | ⭐ **唯一官方的配额数据形状**：`quota.{bucketId}.{remaining_fraction, reset_time, reset_in_seconds}`；实例 `"gemini-weekly"`；还有 `plan_tier`、`email` |
| Installation & Auth | https://www.antigravity.google/docs/cli/install/ | keyring 优先登录；`~/.gemini/antigravity-cli/settings.json`；`GEMINI_API_KEY` + `modelProvider:"gemini"` 模式 |
| CLI Settings | https://antigravity.google/docs/cli/settings/ | 配置目录确认；无凭据 |
| antigravity-cli#51 | https://github.com/google-antigravity/antigravity-cli/issues/51 | keychain item 存在但 `agy` 内部 1s 超时 |
| antigravity-cli#785 | https://github.com/google-antigravity/antigravity-cli/issues/785 | `retrieveUserQuotaSummary` 返回 403 `VALIDATION_REQUIRED` |
| 官方论坛 403 帖 | https://discuss.ai.google.dev/t/antigravity-terminated-due-to-error/185165 | `SUBSCRIPTION_REQUIRED` (#3501) 完整错误体 |
| 官方论坛 eligibility 帖 | https://discuss.ai.google.dev/t/google-ai-pro-via-jio.../185437 | 认证成功但 quota 403；日志显示 `SetProjectID: ""` |

⚠ **官方文档里没有 `retrieveUserQuotaSummary` / `loadCodeAssist` / `fetchAvailableModels` 的任何说明。** 端点全部来自逆向。

---

## 协议细节来源（第三方，按价值排序）

### ⭐ 1. `robinebers/openusage` — `docs/providers/antigravity.md`（MIT）
https://raw.githubusercontent.com/robinebers/openusage/main/docs/providers/antigravity.md

最有价值的一份：
- 2 池 × 2 窗口的**语义映射**（Session/Weekly = Gemini 池，Claude/Claude Weekly = 非 Gemini 池）
- 凭据来源策略（LS 优先 → Keychain 兜底）、**从不回写 Antigravity 自己的 keychain item**
- **project 缺失会假报 100%** 的警告
- 回退链：`RetrieveUserQuotaSummary` → `GetUserStatus`/`GetCommandModelConfigs`/`fetchAvailableModels`
- 排障条目：老版本无 weekly；`userTier` 优于 Windsurf 继承的 plan 字段

### ⭐ 2. `luisleineweber/usagebar-fork-archive` — `docs/providers/antigravity.md`（MIT fork）
https://raw.githubusercontent.com/luisleineweber/usagebar-fork-archive/main/docs/providers/antigravity.md

**最详细的协议笔记**，含：
- Connect RPC v1 端点全路径 `/exa.language_server_pb.LanguageServerService/*`
- 请求头（`x-codeium-csrf-token`、`Connect-Protocol-Version: 1`）
- **3 个 Cloud Code base URL 按序回退**
- `state.vscdb` 的三个 key 与 `OAuthTokenInfo` protobuf 结构
- 6 步 plugin strategy（若走本机路线可直接照抄结构）
- 401 = 登录过期；403 = 账号/地区/套餐权限

### ⭐ 3. `can1357/oh-my-pi` issue #9940
https://github.com/can1357/oh-my-pi/issues/9940

⭐ **最贴题的一手 issue**：完整贴出 `retrieveUserQuotaSummary` 的真实 JSON（2026-08），并列出从 `fetchAvailableModels` 迁移的两个 bug：
1. weekly 限额被短周期 bucket 吞掉/覆盖
2. 5h 窗口被误分类为 Daily（`durationMs: 86400000`）

⇒ 直接支撑「不做 fetchAvailableModels 回退」这个决策。

### 4. `quotas` crate — `antigravity.rs`（docs.rs）
https://docs.rs/quotas/latest/src/quotas/providers/antigravity.rs.html

**唯一的 live fixture 断言**（注明「Captured 2026-07-14」）：
- 形状：2 组 × (weekly + 5h) 的 fraction-only bucket
- 断言值：`gemini-weekly` frac 0.8187191 → limit 100 / remaining 82 / used 18 / period 7×86400
- `5h` frac 0.9798726 → used 2 / period 5×3600
- `window_type` 命名约定 `7d/gemini`、`5h/3p`

⇒ **这是唯一带日期的真实数值，可作 fixture 数值的参照**（许可未核 → 建议自己重造 fixture 文件，不复制）。

### 5. `aqua5230/usage` — `agy_quota_probe.py` ⛔ AGPL-3.0-only
https://github.com/aqua5230/usage/blob/refs/heads/main/agy_quota_probe.py

协议形状最全（三种 nesting、三种 fraction 字段名、Keychain/token 文件/Credential Manager 三平台回退、429 有界退避），但**代码不可抄**。
⚠ 它的 OAuth `client_id` / `client_secret` 字面量也是从这里来的 → 见 `06-open-questions.md` Q2。

### 6. `steipete/CodexBar` — `docs/antigravity.md`（MIT）
https://github.com/steipete/CodexBar/blob/v0.20/docs/antigravity.md
+ PR #693 / #727（TLS 挑战、`--extension_server_csrf_token` 与 `--csrf_token` 之分、端口三级排序）

⇒ 本机 LS 路线的完整代价清单。**本任务不走这条路，但这份文档是「为什么不走」的证据。**

### 7. `slkiser/opencode-quota` README（MIT）
https://github.com/slkiser/opencode-quota

唯一明确把 Antigravity 标为 **"Remote API"** 的同类项目（其余家标的都是本机 CLI/LS）。但其 provider 文档目录未能抓取（404）。

### 8. `tddworks/ClaudeBar`（许可未验证）
README / CLAUDE.md。错误文案 `"Antigravity probe failed: server not found" → Ensure Antigravity app is running locally` ⇒ 它走本机 LS。

### 9. npm `pi-antigravity@0.7.2` — `src/usage/usage.ts`（许可未验证）
https://cdn.jsdelivr.net/npm/pi-antigravity@0.7.2/src/usage/usage.ts
- **`currentTier` 对 Pro 账号也返回 `free-tier`；真实订阅在 `paidTier`** ⭐
- 免费档 403 `SUBSCRIPTION_REQUIRED (#3501)` 的注释
- `parseQuotaSummary` 的 bucket 跳过逻辑

### 10. `Tzamun-Arabia-IT-Co/auxly-memory-cli` — `internal/usage/google.go`（许可未验证）
反向观点，**值得注意的警告**：
> Antigravity does NOT drop a readable token of its own… 除非 Google oauth 存在，否则请求 403 SERVICE_DISABLED

⇒ 说明「拿 Gemini CLI 的 token 打 Antigravity 的 host」这条路**行不通**。我们必须读 Antigravity 自己的凭据。

### 11. `jackwener/open-antigravity` — `src/bridge/statedb.ts`
```ts
const STATE_DB_PATH = path.join(homedir(), 'Library/Application Support/Antigravity/User/globalStorage/state.vscdb')
// SELECT value FROM ItemTable WHERE key='antigravityAuthStatus'  →  JSON.parse(raw).apiKey
```

### 12. `ericxliu.me` — 反向工程笔记（2026-01-16）
https://ericxliu.me/posts/reverse-engineering-antigravity-ide/
`state.vscdb` 路径、base64 protobuf key 名、`jetskiStateSync.agentManagerInitState` 的 field #6

### 13. `IshekKhal/Antigravity-Database-Manager` / `JonDickson20/antigrav-recovery`
三平台 `state.vscdb` 路径对照表（新版 `Antigravity IDE` / 旧版 `Antigravity`）

---

## 本仓库基线文件（实读）

| 文件 | 读到的关键事实 |
|---|---|
| `src/main/adapters/types.ts` | `CollectRequest` 无 method/body（**阻塞点**）；`ProviderAdapter` 契约；`mark` 可选 |
| `src/main/adapters/engine.ts` | 三条纪律；`identityOf`；`officialSnap`/`localSnap`/`errSnap`/`noDataSnap`；`mark` 是实例派生 |
| `src/main/adapters/copilot.ts` | 最接近的 HTTP 参照：四分支降级、三 snapshot 上限、无 quota 时的占位窗口 |
| `src/main/adapters/claude.ts` | 本机文件 + `localSnap` + `extras` 限额覆盖（本任务**不适用**，无绝对限额） |
| `src/main/adapters/codex.ts` | 服务端 `percent` + 本机 token 兜底的双路径；`used:0, limit:缺省` 的窗口先例 |
| `src/main/adapters/protocols.ts` | 8 条声明（`N7` 断言锁死数量）；`probe` 只有 `{path}\|{url}` ⇒ **表达不了 Antigravity** |
| `src/main/adapters/index.ts` | `CODE_ADAPTERS` 7 条；分类注释「浏览器会话 / 本机文件」 |
| `src/main/adapters/plan-utils.ts` | 纯函数模块的先例（`claude`/`codex` 共用）⇒ `parseQuotaSummary` 应照此形态 |
| `src/shared/quality.ts` | `applyCachePolicy` 全部降级规则；`isPlan`；`isNetworkError` |
| `src/shared/types.ts` | `ProviderWindow` 字段语义；`ProviderStatus`；`DataQuality` |
| `src/main/providers.ts` | `BuiltinPreset` 形状；`localCredential` / `singleton` |
| `src/main/ipc.ts:54-68` | `items` vs `extras` 边界（tts 教训原文） |
| `src/main/ipc.ts:283` / `renderer/App.tsx:220` | `tts:getSecret` 已下线，渲染层不得拿明文 |
| `scripts/test-adapters.mjs` | 已用段 A–M/N/T/R/S/U；`makeRequest`/`callProject`/`check` 骨架；`stable()` 过滤 `undefined` |
| `.trellis/spec/guides/external-api-integration.md` | Step 1（端点确认）/ Step 2（fixture≠证据）/ Step 4（口径不符宁可不显示）/ Step 8（护栏要能红） |
| `.trellis/spec/adapters/index.md` | 层规则 2（测真源码）/ 3（未知形状要有出口）/ 5（端口径不一致宁可不显示） |
| `docs/adr/0001` | Considered Options：协议表表达不了「本机转录、sqlite、浏览器会话」 |

---

## 未能验证 / 抓取失败

| 目标 | 结果 |
|---|---|
| `slkiser/opencode-quota` 的 `docs/providers/*.md` | CRAWL_NOT_FOUND（README 链接的路径不存在） |
| `tddworks/ClaudeBar` 的 `LICENSE` | CRAWL_NOT_FOUND ⇒ **许可未验证** |
| GitHub code search API | 401（需认证） |
| 本机 Antigravity 任何数据 | **该机未安装 Antigravity**（`~/.gemini`、`Application Support/Antigravity*`、Keychain `gemini/antigravity` 全不存在） |
| `retrieveUserQuotaSummary` 的官方文档 | **不存在** |
| Google 对该端点的稳定性承诺 | **无** |