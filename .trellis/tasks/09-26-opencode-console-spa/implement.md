# 执行计划：opencode 控制台明细适配新版 SPA

顺序原则：**先纠正已写错的文档，再动能独立验证的部分，最后才碰需要用户授权的部分。**
每步结束跑一次 `npm run typecheck && npm test`，全绿才进下一步。

## 进度快照

| 步 | 内容 | 状态 | 验证 |
|---|---|---|---|
| 0 | 实测取证（改版 / 会话 / 新端点） | ✅ 完成 | 见 `prd.md`「本轮实测确认的事实」 |
| 1 | 纠正 `verify-opencode.mjs` 的写死 fixture | ✅ 完成 | `ce6755a`，脚本明说「本脚本不访问网络」 |
| 2 | `opencode-auth.ts` 登录 URL + workspace 发现 + 验证判据 | ✅ 代码完成，端到端待用户授权 | `9d8a112`，typecheck + 全套 test 0 失败 |
| 3 | cookie 路径改打 `/console/api/usage/summary` | ⬜ | 纯函数单测 + 401 断言 |
| 4 | `opencode-details.ts` 改打 `/console/api/usage/models` | ⬜ | 纯函数单测 |
| 5 | R7 形状转储 + R8 错误提示 | ⬜ | 需真实响应 |
| 6 | 用真实 fixture 收紧解析器 + 重写 `test:ssr` | ⬜ | 阻塞于用户授权 |

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

- [ ] `scripts/verify-opencode.mjs:65-70` 的 `// ── 2. 官方 API 响应（实测）` 是**硬编码字面量**，
      `resetsAt` 停在 9-13/14/20。改成显式标注「写死的历史样本，不是实时响应」，
      或改成真的发请求（发请求更好，但会依赖 key；两者择一并写清理由）
- [ ] `TASKS.md`「2026-09-26 第二十一轮」里那句「官方 `zen/go/v1/usage` API 正常（实测 5h 0% / 周 48% / 月 66%）」
      **是错的**，改成 403 `EntitlementError`
- [ ] `TASKS.md` 同节「两条抓取路径同时失效」补上第三条：官方 API 也是 403，
      现在只剩本机 db 一条路
- [ ] `verify:opencode` 在 `package.json` 里的定位描述更新（它不验证任何线上行为）

> 为什么先做这步：我在上一轮汇报里把写死 fixture 当成了实测结论，这个错误已经进了
> `TASKS.md`。先把它纠正，后面的结论才站在干净的地基上。

**门**：`grep -n "实测" TASKS.md` 里的每条"实测"都要有对应的真实命令。

## 步 2：授权链路（R1/R2）

- [ ] `opencode-auth.ts:21` `LOGIN_URL` → `https://opencode.ai/console/login`
- [ ] `opencode-auth.ts:86` workspace 发现的三条旧路径（`/workspace`、`/dashboard`、`/`）
      重新确认后替换为 `/console/...` 形状的路径
- [ ] `opencode-auth.ts:49-55` cookie 域规则：现在**排除 `auth.opencode.ai` 等子域**。
      验证新控制台的会话 cookie 是否落在 `opencode.ai` 域上；若落在子域上，规则要放开
- [ ] `opencode-auth.ts:214` 的 `setWindowOpenHandler` 白名单实测确认能覆盖新登录的
      OAuth 跳转（Google / GitHub）
- [ ] **需要用户配合**：在应用里走一次一键授权

**门**：授权后 `GET /console/auth/session` 不是 401。
（这是"会话真的建立了"的判据，比"登录页打开了"强 —— 后者在旧 cookie 下也会"成功打开"登录页。）

## 步 3：cookie 路径改打 summary（R4/R5）

- [ ] 新增 `src/main/adapters/opencode-console-api.ts`：端点常量 + 401/404 的错误分类
- [ ] `opencode-cookie.ts:293` 的 URL 从 `/workspace/<id>/go` 改为 `/console/api/usage/summary`
- [ ] 新增纯函数 `parseUsageSummary(body: unknown)`，**返回形状与被替换的
      `parseUsageHtml` + `parseUsagePayload` 之和完全一致**（R4）
- [ ] 保留 `CookieFetchResult` / `SsrUsageWindow` / `SsrRawWindow` 名字不动
      （`design.md` 契约 1 的取舍：命名先脏，换 diff 可读）
- [ ] 401 与其它错误分开，错误文案指向"重新授权"（R8）
- [ ] 删 `parseUsageHtml` / `labelToKind` / `stripHtmlComments` / `parseDurationToSec`
      与 `pickNum` / `pickStr`（仅被这两个函数用的才删）
- [ ] 写单测：宽容取值的多种字段命名变体 + 401 + 空响应 + `unknownKeys` 非空
- [ ] `test:ssr` 里针对被删函数的断言同步删（**先删，别留引用已删函数的死断言**）

**门**：`npm test` 全绿（此时可不含真实 fixture —— 只测解析器的宽容行为）。

## 步 4：明细改打 models（R6）

- [ ] `opencode-details.ts`：删 `EXTRACT_JS` 与隐藏窗口的创建/销毁（约 -150 行）
- [ ] 保留：5 分钟缓存、后台非阻塞刷新、`BALANCEDECK_DEBUG` 日志通道
- [ ] 新增 `GET /console/api/usage/models?range=30d`（`range` 取自 bundle 声明的枚举）
- [ ] 保持 `ConsoleModelRow`（`model` / `usageUsd` / `quotaUsd` / `percent`）形状
- [ ] 401 时**静默降级为空**（明细是增强项，不该让整轮采集失败）
- [ ] 写单测

**门**：`npm run details:test` 在授权后能打印出真实内容（授权前会 401，属预期）。

## 步 5：形状转储（R7）

- [ ] 第一次成功拿到 summary / models 响应时，把键路径结构写进
      `/tmp/balancedeck-details.log`（沿用 `BALANCEDECK_DEBUG` 通道）
- [ ] 界面提示：`unknownKeys` 非空时给一句"控制台返回结构已变，明细可能不准"

**门**：拿到真实响应后，日志里有可读的结构转储。

## 步 6：用真实 fixture 收紧解析器（R9）

- [ ] 把真实响应存成 `scripts/fixtures/` 下的匿名 fixture（**剥掉任何标识信息**）
- [ ] 按真实字段名收紧 `parseUsageSummary` / models 解析
- [ ] `test:ssr` 重写为覆盖真实 fixture
- [ ] 清掉不再需要的宽容分支（在注释里记下"这是为哪次改版留的"）

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

