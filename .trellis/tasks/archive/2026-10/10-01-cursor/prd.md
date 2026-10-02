# Cursor 适配器

## Goal

新增 **Cursor** 供应商：用 Cursor IDE/CLI 本机登录态里的 JWT，出网打
`api2.cursor.sh` 的 Connect RPC 取**服务端真值**（月度订阅额度，单位美元）。
凭据只读本机、**不刷新、不回写、不缓存**。

调研原文与逐字证据：`.trellis/tasks/10-01-cursor/research/`
（`00-summary-and-recommendation.md` 索引 / `01-cursor-quota-model.md` 额度模型 /
`02-endpoints-and-auth.md` 端点与鉴权 / `03-competitors-and-licenses.md` 竞品与许可 /
`04-repo-contract-mapping.md` 契约映射 / `05-gotchas-and-open-questions.md` 踩坑与待确认）

## Background

### 端点（未文档化，两个独立来源互证 + 本机 curl 验证未鉴权分支）

```
POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage
     headers: Authorization: Bearer <jwt>
              Content-Type: application/json
              Connect-Protocol-Version: 1
     body: {}
     → { billingCycleStart/End（unix 毫秒字符串）,
         planUsage: { includedSpend, remaining, limit（分）, autoPercentUsed, apiPercentUsed, totalPercentUsed },
         spendLimitUsage: { individualLimit/Used, pooledLimit/Used, limitType } }
```

本机实测（2026-10-01，无凭据）：`401` + `ERROR_NOT_LOGGED_IN` —— 端点存在且活着。
个人计划**没有官方用量 API**（Admin/Analytics 只对 Enterprise 团队）。

### ⚠️ 核心坑：`*PercentUsed` 字段不可信（官方亲口承认）

2026-08-12~14 事故：三个 percent 字段连续 3 天冻结（用户实际已用 64.4%，字段显示 3.73%）。
Cursor 官方员工 2026-08-13 回复：「这三个 percent 字段**不是** `totalSpend/limit`，
它们反映另一个内部指标。」四份独立材料对该字段有**互相矛盾**的解读。

→ **只用绝对值自算百分比，不碰服务端 percent 字段。**

### 前置已交付

- 采集接缝（`10-01-seam-post-body` / `168c6bc`）：`method`/`body` 透传，测试桩有
  `callProjectRich` / `makeRichRequest`
- `readJson` 可选第 5 参（Gemini 任务扩的）：`opts?: { method, body }`，既有 7 个调用点未动
- 段字母锁定（父任务）：Gemini `V` · **Cursor `W`** · Antigravity `X` · OpenAI `Y`

## Requirements

### R1 · 落点：独立代码适配器

1. 新增 `src/main/adapters/cursor.ts`，注册进 `CODE_ADAPTERS['cursor']`。
   **不进 `protocols.ts`**（`test-adapters.mjs:800` 的 N7 断言 `PROTOCOLS.length === 8`；
   且 `protocol-adapter.ts:68-72` 工厂写死 GET + 两个固定头，无 body/自定义头扩展点）。
2. `kind: 'coding'`；`mark` / preset id / protocol id **三同 `'cursor'`**
   （`providerMark` 只按 key 查，劈叉会让自定义实例静默退回 generic 图标——Gemini 已踩过反例）。
3. `providers.ts` 的 `BUILTIN_PRESETS` 加一条（照 copilot 形状：
   `localCredential: true` + `singleton: true`，无 `keyHint`）。
4. `scripts/gen-provider-icons.mjs` 的 `MARKS` 加 `cursor` 键后**跑脚本**生成
   `provider-icons.ts`（生成物不手改；已实测 `simple-icons:cursor` Iconify 200）。
   串行执行，无并行冲突。

### R2 · 凭据：三源级联，只读不写

5. 顺序：`state.vscdb`（`ItemTable` / `cursorAuth/accessToken`）→
   CLI `auth.json`（多候选路径试探）→ `ctx.getKey(inst.id)`（用户手动粘贴，`items` 加密，**优先级最低**）。
6. **绝不写 Cursor 的凭据文件**（CodexBar / cursor-cli-usage 原话：
   never refreshes, rotates, or modifies Cursor-owned credentials）。
   **不实现 `oauth/token` 刷新、不做 `setKey` 回写、不把 token 缓存进 `items`**——
   刷新权在 Cursor 手里，回写只会与它抢写同一个文件，且缓存副本必然比 Cursor 自己的旧。
7. JWT 本地过期判定（`exp` 距今）：过期 → `errSnap`「在 Cursor 中重新登录」，**不发请求**。
8. **不新增任何返回 token 的 IPC**（`tts:getSecret` 教训，E5/F6 门禁守着）。

### R3 · 采集：单请求 + 不变量自检

9. 单 `POST`（body `'{}'`），headers 显式写全三项：
   `Authorization: Bearer <jwt>` + `Content-Type: application/json` +
   `Connect-Protocol-Version: 1`。
10. **不变量**：`includedSpend + remaining === limit`，不成立 → `errSnap`（schema drift），
    **绝不返回 0**（`external-api-integration.md` Step 3：Field has no source → delete it, don't zero it）。
11. 缺失值保持 `null`，绝不填 0（P0 纪律延续）。

### R4 · 窗口：美元主窗口 + 按需预算，子池 v1 不展示

12. 主窗口 `本月套餐`：`{ used: includedSpend/100, limit: limit/100, unit: 'usd',
    percent: 自算一位小数, resetAt: 毫秒字符串→ISO, note: '官方接口' }`。
13. `spendLimitUsage.individualLimit > 0` 时加「按需预算」窗口（同口径自算）；
    `limitType === 'team'` 时用 pooled 口径。
14. 两个子池（`autoPercentUsed` / `apiPercentUsed`）**v1 不展示**——没有对应绝对值可自校验，
    且语义有三种矛盾解读 + 出过冻结事故。
15. 团队/企业形状（无 `planUsage`）→ 明确 `errSnap`，**不从 `*DisplayMessage` 人话里正则数字**
    （Cursor 改文案就静默出错）。
16. `isUnlimited: true` → 无 limit 窗口 + note「不限量」，`percent` 缺省（照 copilot 不限量先例）。
17. `plan`：读**同库** `cursorAuth/stripeMembershipType`，原样透传 + title-case；
    拿不到就留空（可选字段）。**不为此多打一次 `GetPlanInfo`**。

### R5 · 降级：失败一律 `dataQuality === undefined`

18. 成功 → `officialSnap`（服务端真值，与 copilot 同构，不违反出网采集模型）。
    所有失败 → `errSnap` / `noDataSnap`，`dataQuality` 必须是 `undefined`（ADR-0002）。
19. 本适配器**永不出现 `local`**——本机没有任何可推算口径（与 claude/codex 的转录估算性质不同）。
20. 401/403 → 会话失效文案；429 → 限流文案（**不说「请检查网络」**）；其它非 200 → `HTTP <status>`；
    形状认不出 → `响应格式未识别：<160 字符预览>`；ok + 空 `windows` 禁止（`applyCachePolicy` 会判 degraded）。

## Constraints

- **共享文件只追加**：`scripts/test-adapters.mjs` 是四家共改文件（V 已被 Gemini 占用，
  Cursor 用 `W`）。段字母撞车会让两段互相覆盖，且表现为「某段没跑到」而非报错。
- **`protocols.ts` 一行都不碰**（N7 守着 8 条）。
- **凭据字面量红线**（`keystore.ts:5-6`）：源码、示例、测试禁止出现可用凭据字面量。
  fixture JWT 用 `{"alg":"none"}` + base64url 自造 payload（`sub`/`exp`），明显假。
- **许可边界**：参考思路自己重写，不逐行复制。`wakamex/cursor-cli-usage` 是 **NONE（无 LICENSE，
  不可复用代码）**，`tddworks/ClaudeBar` 同样 NONE——只读它们的文档结论，不碰代码。
  文件头附来源与许可声明（照 `opencode-cookie.ts:22-23` 先例）。
- **未文档化声明**：文件头 + 本 prd 明确写「Cursor 适配器使用未文档化的 dashboard 接口，
  可能随时失效」。这是产品责任边界，不是技术细节。
- **v1 不做**：备选 cookie 端点（`usage-summary`）、`GetPlanInfo` 第二请求、
  `get-filtered-usage-events` 明细（403 有 6 小时冷却，体量也不属订阅查询）、
  `CURSOR_ACCESS_TOKEN` 环境变量（`scanner.ts` 共享文件，留待合并阶段统一安排）、
  `baseUrl:cursor` 的 extras 覆盖。
- **不新增网络请求**：access_token 的 JWT 本地可判过期；`stripeMembershipType` 读同库不另打请求。

## Acceptance Criteria

- [ ] AC1 `src/main/adapters/cursor.ts` 存在并注册进 `CODE_ADAPTERS['cursor']`
- [ ] AC2 `kind: 'coding'`、mark/preset/protocol 三同 `'cursor'`
- [ ] AC3 `BUILTIN_PRESETS` 加一条 `localCredential: true` + `singleton: true`，无 `keyHint`
- [ ] AC4 `provider-icons.ts` 由脚本**跑出来**（非手改），`PROVIDER_MARKS['cursor']` 存在
- [ ] AC5 三源全空 → `noDataSnap` 且 `dataQuality === undefined`，文案点名登录入口与两个文件路径
- [ ] AC6 JWT `exp` 已过 → `error` 且**请求序列为空**（本地判定，不发请求）
- [ ] AC7 手动粘贴 token 优先级最低：本机文件有值时用文件的（`credentialSource` 一致性）
- [ ] AC8 **未调用 `setKey`**（锁住「不自愈」决策）；`gemini.ts`…不，`cursor.ts` 无 `keychain`/`setKey` import
- [ ] AC9 请求形状断言：URL 恰好是 `.../DashboardService/GetCurrentPeriodUsage`、
      `method: 'POST'`、`body: '{}'`、`Authorization: Bearer <jwt>`、
      `Connect-Protocol-Version: 1`、`Content-Type: application/json`
- [ ] AC10 金额换算：`limit: 40000`（分）→ `limit: 400`（美元），`used` 同理
- [ ] AC11 `percent` 自算一位小数，与 `used/limit` 一致；**无任何服务端 percent 字段进入快照**
- [ ] AC12 `resetAt` 由 unix **毫秒字符串** → ISO
- [ ] AC13 `includedSpend + remaining !== limit` → `errSnap`，**不是** 0%
- [ ] AC14 缺 `planUsage`（team 形状）→ `errSnap`，不是 0%
- [ ] AC15 `isUnlimited: true` → 无 limit 窗口 + note「不限量」，`percent` 字段不存在
- [ ] AC16 `spendLimitUsage.individualLimit > 0` → 有「按需预算」第二窗口
- [ ] AC17 401 → 重登录文案；429 → 限流文案且**不含「检查网络」**；500 → `HTTP 500`
- [ ] AC18 形状认不出 → `响应格式未识别：<预览>`；成功路径 `dataQuality === 'official'`
- [ ] AC19 每一条失败路径 `dataQuality === undefined`；适配器未写 `degradedReason`；
      `dataQuality === 'local'` 永不出现
- [ ] AC20 `plan` 取 `stripeMembershipType` title-case；拿不到则字段省略
- [ ] AC21 `protocols.ts` **零改动**（N7 仍绿）；`PROTOCOLS.cursor === undefined`
- [ ] AC22 `test-adapters.mjs` **W 段**追加在 V 段之后、汇总行之前，既有行**一行未改**
- [ ] AC23 WAL 只读失败 → 回落 `auth.json`（不碰 Cursor 目录、不建 `-wal`/`-shm` 副作用）；
      fixture 用临时目录真实建库验证
- [ ] AC24 token 含 NUL 字节（UTF-16LE BLOB 形态）→ 去 NUL 后可用，不判空
- [ ] AC25 **`npm test` 全绿，且除 `adapters` 外 19 套件断言数与基线逐个一致**（纯增量硬证明）
- [ ] AC26 `npm run typecheck` 通过；`test-structure.mjs` E5/F6 仍绿
- [ ] AC27 **零 UI 改动**（`src/renderer/**` 只允许 `provider-icons.ts` 生成物变化）
- [ ] AC28 **反验实测**：`method: 'POST'` 改回 GET → W 段必须报红
- [ ] AC29 **反验实测**：把自算 percent 改成读 `totalPercentUsed` → 不变量/快照断言必须报红

## Notes

### 用户 / 前期已定的决策

| 问题 | 结论 | 来源 |
|---|---|---|
| 段字母 | **Cursor 用 `W`**（Gemini 已占 `V`） | 父任务 prd.md:79 |
| Q3 手动粘贴优先级 | **最低**（本机文件优先），否则「IDE 明明登录了却说未配置」 | 本任务决定（采纳调研建议） |
| Q4 子池展示 | **v1 不展示** | 本任务决定 |
| Q5 团队账号 | **明确 `errSnap`**，不正则人话 | 本任务决定 |
| Q6 第二请求拿套餐名 | **不要**，读同库 `stripeMembershipType` | 本任务决定 |
| Q7 WAL 失败回落 | SQLite 只读失败 → 直接回落 `auth.json`；都失败 → `nodata` 且 detail **同时列出两个路径** | 本任务决定 |
| Q8 未文档化声明 | **写**（文件头 + 本 prd） | 本任务决定 |
| Q9 许可静态断言 | 本任务只在自己文件头声明；守门断言不存在，不新增（与 Gemini 同一处理） | 本任务决定 |

### 未验证的点（不要当断言用）

| 点 | 状态 |
|---|---|
| 响应字段形状 | 第三方记录（PaceBar + 官方论坛贴文互证），**本机无账号可抓**；fixture 逐字标注来源与检索日期，不得标「实测」 |
| `planUsage` 之外的响应键 | fixture 只覆盖见过的键；未知键忽略（不报错不断言） |
| `membershipType` 完整值域 | 只见到 5 个值 → **不写 switch 白名单**，原样透传 + title-case |
| User-Agent 伪装是否必需 | 未验证 → 先不伪装，用可识别自己的 UA；401/403 时再考虑（代码注释写清） |
| `api2.cursor.sh` 限流配额 | 无公开文档 → 不额外限速，429 当可诊断错误处理 |
| Electron 打包后 `node:sqlite` | opencode.ts 在用但未单独验证 → 实现时在 Electron 里实测一次 |
| CLI `auth.json` 确切路径 | 三方分歧 → **多候选试探** + 认 `CURSOR_CONFIG_DIR` / `XDG_CONFIG_HOME` |
