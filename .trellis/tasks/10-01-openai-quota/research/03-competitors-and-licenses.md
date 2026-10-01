# Research 03 · 竞品调研与许可协议

- **Query**: CodexBar / ClaudeBar / opencode-quota / token-monitor 怎么做的？仓库名 + 许可协议
- **Scope**: external
- **检索日期**: 2026-10-01

---

## 许可对本仓库的约束

本仓库边界（任务书原文）：
> 「参考思路自己重写；若复用片段必须在文件头附版权与许可声明」

已在本仓库落地的先例（照抄这个模式）：

```ts
// src/main/adapters/opencode-cookie.ts:22-23
// 逻辑移植自 dsh-opencode-go-usage（MIT）的 cookie 规范化部分：
//   https://github.com/v587d/dsh-opencode-go-usage
```

本任务**建议不复制任何代码**，只按观测到的端点形状**自己重写解析器**，
理由见 `05-design-decisions.md`。

---

## 1. CodexBar — 最直接的参照 ⭐

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/steipete/CodexBar |
| 作者 | Peter Steinberger (steipete) |
| **许可** | **MIT** |
| 规模 | 22.1k stars / 2.0k forks / 6479 commits |
| 平台 | macOS 14+ 菜单栏 app + Linux Qt6 + CLI |
| 文档 | `docs/codex.md`（Codex provider）、`docs/openai.md`（API provider）、`docs/provider.md`（新增 provider 指南） |

**它对 OpenAI 的做法（`docs/codex.md`，逐字要点）**：

1. **数据源与回落顺序**
   - App 默认：① OAuth API（auth.json 凭据）② CLI RPC（`codex app-server`）
   - ③ 仅当用户**显式开启** OpenAI web extras 且有匹配会话时，dashboard 增强项作为
     **第二次刷新**加载，source 标签变为 `primary + openai-web`。
2. **主路径端点**：`GET https://chatgpt.com/backend-api/wham/usage`，
   带 `Authorization: Bearer <token>`；reset-credit 另打
   `GET /backend-api/wham/rate-limit-refit-credits`（best-effort，每轮刷新读一次）。
3. **窗口映射**：`rate_limit.primary_window` / `secondary_window`
   → session / weekly 两条 lane。
4. **凭据读取**：`~/.codex/auth.json`（或 `$CODEX_HOME/auth.json`）；
   缺失/不可读/半发布时**间隔 50ms 重试两次**；到期 token 会**重读**再决定是否报「需刷新」。
5. **token 所有权（对我们最关键的一条）**：
   > 「CodexBar **never publishes refreshed native tokens into `auth.json`**;
   > when native credentials are stale, … delegates recovery to the Codex CLI,
   > which owns that file. If the CLI is unavailable, the OAuth error is surfaced
   > instead of mutating the shared file.」
   → **我们也不该写回 `auth.json`。**
6. **读别的应用的 OAuth 文件**（「External Codex OAuth sources」）**默认关闭**，
   文档明写 "This cross-application credential access defaults off."
7. **API provider 与订阅 provider 是两个独立 provider**（`docs/openai.md`：
   "targets the API Platform organization dashboard, **not** ChatGPT/Codex subscription limits"）。
   → 与本任务 `01-current-state-openai-billing.md` 的结论一致。

**MIT 义务**：保留版权与许可声明。**我们不需要声明** —— 不复用代码。

---

## 2. ClaudeBar

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/tddworks/ClaudeBar |
| 作者 | tddworks |
| **许可** | **未验证**（仓库页未在检索中返回 license 字段；SourceForge 有镜像 https://sourceforge.net/projects/claudebar.mirror/） |
| 定位 | macOS 菜单栏，监控 Claude / Codex / Antigravity / Gemini 等 AI 助手额度 |
| 与本任务的关系 | **间接** —— 它证明「ChatGPT 额度」在菜单栏类工具里是常规需求；Claude 的额度获取路径（OAuth vs cookie）值得对照 |

⚠ **实现前若要参考其代码，必须先确认 LICENSE 文件内容。**

---

## 3. opencode-quota 家族（三个独立项目，注意别混淆）

| 仓库 | 许可 | 说明 |
|---|---|---|
| https://github.com/slkiser/opencode-quota | **MIT** | OpenCode 配额 + token 用量，TUI 状态栏 / sidebar。README 明确「非 OpenCode 官方，无关联」 |
| https://github.com/PhilippPolterauer/opencode-quotas | **MIT** | opencode 插件；配置项含 `disabled: ["ag-pro", "codex-smart"]` —— **说明它也覆盖 codex** |
| https://github.com/leo000001/opencode-quota-sidebar | **MIT**（npm `@leo000001/opencode-quota-sidebar` 4.1.2，Libraries.io 标注） | sidebar |

- 与本任务的关系：**OpenAI 侧的参照价值低**，但它们的许可都是 MIT，
  且它们把 codex 额度当作插件内的一个 provider 看待 —— 支持「独立 provider」的判断。

---

## 4. token-monitor —— **未能确认存在该仓库**

检索到的相关物（都不是 `token-monitor` 这个确切仓库名）：

- `cctokmon` —— Claude Code 终端用的 token monitor（仅 Facebook 帖提及，**无仓库**）
- `opencode-quota`（上方）常被称为 token monitor
- GitHub topic `quota-tracker`（https://github.com/topics/quota-tracker）：
  「Track AI API quotas across Synthetic, Z.ai, Anthropic (Claude Code), Codex,
  GitHub Copilot & Antigravity in real time.」
  → 该 topic 下有具体仓库，但检索结果未返回仓库名，**未能确认**

→ **标注为「未找到确切仓库」**，不臆造。

---

## 5. 其他可参考的、已确认许可的项目

| 项目 | 许可 | 与本任务的关系 |
|---|---|---|
| openclaw/openclaw | 见仓库 release（检索未确认 LICENSE） | release notes 提到 "WHAM usage" 来源标注治理 |
| headroomlabs-ai/headroom | 未确认 | CHANGELOG 有 `codex: poll /wham/usage for subscription …` |
| pleaseai/shunt | 未确认 | 文档写明 `wham/usage` polling 填充 5-hour / shared weekly windows |
| simonw/llm-openai-via-codex | 未确认 | **最小实现参考**：从本地 Codex CLI 借 `(access_token, account_id)` 并自动刷新 |
| pydantic-ai（`OpenAICodexProvider`） | MIT | 有完整的 `OpenAICodexOAuthFlow`（不依赖 Codex CLI 的独立 OAuth 实现） |
| langchain_openai `ChatOpenAICodex` | MIT | `_ChatGPTOAuthTokenProvider` 负责 `Authorization` + `ChatGPT-Account-Id` 头 |
| dsh-opencode-go-usage | **MIT**（已在本仓库注明出处） | 本仓库既有先例 |

---

## 6. 从竞品提炼的三条对本仓库有约束力的结论

1. **竞品一致选择 OAuth bearer 而非 cookie 作为主路径**（CodexBar 明确把 cookie 排在
   「可选增强」）。→ 支持 `05-design-decisions.md` 的推荐。
2. **没有任何人写回 Codex 的 `auth.json`**（CodexBar 明文禁止；Simon Willison 那种
   独立工具才做，且那是它自己拥有的文件场景）。→ 我们也不写。
3. **「读另一个应用的 OAuth 文件」在成熟工具里是被显式开关保护的行为**。
   → 我们若读 `~/.codex/auth.json`，UI 文案必须说清「读的是 Codex CLI 自己的登录凭据」，
   并考虑是否需要一个显式开关（见 `07-open-questions.md`）。

---

## Caveats

- **所有许可协议均来自 2026-10-01 的仓库页/README 摘要，未逐一打开 LICENSE 文件核对。**
  若要真正复用任何代码，**必须先读 LICENSE 原文**。
- ClaudeBar、headroom、shunt、openclaw 的许可**未验证**。
- `token-monitor` **未能确认对应仓库存在**。
- 本次未检索 GitHub Code Search（需认证），覆盖可能不完整。