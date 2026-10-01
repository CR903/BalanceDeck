# 验证实测记录 — 10-01-seam-post-body

全部数字为本轮**实际运行**所得，不是记忆值。基线见 `baseline.md`。

## 1. 18 个既有套件：断言数前后对照（最关键的一条门）

采集：`node scripts/test-<name>.mjs > out 2>&1`，断言数 = 输出中 `✓` 行数。

| # | 套件 | 改动前 | 改动后 | 差 | exit |
|---|---|---|---|---|---|
| 1 | percent | 21 | 21 | +0 | 0 |
| 2 | ssr-parser | 72 | 72 | +0 | 0 |
| 3 | quality | 32 | 32 | +0 | 0 |
| 4 | tray | 98 | 98 | +0 | 0 |
| 5 | pet | 43 | 43 | +0 | 0 |
| 6 | gesture | 58 | 58 | +0 | 0 |
| 7 | **adapters** | **166** | **166** | **+0** | 0 |
| 8 | structure | 85 | 85 | +0 | 0 |
| 9 | read-model | 118 | 118 | +0 | 0 |
| 10 | voice | 49 | 49 | +0 | 0 |
| 11 | speech-out | 197 | 197 | +0 | 0 |
| 12 | trigger-engine | 146 | 146 | +0 | 0 |
| 13 | alert-orchestration | 240 | 240 | +0 | 0 |
| 14 | system-notify | 73 | 73 | +0 | 0 |
| 15 | usage-predict | 104 | 104 | +0 | 0 |
| 16 | usage-store | 42 | 42 | +0 | 0 |
| 17 | usage-history | 72 | 72 | +0 | 0 |
| 18 | cli-export | 107 | 107 | +0 | 0 |
| | **合计** | **1723** | **1723** | **+0** | 18/18 |

`adapters` 那一行是本任务的核心证明：它被新增了 `callProjectRich` / `makeRichRequest`
两个函数，而断言数**一条没变** → D3「只加不改」成立，既有投影的返回形状未动。

新增第 19 套件 `test:seam`（36 项，全绿），故 `npm test` 总体 1759 项。

## 2. 门禁

| 命令 | 结果 |
|---|---|
| `node scripts/test-seam.mjs` | exit 0，36 通过 / 0 失败 |
| `npm test`（19 套件） | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |

## 3. 反验一：把 `req.method ?? 'GET'` 改回硬编码 `'GET'`

断点：`const method = req.method ?? 'GET'` → `const method = 'GET'`

实测红集 = **恰好 3 项**（`通过 33 项，失败 3 项`，exit 1）：

```
✗ S3a POST 按 POST 发
✗ S4a POST 按 POST 发
✗ S6f request.ts 的实现读了 req.method（钉住 D4：不能硬编码 'GET'）
```

- S3a / S4a 是行为断言（POST 请求真的变成 GET 了）。
- **S6f 是 D4 的静态守卫**，它红了 → 守卫有牙齿。
- 目标集之外的断言一条没红 → 破坏范围受控，这一批只证明了它要证明的事。
- 还原后 `通过 36 项，失败 0 项`。

## 4. 反验二：让接缝自动 `JSON.stringify(body)` 并覆盖调用方 Content-Type

断点（模拟 design.md 的 Bad case）：

```ts
const body = req.body === undefined ? undefined : JSON.stringify({ raw: req.body })
const headers = { ...req.headers, 'Content-Type': 'application/json' }
```

实测红集 = **9 项**（`通过 27 项，失败 9 项`，exit 1）：

```
✗ S1d 无 body → 不补 Content-Type
✗ S2c 显式 GET 无 body → 不补 Content-Type
✗ S3c POST 无 body → 不补 Content-Type（无体不需要）
✗ S4b body **原样**到达 fetch（接缝不碰内容，一个字节都不改）
✗ S4e 空串 body 原样透传（不被当成「没给 body」丢成 undefined）
✗ S5a form body 原样到达 fetch
✗ S5b 自带 form Content-Type 时不被覆盖（form 编码必须生效）   ← 任务点名的用例
✗ S5d 只存在一个 Content-Type（没被补成两份同义头）
✗ S6h 整个 request.ts 里 JSON.stringify 出现 0 次
```

还原后 `通过 36 项，失败 0 项`。

### ⚠ 过程中发现并修掉的一个**假守卫**

S6h 的守卫**两次收窄都失效**，值得记下来：

| 版本 | 写法 | 注入 `JSON.stringify({ raw: req.body })` 时 |
|---|---|---|
| v1 | `!/JSON\.stringify\(\s*req\.body/` | **没红**（写法对不上） |
| v2 | fetch 调用**那一行**里不许有 `JSON.stringify` | **没红**（突变挪到上一行即绕过） |
| v3（现版） | 整个 `request.ts`（剥注释后）`JSON.stringify` 计数 = 0 | **红了** ✅ |

两次「没红」时动态断言（S4b/S5a/S5b）都还在兜底，所以最终结论没受影响 ——
但那条静态门自己是有洞的。这正是 spec 第 6 条现在写「收窄的静态守卫尤其要实测」的由来。
现版的作用域是整个文件，成立的理由是：接缝的职责只有 `assertNetAvailable` /
`AbortController` / `fetch` / 可达性记账，**没有任何需要自己序列化东西的理由**，
所以「一次都不许出现」是一个站得住的前提，而非为了让断言变红而设。

## 5. 改动范围自查（禁碰文件）

```
M package.json
M scripts/test-adapters.mjs      （只新增 callProjectRich / makeRichRequest）
M src/main/adapters/types.ts     （只加两个可选字段）
M src/main/request.ts            （透传）
?? scripts/test-seam.mjs          （新建）
M .trellis/spec/adapters/index.md（接缝契约文档）
```

逐个确认**未改动**：`protocols.ts`（PROTOCOLS 仍 8 条，adapters 166 项全绿即证）、
`adapters/index.ts`、`main/providers.ts`、`provider-icons.ts`、`main/scheduler.ts`、
`gemini.ts` / `antigravity.ts` / `cursor.ts` / `codex.ts`（本任务不做适配器）、
整个 `src/renderer/` 与 `src/main/qa/`。

## 6. 既有调用点零改动

`grep -rn "request({" src/` → 2 处，都只传 `url` / `headers` / `timeoutMs`：

- `src/main/adapters/engine.ts:102`
- `src/main/adapters/opencode-cookie.ts:273`

两处**一行未改**（新字段都是可选，且 18 套件断言数不变为其证明）。