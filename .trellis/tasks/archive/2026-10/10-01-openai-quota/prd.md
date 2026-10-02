# OpenAI 额度（升级 `codex.ts` 数据源）

## Goal

把 `codex.ts` 的数据源升级为 **`wham/usage` 主动查询优先、jsonl 转录兜底**，
让同一份服务端真值从"只能等 CLI 跑过才有"变成"随时可查"。**不新增独立卡片**
（两者是同一份服务端真值，另起卡片等于让用户看到两张同一份额度）。

调研原文与逐字证据：`.trellis/tasks/10-01-openai-quota/research/`
（`00-index.md` 总览 / `01-current-state-openai-billing.md` 现状 /
`02-endpoints-and-auth.md` 端点与鉴权 / `03-competitors-and-licenses.md` 竞品与许可 /
`04-credential-security-and-degradation.md` 凭据与降级 /
`05-design-decisions.md` 设计决策 / `06-pitfalls-and-graceful-degradation.md` 踩坑 /
`07-open-questions.md` 待确认问题）

## Background

### 端点（无官方文档；四个互不相关的项目在用同一端点，2026-10 仍活着）

```
GET https://chatgpt.com/backend-api/wham/usage
    Authorization: Bearer <access_token>        ← ~/.codex/auth.json 的 tokens.access_token
    ChatGPT-Account-Id: <account_id>            ← 同文件的 tokens.account_id（多 workspace 必需）
    → { plan_type, rate_limit: { primary_window: { used_percent, limit_window_seconds, reset_at },
                                secondary_window: {...} | null } }
```

### 关键事实：`wham/usage` 与 jsonl 转录是同一份服务端真值

`codex.ts` 今天从 `~/.codex/sessions/**/rollout-*.jsonl` 的 `rate_limits` 事件读
`primary/secondary` —— 那正是服务端下发给 CLI 的同一份 `used_percent`。
方案 A 只是换了个更直接的拿法（主动查 vs 等快照），口径零变化。

### 前置已交付

- 采集接缝（`168c6bc`）+ `readJson` 可选第 5 参——wham 是 GET，只需透传 headers，
  `readJson(ctx, url, headers)` 现状即够用，`engine.ts` 不动
- 段字母锁定：Gemini `V` · Cursor `W` · Antigravity `X` · **OpenAI `Y`**
  （V/W/X 已被占，Y 是最后一个空闲语义字母）
- `codex.ts` 今天**零 fixture**（第一个给它加黄金样本的任务）

## Requirements

### R1 · 落点：只改 `codex.ts`，不新增文件

1. 修改 `src/main/adapters/codex.ts`（唯一产品代码改动）：
   `wham/usage` 主动查询优先，现有 jsonl 逻辑**逐字保留**作兜底。
2. **不碰** `protocols.ts`（N7 守着 8 条）、`index.ts`（注册不变）、`providers.ts`
   （预设不变）、`gen-provider-icons.mjs` + `provider-icons.ts`（`codex` 键已存在）、
   `src/renderer/**`（零 UI 改动）。
3. **不碰** `openai-billing` 声明（Q6 A：它可能已废弃，发现即单独上报，不顺手改共享文件）。

### R2 · 优先级链（D2，wham 成功则升级，失败则今天什么样还什么样）

4. `resolveCreds()` 有 token → 打 wham：
   - 200 + 可识别形状 → wham 窗口（official），**直接返回，不再碰 jsonl**
   - **401 → `errSnap`「请运行 `codex login`」，不回退**（凭据已死，回退只会拿旧快照冒充 live 真值）
   - 其他失败（403/429/404/抛错/形状认不出）→ **静默走现有 jsonl 逻辑**（今天什么样还什么样）
5. `resolveCreds()` 无 token → 现有 jsonl 逻辑**逐字不变**（无 auth.json 用户零感知）。

### R3 · 凭据三源，只读不写

6. 顺序：`$CODEX_HOME/auth.json`（缺省 `~/.codex/auth.json`）的
   `tokens.access_token` + `tokens.account_id` →
   环境变量 `CODEX_ACCESS_TOKEN`（单个名字，pi 先例；account_id 无）→
   `ctx.getKey(instanceId)` 手动 token（`items` 加密，**优先级最低**）+
   `ctx.getExtra('accountId:codex')`（account_id 非凭据，可明文；沿 `limits:claude` 冒号惯例）。
7. `account_id` 缺失 → 省略 `ChatGPT-Account-Id` 头，照常请求（单 workspace 降级）。
8. **绝不写回 `auth.json`**（Codex CLI 的文件；CodexBar 明文禁止，我方亦然）。
   **不新增任何返回 token 的 IPC**（E5/F6 门禁守着）。

### R4 · 窗口：与现有 `buildServerWindows` 同形

9. `{ used: 0（或见 R5）, unit: 'token', percent: used_percent,
    resetAt: new Date(reset_at * 1000).toISOString(), note: '服务端真值' }`。
   `reset_at` 是 **Unix 秒**（与 billingCycle 毫秒、`resets_in_seconds` 相对秒三套单位各不相同，
   分开处理，混了就把重置时间算错）。
10. 窗口名**按 `limit_window_seconds` 映射，不硬编码**：
    `18000`→`'5 小时'`，`604800`→`'本周'`；未知秒数按算术推导
    （整小时→`'N 小时'`，整天→`'N 天'`，否则→`'N 秒窗口'`）。
11. `secondary_window: null` → 只产出一个窗口（不造第二个）。
12. `used_percent` 缺失的窗口直接跳过（不产出 `percent: 0`——"花了却显示 0%" 是撒谎，
    `opencode-cookie.ts:167-171` 已付费学过）。
13. `plan` 保持 `'ChatGPT 订阅'`（与 `codex.ts:253` 一字不差，不发明 tier 中文名）。

### R5 · used 回填：有 sessions 就填，没有就 0

14. wham 成功且 sessions 可读 → 用现有 `sumSince` 逻辑回填各窗口 `used`
    （窗口起点 = `reset_at - limit_window_seconds`，与现有 `resetAt - 5h` 同式）。
    无 sessions → `used: 0`（网页版用户的新增量：今天他们是 nodata）。
15. `dataQuality`：wham 成功 → `'official'`；jsonl 路径 → 今天什么样还什么样；
    所有失败 → `undefined`；`local` 只出现在现有本地估算分支（不新增）。

## Constraints

- **共享文件只追加**：`scripts/test-adapters.mjs` 是四家共改文件（V/W/X 已被占，
  OpenAI 用 `Y`）。段字母撞车会让两段互相覆盖，且表现为"某段没跑到"而非报错。
- **凭据字面量红线**（`store.ts:13`）：源码、示例、测试禁止出现可用凭据字面量。
  fixture token 用明显假的 `fake-jwt-for-tests`，account_id 用假 uuid。
- **许可边界**：参考思路自己重写，不逐行复制。CodexBar（MIT）只取端点/头/形状事实；
  ClaudeBar（许可未验证）只读结论不碰代码；`token-monitor` 未能确认仓库存在，不引用。
- **v1 只做 `wham/usage`**（Q7）：不做 `rate-limit-reset-credits`（明确 429 记录）、
  不做 `monthly-usage`（普通账号必然 404）、不做 `/backend-api/codex/usage`（未验证存在）、
  不做 `additional_rate_limits` 每模型明细。
- **不新增网络请求**：wham 每轮最多 1 次（失败不重试，401/403/429 一律不自动重试）；
  现有 jsonl 解析是纯本地，不新增出网。
- **单账号**（Q3 A）：`CODEX_HOME` 进程级，多 home 需求留给用户自己改环境变量；
  `shared/types.ts` 不加字段。
- **无开关**（Q2 A）：与 claude/codex/copilot 的 `localCredential` 语义一致；
  文案写清"读取 Codex CLI 自己的登录凭据文件，不修改它"，绝不要求输入密码。

## Acceptance Criteria

- [ ] AC1 wham happy path → 2 窗口（5 小时 + 本周）+ `plan: 'ChatGPT 订阅'` +
      `dataQuality: 'official'` + `source: '服务端真值'`
- [ ] AC2 请求断言：URL 恰好是 `.../wham/usage`、method GET、
      `Authorization: Bearer <token>` + `ChatGPT-Account-Id: <account_id>` 双头全在
- [ ] AC3 `secondary_window: null` → 只一个窗口（不造第二个）
- [ ] AC4 未知秒数（如 86400）→ 窗口名按算术推导（`'24 小时'`），不是硬编码也不是报错
- [ ] AC5 `used_percent` 缺失 → 该窗口跳过；两窗口都缺 → 走 jsonl 回退（不是 `percent: 0`）
- [ ] AC6 401 → `errSnap` 含 `codex login`，**即使 sessions 里有 rate_limits 也不回退**
      （凭据已死的可见性，D2 的冻结测试）
- [ ] AC7 429 → 静默走 jsonl（fixture：429 + sessions 有 rate_limits → official jsonl 窗口）
- [ ] AC8 404 → 静默走 jsonl；抛错（断网）→ 静默走 jsonl
- [ ] AC9 形状认不出 → 静默走 jsonl（漂移韧性：端点改版不炸掉现有功能）
- [ ] AC10 无 auth.json + sessions 有 rate_limits → 与今天逐字相同的 official 快照（零回归证明）
- [ ] AC11 无 auth.json + 无 sessions → nodata（文案提及两条路：sessions 与服务端查询）
- [ ] AC12 手动 token（getKey）+ extras accountId → wham 成功；`onKey` 收到的是实例 id
- [ ] AC13 env `CODEX_ACCESS_TOKEN` → wham 成功；account_id 缺失 → 请求**无** Account-Id 头但照常发
- [ ] AC14 快照 `JSON.stringify` 后不含 token/account_id 任一片段
- [ ] AC15 `setKey` **从未被调用**（无自愈回写）；`codex.ts` 无 `writeFile*`（不碰 auth.json）
- [ ] AC16 `reset_at`（秒）→ ISO；与 `resets_in_seconds`（相对秒）路径的换算各走各的
- [ ] AC17 有 sessions 时 wham 窗口 `used` 被回填；无 sessions 时 `used: 0`
- [ ] AC18 `codex.ts` 走 `readJson` 出网（静态守卫：无裸 `fetch(`，出网能力可注入）
- [ ] AC19 `plan_type` 各种值（plus/pro/team/free）→ plan 恒为 `'ChatGPT 订阅'`
- [ ] AC20 每条失败路径 `dataQuality === undefined`；成功路径 `'official'`
- [ ] AC21 `protocols.ts` **零改动**（N7 仍绿）；无新增注册/预设/图标改动
      （`git diff --stat` 产品代码只有 `codex.ts`）
- [ ] AC22 `test-adapters.mjs` **Y 段**追加在 X 段之后、汇总行之前，既有行**一行未改**
- [ ] AC23 测试用 `CODEX_HOME` 指临时目录；段末恢复 env；绝不碰真实 `~/.codex`
- [ ] AC24 **`npm test` 全绿，且除 `adapters` 外 19 套件断言数与基线逐个一致**
- [ ] AC25 `npm run typecheck` 通过；`test-structure.mjs` E5/F6 仍绿
- [ ] AC26 **零 UI 改动**（`src/renderer/**` 零 diff；连 `provider-icons.ts` 都不动）
- [ ] AC27 **反验实测**：删掉 `ChatGPT-Account-Id` 头 → Y 段必须报红
- [ ] AC28 **反验实测**：让 collect 跳过 wham（永远走 jsonl）→ wham happy-path 断言必须红

## Notes

### 用户 / 前期已定的决策

| 问题 | 结论 | 来源 |
|---|---|---|
| 方案 A vs B vs C | **A：升级 `codex.ts`，不新增卡片**（同一份服务端真值） | 前期已定 |
| 段字母 | **OpenAI 用 `Y`**（V/W/X 已被占） | 父任务 prd.md:79 |
| Q2 开关 | **A：不加**（与三家本机预设语义一致） | 本任务决定（采纳调研建议） |
| Q3 多账号 | **A：单账号**，`shared/types.ts` 不加字段 | 本任务决定 |
| Q4 合并策略 | 串行执行，本任务emar 最后一家，无冲突 | 现状 |
| Q5 真实凭据实测 | 有账号则做（升级 fixture 为实测）；无则二手 fixture + 明确标注 | 待定（见遗留） |
| Q6 openai-billing | **A：不动**，发现 404/401 单独上报 | 本任务决定 |
| Q7 v1 边界 | 只做 `wham/usage` 三字段组 | 本任务决定 |

### 未验证的点（不要当断言用）

| 点 | 状态 |
|---|---|
| 响应字段形状 | 二手（CodexBar#2900 EDU 样本 + gist 摘要），**本机零实测**；fixture 逐字标注来源与检索日期，不得标「实测」 |
| `ChatGPT-Account-Id` 是否必需 | 未验证 → 缺失时省略照发（单 workspace 降级），不断言服务端行为 |
| `free` 计划的 wham 行为 | 未验证（是否只有 primary_window）→ fixture 不编，代码按"缺啥跳啥"处理 |
| access_token 典型有效期 | 未验证（CodexBar 只说会过期）→ 不做过期预判，401 见招拆招 |
| UA/Origin/Cookie 要求 | 未验证 → 只发 Bearer + Account-Id + Accept（仓库惯例），不伪装 |
| `/backend-api/codex/usage` | 未验证存在 → 实现不依赖，-testid 不覆盖 |
