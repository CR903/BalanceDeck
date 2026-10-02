# 需要用户确认的问题

- **Date**: 2026-10-01
- 每条都标注了「不回答会怎样」

---

## Q1（**阻塞**）· 是否接受扩展 `CollectRequest`（加 `method` / `body`）？

**背景**：`src/main/adapters/types.ts:11` 的 `CollectRequest` 只有 `url` / `headers` / `timeoutMs`，`request.ts:26` 恒为 GET。Antigravity 的 Cloud Code 端点全是 POST。

| 选项 | 后果 |
|---|---|
| **A. 扩展接缝**（推荐） | `types.ts` + `request.ts` 各加两个可选字段。既有调用点零改动。但 `types.ts` 是**共享文件**，若其它三家子任务并发改会冲突 |
| B. 不扩展，Antigravity 走本机语言服务器 | 需要 `ps` + `lsof` + 关 TLS 校验 + 随机端口探测 + 两个不同 CSRF token；且 **IDE 不开就完全不可用**，与「托盘常驻定时刷新」冲突。CodexBar 为此写了 13 个测试 + 两次 TLS 修复 PR |
| C. 不做这个适配器 | P2 任务，可延后 |

**建议**：A。

---

## Q2 · 是否内嵌 Google 的公开 OAuth `client_id` / `client_secret`？

**背景**：access_token 过期后要用 refresh_token 换新的，需要 Antigravity installed-app 的公开客户端凭据。这两个字符串**来源是 `aqua5230/usage`（AGPL-3.0-only）的源码字面量**。

| 选项 | 后果 |
|---|---|
| **A. 不内嵌**（合规最稳） | token 过期就如实报「请在 Antigravity 中重新登录」。代价：用户每隔一段时间要手动操作一次 |
| B. 内嵌 + 文件头附声明 | 第三方来源论证这是 RFC 8252 public client（installed-app 无法保密 client_secret，**它本身不是用户凭据、不授予任何权限**），多个项目都这么做。但仍是 AGPL 源码的具体字符串 |
| C. 自己走一次 OAuth 授权拿 token | 需要在 Electron 里开浏览器窗口做 OAuth 流程 —— 与 `opencode-auth.ts` 同类工作，**工作量显著更大**，但最干净 |

**建议**：先 A（v1 不做刷新），观察用户是否抱怨；真有需要再上 C。

---

## Q3 · 是否做 IDE SQLite 凭据路径（`state.vscdb`）？

**背景**：Antigravity 把凭据也存在 `~/Library/Application Support/Antigravity[ IDE]/User/globalStorage/state.vscdb`，key = `antigravityAuthStatus.apiKey`（或 `jetskiStateSync.agentManagerInitState` 的 protobuf）。

| 选项 | 后果 |
|---|---|
| **A. 第一版不做**（推荐） | 只走 Keychain + 旧 token 文件 + 手动粘贴。覆盖绝大多数已登录用户 |
| B. 调 `sqlite3` CLI 读 | 无新依赖；但要处理「CLI 不存在」，且 Electron 打包后子进程调用需实测 |
| C. 引 `better-sqlite3` | ⚠ electron-builder 原生模块重编译是已知的坑 |

**建议**：A。

---

## Q4 · `ProviderWindow.unit` 用 `'percent'` 还是 `'token'`？

**背景**：`shared/types.ts:3` 两个都合法。Antigravity 的量纲**就是百分比**。

| 选项 | 后果 |
|---|---|
| **A. `'percent'`**（语义诚实） | `tray-text.ts:48` 走 `formatPercent`。但 `used` 在 percent 语义下应该是百分比值（`types.ts:15`：「percent 单位时 used=百分比值」），**与服务端直报的 `percent` 字段语义重叠**，需确认 UI 会不会双重渲染 |
| B. `'token'`（照 codex.ts 服务端窗口） | 已验证的先例（`used:0, limit:缺省, percent:值`），但语义撒谎 —— 那不是 token 数 |

**建议**：**需要 implement 阶段读一遍 `tray-text.ts` 与卡片的格式化分支再定**。若 UI 对 percent 的处理有坑，退 B（与 codex 一致，安全）。

---

## Q5 · 是否要「手动粘贴 token」的兜底入口？

**背景**：`localCredential: true` 的预设（claude / codex / copilot）**用户无法在设置页填凭据**。但 Keychain 读取在 Linux（Secret Service 未运行）与部分 Windows 环境会失败。

| 选项 | 后果 |
|---|---|
| A. 不做 | 这类用户彻底无法使用该适配器 |
| **B. 做**（推荐） | 存 `items`（加密），`ctx.getKey('antigravityToken')` 读。⚠ 需确认**渲染层不得拿到明文**（`tts:getSecret` 教训：`App.tsx:220` + `ipc.ts:283`）—— 不能新增返回凭据的 IPC |

**建议**：B，且必须守住渲染层边界。

---

## Q6 · `provider-icons.ts` 的 `antigravity` 图标用哪个？

**背景**：`engine.ts:18` 说 mark 是实例派生的（内置用 presetId、自定义用 protocolId）。两者都取 `'antigravity'` 时不会劈叉。但 `provider-icons.ts` 没有这个键，logo 会落空。

- simple-icons 有 `googlegemini`；Antigravity 不是 Gemini 应用
- `volc` 的先例是自备 `thesvg:volcengine`

**需要**：确认用现成图标还是自备 svg（自备要走 README 第三方素材区的署名流程）。

---

## Q7 · 端点无官方文档，是否接受逆向来源？

**背景**：`retrieveUserQuotaSummary` **不在 Google 官方文档里**。官方只公开了 CLI 的 `/usage` 命令与 statusline JSON 形状（`remaining_fraction` / `reset_time` / `reset_in_seconds`）。全部协议细节来自逆向（openusage / CodexBar / usagebar / oh-my-pi issue）。

**这是本仓库 external-api-integration.md Step 1 直接命中**：
> A bundle's API declaration proves an endpoint *exists*. It does **not** prove it carries the data you need.

**需要确认**：接受「协议来自逆向、可能随时失效」这一前提吗？如果接受，适配器注释里必须写清这一点，且文案**不得**说「官方接口」—— 也许 `source` 该写「Antigravity 接口」更诚实。
（这是**唯一还没解决的口径诚实性问题**，建议父任务一并拍板。）

---

## 附：已确定、不需要确认的结论

| 项 | 结论 |
|---|---|
| `kind` | `'coding'` |
| `mark` / presetId / protocol id | 都是 `'antigravity'` |
| 声明表 vs 独立适配器 | **独立** `antigravity.ts`（声明表表达不了 POST / 本机文件 / 多 baseUrl 回退） |
| 是否碰 `protocols.ts` | **不碰** |
| 适配器注册 | `CODE_ADAPTERS['antigravity']` |
| 凭据存放 | token → `items`（加密）；project → `extras` |
| `fetchAvailableModels` 回退 | **不做**（口径不同，只有 5h） |
| `dataQuality: 'local'` | **不适用**（无本机额度估算） |
| 测试段落 | `scripts/test-adapters.mjs` 追加 `V` 段（只加不改） |