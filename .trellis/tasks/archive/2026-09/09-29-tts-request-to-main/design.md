# Design: TTS 请求迁移到主进程

## 边界

```
渲染层 speechOut.ts                主进程
┌──────────────────────┐          ┌──────────────────────────┐
│ requestAudioBlob()    │  ipc     │ tts:speak               │
│   ↓ 纯逻辑（可测）    │ ───────► │   ↓                      │
│ fetch()  ← 删掉      │  invoke  │ fetch() + AbortController│
│                       │ ◄─────── │   ↓                      │
│ ArrayBuffer           │  二进制  │ ArrayBuffer              │
└──────────────────────┘          └──────────────────────────┘
        │                                    │
   URL.createObjectURL               失败 → 抛，原因码化
   new Audio().play()
```

**关键**：把 `fetch` 换成 IPC 后，`requestAudioBlob` 里其余全部逻辑（超时、重试、401/403
不重试、blob 配平）留在原位不动 —— 所以它现有的一整套测试**仍然有效**，只是被测对象的
传输层从 `fetch` 换成桩。

## IPC 契约

```ts
// preload
ttsSpeak(req: { url: string; headers: Record<string,string>; body: string }): Promise<ArrayBuffer>
```

返回 `ArrayBuffer`；失败则 reject 一个**带原因码的 Error**：

| 码 | 含义 | 渲染层处理 |
|---|---|---|
| `TTS_UNREACHABLE` | DNS/连接/超时 | 置不可达 + 排自愈探测 |
| `TTS_HTTP_<n>` | 服务返回非 2xx | 401/403 不重试；其余重试 1 次 |

`structuredClone` 能传 `ArrayBuffer`（Electron 的 IPC 走 Structured Clone），无需 base64。

## 复用既有出网层

`src/main/request.ts` 已有：超时（AbortController）+ `markNetResult` 离线记账。
但它的签名面向采集（返回 `{status, text}` 文本），TTS 要二进制。

**取舍**：不强行复用 `request()`，而是照它的**模式**写一个 `tts:speak` 专用 handler。
理由：`request()` 强制 `res.text()`，二进制会损坏；强行加参数会把采集链路的契约搞复杂。
共享的是「模式 + net.ts 记账」，不是函数。

## 自建 URL 的安全边界

主进程连任意用户配置域名 —— 这是**有意放开的输入**，不是漏洞：

- 域名由用户在设置里配置，不是代码里写死的
- CSP 保护的是**渲染层**（XSS 场景），渲染层仍不能外连
- 主进程本来就是出网进程（`adapters` 已在连用户配置的 API 地址）

**明确不做**：不引入域名白名单/黑名单。用户自建服务是本项目的核心用例，加白名单会直接
废掉「自定义服务」这个功能。

## token 收口

现在 token 在渲染层 `ttsSecretRef`（明文）。迁移后：

- token 由渲染层启动时取一次 → 存主进程
- `tts:speak` 时由主进程自己拼 `Authorization` 头
- 渲染层**不再持有明文**，state 里只有布尔 `hasSecret`

这顺带收紧一处：明文不再跨进程传递。

## 探测链路

`probeReachable()` 从「渲染层 fetch」改为「主进程发一个极短文本的 TTS 请求」。
仍然是：不发声、不入队、不计配额 —— 判定拿到字节即恢复。

## 兼容与回滚

| 项 | 影响 |
|---|---|
| CSP | 不动 |
| 既有测试 | `requestAudioBlob` 的超时/重试/401 断言应仍绿（桩换传输层） |
| 回滚 | 单点：`tts:speak` handler 删掉，渲染层退回 `fetch`（但仍不可用） |

## 取舍

- **不做**：让渲染层直连主进程的 `net.request`（跨进程暴露 API）—— 增加耦合，不如直接 IPC
- **不做**：base64 传输音频。`ArrayBuffer` 直接走 Structured Clone，无需编码
- **代价**：主进程多一个 IPC 面；错误信息跨进程需要显式序列化（不能靠 Error.name 自动带）
- **风险**：Electron 的 IPC 对 `ArrayBuffer` 支持需实测确认；若失败退回 base64（有断言兜底）
