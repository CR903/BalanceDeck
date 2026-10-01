# Gemini Code Assist 适配器 — 实现前协议调研（索引）

- **Task**: `.trellis/tasks/10-01-gemini-code-assist`（父任务 `10-01-p1-remaining`）
- **Date**: 2026-10-01
- **范围**: 实现前的协议 / 来源 / 凭据 / 降级 / 落点 / 测试 / 踩坑调研。**未改任何产品代码。**

## 文件清单

| 文件 | 内容 | 对应任务问题 |
|---|---|---|
| [`01-protocol-research.md`](./01-protocol-research.md) | 有无官方 quota API、端点与响应形状逐字、凭据形态、本机路径、**可选来源与代价（含竞品与许可）**、10 个必踩的坑 | Q1 / Q2 / Q8 |
| [`02-adapter-design.md`](./02-adapter-design.md) | 协议 vs 独立适配器、kind/mark、凭据存储与渲染层红线、**9 条降级分支表**、collect 骨架 | Q3 / Q4 / Q5 / Q6 |
| [`03-testing-and-pitfalls.md`](./03-testing-and-pitfalls.md) | 共享文件段位地图、**结构性阻塞：夹具送不出请求体**、fixture 造法、**33 条断言清单** | Q7 / Q8 |

---

## 一页纸推荐方案

```
数据源   POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota
         （前置 POST /v1internal:loadCodeAssist 取 cloudaicompanionProject）
         → buckets[]，每项 { modelId, tokenType:"REQUESTS", remainingFraction: 0–1, resetTime }
凭据     只读 $GEMINI_CLI_HOME/oauth_creds.json → ~/.gemini/oauth_creds.json
         （次选 gcloud ADC）。client_id/secret 就在该文件里。
         **不回写我们的 keystore，不新增任何回传 token 的 IPC**
落点     独立代码适配器 src/main/adapters/gemini.ts + CODE_ADAPTERS['gemini']
kind     'coding'      mark 'gemini'（preset id == protocol id）
窗口     unit:'percent'，used = 已用百分比，(1-remainingFraction)*100，只给 percent 不给 limit
dataQ    成功 officialSnap；所有失败 errSnap（dataQuality 必须 undefined，ADR-0002）
测试     scripts/test-adapters.mjs 追加 V 段（插在 1220 与 1221 行之间）
否决     Cloud Console 抓取 / Cloud Quotas API / Cloud Monitoring / 第三方缓存文件
```

---

## 三个必须先知道的结论

### 1️⃣ 有事实上的权威端点，但它不是公开 API

Google **没有**发布「Gemini Code Assist 个人额度查询」的公开 API。Cloud Monitoring（组织级聚合）与 Cloud Quotas API（project 级）都拿不到 per-user 口径。
唯一能拿到 per-account 真值的是 Gemini CLI 官方客户端自己在用的 `cloudcode-pa.googleapis.com/v1internal:*` 端点族。端点、请求体、响应字段已从 `google-gemini/gemini-cli`（Apache-2.0）源码**逐字核对**，见 01 §1.2。

### 2️⃣ ⚠️ 2026-06-18 免费 / Pro / Ultra 档已全部关停

Google 官方 deprecation 页明确：Code Assist IDE 扩展与 Gemini CLI 从 2026-06-18 起**不再为 Gemini Code Assist for individuals / Google AI Pro / Google AI Ultra 服务**，「Login with Google」选项也已移除。

**活着的只有**：Workspace **Code Assist Standard / Enterprise** 许可 + Gemini API key。

→ 这直接影响任务的价值判断：**如果产品预期是「个人免费用户看额度」，目标用户群几乎为空。** 列为待确认问题 **Q-a**。

### 3️⃣ 🚧 测试夹具目前送不出 POST 请求体

`CollectRequest`（`types.ts:11-16`）和 `request.ts:21` **都没有 body 字段**，测试桩 `callProject`（`test-adapters.mjs:112-118`）也不记录 body。
→ Gemini 需要的两次 POST 都发不出 body，且 **`{ project }` 这个最关键的字段完全无法断言**。
→ 已给出最小扩接缝方案（`body?: string` 可选，既有调用点与 fixture 零影响），列为待确认问题 **Q-b**。

---

## 需要用户确认的问题（汇总）

| # | 问题 | 我的倾向 | 出处 |
|---|---|---|---|
| **Q-a** | 是否接受只支持 **Code Assist Standard / Enterprise**（免费档已关停）？ | 按 Enterprise/Standard 做 | 01 §4 P3 |
| **Q-b** | `CollectRequest` 加 `body?: string`（配套 `request.ts:21` + 新增 `callProjectWithBody`，**既有函数一行不动**）—— 批准吗？ | 建议批准 | 03 §2 |
| **Q-c** | 若不批准 Q-b：接受「请求体不被测试覆盖」？ | 不理想但可行 | 03 §2.2 |
| **Q-d** | 要不要支持用户**手填 refresh token**（写 `items`）？还是只读本机文件？ | 先只做本机文件（与 claude/codex/copilot 一致） | 02 §3.2 |
| **Q-e** | 是否需要特殊处理「自定义实例」入口？ | 不特殊处理（preset id == protocol id，行为与 claude 相同） | 02 §6 |
| **Q-f** | `providers.ts` 的 `BUILTIN_PRESETS` 归谁改？会影响 T 段目录断言 | 需确认无并发冲突 | 02 §1.4 |
| **Q-g** | 夹具用 env 指向临时目录，还是让适配器导出可注入的读文件函数？ | **推荐后者**（不碰 env、不落盘、更快） | 03 §3.3 |
| **Q-h** | V 段独立编号 `V`，还是并入 `N` 段？ | 独立 V 段 | 03 §5 |
| **Q-i** | 能否提供一个**可用的 Code Assist Standard/Enterprise 账号**跑一次 `--uitest`？ | **强烈建议** —— 会把 fixture 从「按类型定义推的」升级为「实测的」 | 03 §6 |

---

## 信息源清单（含许可）

### 一手 / 权威

| 来源 | 许可 | 用到了什么 |
|---|---|---|
| [`google-gemini/gemini-cli`](https://github.com/google-gemini/gemini-cli)（107k★） | **Apache-2.0**（每文件头 `SPDX-License-Identifier: Apache-2.0` + `Copyright 2025 Google LLC`） | `code_assist/types.ts`（`BucketInfo`/`LoadCodeAssistResponse`/`UserTierId`）、`code_assist/server.ts`（端点常量、`requestPost` 重试策略、VPC-SC 判定）、`code_assist/oauth2.ts`（OAuth client 常量、凭据缓存路径与 0600 写入）、`code_assist/setup.ts`（`loadCodeAssist` 的 metadata 常量）、`config/storage.ts`（`getOAuthCredsPath`）、`utils/paths.ts`（`GEMINI_CLI_HOME` 覆盖） |
| [Gemini for Google Cloud — Quotas and limits](https://docs.cloud.google.com/gemini/docs/quotas) | 文档 CC-BY-4.0（页面页脚声明） | 各档限额数字、2 req/s 限流 |
| [Gemini Code Assist consumer accounts（deprecation）](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals) | 同上 | 2026-06-18 关停 |
| [Google Developers Blog — Transitioning Gemini CLI to Antigravity CLI](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli) | 同上 | 继任产品时间线 |
| [Monitor Gemini Code Assist usage](https://docs.cloud.google.com/gemini/docs/codeassist/monitor-gemini-code-assist) | 同上 | Cloud Monitoring 指标清单（用于论证「否决」理由） |
| [Cloud Quotas API REST reference](https://docs.cloud.google.com/docs/quotas/reference/rest) | 同上 | 粒度为 project/folder/org（用于论证「否决」理由） |
| [Cloud Quotas API — Go packages](https://pkg.go.dev/cloud.google.com/go/cloudquotas/apiv1) | 同上 | 确认无 per-user Code Assist 配额项 |
| [Antigravity CLI docs（安装与鉴权）](https://antigravity.google/docs/cli/install) | 同上 | 钥匙串鉴权、配置文件路径（后继产品，本任务外） |
| [`google-antigravity/antigravity-cli`](https://github.com/google-antigravity/antigravity-cli) | **未核对**（README 含 ToS/数据使用条款） | 仅确认存在 |

### 真实响应样本

| 来源 | 可信度 |
|---|---|
| [gemini-cli issue #27363](https://github.com/google-gemini/gemini-cli/issues/27363) | 高 —— 用户贴出的**真实原始响应**；并含官方 `config.ts` 的 `for (const bucket of quota.buckets)` 代码片段，确认数组键名 |
| [gemini-cli issue #14883](https://github.com/google-gemini/gemini-cli/issues/14883) | 高 —— 证明 token 桶耗尽时**不**出现在响应里 |
| [CLIProxyAPI issue #1015](https://github.com/router-for-me/CLIProxyAPI/issues/1015) | 中高 —— 17 个账号 generation 全 429 而 quota API 报 60–100%，证明「配额读数 ≠ 可发请求」 |

### 第三方参考实现（**只参考思路，不逐行复制**）

| 项目 | 仓库 | 许可（GitHub API SPDX 核对） | 用到了什么 |
|---|---|---|---|
| hermes-quota-plugin | [`rarf/hermes-quota-plugin`](https://github.com/rarf/hermes-quota-plugin) | **MIT** | `quota_providers/gemini.py`：完整流程、凭据读取、tier 映射、免费档退役处理。⚠️ 其读 `data.get("quota")` **与官方类型定义矛盾**（01 P10） |
| CodexBar | [`steipete/CodexBar`](https://github.com/steipete/CodexBar)（22k★） | **MIT** | `docs/gemini.md`：端点、token 刷新 form body、project 发现（含 `cloudresourcemanager` 回落）、tier→人类名映射 |
| codexbar | [`bcharleson/codexbar`](https://github.com/bcharleson/codexbar) | **MIT** | 同上文档 |
| ClaudeBar | [`tddworks/ClaudeBar`](https://github.com/tddworks/ClaudeBar)（1.5k★） | 站点/README 声称 MIT，**GitHub API `spdx_id` 返回 `null` → 未验证** | provider 清单含 Gemini；`Sources/CodexBarCore/Providers/Gemini/GeminiStatusProbe.swift` |
| agy-quota | [`tingyi365/agy-quota`](https://github.com/tingyi365/agy-quota) | **MIT** | Antigravity keychain 路径（service `gemini`/account `antigravity`，**未验证**）、`daily-cloudcode-pa` 备用主机（**未验证**）、「Claude/GPT 不在 retrieveUserQuota 里」 |
| OpenTokenUsage | [`PowerUserZ/OpenTokenUsage`](https://github.com/PowerUserZ/OpenTokenUsage) | **MIT** | `docs/providers/antigravity.md`：Antigravity 本地 Connect-RPC 端点与响应形状 |
| gemini-cli-usage | PyPI | **未核对** | 说明 `~/.gemini/usage-limits.json` 是**第三方工具的派生缓存** → 列为「否决」 |
| claudebar（同名无关） | [`kevinmaes/claudebar`](https://github.com/kevinmaes/claudebar) | MIT | 纯 Claude bash 状态栏，与 Gemini 无关 |
| ClaudeBar（Touch Bar） | [`narendraio/ClaudeBar`](https://github.com/narendraio/ClaudeBar) | MIT | 纯 Claude，**零网络请求** |
| AIQuotaBar | [`yagcioglutoprak/AIQuotaBar`](https://github.com/yagcioglutoprak/AIQuotaBar) | MIT | 无 Gemini |

### 复用边界声明

> 仓库纪律：**参考解析思路并自己重写，不逐行复制；复用片段须在文件头附版权与许可声明。**

落到本任务：
- **可以照抄的**（接口事实，非创作表达）：端点 URL、请求/响应字段名、OAuth client id/secret、tier id 枚举、限额数字。
- **可以照抄思路的**（各实现必然相同，因为接口就那样）：两阶段请求、`100 - remainingFraction*100`、tier→人类名映射。
- **不照抄的**：任何 Python / Swift 函数体；`hermes` 那个「拆两半拼 client_id」的注释文案（保留行为，换自己的说法）。
- **建议主动加的文件头声明**（成本为零）：
  ```ts
  // 端点常量与字段名参考自 google-gemini/gemini-cli（Apache-2.0, Google LLC）
  // 与 rarf/hermes-quota-plugin（MIT）。本文件为独立重写实现。
  ```
  按当前分析**很可能一行代码都不需要复制**，仅引用事实。

---

## 改动落点清单（供 implement 用）

```
新增  src/main/adapters/gemini.ts               # 适配器实现
改    src/main/adapters/index.ts               # import + CODE_ADAPTERS['gemini']
改    src/main/providers.ts  BUILTIN_PRESETS    # ⚠ 可能与他人并发（Q-f）
跑    node scripts/gen-provider-icons.mjs       # provider-icons.ts 是生成物，勿手改
追加  scripts/test-adapters.mjs  V 段          # ⚠ 只追加，插在 1220/1221 之间
─── 若批准 Q-b ───
改    src/main/adapters/types.ts               # CollectRequest 加 body?: string
改    src/main/request.ts:21                   # fetch 传 body
改    scripts/test-adapters.mjs                # 新增 callProjectWithBody（既有函数不动）
─── 不碰 ───
     src/main/adapters/protocols.ts           # 四家适配器子任务共用，会冲突
     src/shared/quality.ts                    # 降级逻辑已完备
```

---

## 尚未验证的点（不要当断言用）

| 点 | 状态 |
|---|---|
| 响应数组键是 `buckets` 还是 `quota` | 官方源码 = `buckets`（高置信）；`quota` 仅见于一个第三方实现 → 实现时**两者兼容** |
| `expiry_date` 单位是毫秒 | google-auth-library 约定（高置信），未在本机文件上核对 |
| 活账号实际返回几个 bucket、有无非 `REQUESTS` 桶 | **完全未验证** |
| `daily-cloudcode-pa.googleapis.com` 提供同端点 | 单一来源，**未验证** → 只留 env override，不默认用 |
| token 刷新 400 + `invalid_grant` 的 body 形状 | 标准行为推断，**未验证** → 解析时宽松取 `error` 字段 |
| 真实 `ineligibleTiers[].reasonMessage` 文案 | **未验证** → `detail` 直接回显 Google 给的原文，不自己编 |
| `claude.ts` 等本地估算类适配器是否有本机转录可参照 | Gemini **没有**（无 `~/.claude/projects/*.jsonl` 类转录）→ 不做 `local` 降级 |
