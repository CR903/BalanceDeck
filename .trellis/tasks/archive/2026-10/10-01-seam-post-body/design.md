# Design: 采集接缝支持 POST body 与 method

## Architecture

```
适配器（gemini / antigravity / codex 升级后）
    │  ctx.request({ url, method:'POST', headers, body })
    ▼
CollectContext.request          ← 注入的能力，适配器不依赖 electron
    │
    ├──【生产】src/main/request.ts
    │     request(req) → fetch(url, { method: req.method ?? 'GET', headers, body, signal })
    │
    └──【测试】scripts/test-adapters.mjs 的桩
          request(req) → 记录 call(req)（含 method / body）→ 路由匹配 → 返回桩响应
```

## Technical Decisions

### D1 · 只加可选字段，缺省行为逐字不变（纯增量）

`CollectRequest` 从 `{ url, headers, timeoutMs? }` 扩到
`{ url, headers, timeoutMs?, method?, body? }`。

**为什么必须纯增量**：接缝是**全部 9 种既有协议 + 5 个既有适配器**的地基。
任何「顺手重构」都会让 18 个套件的断言静默变化，而它们之间的对齐关系
（比如 T 段的目录断言、N 段的协议数断言）是**数目型**的 —— 数目对了不代表行为对。

`method` 收窄成字面量联合 `'GET' | 'POST'` 而不是 `string`：类型层面挡住
「拼错方法名」这种运行时才发现的错误（`type-safety.md` 的 literal union 纪律）。

### D2 · body 是字符串，序列化由适配器决定

接缝**不做序列化决策**。理由是实测的：Gemini 的 token 刷新端点是
**form-encoded**，而 quota 端点是 JSON（调研 P8）。若接缝只认 JSON，
form 那条路就得绕过接缝 —— 那等于没扩。

同理，`Content-Type` **由调用方决定**：接缝只在「有 body 且调用方没自带
Content-Type」时补 `application/json`。调用方自带就原样用。

### D3 · 测试桩加一个**新函数**记录 method/body，不改既有 `callProject`

`callProject`（`test-adapters.mjs:112-118`）被既有断言深度依赖
（它返回的 `auth` / `accept` 被多段测试断言）。**改它的返回形状会让既有断言红**。

**决策**：新增 `callProjectRich(req)`（或给 `callProject` 加可选参数），
返回 `{ url, auth, accept, method, body }`。
既有三字段保持不变 → 既有断言逐字不变；依赖 POST 的适配器用 rich 版本。

> 这正是本仓库反复记录的纪律：「加字段」比「改字段」安全 ——
> `ProviderSnapshot` 当年加 `dataQuality` 是这样做的。

### D4 · 静态守卫：`request.ts` 的 fetch 必须读 `req.method`

防止「后来有人清理代码时把 method 又改回硬编码 GET」。守卫断言
`request.ts` 的 fetch 调用形参里出现 `req.method` —— 加字段容易、删字段难，
静态断言把「删」这个动作变成红的。

## Contracts

```ts
// src/main/adapters/types.ts
export interface CollectRequest {
  url: string
  headers: Record<string, string>
  timeoutMs?: number
  /** HTTP 方法；缺省 'GET'（与改动前逐字相同） */
  method?: 'GET' | 'POST'
  /** 请求体（**已序列化**的字符串）。接缝不决定序列化方式，调用方负责 */
  body?: string
}
```

```ts
// src/main/request.ts（新增部分）
const method = req.method ?? 'GET'
const headers = { ...req.headers }
if (req.body !== undefined && !hasContentType(headers)) headers['Content-Type'] = 'application/json'
const res = await fetch(req.url, { method, headers, body: req.body, signal: ctrl.signal })
```

## Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| 不传 `method` | 发 GET（与改动前逐字相同） |
| 不传 `body` | 不带 body；**不补** `Content-Type`（无体请求不需要） |
| `method:'POST'` + 有 body + 无 Content-Type | 补 `application/json` |
| `method:'POST'` + 有 body + 自带 Content-Type | **原样用调用方的**（form-encoded 要生效） |
| `method:'POST'` + 无 body | 不补 Content-Type（无体不需要） |
| 未知 method（类型层面被挡，运行时若绕过） | fetch 自然抛错 → `markNetResult(false)` → 离线记账 |
| POST 返回非 2xx | 与 GET 一致：返回 `{ status, text }`，由适配器判 |

## Good / Base / Bad Cases

- **Good**：Gemini 发 `POST v1internal:retrieveUserQuota`，body `{"project":"p-123"}`，无自带 Content-Type → 接缝补 JSON 头，body 原样到达。
- **Base**：既有的 `deepseek` 协议仍发无 method 的 GET → 行为、断言、请求数**全部不变**（18 套件证明）。
- **Bad**：接缝「聪明地」把 body 对象自动 JSON.stringify → Gemini 的 form-encoded 刷新请求被静默改成 JSON，服务端返回 400 而适配器报「解析失败」—— **症状离病因很远**。这就是 D2 把序列化留给适配器的原因。

## Tests Required

新建 `scripts/test-seam.mjs`（或并入既有套件的一段），覆盖：

1. 缺省（无 method）→ 请求是 GET、无 body
2. 显式 `method:'GET'` → 仍是 GET
3. `POST` + JSON body + 无 Content-Type → 补 `application/json`
4. `POST` + form body + 自带 `Content-Type: application/x-www-form-urlencoded` → **不被覆盖**
5. `POST` 无 body → 不补 Content-Type
6. 静态守卫：`request.ts` 的 fetch 读 `req.method`；`types.ts` 里 `method`/`body` 都是可选
7. **既有 18 套件断言数与改动前一致**（纯增量的证明）

## Wrong vs Correct

#### Wrong
把接缝改成「自动 JSON.stringify body」并把 `method` 放开成任意字符串：

- Gemini 的 form-encoded token 刷新被静默改成 JSON → 服务端 400 → 适配器报「解析失败」，
  **病因（请求体格式错）与症状（解析失败）隔了三层**，排查成本极高；
- `method: string` 放开后，`method: 'PSOT'` 这类拼错要到运行时 fetch 才炸；
- 且这不是「顺手」，它改变了接缝对**所有**适配器的语义。

#### Correct
只加两个可选字段、字面量联合、序列化与 Content-Type 都留给调用方、
测试桩**加** rich 函数而不**改**既有函数。既有 18 套件逐字不变作为回归证明。