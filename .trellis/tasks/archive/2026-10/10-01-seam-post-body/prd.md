# 采集接缝支持 POST body 与 method

## Goal

让采集接缝能发 **POST + JSON body**，使依赖 POST 的适配器（Gemini Code Assist /
Google Antigravity / OpenAI 额度）可以正确实现，且**请求体可被测试断言**。

本任务改的是**所有适配器共用的接缝**，因此单独先行交付 —— 不混在某个适配器任务里，
让这次共享契约变更能被独立评审、独立测试、独立回滚。

## Background

调研确认三家适配器都需要 POST + JSON body：

| 适配器 | 端点形态 | body 的关键性 |
|---|---|---|
| Gemini Code Assist | `v1internal:loadCodeAssist` + `v1internal:retrieveUserQuota` | body 里的 `{ project }` **决定请求能否成功** |
| Google Antigravity | `retrieveUserQuotaSummary` / `loadCodeAssist` | 同上 |
| OpenAI（升级 `codex.ts`） | `wham/usage` | body 含账户与时间范围参数 |

而现状：

- `src/main/adapters/types.ts:11-16` — `CollectRequest` 只有 `url` / `headers` / `timeoutMs`
- `src/main/request.ts:21` — `fetch(req.url, { headers, signal })`，**方法硬编码为 GET，无 body**
- `scripts/test-adapters.mjs:112-118` — 测试桩 `callProject` 只记 `url` / `auth` / `accept`，**不记 body**

**不扩接缝的后果**（三选一都不理想）：
- 只能发 GET → 适配器**做不出来**（三家端点全是 POST）
- 改生产实现但不给测试桩记 body → **决定请求成败的字段无任何覆盖**，
  而这类字段错了的表现是「运行时静默失败」（Adaptation Level 2 的典型症状）

## Requirements

1. **`CollectRequest` 加两个可选字段**：`method?: 'GET' | 'POST'`、`body?: string`。
   缺省行为与今天**逐字相同**（不传 method 就是 GET，不传 body 就是无体请求）。
2. **生产实现透传**：`request.ts` 按 `req.method ?? 'GET'` 选择方法，
   有 body 时带 `Content-Type`（若调用方未自带）与 body。
3. **测试桩记录 body 与 method**：新增一个**不改动既有函数**的记录入口，
   让依赖 POST 的适配器能断言「我发的 body 里 `{ project }` 是对的」。
4. **既有适配器与 fixture 零影响**：全部 18 个套件在改动后必须原样全绿。

## Constraints

- **纯增量**：只加可选字段，既有调用点**一行都不改**
- **不碰 `protocols.ts`**：`test-adapters.mjs:752-756` 断言
  `Object.keys(PROTOCOLS).length === 8`，加一条就红，而该文件是四家适配器任务的共享文件
- **不碰任何适配器**：本任务只做接缝，不实现那三家
- **body 是字符串而非对象**：接缝不做序列化决策 —— 有的端点要 JSON、
  有的要 form-encoded（Gemini 的 token 刷新端点是 form，`type-safety` 那条纪律：
  刷新 token 不能走 `readJson` 的默认 JSON 假设）。把选择权留给适配器。
- **`Content-Type` 由调用方决定**：接缝只在「调用方带了 body 但没带 Content-Type」时
  补 `application/json`；调用方自带就原样用（form-encoded 的端点自己会带）。

## Acceptance Criteria

- [ ] `CollectRequest` 有 `method?` 与 `body?`，**都是可选**
- [ ] `request.ts` 按 `method` 发请求；带 `body` 时能带上 `Content-Type`
- [ ] **缺省行为逐字不变**：不传 `method`/`body` 的调用仍发 GET 且无 body
      （用既有 18 个套件全绿证明）
- [ ] 测试桩能记录 `method` 与 `body`，供依赖 POST 的适配器断言
- [ ] 静态守卫：`request.ts` 里 `fetch` 调用**必须**读 `req.method`
      （否则有人加回硬编码 GET 时测试会红）
- [ ] 新增一个专测接缝的套件（或并入 `test-adapters.mjs` 的一段），覆盖：
      缺省 GET / 显式 GET / POST 无 body / POST + JSON body / POST + form body /
      调用方自带 Content-Type 时不被覆盖
- [ ] `npm test` 与 `npm run typecheck` 通过
- [ ] **既有 18 个套件的断言数与改动前一致**（证明「纯增量、零影响」）

## Notes

- 依赖关系：本任务**必须先于** Gemini / Antigravity / OpenAI 三家适配器完成。
  父任务 `10-01-p1-remaining` 的 Task Map 已记录该顺序。
- 三家适配器调研均独立得出「不要动 `protocols.ts`」的结论（有硬测试佐证），
  因此那三家都写**独立适配器**（`gemini.ts` / `antigravity.ts` / 升级 `codex.ts`）。
- 本任务完成后应更新 `.trellis/spec/adapters/index.md` —— 接缝契约变了，
  spec 里现在写的 `CollectRequest` 只有三个字段。