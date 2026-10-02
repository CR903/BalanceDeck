# Research: 汇总与推荐方案

- **Query**: 为「新增 Cursor 供应商适配器」的实现前协议调研结论
- **Scope**: mixed
- **Date**: 2026-10-01

> 详细论证见同目录其它 4 份：
> `01-cursor-quota-model.md`（额度模型 + 官方 API 有无）
> `02-endpoints-and-auth.md`（端点 / 鉴权 / 结构性风险 / 过期与自愈）
> `03-competitors-and-licenses.md`（竞品 + 许可）
> `04-repo-contract-mapping.md`（kind / mark / 凭据 / 降级 / 协议表 vs 代码适配器 / 测试落点）
> `05-gotchas-and-open-questions.md`（踩坑预判 + 待确认问题）

---

## 一句话结论

> Cursor 的额度**能出网取到服务端真值**（`api2.cursor.sh` 的 Connect RPC），但**鉴权材料只能从本机**
> （Cursor IDE 的 `state.vscdb` / CLI 的 `auth.json`）。这与 `copilot.ts` **完全同构**，
> **不违反「出网采集」模型**，应当声明 `dataQuality: 'official'`。
> 真正的坑不是「结构不兼容」，而是 **`*PercentUsed` 字段不可信**（官方承认它不等于 `spend/limit`，
> 且 2026-08 出过连续 3 天冻结的事故）—— **只用绝对值自算百分比**。

---

## 推荐方案（可直接开工）

| 决策点 | 结论 |
|---|---|
| 额度模型 | 月度订阅，两个池（Cursor Models / Other Models），量纲**美元（服务端单位：分）**，随 billing cycle 重置。历史 request-based 计划走另一条老端点 |
| 官方 API | **个人计划没有**（Admin/Analytics API 只对 Enterprise 团队、需 `admin:*` 团队 key） |
| 官方 CLI 额度子命令 | **没有**（`/usage` 只在 REPL 里显示活动统计） |
| **主端点** | `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`<br>头：`Authorization: Bearer` + `Content-Type: application/json`（**由接缝补**）+ `Connect-Protocol-Version: 1`（**适配器自己写**）；体 `{}`<br>⚠ 依赖 `10-01-seam-post-body`（设计已提交 commit `6c81361`，**代码尚未实现**） |
| 备选端点 | `GET https://cursor.com/api/usage-summary`（需从同一 JWT 合成的 `WorkosCursorSessionToken` cookie；含 `membershipType` / `isUnlimited`；`billingCycle*` 是 RFC3339 而非毫秒） |
| **凭据主源** | Cursor IDE `state.vscdb` → `ItemTable` / `cursorAuth/accessToken`<br>macOS `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| 凭据回落 | ① `ctx.getKey(inst.id)`（用户手动粘贴，存 `items` 加密）**优先级最低**<br>② `state.vscdb`（主）<br>③ CLI `auth.json` 的 `accessToken` |
| **不自愈** | **不实现 `oauth/token` 刷新、不做 `setKey` 回写、不把 token 缓存进 `items`**。刷新权在 Cursor 自己手里；缓存副本只会比它旧 |
| **percent** | 一律 `includedSpend / limit * 100` **自算**。**不信** `totalPercentUsed` / `autoPercentUsed` / `apiPercentUsed` |
| 不变量自检 | `includedSpend + remaining === limit`；不成立 → `errSnap`（schema drift），**绝不**返回 0 |
| `kind` | `'coding'` |
| `mark` / presetId / protocol | 全部 `'cursor'`；需在 `scripts/gen-provider-icons.mjs` 加 `cursor: { icon: 'simple-icons:cursor', color: '' }`（已实测 Iconify 200） |
| 形态 | **独立 `src/main/adapters/cursor.ts`（代码适配器）**，注册进 `CODE_ADAPTERS`。**不进 `protocols.ts`** |
| 预设条目 | 照抄 copilot 那条：`{ id:'cursor', kind:'coding', protocol:'cursor', defaultBaseUrl:'https://api2.cursor.sh', localCredential:true, singleton:true }` |
| 窗口 | 主窗口 `本月套餐`：`{ used: includedSpend/100, limit: limit/100, unit:'usd', percent: 自算, resetAt: billingCycleEnd→ISO, note:'官方接口' }`。`spendLimitUsage` 有非零 limit 时加「按需预算」窗口。**两个子池 v1 不展示**（见 Q4） |
| `plan` | 读同库 `cursorAuth/stripeMembershipType`，原样透传 + title-case；**不**为它多打一次请求 |
| `dataQuality` | 成功路径一律 `official`（`officialSnap`）。**本适配器永不出现 `local`** —— 本机没有任何可推算的口径 |
| 降级 | 见 `04` §4 的九场景表；`degradedReason` 由 `scheduler.ts:87` 的 `applyCachePolicy` 统一写，适配器只管把话写进 `detail` |
| 测试段 | `scripts/test-adapters.mjs` **追加** `V` 段（现有段 A–L/M/N/T/R/S/U，空闲 O P Q V W X Y Z）。建议四家分别用 O/P/Q/V |
| 测试注入缝 | 需新增 `process.env.CURSOR_STATE_DB` 之类的路径覆写（`copilot.ts:51` 的 `XDG_CONFIG_HOME` 是先例），否则本机文件读不到、端到端 fixture 跑不起来 |

---

## 信息源清单（含许可）

### 仓库内（一手）

| 来源 | 提供了什么 |
|---|---|
| `.trellis/tasks/10-01-seam-post-body/{prd,design,implement}.md`（commit `6c81361`，2026-10-01） | **接缝扩 `method`/`body` 的定案**：`method?: 'GET'\|'POST'` 字面量联合、`body?: string`（已序列化）、「有 body 无 Content-Type」自动补 JSON 头、测试桩加 rich 记录而不改 `callProject`、门禁「18 套件断言数不变」 |
| `.trellis/tasks/10-01-p1-remaining/prd.md` | 父任务的并行冲突面、许可边界、验收标准 |

### 官方（一手）

| 来源 | 用途 | 检索日期 |
|---|---|---|
| <https://cursor.com/docs/models-and-pricing> | 计划价格、两个用量池、Cursor Token Rate | 2026-10-01 |
| <https://cursor.com/help/models-and-usage/usage-limits> | 「怎么查用量」（Spending 页）、重置规则、超额行为 | 2026-10-01 |
| <https://cursor.com/docs/api> | **证明个人计划没有官方用量 API**（Admin/Analytics 仅 Enterprise）+ 限流表 | 2026-10-01 |
| <https://cursor.com/docs/cli/reference/parameters> | CLI 子命令全集（**无 usage**） | 2026-10-01 |
| <https://cursor.com/docs/cli/reference/authentication> | `agent login` / `agent status` / `CURSOR_API_KEY` | 2026-10-01 |
| <https://cursor.com/docs/cli/reference/configuration> | `~/.cursor/cli-config.json`、`CURSOR_CONFIG_DIR`、`XDG_CONFIG_HOME` | 2026-10-01 |
| <https://forum.cursor.com/t/bug-report-...-totalpercentused.../168210> | **percent 字段语义澄清 + 3 天冻结事故的官方承认 + 真实响应样本** | 2026-10-01 |

### 第三方（参考思路；许可见括号）

| 来源 | 提供了什么 | 许可（GitHub API，2026-10-01） |
|---|---|---|
| [steipete/CodexBar](https://github.com/steipete/CodexBar) `docs/cursor.md` | 最完整的 Cursor 端点/凭据/降级阶梯文档 | **MIT**（22,092★） |
| [cbnsndwch/pacebar](https://github.com/cbnsndwch/pacebar) `docs/providers/cursor` | **唯一有正式 provider 文档的**：全部 Connect 端点、必需头、分/毫秒量纲、token 刷新流程 | **MIT**（4★） |
| [akitaonrails/ai-usagebar](https://github.com/akitaonrails/ai-usagebar) `cursor/{types,db}.rs` | live Ultra 响应样本、「schema drift 绝不渲染成 0」、团队账号兜底规则 | **MIT**（603★） |
| [Mai0313/VibeCodingTracker](https://github.com/Mai0313/VibeCodingTracker) `quota/cursor.rs` | 从 JWT `sub` 合成 WorkOS cookie 的最小实现、reactive 过期判定 | **MIT**（14★） |
| [wakamex/cursor-cli-usage](https://github.com/wakamex/cursor-cli-usage) | 端点 URL + 请求头 + 响应字段的完整 Python 实现 | **NONE（无 LICENSE → 不可复用代码）** |
| [Dicklesworthstone/coding_agent_account_manager](https://github.com/Dicklesworthstone/coding_agent_account_manager) PR #107 | 加固清单：拒绝非有限/矛盾数值、pin 主机、拒带凭据重定向、body 上限 | **NOASSERTION** |
| [Rahularya01/pi-cursor](https://github.com/Rahularya01/pi-cursor) | 四级凭据级联、`tokenSource` 诊断 | **MIT**（29★） |
| [Tendo33/cursor-usage-tracker](https://github.com/Tendo33/cursor-usage-tracker) | 跨平台 `state.vscdb` 路径表 | **MIT**（4★） |
| [tddworks/ClaudeBar](https://github.com/tddworks/ClaudeBar) | 竞品对照 | **NONE（不可复用）** |
| [slkiser/opencode-quota](https://github.com/slkiser/opencode-quota) | 父任务报告称支持 Cursor（本次未核实细节） | **MIT**（985★） |

### 本机实测（2026-10-01）

```
POST api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage  → 401  ERROR_NOT_LOGGED_IN
GET  cursor.com/api/usage-summary                                        → 401  not_authenticated
GET  api.iconify.design/simple-icons/cursor.svg                          → 200
node v22.23.2: node:sqlite 可用
本机无 Cursor：~/.cursor / ~/Library/Application Support/Cursor 均不存在；cursor-agent 不在 PATH
```

### 本仓库基线（已读）

`src/main/adapters/{types,engine,claude,codex,copilot,minimax,protocols,protocol-adapter,protocol-adapter,bind-instance,collect,index}.ts`、
`src/shared/{types,quality,percent,levels}.ts`、`src/main/{providers,scanner,keystore,store,ipc,request,scheduler,net,usageStore}.ts`、
`src/renderer/src/{provider-icons,ProviderMark,SettingsView,smartBroadcast,format}.tsx|ts`、
`scripts/{test-adapters.mjs,test-structure.mjs,gen-provider-icons.mjs,lib/load-ts.mjs}`、
`.trellis/spec/{adapters/index.md,guides/external-api-integration.md}`、`docs/adr/0001-0003`

---

## 需要用户确认的问题（摘要）

🔴 **阻塞**
1. ~~允许给 `CollectRequest` 加 `method` / `body` 吗？~~ → **✅ 已由 `10-01-seam-post-body` 定案**
   （`method?: 'GET'|'POST'` + `body?: string`；有 body 且无 Content-Type 时接缝自动补 `application/json`；
   设计 commit `6c81361`，2026-10-01）。
   **残留**：该接缝**代码尚未实现**，Cursor 开工前需确认已合入；
   即便合入也**仍不能走声明表**（`protocol-adapter.ts:68-72` 的工厂写死 GET + 两个固定头）。
2. **测试段字母**：我建议 **V**；另外三家请分别用 O / P / Q。
3. **手动粘贴 token 的优先级**：我建议**最低**（本机文件优先），否则「Cursor 明明登录了却说未配置」。

🟡 **拍板**
4. 两个子池要不要展示？**建议 v1 不展示**（无绝对值可自校验 + 字段语义有争议 + 出过事故）。
5. 团队/企业账号？**建议明确 `errSnap`**，不从人话 `*DisplayMessage` 里正则百分比。
6. 要不要为套餐名多打一次 `GetPlanInfo`？**建议不要**（读同库 `stripeMembershipType` 即可）。

🟢 **可延后**
7. `state.vscdb` 只读失败的回落顺序（建议：直接回落 `auth.json`，两个路径都写进 detail）。
8. 要不要在 PRD/README 显式声明「Cursor 用的是未文档化接口，可能随时失效」？**建议写。**
9. `test-structure.mjs` 的「文件头必须声明来源与许可」静态断言**目前并不存在**（父任务 prd 与实际不符）——
   本任务只在自己文件头声明（照 `opencode-cookie.ts:22-23` 先例），守门断言请主 agent 统一安排。

---

## Caveats

- 端点响应字段**全部来自第三方记录**（本机无 Cursor 账号可抓）。`GetCurrentPeriodUsage` 有两个独立来源互证
  （PaceBar 文档 + Cursor 官方论坛贴文），可信度较高，但 fixture 里必须**逐字标注来源与检索日期**，
  不得标成「实测」（`external-api-integration.md` Step 2）。
- `*PercentUsed` 的语义在四份材料里互相矛盾（见 `02` §4）—— 本方案的「只用绝对值」是对这四处矛盾
  **最保守**的处理，不是「已证明 percent 字段无效」。
- 未验证项的完整清单见 `05` §7。