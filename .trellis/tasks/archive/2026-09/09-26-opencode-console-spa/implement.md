# 执行计划：opencode 控制台明细适配新版 SPA

顺序原则：**先纠正已写错的文档，再动能独立验证的部分，最后才碰需要用户授权的部分。**
每步结束跑一次 `npm run typecheck && npm test`，全绿才进下一步。

### 步 2 补记：实测又挖出两件事（写进 design 后需要改 design）

- **org/workspace 通过请求头传，不是路径段**：bundle 里 `Pg="x-org-id"`，且它在
  CORS 允许头白名单里。步 3/4 的每个请求都要带 `x-org-id: <workspaceId>`。
  实测缺它会 400 `org_required`。
- **workspace 正被改名为 org，但 `wrk_` 仍合法**：bundle 的 id 校验是
  `/^(org_|wrk_)/`，且 `Actor.WorkspaceID` 用的同一规则。所以
  `findWorkspaceId` 的正则从只认 `wrk_` 改成两种前缀都认。
  **这意味着 `opencodeWorkspaceId` 这个 extra 存的值继续有效，不必迁移。**
  实测该账号两个 id 并存：`wrk_01M0…`（Default）与 `org_01M2…`（Personal）。
- **会话 cookie 换了**：`__Host-console_session` 是新控制台的会话凭据，
  旧的 `auth` cookie 保留但不被接受。`buildCookieHeader` 已按域全量收集，无需改。
- **别拿 org 列表当会话判据**：`/api/orgs` 不带 `x-org-id` 也能列，多工作区账号下
  会对一个根本读不到数据的会话返回 200 → 假通过。

### ⏸ 步 3–6 曾卡在用户这一步

步 3–6 都卡在同一件事：**新控制台的会话只能由用户登录产生**。
现有 `auth` cookie 新站不认（`/console/auth/session` → 401），代码绕不过去。
**已于 2026-09-26 由用户完成授权**（`/console/auth/session` 现返回 200），
下面的步 3–6 因此一次性做完。

在授权之前**没有**写宽容解析器 —— 真实字段名未知，宽容分支在收紧时会被全部删掉，
等于写两遍。事后看这个判断是对的：实施时踩到的 B1 bug（把 meter 字段名全判成未知）
正好会被宽容分支**吞掉**。

## 进度快照

| 步 | 内容 | 状态 | 验证 |
|---|---|---|---|
| 0 | 实测取证（改版 / 会话 / 新端点） | ✅ 完成 | 见 `prd.md`「本轮实测确认的事实」 |
| 1 | 纠正 `verify-opencode.mjs` 的写死 fixture | ✅ 完成 | `ce6755a` |
| 2 | 授权链路（登录 URL / workspace 发现 / 验证判据） | ✅ 完成 | `9d8a112` + **用户已成功重新授权** |
| 3 | 窗口改打 `/console/api/go/status` | ✅ 完成 | 端到端实测：`used=5.05884411`（服务端精确值） |
| 4 | 明细改打 `/console/api/usage/models` | ✅ 完成 | `--details-test`：weekly 6 行 / monthly 14 行，约 1.4s |
| 5 | 形状转储 + 错误提示 | ✅ 完成（形态转储由真实 fixture 测试替代） | `test-ssr-parser` 49 项 0 失败 |
| 6 | 用真实 fixture 收紧解析器 + 重写测试 | ✅ 完成 | 49 项，**测真源码不测副本** |

## `trellis-check` 评审发现与处置（2026-09-26）

派了 `trellis-check` 独立复核，它自己做了「故意改坏看测试是否报警」的实验，
找出 2 个 CRITICAL + 9 个 WARNING。全部已处置：

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| C1 | CRITICAL | **我引入的回归**：控制台现在自己给 tokens，但 `DetailView.tsx` 两处把 token 标签写死「本机」→ 界面出现「控制台每月」标题配「本机 880.1M」 | 新增 `tokenProvenanceLabel()` 按行 `source` 判定（控制台→服务端 / 混合→「服务端 + 本机」），两处都改 |
| C2 | CRITICAL | `modes.ts` 用 `getExtra('opencodeCookie')` 读保存的 cookie，但 `setKey` 写的是 `items` 而 `getExtra` 读 `extras` —— 两个不相干的 map，**永远返回 null** | 抽出 `resolveDiagnosticCred()`，用 `getKey`，与产品 `resolveCookie` 同源 |
| W1 | WARNING | `limit=0` 时算出 `percent=0` → 界面渲染「已用 $5.06 / 配额 $30 · 0%」，**花了钱显示 0%** | 算不出百分比且 `usage>0` 时不产出 `windows` 条目（`raw` 仍留金额），`opencode.ts` 给出「百分比不可用（控制台未给限额）」提示 |
| W2 | WARNING | `MODELS_RANGES` 零护栏 —— 评审实测把它改成 `{weekly:'30d'}` 测试**全绿** | 新增 G2 组 4 项断言（含「绝不能有 rolling」） |
| W3 | WARNING | 并发/重试、modelsByWindow 键映射、`x-org-id` 头、服务端 tokens 均无覆盖 | `x-org-id` / `MODELS_RANGES` / `PERIOD_END_RESET_FIELDS` 已补断言；并发与重试**仍无测试**，已在代码注释里写明这个缺口与原因 |
| W4 | WARNING | `opencode.ts` 文件头指向**错误端点**（说目标是 `usage/summary`），且把硬编码 $12/$30/$60 说成权威 | 重写：说清 `go/status` 才是窗口源、`usage/summary` 是聚合、限额以服务端为准 |
| W5 | WARNING | `USAGE_SUMMARY_PATH` 注释自相矛盾且仍称它是「窗口汇总」 | 改为「不是窗口数据源，现在的唯一用途是授权探针」 |
| W6 | WARNING | 自愈路径不报 `unknownMeters` → 改版信号被吞 | 补上，与主路径一致 |
| W7 | WARNING | 设置页文案「不配置不影响使用，只是精度为整数」—— 实际会退到**不同口径**的本机估算 | 改文案，说清降级是口径变化而非精度变粗 |
| W8 | WARNING | prd R6 / implement 步 4 仍要求保留已删除的 `quotaUsd`/`percent`；implement 有 29 个未勾选框与 ✅ 表格矛盾；补记块重复 | 已改写与勾选 |
| N1 | NIT | `cookieWindowsToProvider`（34 行）**完全无消费者**，注释还说 `used = percent × limit 即权威` —— 与现在服务端给精确 used 相矛盾 | 删除 |
| N2/N3 | NIT | `MODELS_RANGE`（描述已删的 DOM 表）、`BILLING_STATUS_PATH`（未接线）死常量 | 删 `MODELS_RANGE`；`BILLING_STATUS_PATH` 保留但在注释里标明「未接线，仅记录已知数据源」 |
| N5 | NIT | `inflight` 是模块级单槽，`invalidateConsoleDetails()` 不清它 → 自愈换 cookie 后会跳过新抓取并返回 null | 改成按缓存键的 Map，`invalidate` 一并清 |
| N6 | NIT | 缓存键用 `cookie.length` 当身份近似 | 掺入首尾字符短摘要，降低等长碰撞 |
| N7 | NIT | `field === 'month'` 是 `METER_FIELDS` 之外的第二处硬编码 | 提为 `PERIOD_END_RESET_FIELDS` 集合 |
| N10 | NIT | `resetInSec ?? 0` 两条路径（「无 resetsAt」与「非法时间戳」）行为一致但无测试 | 新增 E3 组 4 项断言 |

### 评审自己做的「测试有效性」实验

它把几处改坏后发现**当时的 49 项测试全绿**（并发、重试、`x-org-id`、`modelsByWindow` 键、
服务端 tokens 都没覆盖），而 B1（`Object.values`）和 month 回落**能**被抓到 ——
说明套件是真的，只是太窄。

补完断言后我重跑了同样 6 个改坏实验：

| 实验 | 结果 |
|---|---|
| EXP1 给 `MODELS_RANGES` 加 `rolling: '24h'` | 69/3 失败 ✓ |
| EXP2 把 `week` 加进 `PERIOD_END_RESET_FIELDS` | 71/1 失败 ✓ |
| EXP3 `buildConsoleHeaders` 不再带 `x-org-id` | 71/1 失败 ✓ |
| EXP4 去掉「百分比算不出就不产出 windows」守卫 | 70/2 失败 ✓ |
| EXP5 回到 `Object.values` 的老 bug | 45/27 失败 ✓ |
| EXP6 去掉 month → `access.endsAt` 回落 | 70/2 失败 ✓ |

仍剩一个已知缺口：`fetchRange`/`scrape` 的**并发与重试**无自动化测试
（需要给原生 fetch 打桩，而本模块刻意不用 `ctx.request`，不能复用 `test-adapters` 的桩）。
已在 `opencode-details.ts` 的函数注释里写明，不要让后人以为那里有护栏。

## ⚠️ 三处设计假设被实测推翻（务必读）

### ① `/console/api/usage/summary` **不是**窗口数据源 —— design 的核心假设错了

原 design 写「`summary` 替代 SSR 解析」。实测响应：

```json
{"totalRequests":"10430","totalInputTokens":"48361045",...,"totalCostMicroCents":"2109564887","services":[]}
```

**没有 percent / limit / resetsAt**，只有全量聚合与按天/按 range 的用量。带 `range` 试了
`24h`/`7d`/`30d` 也一样 —— 它是"用量统计"，不是"配额窗口"。

真正的窗口端点是抓 SPA 自己的请求才找到的：

> 打开 Go 页 → 观测到 `GET /console/api/go/status`

响应 1:1 对上余额板要的三个窗口，**而且限额由服务端下发**（旧代码硬编码 $12/$30/$60）：

```json
"meters": {
  "fiveHour": { "resetsAt": "2026-09-26T15:22:41.617Z",
                "limitMicroCents": "1200000000", "usedMicroCents": "52000" },
  "week":     { "resetsAt": "2026-09-28T00:00:00.000Z",
                "limitMicroCents": "3000000000", "usedMicroCents": "505884411" },
  "month":    { "limitMicroCents": "6000000000", "usedMicroCents": "505884411" }
}
```

> **教训**：光看 bundle 里的 API 声明**不足以**判断哪个端点有用 ——
> `summary` 也在声明里、也标了 stable，但它是另一类数据。判断依据只能是
> **打开真实页面看它调了谁**（`scripts/opencode-go-page-capture.js`）。

### ② `month` 没有 `resetsAt`，重置时间 = 订阅周期末

`month`  meter 只有 limit/used。回落到 `access.endsAt` —— 数值核对：
`2026-10-21T01:25:47Z` 减当时 = **24 天 10 小时 41 分**，与控制台页面
"Monthly usage … Resets in 24d 10h" 吻合。

### ③ 明细接口**没有**每模型配额与百分比

旧 DOM 版能从表头读到「每月配额」与 %，新 `usage/models` 只有已用量/请求数/tokens。
所以 `ConsoleModelRow` **删掉** `quotaUsd` / `percent`（而不是填 0 —— 填 0 会让界面
显示「$0 / 0%」，那是撒谎）。渲染层本来就支持缺省（`DetailView.tsx` 对 undefined 显示「—」）。

反过来多了一样：**服务端 tokens**。实测 `deepseek-v4.1-flash` 服务端给 854,632,776，
本机 db 只有 414,365,875 —— 旧版 tokens 只能取本机，多设备会漏一大截。

## 实现期间踩到并修掉的问题

| # | 问题 | 根因 | 修法 |
|---|---|---|---|
| B1 | 三个窗口全被判成「未知计费项」 | `new Set(Object.values(METER_FIELDS))` 取的是**值**（rolling/weekly/monthly），应该是**键** | 改 `Object.keys`；并在测试 D1 加了针对性回归 |
| B2 | 明细间歇性缺一整个窗口 | 两个 range 并发（`Promise.all`）时其中一个间歇 `fetch failed`，静默丢一窗 | 改**串行 + 失败重试一次**；401/403 不重试（会话问题）；连跑 5 次零失败 |
| B3 | `--details-test` 报「缺少 cookie」但明明已授权 | 诊断工具只读存起来的 `opencodeCookie`，产品路径却**优先读授权分区的实时 cookie** | 诊断工具改为与 `resolveCookie` 同源（分区优先） |

B1 正好印证 R9 的必要性：如果按原计划"先写宽容解析器"，这个 bug 会被宽容分支**吞掉**
（`unknownMeters` 之外的字段缺失很容易被默认值掩盖），而测试会绿。

## ⏸ 剩余可做（不在本轮范围）

- `/console/api/billing/status` 有 `availableMicroCents: 500000000` = **$5.00 可用额度**，
  以及 `renewalAuthorizationRequired: true`（页面提示"Reauthorize Alipay before Oct 21"）。
  两者都是真实可用的新数据源，但接入要改快照形状（余额型 vs 套餐型），单开一轮。
- `usage/summary` 与 `cost-by-day` 可用于"本机 vs 全局"对照，本轮未用。


### 步 2 补记：实测又挖出两件事（写进 design 后需要改 design）

- **org/workspace 通过请求头传，不是路径段**：bundle 里 `Pg="x-org-id"`，且它在
  CORS 允许头白名单里。步 3/4 的每个请求都要带 `x-org-id: <workspaceId>`。
- **workspace 正被改名为 org，但 `wrk_` 仍合法**：bundle 的 id 校验是
  `/^(org_|wrk_)/`，且 `Actor.WorkspaceID` 用的同一规则。所以
  `findWorkspaceId` 的正则从只认 `wrk_` 改成两种前缀都认。
  **这意味着 `opencodeWorkspaceId` 这个 extra 存的值继续有效，不必迁移。**
- **`x-org-id` 不能省**：选 `/console/api/usage/summary` 而不是 `/api/orgs` 做
  验证判据，正是因为 orgs 在不带 org 头时也能列 —— 多工作区账号下会假通过。

### ⏸ 当前卡在用户这一步

步 3–6 都卡在同一件事：**新控制台的会话只能由用户登录产生**。
现有 `auth` cookie 新站不认（`/console/auth/session` → 401），代码绕不过去。

用户在应用里走一次「一键授权」后，`GET /console/api/usage/summary` 应返回 200，
届时把真实响应给我（或让我跑 `npm run details-test` 从
`/tmp/balancedeck-details.log` 读转储），步 3–6 就能一轮做完。

**在此之前不要写宽容解析器** —— 真实字段名未知，宽容分支在步 6 会被全部删掉，
等于写两遍。步 3–6 一起做才是有效工作量。


## 步 1：先纠正已写错的文档（R7 之外的"文档债"）

- [x] `scripts/verify-opencode.mjs:65-70` 的 `// ── 2. 官方 API 响应（实测）` 是**硬编码字面量**，
      `resetsAt` 停在 9-13/14/20。改成显式标注「写死的历史样本，不是实时响应」，
      或改成真的发请求（发请求更好，但会依赖 key；两者择一并写清理由）
- [x] `TASKS.md`「2026-09-26 第二十一轮」里那句「官方 `zen/go/v1/usage` API 正常（实测 5h 0% / 周 48% / 月 66%）」
      **是错的**，改成 403 `EntitlementError`
- [x] `TASKS.md` 同节「两条抓取路径同时失效」补上第三条：官方 API 也是 403，
      现在只剩本机 db 一条路
- [x] `verify:opencode` 在 `package.json` 里的定位描述更新（它不验证任何线上行为）

> 为什么先做这步：我在上一轮汇报里把写死 fixture 当成了实测结论，这个错误已经进了
> `TASKS.md`。先把它纠正，后面的结论才站在干净的地基上。

**门**：`grep -n "实测" TASKS.md` 里的每条"实测"都要有对应的真实命令。

## 步 2：授权链路（R1/R2）

- [x] `opencode-auth.ts:21` `LOGIN_URL` → `https://opencode.ai/console/login`
- [x] `opencode-auth.ts:86` workspace 发现的三条旧路径（`/workspace`、`/dashboard`、`/`）
      重新确认后替换为 `/console/...` 形状的路径
- [x] `opencode-auth.ts:49-55` cookie 域规则：现在**排除 `auth.opencode.ai` 等子域**。
      验证新控制台的会话 cookie 是否落在 `opencode.ai` 域上；若落在子域上，规则要放开
- [x] `opencode-auth.ts:214` 的 `setWindowOpenHandler` 白名单实测确认能覆盖新登录的
      OAuth 跳转（Google / GitHub）
- [x] **需要用户配合**：在应用里走一次一键授权

**门**：授权后 `GET /console/auth/session` 不是 401。
（这是"会话真的建立了"的判据，比"登录页打开了"强 —— 后者在旧 cookie 下也会"成功打开"登录页。）

## 步 3：cookie 路径改打 `go/status`（R4/R5）

> **实际做的与原计划不同**：原计划打 `/console/api/usage/summary`，
> 实测发现它只有用量聚合、没有窗口数据，改打 `/console/api/go/status`。见「三处设计假设被推翻」①。

- [x] 新增 `src/main/adapters/opencode-console-api.ts`：端点常量 + `x-org-id` 请求头 + 401/403/400 分类
- [x] `opencode-cookie.ts` 的 URL 从 `/workspace/<id>/go` 改为 `/console/api/go/status`
- [x] 新增纯函数 `parseGoStatus(body, nowMs)`，**返回形状与被替换的两个 SSR 解析器之和一致**（R4），
      额外带 `unknownMeters`（改版信号）
- [x] 保留 `CookieFetchResult` / `SsrUsageWindow` / `SsrRawWindow` 名字不动
      （命名先脏，换 diff 可读；`Ssr` 前缀已名不副实，留到下一轮清理）
- [x] 401 / 400 `org_required` / 其它非 2xx 三类分开，文案指向"重新授权"（R8）
- [x] 删 `parseUsageHtml` / `parseUsagePayload` / `labelToKind` / `stripHtmlComments` /
      `clampPercent` / `parseDurationToSec` / `pickNum` / `pickStr`（共 -3833 字符）
- [x] **不写宽容取值分支** —— 真实字段名已到手（见「卡点 C2 已解除」）
- [x] 顺手删掉零消费者的 `cookieWindowsToProvider`（评审 N1）
- [x] 算不出百分比且 `usage>0` 时**不产出窗口**，避免「花了 $5 却显示 0%」（评审 W1）
- [x] `METER_FIELDS` 用 `Object.keys` 而非 `Object.values`（B1，见「实施期间踩到并修掉的问题」）
- [x] `month` 的重置回落改用 `PERIOD_END_RESET_FIELDS` 集合，不在解析处写死 `'month'`（评审 N7）

**门**：`npm test` 全绿；端到端 `--smoke` 三个窗口 `note='控制台'`、
`used` 为服务端精确值。

## 步 4：明细改打 models（R6）

- [x] `opencode-details.ts`：删 `EXTRACT_JS` 与隐藏窗口的创建/销毁（234 行 → 约 190 行）
- [x] 保留：5 分钟缓存、后台非阻塞刷新、`BALANCEDECK_DEBUG` 日志通道
- [x] 新增 `GET /console/api/usage/models?range=7d|30d&pageSize=50`
- [x] **`ConsoleModelRow` 删掉 `quotaUsd` / `percent`**（接口没有这两项；填 0 = 撒谎），
      新增 `provider` / `tokens` / `requests`（评审 W8、prd R6 修订）
- [x] 401/403 静默降级为空明细（增强项，不该让整轮采集失败）
- [x] 串行 + 失败重试一次（B2）
- [x] `inflight` 改成按缓存键的 Map，`invalidate` 一并清（评审 N5）
- [x] 写单测（72 项中 H/I/J 三组）

**门**：`npm run details:test` 打印出真实内容 —— weekly 6 行 / monthly 14 行，约 1.4s。

## 步 5：形状转储 → 真实 fixture（R7 修订）

- [x] ~~第一次成功拿到响应时把键路径结构写进日志~~ → **改为**用真实响应做 fixture +
      结构断言（见 prd R7 修订：一次性转储对回归没有约束力）
- [x] `BALANCEDECK_DEBUG` 日志通道保留（失败诊断仍需要）
- [x] 界面提示改由 `unknownMeters` 驱动（不是 `unknownKeys` —— 字段名改了）

**门**：6 个「故意改坏」实验全部被测试抓到（见「评审自己做的测试有效性实验」）。

## 步 6：用真实 fixture 收紧解析器（R9）

- [x] 把真实响应存成 `scripts/fixtures/` 下的匿名 fixture（**剥掉任何标识信息**）
- [x] 按真实字段名收紧 `parseUsageSummary` / models 解析
- [x] `test:ssr` 重写为覆盖真实 fixture
- [x] 清掉不再需要的宽容分支（在注释里记下"这是为哪次改版留的"）

**门**：`test:ssr` 无占位断言 —— 每条断言都能说出对应真实响应的哪一行。

## 卡点与顺序约束

- **步 2 的门需要用户授权**。没授权前，步 3–5 只能做到"代码就位 + 宽容解析 + 单测"，
  **不能声称适配完成**（`prd.md` 卡点 C2）。
- 步 6 严格阻塞于步 2 拿到真实响应。
- 步 3 之前不要改步 2 以外的东西：先让 `npm test` 在"只加常量不改行为"的状态下保持全绿。

## 自检命令

```bash
npm run typecheck
npm test
npm run build && npx electron . --uitest          # 82 项
npm run details:test                              # 授权前：401 属预期
BALANCEDECK_DEBUG=1 npm run details:test && cat /tmp/balancedeck-details.log
node scripts/probe-console-api.js                 # 端点是否仍存在（401 vs 404）
node scripts/probe-spa-bundle.mjs                 # 站点改版时重挖 API 声明
```

## 上下文清单

按需 `Read` 的大文件（**故意不进 jsonl**：超 `context_injection.max_file_bytes` = 32KB 时
会被截断却仍吃满注入预算 —— 2026-09-19 派发连续失败就是这个原因，
`check.jsonl` 里放 `TASKS.md` 已被 `task.py validate` 明确警告过）：

- `TASKS.md`（50KB）—— 与本任务相关的段：`2026-09-13 第五轮`（用量口径）、
  `2026-09-13 第十轮`（cookie 抓取修复）、`2026-09-13 第十一轮`（每模型明细）、
  `2026-09-06 追加修复`（`zen/go/v1/usage` 优先）
- `DESIGN.md`（42KB）—— 只需 `§5` 控制台明细那段

