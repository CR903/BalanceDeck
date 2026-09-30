# Implement: TTS 请求迁移到主进程

## 文件所有权

| 文件 | 动作 |
|---|---|
| `src/main/ipc.ts` | 改：新增 `tts:speak` handler（二进制返回 + 原因码错误） |
| `src/preload/index.ts` | 改：暴露 `ttsSpeak` |
| `src/renderer/src/speechOut.ts` | 改：`requestAudioBlob` 的 `fetch` → IPC；探测同理 |
| `src/renderer/src/App.tsx` | 改：token 改由主进程持有，渲染层不再持明文 |
| `scripts/test-speech-out.mjs` | 改：传输层桩从 `fetch` 换成 `ttsSpeak` |
| `scripts/test-structure.mjs` | 改：加 CSP 不变守卫 + IPC 存在性 |

**严禁触碰**：`src/renderer/index.html`（**CSP 是本任务的红线**）、
`alertOrchestrate.ts` / `smartBroadcast.ts` / `history.ts` / `VoiceReminderSection.tsx` /
`adapters/**` / 其他 `.mjs`。**不要 git commit。**

## Phase 1 · 主进程出口

- [ ] **1.1** `ipc.ts` 新增 `tts:speak`：入参 `{url, headers, body}`，返回 `ArrayBuffer`
- [ ] **1.2** 超时用 `AbortController`（照 `request.ts` 模式，默认 12s）
- [ ] **1.3** 失败分类：DNS/连接/超时 → `TTS_UNREACHABLE`；非 2xx → `TTS_HTTP_<n>`
- [ ] **1.4** **实测** `ArrayBuffer` 能否过 Electron IPC。若不行 → 退回 base64 并加断言
- [ ] **1.5** `markNetResult` 记账（与 adapters 保持一致的离线判定）
- [ ] **1.6** preload 暴露 `ttsSpeak`
- [ ] **1.7** 校验 `url` 是 http/https（禁 `file:`/`javascript:`）

## Phase 2 · 渲染层改走 IPC

- [ ] **2.1** `requestAudioBlob`：`fetch` → `window.api.ttsSpeak`，**其余逻辑一行不动**
      （超时 / 重试 1 次 / 401-403 不重试 / 错误向上抛，全部保留）
- [ ] **2.2** `probeReachable` 同样改走 IPC（不发声、不入队、不计配额的性质不变）
- [ ] **2.3** 错误映射：`TTS_UNREACHABLE` → 置不可达；`TTS_HTTP_401/403` → 不重试

## Phase 3 · token 收口

- [ ] **3.1** token 存主进程（复用已有的 `tts:setSecret` 加密存储，启动时由主进程读取）
- [ ] **3.2** `tts:speak` 时主进程自行拼 `Authorization` 头
- [ ] **3.3** 渲染层删除 `ttsSecretRef` 明文；state 只留 `hasSecret` 布尔

## Phase 4 · 测试

- [ ] **4.1** `test-speech-out.mjs` 传输层桩改用 `ttsSpeak`；**保留**全部既有断言
      （超时/重试/401/blob 配平）—— 它们必须仍然绿，证明只换了传输层
- [ ] **4.2** 新增：原因码映射的断言（`TTS_UNREACHABLE` → 置不可达）
- [ ] **4.3** `test-structure.mjs` 加 CSP 不变守卫（逐字锁 `connect-src`）
- [ ] **4.4** token 明文不入渲染层 state 的断言

## Phase 5 · 验证（强制）

- [ ] **5.1** `npm run typecheck` / `npm test` / `npm run build` 全绿
- [ ] **5.2** **真机验证**（关键）：`npm run dev` 后点「测试播报」，**必须真的出声**。
      此前三轮我的「实测」都是 curl 打服务端 —— curl 不受 CSP 约束，**这不算验证**
- [ ] **5.3** 断开网络后点试听 → 应听到系统语音回退，且提示「连不上语音服务」
- [ ] **5.4** **反向验证**：

| 注入 | 期望 |
|---|---|
| `connect-src` 加外部域名 | CSP 守卫红 |
| `requestAudioBlob` 改回 `fetch` | 守卫红（防止再犯） |
| 渲染层重新持有 token 明文 | 守卫红 |
| `tts:speak` 漏掉 401-403 不重试 | 既有断言红 |

- [ ] **5.5** 如实记录抓不到的变异

## 风险

| 风险 | 应对 |
|---|---|
| `ArrayBuffer` 过不了 IPC | Phase 1.4 先实测；兜底 base64 + 断言 |
| 既有断言失效（误以为只换了传输层） | Phase 4.1 要求全部保留；若有失效要逐条说明为何 |
| 改回 `fetch` 的诱惑 | Phase 5.4 专门加守卫 |
| 漏验「真的出声」 | Phase 5.2 是必过项，不能用 curl 代替 |
