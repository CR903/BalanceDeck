# Research: 竞品支持情况与许可协议

- **Query**: 竞品（CodexBar / ClaudeBar / token-monitor / opencode-quota 等）支持 Cursor 吗？许可协议是什么？
- **Scope**: external（GitHub API 元数据 + 项目文档）
- **Date**: 2026-10-01（GitHub 元数据经 `api.github.com/repos/*` 于当日拉取）

---

## 0. 本仓库的许可边界（父任务 `10-01-p1-remaining/prd.md` 原文）

> **决策：参考「解析思路」并自己重写实现**，不逐行复制他人代码；
> 若确实复用了代码片段，则必须在该文件头附上版权与许可声明。

另外仓库现状：`opencode-cookie.ts:22-23` 已有先例 ——
```
// 逻辑移植自 dsh-opencode-go-usage（MIT）的 cookie 规范化部分：
//   https://github.com/v587d/dsh-opencode-go-usage
```
⇒ **本任务的建议做法**：在 `src/main/adapters/cursor.ts` 文件头用同样格式列出**参考过的项目与许可**，
实现全部自己写。这既满足父任务约束，也不触发任何许可证义务（MIT 允许闭源复用但要求保留声明，
而我们不复用代码 → 连声明义务都没有，只做「致意 + 注明未复制」）。

⚠ 父任务提到「这条边界由 `test-structure.mjs` 的静态断言守门」——
**实测 `scripts/test-structure.mjs` 里没有任何许可/版权断言**（grep `许可|来源|版权|MIT|license` 零命中）。
该守门目前**不存在**，若需要守门得新写（超出本任务范围，列为待确认项）。

---

## 1. 支持 Cursor 的竞品清单

| 项目 | Star | License(GitHub API) | 技术栈 | Cursor 支持方式 | 值得参考的 |
|---|---|---|---|---|---|
| [steipete/CodexBar](https://github.com/steipete/CodexBar) | 22,092 | **MIT** | Swift (macOS) / Qt (Linux) | ✅ 完整支持，59+ provider | `docs/cursor.md` 是**最完整的 Cursor 端点/凭据文档**；三级凭据阶梯 + 团队成员预算 + 6 小时 403 冷却 |
| [tddworks/ClaudeBar](https://github.com/tddworks/ClaudeBar) | 1,513 | **NONE**（仓库无 LICENSE 文件） | Swift | ✅ 15+ provider 含 Cursor | 仅可读思路，**不可复用代码** |
| [akitaonrails/ai-usagebar](https://github.com/akitaonrails/ai-usagebar) | 603 | **MIT** | Rust | ✅ | `cursor/types.rs` + `cursor/db.rs`：**「schema drift 绝不渲染成 0」的范本**；团队账号 display-message 兜底的「两条都解析成功才认」规则 |
| [WoojinAhn/CursorMeter](https://github.com/WoojinAhn/CursorMeter) | 13 | **MIT** | Swift | ✅ Cursor 专用 | Keychain 持久化 + 活动驱动刷新 |
| [javaisbetterthanpython/cursor-usage](https://github.com/javaisbetterthanpython/cursor-usage) | 1 | **MIT** | Python | ✅ Cursor 专用 | README 有「两个池 + included 金额」的实际输出样例 |
| [Mai0313/VibeCodingTracker](https://github.com/Mai0313/VibeCodingTracker) | 14 | **MIT** | Rust | ✅ | `quota/cursor.rs`：**从 JWT `sub` 合成 WorkOS cookie** 的最小实现 + 完整的 reactive 过期判定 |
| [cbnsndwch/pacebar](https://github.com/cbnsndwch/pacebar) | 4 | **MIT** | TS | ✅ | **唯一有正式 provider 文档的**：`docs/providers/cursor` 列出全部 Connect 端点、必需头、分/毫秒量纲、token 刷新流程 |
| [Tendo33/cursor-usage-tracker](https://github.com/Tendo33/cursor-usage-tracker) | 4 | **MIT** | TS (VS Code ext) | ✅ Cursor 专用 | 跨平台 `state.vscdb` 路径表；注意其 README 提到 state.vscdb 可能涨到数 GB |
| [alextra-lab/cursor_usage](https://github.com/alextra-lab/cursor_usage) | 1 | **MIT** | Python | ✅ Cursor 专用 | — |
| [engelde/meter](https://github.com/engelde/meter) | 1 | **MIT** | Swift | ✅ | 明确写了「Cursor 只有月度窗口」，与我们的口径一致 |
| [cbyad/cursor-desk-monitor](https://github.com/cbyad/cursor-desk-monitor) | 1 | **MIT** | Bun/Effect | ✅ | 用 `GET /api/usage-summary`；`CURSOR_SESSION_TOKEN` 手工粘贴路径 |
| [wakamex/cursor-cli-usage](https://github.com/wakamex/cursor-cli-usage) | 0 | **NONE** | Python | ✅ Cursor 专用 | **无 LICENSE ⇒ 默认「保留所有权利」，不可复用任何代码**。仅可读思路 |
| [Rahularya01/pi-cursor](https://github.com/Rahularya01/pi-cursor) (`@0reki/pi-cursor`) | 29 | **MIT** | TS | ✅（`/cursor.usage`） | 四级凭据级联 + `tokenSource` 诊断输出 |
| [Dicklesworthstone/coding_agent_account_manager](https://github.com/Dicklesworthstone/coding_agent_account_manager) | 205 | **NOASSERTION** | Go | ✅ | PR #107 的**加固清单**极有参考价值：拒绝非有限/矛盾数值、pin 主机、拒绝带凭据的重定向、body 上限、deadline |
| [ephraimduncan/opencode-cursor](https://github.com/ephraimduncan/opencode-cursor) | 279 | **NONE** | — | 协议来源 | 无许可证 |
| [v587d/dsh-opencode-go-usage](https://github.com/v587d/dsh-opencode-go-usage) | 10 | **MIT** | — | 非 Cursor | 仓库**已复用**其 cookie 规范化部分（`opencode-cookie.ts:22`）—— 先例 |

**用户点名要查的四个**：
- **CodexBar** → ✅ 支持，**MIT**，star 22k，本任务的**首要参考**
- **ClaudeBar** → ✅ 支持，**无 LICENSE**（不可复用）
- **token-monitor**（Javis603/token-monitor）→ 父任务竞品报告里列了 43 款工具，**本次未单独核实其 Cursor 支持**（未验证）
- **opencode-quota**（slkiser/opencode-quota，MIT，985★）→ 父任务报告称支持 Cursor，
  **本次未核实其 Cursor 实现细节**（未验证；它已列入 P1-2 的其它范围）

---

## 2. 各项目对 Cursor 的做法对比（提炼「思路」，不复制代码）

| 项目 | 凭据优先级 | 主端点 | percent 来源 |
|---|---|---|---|
| CodexBar | Cursor.app `state.vscdb` → 缓存 cookie → 浏览器导入 → 存的 session | `GET cursor.com/api/usage-summary` | 端点直给；同时解析两条 `*DisplayMessage` 文本兜底 |
| PaceBar | Desktop SQLite → CLI Keychain | `POST api2.cursor.sh/.../GetCurrentPeriodUsage` | `totalPercentUsed`，缺失时回落 `(limit-remaining)/limit*100` |
| ai-usagebar | `state.vscdb` → `config_dir()/cursor/auth.json` | `GET cursor.com/api/usage-summary` | 端点直给；缺 `individualUsage.plan` 时**要求两条 display message 都解析成功**才认 |
| VibeCodingTracker | `config_dir()/cursor/auth.json` | `GET cursor.com/api/usage-summary` | 反转为 `100 - p`（**我们不采纳，见 02 §4**） |
| cursor-cli-usage | `agent status --format json` → `state.vscdb` | `POST api2.cursor.sh/.../GetCurrentPeriodUsage` | `totalPercentUsed` |
| CAAM | 自己的 profile 凭据根 | `api2.cursor.sh` 三个端点 | `totalPercentUsed` / `apiPercentUsed`，**范围外直接丢弃不夹取** |

**共识（4/6 家）**：`state.vscdb` 是首选凭据源。
**共识（3/6 家）**：两个池（Cursor Models / Other Models）要分别展示。
**共识（全部）**：percent 缺失时**宁可不给**，不能给 0。

---

## 3. 对本任务的许可结论

1. **可自由参考思路**：CodexBar(MIT)、PaceBar(MIT)、ai-usagebar(MIT)、VibeCodingTracker(MIT)、
   CAAM(NOASSERTION，谨慎——只读思路)、cursor-usage(MIT)。
2. **不可复用代码**：`wakamex/cursor-cli-usage`（无 LICENSE）、`tddworks/ClaudeBar`（无 LICENSE）、
   `ephraimduncan/opencode-cursor`（无 LICENSE）。
3. **实现方式**：全部自己写；在 `cursor.ts` 文件头列出「参考了哪些项目 / 各自的许可 / 未复制任何代码」，
   格式照抄 `opencode-cookie.ts:22-23` 的先例。
4. **⚠ 合规提醒（不是法律意见）**：`api2.cursor.sh/aiserver.v1.*` 与 `cursor.com/api/*` 都是
   **未文档化的私有端点**，Cursor 的服务条款是否允许第三方自动化调用**未知**。
   竞品全都这么做且 Cursor 未公开封禁，但这是**产品决策层面的风险**，需要在 PRD/交付说明里显式记一笔。

---

## Caveats / 未验证

- Star / License 均为 2026-10-01 通过 GitHub API 拉取的快照，会变。
- `token-monitor` 与 `opencode-quota` 的 Cursor 实现细节本次未核实。
- ClaudeBar 的 README 里多处出现的 `millord237/CodexBar` / `FireDragonCore/codexbar` 是 fork 镜像，
  上游是 `steipete/CodexBar`（MIT）。