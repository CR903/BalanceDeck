# Research: 可选来源与其代价（竞品对比 + 许可）

- **Query**: 官方 API / 本机数据 / 竞品支持情况，GitHub 仓库名 + 许可协议
- **Scope**: external
- **Date**: 2026-10-01（检索日期）
- **本仓库边界**: 「参考思路自己重写；若复用片段必须在文件头附声明」（`.trellis/spec/adapters/index.md` 层规则 2 的精神 + README 第三方素材区惯例）

---

## 1. 竞品矩阵

| 项目 | 仓库 | 许可 | 支持 Antigravity？ | 数据来源 | 实现路线 |
|---|---|---|---|---|---|
| **openusage** | `robinebers/openusage` | **MIT** ✅ | ✅ 明确支持（"shared Gemini and Claude pool quotas, 5-hour and weekly windows"） | 本机 LS **优先** → Cloud Code API 兜底 | 最完整，且有专门文档 |
| **CodexBar** | `steipete/CodexBar` | **MIT** ✅ | ✅（`AntigravityStatusProbe.swift`，有 `docs/antigravity.md`） | **仅本机语言服务器**（`GetUserStatus`） | 本机 LS 路线，文档写得最细 |
| **ClaudeBar** | `tddworks/ClaudeBar` | ❓ **未验证**（raw `LICENSE` 404，抓不到） | ✅（README 列出 Antigravity；错误文案提到 "server not found" → 说明它也走本机 LS） | 本机 CLI/LS 探测为主 | Swift，`QuotaMonitor` 架构 |
| **opencode-quota** | `slkiser/opencode-quota` | **MIT** ✅ | ✅（README 把 "Google Antigravity" 与 "Google AGY" **列成两个 provider**，都是 "Needs setup / Remote API"） | **Remote API** | TS，唯一明确「出网」路线的同类项目 |
| **opencode-token-monitor** | `Ainsley0917/opencode-token-monitor` | **MIT** ✅ | ✅（"Monitor Antigravity quota remaining fractions"） | 依赖 open-antigravity-auth | 依赖链太长，不建议参考 |
| **usage** | `aqua5230/usage` | ⛔ **AGPL-3.0-only** | ✅ 协议解析最完整 | Cloud Code API + Keychain/token 文件 | ⚠ **不可复用代码**；协议形状只能读思路 |
| **pi-antigravity** | npm `pi-antigravity@0.7.x`（cdn.jsdelivr） | ❓ 未验证 | ✅ | Cloud Code API | ⚠ 许可未核 |
| **usagebar** | `luisleineweber/usagebar-fork-archive` | fork 自 MIT 的 openusage | ✅ | LS + Cloud Code | 文档最详细的一份协议笔记 |
| **Win-CodexBar** | `nesszer/Win-CodexBar` | ❓ 未验证 | ✅ | 本机 LS | 文档化程度一般 |
| **quotas**（Rust crate） | crates.io `quotas` | ❓ 未验证 | ✅ | Cloud Code API | ⭐ **含唯一的 live fixture**（2026-07-14） |
| **antigravity-tools-linux** | `daviddallet/antigravity-tools-linux` | ❓ 未验证 | ✅（`GetUserStatus` curl 脚本） | 本机 LS | 只是 shell 脚本 |
| **oh-my-pi** | `can1357/oh-my-pi` | ❓ 未验证 | ✅ | issue #9940 记录了从 fetchAvailableModels **迁移到** retrieveUserQuotaSummary 的全过程 | ⭐ 最好的「坑位地图」 |

---

## 2. 各路线的代价

### 路线 A：Cloud Code `retrieveUserQuotaSummary`（出网）✅ 推荐

**代价**：
1. 读凭据（Keychain / SQLite）—— 中等成本
2. **POST 请求** —— ⚠️ **本仓库当前 `CollectRequest` 不支持！** 见 §3
3. 可能需要 refresh_token + 公开 client（授权问题）
4. 免费档可能 403（二手矛盾，需实测）

**收益**：唯一同时给「2 池 × 2 窗口」的端点；IDE 关闭也能查；opencode-quota 走的就是这条。

### 路线 B：本机语言服务器 `GetUserStatus`（localhost）❌ 不推荐

**代价**（CodexBar / ClaudeBar / usagebar 都踩了）：

- 要 `ps -ax` 找 `language_server_macos` 进程 → 抽 `--csrf_token` 与 `--extension_server_port`
- 要 `lsof -nP -iTCP -sTCP:LISTEN -a -p <pid>` 找**随机端口**（每次重启都变）
- 本机是 **HTTPS + 自签名证书** → 必须关 TLS 校验（CodexBar PR #693/#727 就是连续两次修这个）
- **两个不同的 CSRF token**（`--csrf_token` vs `--extension_server_csrf_token`），搞错就 403
- IDE 不开就完全不可用
- CodexBar 有 13 个专门测试（`AntigravityStatusProbeTests`）

**收益**：给 `planName`。但线路 C 也能通过 `loadCodeAssist` 的 `paidTier` 拿套餐名。

⇒ **代价与收益完全不成比例。** 且它要求「IDE 正在运行」，与 BalanceDeck「托盘常驻、定时刷新」的使用形态冲突。

### 路线 C：`fetchAvailableModels` 回退（只有 5h）

**代价**：口径不全（无 weekly），要自己做池合并（这正是 oh-my-pi#9940 修掉的「weekly 被吞」与「5h 被误分类为 Daily」两个 bug）。
**结论**：**不做**。

### 路线 D：只读本机文件

**代价**：本机根本没有「额度」文件。额度在后端，本机只有**凭据**与**对话 token 记录**。
⇒ 想要额度就必须出网。**路线 D 不成立。**

---

## 3. ⚠️ 结构性障碍：现有采集接缝是 GET-only

```ts
// src/main/adapters/types.ts:11
export interface CollectRequest {
  url: string
  headers: Record<string, string>
  timeoutMs?: number
}
```

**没有 `method`，没有 `body`。** `src/main/request.ts:26` 的实现是 `fetch(req.url, { headers, signal })` —— 恒为 GET。

Antigravity 的三个 Cloud Code 端点**全是 POST + JSON body**。

⇒ **无论走哪条出网路线，都必须先扩展接缝。** 这不是 Antigravity 独有的问题，是接缝的历史缺口被它第一次暴露（现有 9 个协议全是 GET 或「签名进 URL」的 GET，见 `qwen.ts` / `volc.ts` 都是把签名拼到 URL 上以规避无 body 的限制）。

**扩展方案（三选一，需用户拍板）**：

| 方案 | 改动 | 影响面 |
|---|---|---|
| A. `CollectRequest` 加 `method?: string` + `body?: string` | `types.ts` + `request.ts` + 测试桩 `makeRequest` | 最干净。但 `body` 会进 `test-adapters.mjs` 的 `callProject` 投影，可能影响既有断言 |
| B. Antigravity 适配器内直接用 `fetch` | 只加一个文件 | ❌ 破坏 ADR-0003「出网是注入的能力」，且测试桩失效 —— **不可接受** |
| C. 把 POST body 编进 URL query | 不可能 | ❌ |

**推荐 A。** 改动是加两个可选字段，既有调用点零改动（`method` 缺省 GET、`body` 缺省无 body）。

---

## 4. 许可结论

| 分类 | 项目 |
|---|---|
| ✅ **MIT，可读可抄（抄了要附声明）** | openusage、CodexBar、opencode-quota、opencode-token-monitor、frieser/opencode-antigravity-quota、usagebar(MIT fork) |
| ⛔ **AGPL-3.0-only，禁抄** | `aqua5230/usage` |
| ❓ **未验证（抓不到 LICENSE）** | ClaudeBar、pi-antigravity、quotas crate、Win-CodexBar、antigravity-tools-linux、oh-my-pi、open-antigravity-auth |

**给实现的建议**：
- **协议形状**（端点名、字段名、三种 nesting）→ 抄 MIT 的 CodexBar / openusage 文档，或读 AGPL 的思路但**自己重写**（协议事实不是版权表达）
- **OAuth client_id/secret 字面量** → ⚠ 这是从 AGPL 源码抄的**具体字符串**，落在灰色区。见 Q2
- **live fixture** → `quotas` crate 的 `retrieve_user_quota_summary_live.json`（许可未核）→ 建议**自己按 issue #9940 贴的 JSON 重造**，不复制文件

---

## 5. 本机数据实测（2026-10-01）

这台开发机**没装 Antigravity**（详见 `02-quota-lookup-paths.md` §4）。所以：

- ❌ 无法实测端点
- ❌ 无法实测凭据路径
- ❌ 无法造真实 fixture
- ✅ fixture 只能按二手实录手写，且**必须标注来源 + 日期**（`.trellis/spec/guides/external-api-integration.md` Step 2：「A frozen fixture is fine **as a fixture**. It is not evidence about the live system. Label it as such.」）