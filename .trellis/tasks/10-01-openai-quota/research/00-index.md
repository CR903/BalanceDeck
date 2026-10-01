# Research 00 · 总览与推荐方案

- **Task**: `10-01-openai-quota` — 新增 OpenAI（ChatGPT Plus/Pro 额度）供应商适配器
- **性质**: 实现前协议调研（只读；未改任何代码）
- **Date**: 2026-10-01（所有外部信息检索日期同为 2026-10-01）

---

## 一句话结论

> **任务前提需要修正**：`chatgpt.com/backend-api/` 的主数据路径
> `wham/usage` 用的是 **`Authorization: Bearer <access_token>`**
> （Codex CLI 的 ChatGPT OAuth token），**不是浏览器 cookie**。
> 照这个做，Q3 的「cookie 结构性风险」不成立，
> 而且完全复用了本仓库**已经在读**的 `~/.codex` 目录。

---

## 文件导航

| 文件 | 回答的问题 |
|---|---|
| `01-current-state-openai-billing.md` | **Q1** 现状：`openai-billing` 查什么、查不到什么、与订阅能否共存 |
| `02-endpoints-and-auth.md` | **Q2** 端点清单、鉴权、凭据来源、官方有无公开接口 |
| `03-competitors-and-licenses.md` | **Q2 续** 竞品（CodexBar / ClaudeBar / opencode-quota / token-monitor）+ 许可 |
| `04-credential-security-and-degradation.md` | **Q3 Q4 Q5** cookie 风险、凭据存储、渲染层边界、降级矩阵 |
| `05-design-decisions.md` | **Q6 Q7 Q8** kind/mark、扩展还是新增、fixture 断言清单 |
| `06-pitfalls-and-graceful-degradation.md` | **Q9** 限流、header、改版频率、优雅降级、风险登记 |
| `07-open-questions.md` | 需要用户拍板的问题 |

---

## 推荐方案（摘要）

### 数据源

```
主路径：GET https://chatgpt.com/backend-api/wham/usage
        Authorization: Bearer <tokens.access_token>     ← ~/.codex/auth.json
        ChatGPT-Account-Id: <tokens.account_id>
```

**不做** cookie 路径。**不做** `reset-credits` / `monthly-usage`（可选增强，
且都有已知 429 / 404 记录）。**不依赖** `/backend-api/codex/usage`（未验证）。

### 凭据

- 读 `$CODEX_HOME/auth.json`（缺省 `~/.codex/auth.json`）的
  `tokens.access_token` + `tokens.account_id`
- **零拷贝、不落盘、不写回**（`auth.json` 是 Codex CLI 的文件）
- 用户若要脱离 Codex CLI：手动 token → `setKey()` → `items`（safeStorage 加密），
  **绝不进 `extras`**
- 环境变量兜底：`CODEX_ACCESS_TOKEN` / `OPENAI_CHATGPT_TOKEN`

### 代码落点

| 决策 | 推荐 | 主要理由 |
|---|---|---|
| 改 `protocols.ts`？ | **否** | ① ADR-0001：声明表达不了「本机文件 + 额外请求头」；② `test-adapters.mjs:752-756` 的 N7 断言声明表恰好 8 条，加一条必红；③ 任务书明令勿碰 |
| 扩展 `openai-billing`？ | **否** | host / 鉴权 / 凭据来源 / kind / 窗口语义 / 降级档位**六项全不同** |
| 新增代码适配器？ | **是** | `src/main/adapters/openai-chatgpt-api.ts`（常量）+ `openai-chatgpt.ts`（适配器） |
| `kind` | **`coding`** | `balance` 会让 UI 当余额；`token` 语义是「有 token 数的套餐」，而 `wham/usage` 只给 `percent` |
| 窗口形状 | `{ name, used: 0, unit: 'token', percent, resetAt, note: '服务端真值' }` | 与 `codex.ts:155-182` 完全同形（既有先例） |
| `mark` | 新增 id → 复用 `simple-icons:openai` | `mark = presetId \|\| protocol`（`bind-instance.ts:27`）；**不要**复用 `openai-billing` 键 |
| 内部实现映射 | `METER_FIELDS` 式映射 + **未知字段列表** | 层内规则第 3 条「未知形状要有出口」 |

### 测试

追加 `V` 段到 `scripts/test-adapters.mjs`（**共享文件，勿覆盖他人段落**）。
注意 `callProject` 只记录 `url`/`auth`/`accept`，断言 `ChatGPT-Account-Id`
需段内局部 helper。fixture 用 CodexBar#2900 的真实响应形状并标注来源。

---

## 与其它三个适配器子任务的共享文件冲突面

| 文件 | 冲突原因 | 建议 |
|---|---|---|
| `src/main/adapters/protocols.ts` | 四家共用 | **本任务不改** |
| `src/main/adapters/index.ts` | 都要往 `CODE_ADAPTERS` 注册 | 串行合并，或合并到一个 PR |
| `scripts/test-adapters.mjs` | 都要在尾部追加段 | 段标题带语义前缀；`git diff` 检查 |
| `scripts/gen-provider-icons.mjs` | 都要加图标映射 | 同上 |
| `src/renderer/src/provider-icons.ts` | 同上 | 同上 |
| `src/main/providers.ts` | `BUILTIN_PRESETS` 追加 | 同上 |
| `src/shared/types.ts` | 共享类型 | **本任务不需要改** |

---

## 需要用户确认的问题

见 `07-open-questions.md`，最重要的三个：

1. **与现有 `codex` 卡片的关系** —— `codex.ts` 已经在显示 5 小时/本周的 ChatGPT 额度
   （从 `~/.codex/sessions` 的 `rate_limits` 读）。新卡用**主动查询**同一份服务端真值，
   装了 Codex CLI 的用户会看到**两张卡片同一份额度**。
   选 A 合并进 `codex.ts` / 选 B 独立适配器 / 选 C 独立但只在无 Codex CLI 时出现？
2. **是否需要一个显式开关**才能读 `~/.codex/auth.json`？
   （CodexBar 把「读别的应用的 OAuth 文件」做成默认关闭的开关。）
3. **是否需要先做一次真实凭据实测**？
   本调研**全部无凭据、零实测**，所有外部信息为二手。
   `.trellis/spec/guides/external-api-integration.md` Step 1~2 要求
   「观测真实产品页面实际请求什么」，**只靠二手文档实现有风险**。

---

## Caveats（全局）

- **本次调研零实测**：没有 ChatGPT Plus/Pro 凭据，没有 Codex CLI 安装可读。
  外部信息全部来自公开文档、竞品文档与 GitHub issue，均为二手。
- 所有外部链接检索于 2026-10-01，未逐一打开 LICENSE 原文核对。
- `openai-billing` 端点（`/v1/dashboard/billing/subscription`）是否仍可用：**未验证**，
  但有强证据表明它已不在 OpenAI 公开 API reference 里。