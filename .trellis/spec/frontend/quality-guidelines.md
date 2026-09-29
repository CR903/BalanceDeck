# Quality Guidelines

> There is **no linter, no formatter, and no CI** in this repository.
> `glob '{.eslintrc*,eslint.config.*,.prettierrc*,prettier.config.*,biome.json,.editorconfig,oxlint*}'`
> → no files. No husky, no lint-staged, no `.github/`.
>
> The quality gate is **`tsc` + 13 hand-rolled assertion scripts + a real-Electron QA harness.**
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

6 scripts use it (`test-adapters`, `test-ssr-parser`, `test-tray`, `test-pet`,
`test-gesture`, `test-read-model`); `test-quality.mjs` imports the real
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

### Don't: eyeball a screenshot — decode it

`--ballshot` writes a 112×112 mostly-transparent PNG. Glancing at it, the "light square around
the ball" bug looked absent; decoding it, **100% of the pixels outside the ball's circle carried
alpha** (2688/2688, out to the window's diagonal), because `capturePage()` photographs the
window *contents* and the artifact was the page's own alpha. `scripts/lib/png-probe.mjs`
(≈90 lines, `zlib` only, no new dependency) exists for exactly this.

⚠ **Derive DPR from the CSS size, not from the file's pixel count.** `capturePage()` returns
**2× device pixels** on this machine: the 56 CSS px ball comes out 112×112, the 384×600 expanded
window 768×1200. Getting this wrong does not error — it just reports nonsense. Writing
`dpr = width / 112` (the *device* width) yields `dpr = 1` and `R = 28`, which classifies the
square around the circle as "inside the ball" and reports a fabricated **75.4% of pixels outside
the disc carrying alpha** on a build that is actually clean. The correct divisor is
`BALL_VIEW.width = 56`, and the only trustworthy self-check is that the numbers match a known
good frame (clean = 208/2688 outside, furthest radius 56.7 px, 0 beyond 2 px).

The corollary matters as much: `capturePage()` **does not** composite the desktop, so "the ball
shows the wallpaper through it" is *not* observable that way. Two different claims got merged
into one "we can't see it" and cost three misdiagnoses. Before declaring a symptom unobservable,
write down **which layer** you need, then check whether that layer is in the file you have.

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

Procedure, the exact-red-set rule, and two ways it silently fails: see
*Proving an assertion can fail* under **Testing Requirements**.

### Don't: put a function into a `window` test hook

`PetBall.tsx:143-146` documents it: the payload crosses `executeJavaScript`, so it must be
structurally clonable. Data hooks (`__bd_ball`) and action hooks (`__bd_hide`) are separate
for this reason.

---

## Testing Requirements

### The unit suites

`npm test` chains them with `&&` in a fixed order, so the first failure short-circuits
(`package.json` `scripts.test`):

```
percent → ssr → quality → tray → pet → gesture → adapters → structure → read-model
        → voice → speech-out → trigger-engine → alert-orchestration
```

| Script | Loads real source | Covers |
|---|---|---|
| `test-percent.mjs` | **inline copy** ⚠ | percent normalisation / rounding |
| `test-ssr-parser.mjs` | `loadTs` ×3 | console window + per-model parsing, real captured fixtures |
| `test-quality.mjs` | direct `.ts` import | cache policy, staleness, network errors |
| `test-tray.mjs` | `loadTs` | tray wording, offline/cache prefixes |
| `test-pet.mjs` | `loadTs` | identity model, serialization, migration |
| `test-gesture.mjs` | `loadTs` ×2 + `fs` | clip catalog consistency, scheduling |
| `test-adapters.mjs` | `loadTs` ×12 | golden samples A–N, production net R, fan-out S, store T, parity U |
| `test-structure.mjs` | static file reads | 45 architectural guards (A–E: entry / qa / ball surface / **broadcast main-process preconditions**) |
| `test-read-model.mjs` | `loadTs` ×2 | read model + formatting |
| `test-voice.mjs` | `loadTs` | system-voice gender matching (was an inline copy; it hid a real `Siri 声音 1` mismatch — and later, see below, a *wrong* fact) |
| `test-speech-out.mjs` | `loadTs` | queue / interrupt / rate gate / TTS-vs-fallback / the "service unreachable" signal |
| `test-trigger-engine.mjs` | `loadTs` ×2 | 5 trigger scenarios, grading, merge/dedupe |
| `test-alert-orchestration.mjs` | `loadTs` ×3 | **calling order** into the trigger engine + the repeat-until-confirmed state machine |

**The script convention** (uniform across all): a `//` header stating
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

### Pattern: the orchestration pure-function boundary

**Problem.** This repo has no React test infrastructure (no vitest / RTL / jsdom), so
anything living inside a `.tsx` component is untestable. In the voice-alert work this left
three production-fatal bugs unguarded — all in `App.tsx`'s `evaluateAlerts`, none in the
engine it calls. `test-trigger-engine.mjs` covered `checkTriggers` thoroughly and still could
not answer *"did the caller feed things in the right order?"*

The engine answers **「给定快照与历史能不能判出命中」**; it cannot answer **「谁先谁后」**.

**Solution.** Extract the orchestration steps into a pure module that takes an explicit
immutable context and returns a decision, leaving the component as a thin side-effect shell.

```ts
// src/renderer/src/alertOrchestrate.ts — no electron, no DOM, no React
export interface AlertContext { /* snapshots, history, config, …, now */ }
export interface Decision { text: string | null; urgent: boolean; nextHistory: …; nextLatched: … }
export function evaluate(ctx: AlertContext): Decision | null

// src/renderer/src/App.tsx — the only side effects live here
const d = evaluate({ ...ctx, latched: latchRef.current, now: Date.now() })
if (!d) return false
if (d.nextHistory !== ctx.history) persistHistory(d.nextHistory)   // same-reference = skip
alertLatchRef.current = d.nextLatched
if (!d.text) return false
speakOut(d.text, d.urgent)
```

Rules that make this boundary work (each was learned the hard way):

1. **`now` is a parameter.** The pure module must not read its own clock. Exactly one
   `Date.now()` in the wrapper.
2. **The context is a snapshot, not a closure.** The wrapper reads live values from a ref
   mirror (see [`state-management.md`](./state-management.md)) and spreads them in; the pure
   function never closes over them. This is what keeps the timer contract intact.
3. **`null` must not swallow side effects.** `evaluate` returning `null` means *"nothing
   changed at all"* (no snapshots). "This round doesn't broadcast" is `text === null` — that
   round **still records history and updates the latch**. Returning `null` for both silently
   starved `statsFor` of samples, so the anomaly scenario could never fire.
4. **Latch only what reached the decision.** `latchKeys(speakable)`, not `latchKeys(hits)`.
   Otherwise hits filtered out by a grading rule get recorded as "already spoken" and are
   never heard again.

**Testing it** needs no new dependency: `loadTs` the pure module the same way as any other.

**Verify the guard can fail** — inject all four historical bugs and confirm each goes red.
Red sets are the **measured** numbers (2026-09-29 re-measured after the AC7 batch landed, so
they moved from the original figures — record what you measure, not what you remember):

| Injection | Red assertions (measured) |
|---|---|
| feed `checkTriggers` the already-appended history | 10 |
| latch `hits` instead of `speakable` | 2 |
| drop `perProvider` in the engine | 4 (orchestration) + 1 (engine) |
| remove latching entirely | 20 |
| `AUTO_CONFIRM_MS` = 1 min | 23 |
| `REPEAT_MS` = 1 min | 6 |
| drop a fourth dependency on the broadcast timer | 1 |
| `RATE_LIMIT.MAX_PER_MINUTE` = 99 | 7 (speech-out) + 1 (orchestration) |
| `RATE_LIMIT.MAX_PER_HOUR` = 2 | 2 (orchestration) |

### Pattern: a repeat-until-confirmed window must outlast the repeat interval

**Problem.** Two settings that sound independently reasonable can cancel each other out
completely. "Repeat the alert every 5 minutes" plus "auto-confirm after 1 minute" means the
alert fires **exactly once** — identical to not repeating at all, with twice the machinery.

**Why it's bad:** nothing throws. Both features work exactly as written; the composition is
what is wrong. The spec that asked for both looked reasonable on its own, which is why it
survived into implementation.

**Rule:** any auto-stop window must cover at least N repeat periods. In
`alertOrchestrate.ts` that is `AUTO_CONFIRM_MS = 15 * 60_000` against `REPEAT_MS = 5 * 60_000`.

**Guard it.** The regression is a one-character edit, so it needs an assertion:

```js
// scripts/test-alert-orchestration.mjs — L0b/L0c
ok(AUTO_CONFIRM_MS > REPEAT_MS, '自动确认窗口必须大于重复间隔（否则重复永不发生，AC7 是空功能）')
```

Injecting `AUTO_CONFIRM_MS = 60_000` reddened 23 assertions — the widest blast radius of any
mutation in this suite, which is the point: this invariant is load-bearing everywhere
downstream, not just at its own definition site.

### Don't: hide an interactive control inside `aria-hidden`

**Problem.** `.petball-bubble` is `aria-hidden="true"` (a decorative readout). Adding a
`<button>` inside it makes the control invisible to assistive tech and breaks the
"hidden content is not focusable" rule, while still looking interactive and being clickable.

**Instead:** make the confirm bar a **sibling** of the bubble:

```tsx
<div className="petball-confirm" role="status">
  <span className="petball-confirm-text">{alertText}</span>
  <span className="petball-confirm-eta" aria-hidden="true">{alertMinutes} 分</span>
  <button type="button" onClick={() => onConfirmAlert?.()}>知道了</button>
</div>
```

`role="status"` makes the alert text announced as a state change; the button is genuinely
focusable; the purely decorative countdown is separately hidden. Guarded by a structural
assertion (L53/L59) — see below for how brittle that turned out to be.

**Note on slicing JSX in assertions.** The first version of that guard located the confirm bar
by a text anchor, which went green under mutation because the moved bar landed outside the
slice. Matching on `<div` / `</div>` still failed: the search ran *forward* from an index
already inside the opening tag, so it matched the confirm bar's own tag. The working version
uses `lastIndexOf`. Structural JSX assertions are the most fragile guards in this repo —
prefer behavioural ones, and re-verify any you add by mutating the code.


### Pattern: loading the real source cannot catch a wrong *fact*

**Problem.** `voice.ts`'s `voiceGender` classified the macOS Chinese voice **Yu-shu** as male.
It isn't — Apple's own voice bundle is `com.apple.ttsbundle.siri_**female**_zh-CN_compact`.
`test-voice.mjs` asserted `Yu-Shu → male`, and the *same subagent* wrote both. Loading the real
module (the rule this file otherwise insists on) therefore passed, and the reverse-verification
step passed too: mutating the keyword table made the suite go red, so the guard "had teeth".

The guard did have teeth. It was guarding a **false belief**.

**Why it's bad:** a user who picks 男声 for the system-voice fallback on macOS gets a female
voice — exactly the class of bug the whole `voiceGender` function exists to prevent. And the
wider keywords that made it worse (`yu`, `shu`) then hit the prefix trap from the other side:
`"yunxi"` is a substring of `"yunxia"`, and **Yunxia is female**.

**Rule:** a guard proves the *code* matches the *test*. Only a lookup against the real system
proves either matches the *world*. When a test's expected value encodes an external fact, cite
where that fact came from — in the fixture, next to the value.

**Guard it:** the fix is a *negative* assertion about a name that must NOT be claimed, plus a
word-boundary matcher instead of a prefix:

```js
eq(voiceGender({ name: 'Yu-Shu', lang: 'zh-CN' }), 'female', '…（siri_FEMALE_zh-CN；曾错判成 male）')
eq(voiceGender({ name: 'Microsoft Yunxia', lang: 'zh-CN' }), 'unknown', '不能因 "yun" 判成男声')
```

And make the *un*helpful direction the tested one: a `pickVoice` assertion over a **reversed**
voice list, so "the fixture happened to be ordered favourably" stops counting as a pass.

**Check the real thing when you can.** `say -v '?'` on the build machine lists the installed
voices; that is a mechanism, not a memory. The corrected table cites both it and the bundle id.


### Pattern: an `extras` read cannot tell "absent" from "empty"

**Problem.** `extras:get` fills in `''` for keys that were never written
(`out[k] = (await getExtra(k)) ?? ''`, `ipc.ts:198`). Two broadcast settings tested for absence
with `typeof v === 'string'` / `v == null`, and both silently never fired:

- `setTtsPreset(e['ui:ttsPreset'] === '' ? … : 'mytts')` never chose the free preset, so a
  **fresh install landed in the custom-service branch with an empty URL** — no service
  configured, so nothing ever broadcast (AC1/AC2/AC3 dead on day one).
- `e['ui:ttsOn'] == null && legacyOn` was never true, so the `ui:voiceOn` → `ui:ttsOn`
  migration was **dead code**: users who had broadcasting on lost it on upgrade.

**Rule:** read absence as falsy, and never let a stored value *be* the sentinel that means
"unset". The second half is the subtler one: the custom-service option used `value=""`, so
choosing it wrote `''` — indistinguishable from never-chosen, and a user who picked a custom
endpoint got flipped back to the preset on restart. Give it a real id (`'custom'`).

**Guard it.** This class of bug is invisible to the pure-function suites — it lives in an
`extras` round trip through a real window. `--uitest` covers it:

```js
// the branch that actually rendered, not the control's value — see the <select> note below
r.vrsEndpoint = (await exec("!!document.querySelector('.vrs-endpoint')?.value?.includes('mytts')")) ? 'ok' : 'fail:no-endpoint'
```

Verified by reverting the fix: `vrsEndpoint` goes red, nothing else does.

**Problem.** The repeat-until-confirmed cadence lives in `alertOrchestrate.ts` (`REPEAT_MS =
5min`, `AUTO_CONFIRM_MS = 15min`); the app-level rate cap lives in `speechOut.ts` (`1/min`,
`10/hour`). The repeat path deliberately reuses the same `speakOut` exit, so **neither module
can see the other's numbers** — and no test compared them either.

The failure this would produce is silent in a specific way: the hourly cap swallows a repeat →
the orchestration still advances `lastSpokenAt` → the countdown keeps ticking and the confirm
bar keeps showing, but the user hears nothing. Nothing throws; the alert just "stops working".

**Rule:** when feature A's cadence crosses a budget enforced by feature B, assert the
arithmetic **in one test that loads both modules**. This is the only cross-module invariant
assertion in the repo, and it exists because the two files have no shared import.

```js
// scripts/test-alert-orchestration.mjs — L33b…L33d
const perBatch = 1 + Math.floor(AUTO_CONFIRM_MS / REPEAT_MS)   // 一个未确认批次最多播几次
ok(REPEAT_MS >= RATE_LIMIT.MAX_PER_MINUTE * 60_000, …)
ok(perBatch <= RATE_LIMIT.MAX_PER_HOUR, …)
ok(Math.floor(RATE_LIMIT.MAX_PER_HOUR / perBatch) >= 2, …)      // AC6 要求两批能并存
```

The `>= 2` is the load-bearing one: the behavioural assertions (L22/L27) prove two batches are
*independent*, and this proves they also *fit* in the budget. Neither alone is enough.


### Don't: signal "no broadcast" with the same value as "no change"
**Problem.** A single `null` return for both "the whole round is a no-op" and "there is
nothing to say this round" makes the caller skip history and latch updates in the second case
too.

**Why it's bad:** the sample counter feeding the anomaly detector never grows, so the feature
silently never fires — and no assertion fails, because every individual step is correct.

**Instead:** distinct signals. `evaluate() === null` for "nothing changed"; `text === null` for
"changed, but nothing to say" (and the caller still persists history + latch).


### `test-structure.mjs` — the architectural guard (45 assertions, pure static)

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

**Section D is the pattern to copy when a gate needs to read a CSS *declaration block*.** All
three traps are load-bearing and each was hit for real (see `scripts/test-structure.mjs:73-88`):
a comment in the block makes a literal `grep` always-red, a fixed `-A14` window misses a
declaration 18 lines down (a permanently-true fake guard), and the *first* occurrence of the
class name is a comment in `:root`. So: strip `/* */` → locate the **full** selector → balance
braces → then judge the declaration. `ruleBody` / `decls` / `declScopes` are the three helpers.

**One rule that generalises: a negative assertion needs a precondition, or it passes
vacuously.** `!body.includes('backdrop-filter')` is true when `body` is `null` (selector renamed)
and `outer.length === 0` is true when there are zero layers (declaration deleted). Both look
green and mean nothing. Every negative in section D therefore carries either `body != null` or a
`length > 0` floor.

### The real-Electron QA harness

Different contract from the unit scripts: **results are JSON on stdout and the exit code is
not the signal** (`qa/modes.ts:14-15`: "UI 断言以 JSON 打到 stdout，**不设置退出码** —— 失败与否由调用方解析").

> **⚠️ `npx electron . --X` 跑的是 `out/`，不是 `src/`.**
>
> `package.json` 是 `"main": "./out/main/index.js"`，Electron 入口从不读 TypeScript。
> **任何源码改动之后、electron QA 之前必须 `npm run build`** —— 否则这一轮跑的是上一次的
> 构建产物，绿灯毫无意义。（此坑曾静默作废一整轮「验证」：改动后的源码已生效、
> `--uitest` 却仍在测 5 小时前的 `out/`，两轮报告都以为自己在测新代码。）

| | |
|---|---|
| ✅ 正确 | `npm run build` **单独一行** → `BD_USER_DATA=/tmp/x npx electron . --uitest` |
| ❌ 错误 | `BD_USER_DATA=/tmp/x npm run build && npx electron . --uitest` —— env 只传给 `npm run build`，electron 那次继承**默认** userData，报 20+ 条假失败 |
| ❌ 错误 | 改了 `src/` 直接跑 `npx electron . --uitest` —— 测的是旧 bundle |
| 新鲜度判据 | `ls -l out/main/index.js` 的 mtime 必须**晚于**最后一个改动的源文件 |

`npm run uitest` / `npm run shots` / `npm run smoke` 三个包装脚本**自带 build**。
**`--ballshot` 没有 npm 脚本**，必须显式先 build。

| Command | Handler | Env vars |
|---|---|---|
| `npm run smoke` | `qa/modes.ts:49` `runSmoke` | `SMOKE_WAIT_MS` (6000), `BD_TRACE` |
| `npm run uitest` | `qa/uitest.ts` — 119 ok / 135 keys (2026-09-29, +23 for the voice-reminder settings section) | `BD_TRACE`, `BALANCEDECK_AUTOSTART_DIR` (forced to a temp dir) |
| `npm run shots` | `qa/shots.ts` → `/tmp/balancedeck-shots/` | none |
| `npm run details:test` | `qa/modes.ts:119` | `OPENCODE_GO_WORKSPACE_ID`, `OPENCODE_GO_COOKIE` |
| `--ballshot` (direct) | `qa/ballshot.ts` | `BD_PET`, `BD_PET_ID`, `BD_PETS`, `BD_FAKE_DATA`, `BD_SKIP_COLLAPSE`, `BD_ONLY`, `BD_TOGGLE`, `BD_ISOLATE`, `BD_SETTINGS`, `BD_SKINS`, `BD_DEBUG_RING` |

Parse uitest output by counting `"ok` and grepping `fail`; do **not** trust `$?`.

> **Warning**：JSON 打印完整后进程有时**不自行退出**（已知 flake，与磁盘剩余 ~4GB 有关）。
> 判据是「**键数齐全 + `execErrors` 已打印**」，随后手动杀进程；**既不许把挂起当失败，
> 也不许把这一轮丢掉不报**。`$?` 不可信，这条在挂起时尤其成立。

**`petFigureUnchanged` 在 DPR=1 的机器上必然红，这不是回归。** 它的 `FIG_BASE` 记的是
`canvas: [426, 586, 213, 293]`（`capturePage` 风格的 2× 设备像素）；DPR=1 的机器上读回来是
`[213, 293, 213, 293]`，于是逐位比对失配。诊断时要先看**是哪几个字段**不同 —— 十个字段里
只有 canvas 变了就说明是 DPR，不是代码。别去「修」它：这条断言的整个价值就在于逐位钉死。

**Locating controls in `--uitest` must be by class name, never by option value.** Settings has
several `<select>`s and the "播报间隔" one also has an option valued `10`, so a
"first select with an option `10`" selector kept mutating the voice interval and reporting
`intervalSaved: fail` for weeks while the product was fine (`uitest.ts:247-251`, fixed in
`e7d782b`). **Add a class when you need a hook; there is no attribute-based selector layer.**

The same collision came back in another shape when the voice section landed: the retired
`.voice-interval` disappeared and `.vrs-routine-interval` (values 5/10/…/60) took its place
in front of `.refresh-interval`. The *fix* was not needed, the *selector* was — and the comment
at `uitest.ts:470-473` records that the culprit changed identity.

**A controlled `<select>` hides "no option matches its value".** With `value=''` and no
`<option value=''>`, the DOM silently falls back to the first option, so `s.value` reads back
the *first* option. An assertion on `select.value` therefore stays **green** while the component
is rendering a different branch than you think — this cost a real bug a round of review
(`vrsPreset` green, `vrsEndpoint` red). **Assert the branch that got rendered, not the
control's value.**

**`executeJavaScript` is not a module: top-level `await` throws.** A probe written as
`JSON.stringify(await window.api.getExtras([...]))` fails with `Script failed to execute`, which
surfaces only in the aggregate `execErrors` field — every other assertion in the run still
reports `ok`, so it reads as a flake. Use `.then(...)` and let `exec` await the promise.

### Proving an assertion can fail — break-once, with an exact red set

An assertion that cannot be broken is a **fake guard**. The proof is mandatory, per assertion:

1. write → run → **green** (proves it is not always-red)
2. break **only the tested behaviour** → run → **red** (proves it is not always-green)
3. restore → run → **green**
4. record *the break + the actual red output* next to the assertion's checklist entry

**The red set must equal exactly that batch's declared target set.** One extra red means the
blast radius was not controlled — the batch proves nothing about its intended target and must be
redone with a narrower break. Batching several assertions into one run is fine *only* when each
target has a break that isolates it.

**Two ways this fails, both seen in practice:**

- **The break that cannot turn it red.** "Do not assign `display.current = target` at the end of
  the animation" was the documented break for *exact final value* — but at `easeOut`'s `t = 1`
  the interpolation is *exactly* `target`, so the assertion stayed green and proved nothing. The
  fix was a different break (`commit(target * 0.97)`), which necessarily reddens the other
  readout-comparing assertions: declare them as co-targets of the same batch instead of
  pretending isolation.
- **A baseline that looks moved.** Before claiming a change "moved the baseline to go green",
  run `git show HEAD:<file> | grep <field>`. A field that **does not exist in HEAD** is a first
  draft written in this round, not an established expectation — correcting it is not weakening
  it. Established fields never change; align the new draft to the authoritative ones instead
  (`overlay` came from a `--ballshot` diag and was authoritative; `idx`/`caption` did not, and
  the two could not describe the same frame).

**Synthetic events.** React handlers (`onWheel`, `onClick`, …) fire from
`el.dispatchEvent(new WheelEvent('wheel', {deltaY: 100, bubbles: true}))`.
`:active` does **not** — it is driven by the UA compositor, so dispatching it never lights the
selector; use `webContents.sendInputEvent` for press feedback.

**A grep gate vs. a string you must assert on.** After deleting a UI literal, a test may need it
verbatim to assert its absence while the gate forbids it in `src/`. Build it in the test file
(`'\u663e\u793a' + '\u7528\u91cf\u73af'`) — runtime-identical, invisible to grep.
**Required proof**: with the feature restored, the grep gate *and* the assertion must go red in
the **same** run. Concatenate only in the test, never in product code.

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
- [ ] `npm test` all suites 0 failures
- [ ] `npm run build` clean
- [ ] Any new tsconfig option — is it actually set in *both* configs, or does it need adding?

## Related

- [`type-safety.md`](./type-safety.md) · [`directory-structure.md`](./directory-structure.md)
- ADR-0003 one-shot cutover (golden samples): [`../../../docs/adr/`](../../../docs/adr/)
