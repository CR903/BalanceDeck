# Quality Guidelines

> There is **no linter, no formatter, and no CI** in this repository.
> `glob '{.eslintrc*,eslint.config.*,.prettierrc*,prettier.config.*,biome.json,.editorconfig,oxlint*}'`
> → no files. No husky, no lint-staged, no `.github/`.
>
> The quality gate is **`tsc` + 10 hand-rolled assertion scripts + a real-Electron QA harness.**
> Formatting is therefore *de facto*, not enforced: 2-space indent, **no semicolons**, single
> quotes, ~110–120 col soft width, `// ─── section ───` banner comments with box-drawing
> rules, Chinese comments and Chinese commit messages.

---

## Forbidden Patterns

### Don't: inline a copy of the implementation into its test

This has already happened and been caught. `scripts/test-percent.mjs:19-20`:

```js
// 与 src/shared/percent.ts 等价的内联实现（保持同步；源文件为 TS，node 直接跑需转译）
function roundPercent(p) { return Math.round(p * 10) / 10 }
```

"Keep this in sync" is not a mechanism. The source can change and the test stays green.
ADR-0003 records that this file had already drifted.

**Use `loadTs` instead** — it bundles the real module with esbuild and imports it:

```js
// scripts/lib/load-ts.mjs:26-39 (abridged)
export async function loadTs(relPath, { alias } = {}) {
  const result = await build({ entryPoints: [resolve(ROOT, relPath)], bundle: true,
    format: 'esm', platform: 'node', target: 'node22', write: false, … })
  const url = 'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text, 'utf8').toString('base64')
  return import(url)
}
```

7 scripts use it (`test-adapters`, `test-ssr-parser`, `test-tray`, `test-pet`,
`test-projection`, `test-gesture`, `test-read-model`); `test-quality.mjs` imports the real
`.ts` directly via Node's type stripping; **only `test-percent.mjs` still inlines.**
Convert it if you touch it.

### Don't: add a mock that lets a test silently take a different path

`scripts/test-adapters.mjs:98-118` is the model — **exact URL match, and an unmatched URL
throws**:

```js
request: async (req) => {
  list.push(callProject(req.url, req.headers ?? {}))
  const r = routes.find((x) => x.url === req.url)
  if (!r) throw new TypeError(`fetch failed（本套件未覆盖的 URL: ${req.url}）`)
  if (r.throw) throw new TypeError(r.throw)
  return { status: r.status ?? 200, text: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) }
}
```

The comment at `:95` names the reason: "避免测试静默走别的分支". `list` also records
`{ url, auth, accept }` per call, so assertions verify *which* endpoint and *which* headers
the adapter used — not merely that it returned something.

Same discipline in the electron stub:

```js
// scripts/lib/electron-stub.mjs:8-10
// 这里**只实现被用到的成员** … 而不是让测试因为拿不到而静默走别的分支
export const net = { isOnline: () => true }
```

### Don't: add a `switch` on severity, or a second spelling of a class name

There are already three ways to express severity (`lvl-${Level}`, `dotLevel(): string`,
bare `.ok/.warn/.danger`). Read `component-guidelines.md` before adding a fourth.

### Don't: pass a "plausible zero" where the value is actually unknown

The single most repeated lesson in this repo's history. `CONTEXT.md` requires data quality to
be **explicitly declared**; ADR-0002 makes provenance structurally required. Concretely:
`quota`/`percent` are `undefined` (renderer shows `—`), a percentage that cannot be computed
is not reported as `0%`, and `modelsByWindow` omits the 5-hour key rather than approximating
24h data. **A missing value the user can see beats a plausible value they cannot.**

### Don't: trust a label — verify the mechanism

`scripts/verify-opencode.mjs:65-70` had a comment reading
`// ── 2. 官方 API 响应（实测）` above a **hard-coded object literal** whose `resetsAt` values
were two weeks stale. The script never opened a socket. We reported "the official API is
fine" on the strength of it; it returned 403. The comment is now
`这是硬代码的历史样本，不是实时响应`.

### Don't: leave a guard in place that reads as verification but isn't

`PetSection.tsx:57-66` sets `let alive = true` and checks it in a **synchronous** loop body —
always true. It looks like unmount protection and is not.

### Don't: put a real credential literal in source, examples, or tests

Stated twice: `main/store.ts:13` and `main/keystore.ts:6`. Read credentials through
`CollectContext.getKey`. Debug scripts print masks only
(`scripts/keystore-debug.js` prints first 8 + last 4 + length).

---

## Required Patterns

### Pure logic goes in a pure module

Anything testable without electron goes in `src/shared/` or a `pet3d/*.ts` pure module, with
the constraint stated in its header:

```ts
// src/shared/quality.ts:15
// 本模块是纯函数（不依赖 electron），因此主进程、渲染层与单元测试共用同一实现。
```

```ts
// src/renderer/src/pet3d/gesture.ts:4
* 纯函数模块（无 three / 无 DOM / 无 React），scripts/test-gesture.mjs 直接跑。
```

### Adapters take network as an injected capability

`CollectContext.request` is the seam. Do not `import { net }` or `fetch` directly in an
adapter — the two files that do it, say so:

```ts
// src/main/adapters/types.ts:6-7
// 这个模块刻意不 import electron，也不 import net.ts —— 出网是注入的能力
```

### Constants that are used in more than one file get one home

`src/main/adapters/opencode-console-api.ts` is a **zero-import** constants module so both the
cookie path and the details path can depend on it without a cycle. `pet3d/rig.ts` is the
equivalent for camera/form constants, and `pet-view.ts` for window dimensions.

### Verify the guard can fail

After adding an assertion, break the thing it guards and watch it fail. An independent
reviewer inverted six behaviours (concurrency, retry, mandatory header, key mapping,
server-side tokens, a range table) and **all 49 assertions stayed green**. The suite was
real, just blind above the parser layer. This is a required step, not a nicety.

### Don't: put a function into a `window` test hook

`PetBall.tsx:143-146` documents it: the payload crosses `executeJavaScript`, so it must be
structurally clonable. Data hooks (`__bd_ball`) and action hooks (`__bd_hide`) are separate
for this reason.

---

## Testing Requirements

### The ten unit suites

`npm test` chains them with `&&` in a fixed order, so the first failure short-circuits
(`package.json:27`):

```
percent → ssr → quality → tray → pet → projection → gesture → adapters → structure → read-model
```

| Script | Lines | Loads real source | Covers |
|---|---|---|---|
| `test-percent.mjs` | 66 | **inline copy** ⚠ | percent normalisation / rounding |
| `test-ssr-parser.mjs` | 305 | `loadTs` ×3 | console window + per-model parsing, real captured fixtures |
| `test-quality.mjs` | 128 | direct `.ts` import | cache policy, staleness, network errors |
| `test-tray.mjs` | 119 | `loadTs` | tray wording, offline/cache prefixes |
| `test-pet.mjs` | 104 | `loadTs` | identity model, serialization, migration |
| `test-projection.mjs` | 138 | `loadTs` + real `three` | NDC half-span, cross-checked against three's matrix |
| `test-gesture.mjs` | 226 | `loadTs` ×2 + `fs` | clip catalog consistency, scheduling |
| `test-adapters.mjs` | 1160 | `loadTs` ×12 | golden samples A–N, production net R, fan-out S, store T, parity U |
| `test-structure.mjs` | 74 | static file reads | 13 architectural guards |
| `test-read-model.mjs` | 127 | `loadTs` ×2 | read model + formatting |

**The script convention** (uniform in all 10): a `//` header stating
`用法：node scripts/<name>.mjs` plus what it covers; then `let pass = 0; let fail = 0`; then
local `eq()`/`ok()` helpers that compare with `JSON.stringify`; then flat `console.log`
section headers; then a summary; then `process.exit(fail ? 1 : 0)`.

```js
// scripts/test-percent.mjs:6-15
function eq(actual, expected, label) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; console.log(`  ✗ ${label}\n      实际: ${a}\n      期望: ${e}`) }
}
```

Three summary-line spellings coexist (`结果：N 通过 / M 失败`, `通过 N 项，失败 M 项`, and a
prefixed variant) — not worth unifying, but do not assume a grep pattern matches all of them.

### `test-structure.mjs` — the architectural guard (13 assertions, pure static)

```js
// :35-38
ok(lines <= 500, `A1 ${INDEX} 不超过 500 行（当前 ${lines} 行）`)            // index.ts is 104
ok(!/executeJavaScript/.test(index), 'A2 入口里没有 executeJavaScript（UI 驱动属于 qa/）')
ok(!/^\s*(async )?function run(UiTest|Shots)/m.test(index), 'A3 入口里没有 runUiTest / runShots 定义')
ok(/'--uitest'|'--shots'/.test(index), 'A4 入口仍认得 --uitest / --shots 参数（只做分派）')
// :46  qa/ directory listing is a CLOSED SET — a sixth file turns the suite red
// :64  renderer/ and shared/ never import qa/
// :71  main/ modules other than index never import qa/
```

**When you add a file to `src/main/qa/`, you must update the B4 assertion.** That is the
point: the closed set is deliberate.

### The real-Electron QA harness

Different contract from the unit scripts: **results are JSON on stdout and the exit code is
not the signal** (`qa/modes.ts:14-15`: "UI 断言以 JSON 打到 stdout，**不设置退出码** —— 失败与否由调用方解析").

| Command | Handler | Env vars |
|---|---|---|
| `npm run smoke` | `qa/modes.ts:49` `runSmoke` | `SMOKE_WAIT_MS` (6000), `BD_TRACE` |
| `npm run uitest` | `qa/uitest.ts` — 82 assertions | `BD_TRACE`, `BALANCEDECK_AUTOSTART_DIR` (forced to a temp dir) |
| `npm run shots` | `qa/shots.ts` → `/tmp/balancedeck-shots/` | none |
| `npm run details:test` | `qa/modes.ts:119` | `OPENCODE_GO_WORKSPACE_ID`, `OPENCODE_GO_COOKIE` |
| `--ballshot` (direct) | `qa/ballshot.ts` | `BD_PET`, `BD_PET_ID`, `BD_PETS`, `BD_FAKE_DATA`, `BD_SKIP_COLLAPSE`, `BD_ONLY`, `BD_TOGGLE`, `BD_ISOLATE`, `BD_SETTINGS`, `BD_SKINS`, `BD_DEBUG_RING` |

Parse uitest output by counting `"ok` and grepping `fail`; do **not** trust `$?`.

**Locating controls in `--uitest` must be by class name, never by option value.** Settings has
several `<select>`s and the "播报间隔" one also has an option valued `10`, so a
"first select with an option `10`" selector kept mutating the voice interval and reporting
`intervalSaved: fail` for weeks while the product was fine (`uitest.ts:247-251`, fixed in
`e7d782b`). **Add a class when you need a hook; there is no attribute-based selector layer.**

### `test-adapters.mjs` — the injected-request suite

Two layers: `makeCtx()` (`:79-92`) builds a `CollectContext`-shaped object with a **frozen
`now`**, a `getKey` that records every requested id, and a pass-through `request`; then
`makeRequest(routes)` (`:98-118`) routes by exact URL.

The **production** half of the seam is verified separately in section R (`:955-1040`) by
loading the real `request.ts` / `net.ts` with the electron alias and monkey-patching
`globalThis.fetch` (`:964-968`) — covering raw-text passthrough, 5xx not throwing, network
error propagation, `AbortError` on timeout, and the 2-strike offline accounting.

Also note the stable key-sorted serialization with `undefined` keys dropped (`:46-53`), so
`note: undefined` does not become a field in a golden sample.

---

## Code Review Checklist

**Data honesty (the project's stated core principle)**
- [ ] Does any missing/unknown value become a `0`, an empty string, or a plausible guess?
- [ ] If a field was removed from an upstream response, was the field **deleted** rather than
      defaulted?
- [ ] Does every label naming a data source still match where that number now comes from?
      `grep -rn "本机\|官方\|控制台" src/renderer/`
- [ ] If a口径 mismatch exists (right concept, wrong window), is the feature **absent** rather
      than approximated?
- [ ] Do error messages tell the user **what to do**, and are 401/404/5xx distinguished?

**Contracts**
- [ ] Is the endpoint actually the one that carries this data (verified by observing the real
      product, not from docs or a bundle declaration)?
- [ ] Are new constants added to the existing single-source module rather than re-declared?
- [ ] Do adapters still avoid `electron` / `net.ts` static imports?
- [ ] Do IPC channel names stay in sync across `preload`, `ipc.ts`, and `index.ts`?

**Tests**
- [ ] Does the test load the **real** source (`loadTs` / direct import), not a copy?
- [ ] Can the test fail? Have you broken the behaviour and watched it go red?
- [ ] Are fixtures real (captured, de-identified), not invented?
- [ ] If a file was added to `src/main/qa/`, was the B4 closed-set assertion updated?
- [ ] If a `<select>`/control was added to settings, did uitest need a new class hook?

**Build & config**
- [ ] `npm run typecheck` clean (it is not part of `npm test`)
- [ ] `npm test` all ten suites 0 failures
- [ ] `npm run build` clean
- [ ] Any new tsconfig option — is it actually set in *both* configs, or does it need adding?

## Related

- [`type-safety.md`](./type-safety.md) · [`directory-structure.md`](./directory-structure.md)
- ADR-0003 one-shot cutover (golden samples): [`../../../docs/adr/`](../../../docs/adr/)
