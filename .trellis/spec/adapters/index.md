# Adapters & External Integrations

> Executable contracts for talking to third-party APIs from the main process.
> Thinking triggers (which endpoint? is it honest? is it robust?) live in
> [`../guides/external-api-integration.md`](../guides/external-api-integration.md).

---

## Why this layer exists

The main process owns every outbound integration. Those are the places where
the codebase is most likely to be *silently* wrong: a renamed field, a changed
auth scheme, or a fixture mistaken for evidence all produce output that looks
plausible and renders as fact. So this layer is written as contracts, not
adjectives.

## Guides Index

| Spec | Covers | Status |
|---|---|---|
| [opencode-console.md](./opencode-console.md) | opencode.ai 控制台：授权会话、配额窗口、每模型明细 | 已填（2026-09-27，任务 `09-26-opencode-console-spa`） |
| 采集接缝 `CollectRequest` | method / body / Content-Type 的归属（本文下方一节） | 已填（2026-10-01，任务 `10-01-seam-post-body`） |

## The collection seam — `CollectRequest`

`CollectContext.request` is the seam every adapter uses to reach the network
(`src/main/adapters/types.ts`). Its request shape is a **purely additive** contract:

```ts
export interface CollectRequest {
  url: string
  headers: Record<string, string>
  timeoutMs?: number   // 缺省 12s
  method?: 'GET' | 'POST'   // 缺省 'GET'
  body?: string             // **已序列化**；接缝不决定序列化方式
}
```

Three rules govern the two optional fields. All three were paid for by a real
endpoint, not by taste:

1. **`method` is a literal union, not `string`** — so `'PSOT'` is a compile
   error instead of a runtime fetch throw.
2. **`body` is a pre-serialized string, never an object.** The seam makes no
   serialization decision because real endpoints disagree: Gemini's token-refresh
   endpoint is `application/x-www-form-urlencoded` while its quota endpoint is
   JSON. A seam that helpfully did `JSON.stringify(body)` would silently turn the
   form request into JSON → server 400 → adapter reports "解析失败", with the
   cause three layers away from the symptom.
3. **`Content-Type` belongs to the caller.** The implementation adds
   `application/json` **only** when a body is present and the caller did not
   supply a Content-Type (matched case-insensitively). A caller that brings its
   own gets it verbatim — that is how the form-encoded endpoint keeps working.

**Adding a field here is safe; changing one is not.** The seam is the foundation
under all protocols and all adapters. `CollectRequest` grew `method`/`body`
without touching a single existing call site, and `test-adapters.mjs` stayed at
**exactly 166 assertions** before and after — that unchanged count is the proof
of zero impact, and it is why the seam's assertions now live in their own suite
(`scripts/test-seam.mjs`) rather than in the shared adapter fixture file.

Two static guards in `test-seam.mjs` exist because of how this contract decays:
the implementation must read `req.method` (so a later cleanup cannot re-hardcode
`GET`), and `request.ts` must contain **zero** occurrences of `JSON.stringify`
(any serialization decision belongs to the adapter). The latter is deliberately
whole-file: two narrower versions of that guard were both defeated by moving the
mutation to another line.

## Layer-wide rules

1. **端点与请求头常量只有一个来源。** 同一组常量被多处使用时，
   放一个模块导出，其它文件 import 它 —— 两份会漂。
   见 `src/main/adapters/opencode-console-api.ts`。
2. **测试加载真源码，不用内联副本。** `scripts/lib/loadTs()` 把 `src` 下的
   TS 打成内存 ESM 后 import。测试里复制一份实现（哪怕注明"请与源保持一致"）
   是假护栏：源改错了测试照样绿。
3. **未知形状要有出口。** 解析器遇到不认识的字段/端点时，把它报出来并记日志，
   不要静默丢掉 —— 否则一次部分改名会悄悄少一个窗口，而界面上看不出异常。
4. **诊断命令与产品路径同源。** 凭据、配置、命名空间的解析顺序必须一致，
   否则会出现"工具说没配置、应用好好的"。
5. **端口径不一致时宁可不显示。** 近似值是撒谎；缺失是可见的。
6. **新增护栏后，先弄坏它一次**，确认测试真的会红。收窄的静态守卫尤其要实测：
   本节接缝的 `JSON.stringify` 守卫被换行绕过过两次，直到改成整文件计数才
   真的变红 —— 没红过的守卫等于没有守卫。
7. **给共享夹具「加函数」而不是「改函数」。** 既有投影函数（`callProject`）
   的返回值被既有断言做全等比较，给它加键会让几十条断言一起变红。
   POST 类适配器改用新增的 `callProjectRich` / `makeRichRequest`。

## Related

- 领域词汇与架构分层：[`../../../CONTEXT.md`](../../../CONTEXT.md)
  （协议 / 适配器 / 采集引擎 / 快照 / 可信度）
- 历史决策：[`../../../docs/adr/`](../../../docs/adr/)
