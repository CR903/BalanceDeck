# Research: 踩坑预判 + 需要用户确认的问题

- **Query**: 限流 / 特定 header / 响应改版历史？还有什么必须先问清楚？
- **Scope**: mixed
- **Date**: 2026-10-01

---

## 1. 响应改版历史（**这一段是本任务最大的风险来源**）

Cursor 的用量接口**至少换过一次形态**，而且换的时候**没发公告**：

| 时期 | 形态 | 证据 |
|---|---|---|
| ~2025 及以前 | **request-based**（按次）：`GET cursor.com/api/usage?user=ID` → 请求数 + 限额 | CodexBar 称之为 legacy 端点；CAAM 称之为 Enterprise flow |
| 现在（usage-based） | **dollar-based**：`POST api2.cursor.sh/…/GetCurrentPeriodUsage`（分） | PaceBar / cursor-cli-usage / CAAM |
| 未来 | 未知 | — |

⇒ **适配器必须能对「认不出的形状」明确报错，绝不能返回 0。**
`external-api-integration.md` Step 3 的表格就是为这种情况写的：
「Field has no source in the new API → **delete it**, don't zero it（`quota: 0` renders as `$0 / 0%` — a lie）」

**已发生过的一次真实事故（官方承认）** —— 2026-08-12~14：
`totalPercentUsed` / `autoPercentUsed` / `apiPercentUsed` 在 web dashboard 与 IDE 里**连续 3 天冻结不动**
（用户实际已用 64.4%，字段却显示 3.73%）。Cursor 官方员工回复：
> "the percent fields are not calculated as a simple `totalSpend / limit`. They reflect a different internal metric…
>  The fact that the values haven't changed for a few days despite active usage is a real issue we're tracking.
>  It affects what you see in the dashboard and in the IDE… usage is recorded correctly and it won't affect billing."

⇒ **这条事故正是「不要用 percent 字段」的最强论据**（详见 `02-endpoints-and-auth.md` §4）。
⇒ 同时说明：**官方端点会静默返回语义漂移的数据**，所以「认不出 / 自相矛盾 → 报错」这条纪律比平时更重要。

### 已知的其它形态分歧

| 分歧 | 说明 |
|---|---|
| `billingCycleStart/End` 单位 | `api2.cursor.sh` = **unix 毫秒字符串**（`"1771077734000"`）；`cursor.com/api/usage-summary` = **RFC3339**（`"2026-08-04T00:35:51.000Z"`） |
| `planUsage` vs `individualUsage.plan` | Connect 端点叫 `planUsage`；cookie 端点嵌在 `individualUsage.plan` |
| 套餐名在哪 | Connect 端点**没有** `membershipType`；cookie 端点有；`GetPlanInfo` 有；`state.vscdb` 的 `cursorAuth/stripeMembershipType` 也有 |
| 团队账号 | `individualUsage.plan` **整个不存在**；百分比只能从两条 `*DisplayMessage` 文本里正则（ai-usagebar 要求**两条都解析成功**才认，否则判 schema drift） |
| 免费/无限量 | `isUnlimited: true` 时百分比无意义（ai-usagebar 归一成 0 + unlimited 标记） |

---

## 2. 特定 header / 请求形状

| header / 形状 | 必需？ | 来源 |
|---|---|---|
| `Authorization: Bearer <jwt>` | ✅ | 全部来源一致 |
| `Content-Type: application/json` | ✅ | PaceBar 列为 required |
| `Connect-Protocol-Version: 1` | ✅ | PaceBar 列为 required；cursor-cli-usage 也在发 |
| 请求体 `{}` | ✅ | Connect RPC 的空 message |
| `Origin: https://cursor.com` | 仅 `cursor.com/api/dashboard/*` 的 **POST** 需要（CSRF）；`api2.cursor.sh` 与 `GET /api/usage-summary` **未验证** | CodexBar |
| User-Agent 伪装 `cursor-agent/<version>` | **未验证是否必需**。VibeCodingTracker 明确「impersonating the Cursor CLI」，CodexBar 也这么做 | 两家实现 |
| `X-Cursor-Client-Version` | 只见于 `agent.v1` 的 **流式推理**路径（pi-cursor 的 `x-cursor-client-version`），**用量端点未见需要** | pi-cursor README |

**建议**：先按 PaceBar 的最小集发（Authorization + Content-Type + Connect-Protocol-Version），
把 User-Agent 设成能识别自己的字符串。**若返回 403/401 再考虑伪装** —— 伪装 UA 是最后手段，
且应在代码注释里写清为什么。

---

## 3. 限流

- **`api2.cursor.sh` 的用量端点没有公开配额**（官方只公布 `api.cursor.com` 的 Admin/Analytics 表：
  默认 20 req/min，`/teams/user-spend-limit` 250，`analytics/team/*` 100）。**未验证。**
- 邻近证据：Admin API 的 `/teams/daily-usage-data` 曾出现「几乎立刻 429」（Cursor 官方论坛 2025-10 的
  "Admin API Throttled?" 帖）—— 说明 Cursor 的限流tripwire 可能相当敏感。
- 本仓库默认刷新 **60s**（`scheduler.ts:29` `DEFAULT_INTERVAL = 60_000`，用户可调到 10s~300s）。
  10s 档 = 6 req/min，60s 档 = 1 req/min。**单实例单请求，量级远低于任何合理限流。**
- CodexBar 对 `get-filtered-usage-events` 的 403 冷却是 **6 小时**（in-memory）。
  ⇒ 建议：Cursor 适配器**不做本地冷却**（我们不打那个端点），
  但**必须把 429/403 映射成可诊断文案**，否则用户会看到「HTTP 403」这种死胡同。

---

## 4. 本机文件层面的坑

| 坑 | 说明 | 处置建议 |
|---|---|---|
| **SQLite WAL 副作用文件** | `state.vscdb` 在 WAL 模式；活跃时有 `state.vscdb-wal` / `-shm`。CodexBar 的注释：<br>「Active WAL state is read normally; an idle WAL-mode main file with no sidecars uses SQLite **immutable** mode so CodexBar does not recreate files in Cursor's directory」 | `node:sqlite` 的 `readOnly: true` **没有** `immutable` 选项（实测 `DatabaseSync` 只有 open/close/prepare/…）。<br>① 先用 `readOnly: true` 试；<br>② 失败（`SQLITE_CANTOPEN` / "attempt to write a readonly database"）→ **回落到 `auth.json`**，别去动 Cursor 的文件 |
| **state.vscdb 可能极大** | 有插件报告它涨到数 GB（装了 Cursor DB Client 的机器） | 只读一条 `SELECT` 应该无碍；但**别 `SELECT *`**，也别 `prepare` 后 `.all()` 整表 |
| **token 可能是 UTF-16LE BLOB** | CodexBar：「BLOB decoding recognizes BOM-less ASCII UTF-16LE tokens before UTF-8, which would otherwise keep interleaved NUL bytes」 | 解码时**先去 NUL 字节**再判空 |
| **CLI `auth.json` 路径三方分歧** | CAAM 说 macOS `~/.cursor/auth.json`；ai-usagebar 用 `config_dir()/cursor/auth.json`；官方文档只写了 `cli-config.json` | **多候选试探** + 认 `CURSOR_CONFIG_DIR` / `XDG_CONFIG_HOME` 环境变量 |
| **不要 `import { execSync }` 调 `sqlite3` CLI** | 依赖系统装了 sqlite3 | 用 `node:sqlite`（`opencode.ts:122` 已有先例；本机 node v22.23.2 实测可用） |
| **别写 Cursor 的文件** | CodexBar / cursor-cli-usage 都明确「never refreshes, rotates, or modifies Cursor-owned credentials」 | 只读打开；不实现 `oauth/token` 刷新；不做 `setKey` 回写 |

---

## 5. 其它预判

- **Electron 里的 `node:sqlite`**：`opencode.ts:122` 已在生产用（动态 `import('node:sqlite')`），
  说明 Electron 37 的 Node 版本可用。Cursor 可以照抄这个写法。
  ⚠ 但 Electron 打包后 `node:sqlite` 走的是 Electron 内置 Node —— 与本机 node 22 的行为可能不同。
  **建议实现时在 Electron 里实测一次**（`external-api-integration.md` Step 9 就是这个意思）。
- **刷新节奏 vs 服务端滞后**：CursorMeter 的实测是「Cursor 用起来后 ~1 分钟内服务端才反映」，
  且「服务端 usage 反映有数秒+ 延迟是地板」。→ 10s 刷新档位对 Cursor **没有额外价值**，
  但不必为此特殊处理（UI 层本来就有 15 分钟的历史采样，`usageStore.ts:33`）。
- **`planName` 与 `membershipType` 的值域**：`free` / `pro` / `proPlus`? / `ultra` / `team` / `enterprise`?
  —— **`未验证`**（只见到 `free`/`pro`/`ultra`/`team`/`enterprise`）。**不要**写 switch 白名单，
  直接原样透传 + title-case（ai-usagebar 的 `title_case` 就是这么做的，且空值回落 `"Cursor"`）。
- **`Node 22` 的 `node:sqlite` 会打 ExperimentalWarning 到 stderr** —— 与 `test-adapters.mjs` 的
  输出混在一起。加 fixture 时注意别把警告当失败。

---

## 6. 需要用户确认的问题

> 按「阻塞实现 / 需要拍板 / 可延后」排序。每条给出我的建议默认值，确认后即可直接开工。

### 🔴 阻塞（不确认会做错方向）

**Q1. ~~契约边界：`CollectRequest` 允许不允许加 `method` / `body`？~~ → ✅ 已由另一个任务定案**

`10-01-seam-post-body`（`prd.md` / `design.md` / `implement.md`，commit `6c81361`，2026-10-01）已把这条作为
**共享接缝的独立前置**交付设计：
- `CollectRequest` 加 `method?: 'GET' | 'POST'`（字面量联合）+ `body?: string`（**已序列化**）
- 「有 body 且调用方未自带 `Content-Type`」时接缝自动补 `application/json`
- 测试桩**新增** rich 记录函数（记 `method`/`body`），**不改**既有 `callProject`
- 门禁：既有 18 个套件的断言数与改动前**完全一致**（纯增量证明）

⇒ Cursor 走推荐端点时只需：`ctx.request({ url, method: 'POST', body: '{}', headers: { Authorization, 'Connect-Protocol-Version': '1' } })`。
⇒ **但仍不能走 `protocols.ts` 声明表** —— `protocol-adapter.ts:68-72` 的工厂写死 GET + 两个固定头，无 body 扩展点。
⚠ **该接缝代码尚未实现**（工作区 `types.ts` / `request.ts` 仍是旧形状）。
**唯一残留的阻塞问题 → Q1'：Cursor 实现开始前，确认 `10-01-seam-post-body` 已合入。**

**Q2. 测试段落字母** —— 我建议 **V**。另外三家分别用 O / P / Q？
（`test-adapters.mjs` 是共享文件，字母撞车会导致两段互相覆盖。）

**Q3. 手动粘贴 token 的优先级** —— 放最后（本机文件优先）还是放最前（用户显式意图优先）？
- **建议**：放最后。理由见 `04` §3.3（`credentialSource` 的一致性 / Step 6 症状）。

### 🟡 需要拍板（影响用户看到什么）

**Q4. 两个子池（Cursor Models / Other Models）要不要展示？**
- 服务端只给 `autoPercentUsed` / `apiPercentUsed` 两个百分比，**没有绝对值**，
  且这两个字段的语义在社区有三种互相矛盾的解读、还出过 3 天冻结的事故。
- 选项：① v1 不展示（只展示「本月套餐」总池）② 展示但 `note` 标注「服务端百分比」。
- **建议**：①。最诚实。若②，则必须在 `note` 写明口径来源，且 `04` §7.4 的断言要锁死方向。

**Q5. 团队 / 企业账号怎么处理？**
- 这类账号响应里没有 `individualUsage.plan` / 没有可自校验的绝对值。
- 选项：① 明确 `errSnap('团队账号的用量口径暂不支持')` ② 照 ai-usagebar 解析两条 `*DisplayMessage` 文本。
- **建议**：①。②是「从人话里正则数字」，一旦 Cursor 改文案就静默出错 —— 正是
  `external-api-integration.md` Step 4「口径 mismatch 宁可不显示」要防的事。

**Q6. 需不需要第二打一次 `GetPlanInfo` 拿套餐名？**
- **建议**：不。先读 `state.vscdb` 的 `cursorAuth/stripeMembershipType`；拿不到就让 `plan` 留空
  （`plan` 是可选字段）。少一次请求 = 少一份限流/漂移风险。

### 🟢 可延后

**Q7. `state.vscdb` 只读失败时的回落顺序** —— 我建议：SQLite 只读失败 → 直接回落 `auth.json`；
两者都失败 → `nodata` 并在 detail 里**同时列出两个路径**（排障时一眼看到）。
（CodexBar 的做法是「IDE 错误优先展示，因为它更常被期待」。）

**Q8. Cursor 端点未文档化 → 服务条款风险** —— 要不要在 PRD / README 里显式写一句
「Cursor 适配器使用未文档化的 dashboard 接口，可能随时失效」？
- **建议**：写。这是产品责任边界，不是技术细节。

**Q9. 要不要给 `test-structure.mjs` 补「协议文件头必须声明来源与许可」的静态断言？**
- 父任务 prd.md 说这条边界「由 test-structure.mjs 的静态断言守门」，但**实测该断言并不存在**。
- **建议**：本任务只在自己文件头写声明（照 `opencode-cookie.ts:22-23` 先例）；
  守门断言作为独立条目提给主 agent（它会同时约束另外三家）。

---

## 7. 已实测 / 未验证 汇总

| 事实 | 状态 |
|---|---|
| 接缝扩 `method`/`body` 的**设计**已定案（`10-01-seam-post-body`，commit `6c81361`） | ✅ 已提交（**代码未实现**） |
| `POST api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` 无凭据 → 401 + `ERROR_NOT_LOGGED_IN` | ✅ **本机 curl 实测（2026-10-01）** |
| `GET cursor.com/api/usage-summary` 无凭据 → 401 + `not_authenticated` | ✅ **本机 curl 实测（2026-10-01）** |
| 本机未安装 Cursor（无 `~/.cursor`、无 `~/Library/Application Support/Cursor`、`cursor-agent` 不在 PATH） | ✅ **本机实测** |
| `simple-icons:cursor` 在 Iconify 可取（200） | ✅ **本机实测** |
| `node:sqlite` 在本机 node v22.23.2 可用 | ✅ **本机实测** |
| `ConnectRequest` 只有 url/headers/timeoutMs（无 method/body） | ✅ 源码 `types.ts:11-16` + `request.ts:22-26` |
| `test-adapters.mjs` N7 断言 `PROTOCOLS` 恰好 8 条 | ✅ 源码 `test-adapters.mjs:752-756` |
| `test-structure.mjs` 无许可/版权断言 | ✅ 源码 grep 零命中 |
| 端点响应字段（`planUsage` / `spendLimitUsage` 形状） | ⚠ 第三方记录（两个独立来源互证），**本机无账号可抓** |
| `totalPercentUsed` 语义 | ❌ **四份材料互相矛盾，不可信 → 不用** |
| CLI `auth.json` 的 macOS 确切路径 | ❌ 三方分歧，**需多候选试探** |
| User-Agent 伪装是否必需 | ❌ 未验证 |
| `api2.cursor.sh` 限流配额 | ❌ 无公开文档 |
| `membershipType` 完整值域 | ❌ 只见到 5 个值 |
| Electron 打包后 `node:sqlite` 可用 | ❌ opencode.ts 在用但未在 Electron 里单独验证过 |