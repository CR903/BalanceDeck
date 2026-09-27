# Type Safety

> TypeScript conventions. TypeScript 7, `strict: true`, **no lint config**,
> **no runtime validation library**. `tsc` is the entire type gate.

---

## TypeScript Configuration

Three files, project references, `files: []` at the root:

```json
// tsconfig.json
{ "files": [], "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }] }
```

| | `tsconfig.node.json` | `tsconfig.web.json` |
|---|---|---|
| `include` | `src/main/**/*`, `src/preload/**/*`, `src/shared/**/*`, `electron.vite.config.ts` | `src/renderer/**/*`, `src/shared/**/*`, `src/preload/index.d.ts` |
| `lib` | `ES2023` | `ES2023`, `DOM`, `DOM.Iterable` |
| `types` | `["node"]` | — |
| `noEmit` | `false`, `outDir: ./out/tsc-node` | `true` |
| other | `composite`, `target: ES2022`, `module: ESNext`, `moduleResolution: bundler`, `jsx` off, `strict`, `skipLibCheck`, `useDefineForClassFields` off | same, plus `jsx: react-jsx`, `useDefineForClassFields: true` |

**`src/shared/**/*` is in both projects** — that is *how* one file type-checks in both
processes. Every import of it is relative.

**Declared but absent:** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`verbatimModuleSyntax`, `isolatedModules`, `noUnusedLocals`, `noUnusedParameters`,
`noImplicitReturns`, `forceConsistentCasingInFileNames`, `esModuleInterop`. Because
`noUncheckedIndexedAccess` is off, `arr[0]` is typed non-undefined whether or not it exists —
this is why the codebase guards with `!= null` on real objects but freely indexes arrays.

**Dead config entries — do not rely on them:**
- `paths: { "@shared/*": ["./src/shared/*"] }` in both configs. `grep '@shared/' src/` → **no
  matches**. Every real import is relative.
- `tsconfig.web.json:15` includes `src/preload/index.d.ts`, **which does not exist**
  (`src/preload/` contains only `index.ts`).

The gate:

```json
"typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json"
```

`typecheck` is **not** part of `npm test` (`package.json:27` chains only the ten test scripts).

---

## Type Organization

`src/shared/types.ts` (229 lines) is the cross-process contract. It is imported by 11 main
and 8 renderer files, and contains **no** IPC types at all — those live in preload.

**`import type` is used 100% consistently** for type-only imports. Two idioms coexist:

```ts
// separate statement
import type { ProviderSnapshot, ProviderWindow } from '../../shared/types'

// inline modifier, when values and types come from one module
import { PETS, petMeta, type PetId, type PetState } from '../../shared/pet'
import { fmtAmount, ..., type Level } from './format'
```

`verbatimModuleSyntax` is not set, so this is style, not enforcement — but there is not one
violation.

### `enum`: zero

`grep -rn "^\s*(export )?(const )?enum " src/` → nothing. Every closed set is a
string-literal union:

```ts
// src/shared/types.ts
3:  export type Unit           = 'usd' | 'cny' | 'token' | 'request' | 'percent'
11: export type ProviderKind   = 'balance' | 'coding' | 'token'
46: export type ProviderStatus = 'ok' | 'nodata' | 'error' | 'skipped'
54: export type DataQuality    = 'official' | 'local' | 'cached'

// src/shared/pet.ts
16: export type PetId = 'aria' | 'ray'

// src/renderer/src/format.ts
55: export type Level = 'ok' | 'warn' | 'danger' | 'muted'

// src/main/adapters/opencode-cookie.ts
36: export type UsageWindowKind = 'rolling' | 'weekly' | 'monthly'
```

**The pairing convention: a literal union is always accompanied by a `Record<Union, …>`
lookup table.** This is the dominant shape in the repo and the thing to imitate:

```ts
// src/main/adapters/opencode-cookie.ts:48-59
export const WINDOW_SPANS: Record<UsageWindowKind, number> = {
  rolling: 5 * 3600_000, weekly: 7 * 86400_000, monthly: 30 * 86400_000
}
export const WINDOW_NAMES: Record<UsageWindowKind, string> = {
  rolling: '5 小时', weekly: '本周', monthly: '本月'
}
```

Also `FORMS: Record<PetForm, FormRig>` (`pet3d/rig.ts:95`),
`CLIPS: Record<PetId, …>` (`pet3d/clips.ts:43`),
`GESTURES: Record<GestureId, Gesture>` (`pet3d/gesture.ts:139`),
`KIND_LABEL: Record<ProviderKind, string>` (`SettingsView.tsx:20`).
The reverse form — `as const` object as the source of the union — appears once:

```ts
// src/main/adapters/opencode-console-api.ts:61-65
export const METER_FIELDS = { fiveHour: 'rolling', week: 'weekly', month: 'monthly' } as const
```

Because `Record<Union, …>` is exhaustive, adding a union member is a **compile error** until
the table is updated. That is the property the project relies on.

### Discriminated unions: none

There is no `switch` on a `kind`/`type`/`status` field anywhere. What plays the role is a
flat interface with a status field plus independent optionals, re-checked at each call site:

```ts
// src/shared/types.ts:56-86 (abridged)
export interface ProviderSnapshot {
  status: ProviderStatus
  dataQuality?: DataQuality
  degradedReason?: string
  failureReason?: string
  updatedAt: string // ISO
}
```

`status` is **not** a discriminator: the type system does not forbid
`{ status: 'error', dataQuality: 'official' }`. The invariant is enforced by the minting
functions and by ADR-0002, not by types. Status is handled by sequential `if` returns:

```ts
// src/renderer/src/read-model.ts:48-53
export function snapshotLevel(s: ProviderSnapshot): Level {
  if (s.status === 'error') return 'danger'
  if (s.status !== 'ok') return 'muted'
  const max = maxPercent(s)
  return max == null ? 'ok' : levelOfPercent(max, 'ok')
}
```

### The one structural trick worth learning — `Omit` to make honesty required

```ts
// src/main/adapters/engine.ts:40-44
export type MintBase = Omit<
  Partial<ProviderSnapshot>,
  'dataQuality' | 'id' | 'name' | 'kind' | 'builtin' | 'mark'
> &
  Identity
```

`dataQuality` is removed from the optional set and `Identity` is re-added, so **a snapshot
cannot be minted without its identity and its provenance.** `dataQuality` then becomes a
separate positional parameter of `snap()`. This is ADR-0002 expressed in types: "缺少可信度
是编译错误，而不是一个谎言". **Use this pattern for any field whose absence would be a lie.**

### Generics

Almost none. The project's only explicit type parameter:

```ts
// src/renderer/src/pet3d/scene.ts:220
const track = <T extends THREE.BufferGeometry>(g: T): T => { … }
```

Utility types in use: `Record<>` (20 sites), `Partial<>` (6), `Omit<>` (1), `ReadonlySet<>` (1),
`readonly T[]` (1). `satisfies` and `asserts` are never used.

Type guards exist in 4 places — `isPetId` (`shared/pet.ts:55`), `isInstance`
(`main/providers.ts:200`), plus two filter predicates:

```ts
// src/main/adapters/codex.ts:208
.filter((x): x is { f: string; m: number } => x !== null)
// src/renderer/src/read-model.ts:43
const pcts = s.windows.map(windowPercent).filter((p): p is number => p != null)
```

---

## Validation

**No runtime validation library.** No `zod`, `yup`, `io-ts`, `valibot`, `superstruct`, `ajv`
in `package.json`. Five hand-written idioms replace it:

**A — tolerant recursive picker with a depth cap** (the most-used):

```ts
// src/main/adapters/protocols.ts:65-78 (abridged)
function findNumber(obj: unknown, keys: string[], maxDepth = 4, depth = 0): number | null {
  if (depth > maxDepth || obj === null || typeof obj !== 'object') return null
  const rec = obj as Record<string, unknown>
  for (const k of keys) {
    const n = typeof rec[k] === 'string' ? Number(rec[k]) : typeof rec[k] === 'number' ? rec[k] : NaN
    if (Number.isFinite(n)) return n
  }
  for (const v of Object.values(rec)) {
    const found = findNumber(v, keys, maxDepth, depth + 1)
    if (found !== null) return found
  }
  return null
}
```

The depth cap is **per-protocol on purpose** and must not be "cleaned up" — the comment at
`:60-64` says "同一个响应必须读出同一个数，别随手改".

**B — `Number()` + `Number.isFinite()`:**

```ts
// src/main/opencode-details.ts:103-108
function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v !== 'string') return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
```

**C — `try { JSON.parse } catch` with a declared fallback.** The shared reader keeps a
**truncated string** so the UI can say "response format unrecognized":

```ts
// src/main/adapters/engine.ts:103-109
let body: unknown = null
try { body = JSON.parse(text) } catch { body = text.slice(0, 200) }
```

Per-line variant for JSONL transcripts — skip the bad line, keep the good ones
(`adapters/codex.ts:104-112`, `adapters/claude.ts:122-130`).
Persisted-state variant — reset to empty on corruption (`main/overlay.ts:102-108`).

**D — field-by-field re-validation in every IPC handler.** The renderer is not trusted even
though it is typed:

```ts
// src/main/ipc.ts:80-81
ipcMain.handle('providers:update', async (_e, patch: ProviderPatch) => {
  if (!patch || typeof patch.id !== 'string' || !patch.id) return providersPayload()
```

```ts
// src/main/ipc.ts:135-136
ipcMain.handle('providers:reorder', async (_e, ids: string[]) => {
  if (Array.isArray(ids) && ids.every((x) => typeof x === 'string')) {
```

```ts
// src/main/ipc.ts:227-234 — rebuilds the object from untrusted input, field by field
const m: PetMenuModel = {
  title: String(model?.title ?? ''),
  ring: model?.ring !== false,
  hideBalance: model?.hideBalance === true
}
```

**E — version discriminator after parsing persisted state:**

```ts
// src/main/store.ts:47-56
const raw = JSON.parse(readFileSync(p, 'utf-8')) as SecretFile
if (raw?.version === 1) { cache = raw; return cache }
// 损坏则重建
cache = { version: 1, items: {}, extras: {} }
```

And the tolerant per-field decode with clamping at `shared/pet.ts:88-103`
(`name` truncated to 12 chars, `createdAt` falls back to `now`).

**What is NOT validated:** anything loaded via `loadTs` in tests goes through the same code
paths, but there is no schema check on the `opencode` / `deepseek` responses beyond the
tolerant pickers. That is a deliberate trade: a provider that changes its response shape
degrades to "unrecognized format" rather than crashing.

---

## Forbidden / Guarded Patterns

### `as` assertions — ~75 sites, and there *is* a convention

| Category | Count | Example |
|---|---|---|
| `(e as Error).message` in `catch` | 14 | mechanically identical; **no `instanceof Error` anywhere** |
| `as Record<string, unknown>` | 11 | the standard way to index an `unknown` object |
| `as THREE.*` | 9 | scene-graph objects |
| `as { field?: unknown }` | 9 | narrowing an untrusted payload one field at a time |
| `as unknown` after `JSON.parse` | 3 | then immediately handed to a guard |
| `as HTMLElement` | 3 | `;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)` |
| `as any` | **4** | quarantined, see below |
| misc (`as const`, `as never`, `as GestureId[]`) | ~25 | |

**The convention:** at every JSON/disk/IPC boundary the value is asserted **once**, to
`unknown` or to a local shape, and then narrowed by real checks. It is never left as `any`.

```ts
// src/main/providers.ts:219 — the full idiom
const arr = JSON.parse(raw) as unknown
… arr.filter(isInstance)

// src/shared/pet.ts:91
const v = JSON.parse(raw) as Partial<PetState>
// then per-field typeof checks at :98-99
```

### `as any` — 4 occurrences, all one global

```ts
// src/renderer/src/pet3d/scene.ts:938, 943
;(window as any).__bd_pet_scene__ = handle
// src/renderer/src/PetBall.tsx:368
const scene = (window as any).__bd_pet_scene__
```

This is the **only** `any` in `src/`. The same global is typed properly everywhere else:

```ts
// src/renderer/src/App.tsx:95-97 — the reader, fully typed
const petScene = (): { playGesture?: (id: string) => Promise<void> } | undefined =>
  (window as unknown as { __bd_pet_scene__?: { playGesture?: (id: string) => Promise<void> } })
    .__bd_pet_scene__
```

```ts
// src/renderer/src/PetBall.tsx:147-151 — the QA hooks, no `any` at all
const w = window as unknown as {
  __bd_ball?: () => unknown
  __bd_hide?: (i: number, on: boolean) => void
  __bd_gesture?: (id: string) => Promise<void>
}
```

**Rule: `as unknown as { … }` is the pattern. `as any` is not.** If you need a new `window`
global, declare its shape.

### Non-null `!` — 5 sites, and the pattern is a preceding guard

```ts
// src/renderer/src/DetailView.tsx:94-95 — the guard is derived from the asserted field
const hasLimit = w.limit != null && w.limit > 0
const remaining = hasLimit ? w.limit! - w.used : null
```

```ts
// src/shared/tray-text.ts:54-56 — filtered at :54, re-narrowed at :56
pctWindows.map((w) => `${shortWindowLabel(w.name)} ${formatPercent(windowPercent(w)!)}`)
```

The other three: `main.tsx:6` `document.getElementById('root')!`, `DetailView.tsx:106,248`,
`PetBall.tsx:399`. Five is a small enough number to keep it that way.

### Unused parameters — `_` prefix, by habit not by rule

`noUnusedParameters` is off, so this is convention: 22 sites use `_e` for the Electron event
object. In preload the callback param is *typed* `unknown`
(`preload/index.ts:17` `(_e: unknown, s: AppState): void => cb(s)`).

---

## Cross-Process Typing

**The renderer derives `Window.api` from the preload implementation. There is no mirror.**

```ts
// src/preload/index.ts:14, 105, 107
const api = { … }                       // 89 lines, the contract
contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
```

```ts
// src/renderer/src/api.d.ts:1-8 — the file explains the whole reason
// 渲染层的 window.api 类型**从 preload 实现推导**（typeof api），不再手工镜像。
//
// 为什么：此前这里与 src/shared/types.ts 的 BalanceDeckApi 各写一份，结果双向漂移 ——
// 接口声明了 openSettings / closeSettings / onSettingsChanged 而 preload 从未实现
// （App.tsx 用 ?. 调用，于是静默失效），preload 提供的 onCollapsed 又不在接口里，
// 只能在这里打补丁。现在少写一份就不可能漂移：preload 没实现的方法，
// 渲染层连类型都没有。
import type { Api } from '../../preload'
```

**What the derivation does *not* cover — three known gaps:**

1. **Main-process handler signatures are written independently** in `main/ipc.ts` and nothing
   links them to preload. `debugPush` has three different types:
   `preload/index.ts:50` `(snapshots: unknown)`, `ipc.ts:296` `(snapshots: unknown)` bridged by
   `as never`, `scheduler.ts:145` `(snapshots: ProviderSnapshot[])`.
2. **Renderer-ward payload shapes are `unknown` all the way through**
   (`preload/index.ts:50`, `qa/fixtures.ts:10` `export function demoSnapshot(): unknown[]`).
3. **Two debug return shapes are inline-typed**, e.g. `preload/index.ts:84-93` builds its
   return type by hand while `ipc.ts:303` produces it by spreading two independently-typed
   objects.

Channel names are **string literals with no constant table** — they exist in `preload`, in
`ipc.ts`, and (for main→renderer pushes) in `index.ts:51`. Naming is
`<domain>:<kebab-case-action>`; one camelCase exception (`skins:openMenu`).
**Search before changing one** — `grep -rn "'ui:collapse'" src/`.

---

## Known inconsistencies (state, don't silently "fix")

1. `DataQuality` vs `string` — `quality.ts:59,64` widen `dataQuality` to `string` while the
   same file imports the strict union and uses it strictly at `:35`.
2. `ProviderStatus` vs `string` — `format.ts:58` `levelOfPercent(pct, status: string)`; every
   call site passes the literal `'ok'`, so `ProviderStatus` is never used there.
3. `Unit` → display is implemented **twice** and **disagrees for `request`**:
   `shared/tray-text.ts:32-49` (rounds) vs `renderer/format.ts:21-41`.
4. `DataQuality` semantics: `PetBall.tsx:399` renders `'本机估算'` for `cached`, which reads
   as local. Trust the label in the snapshot, not this string.
5. `tsconfig.web.json` includes a non-existent file; `@shared/*` is declared but unused.

## Related

- [`quality-guidelines.md`](./quality-guidelines.md) · ADR-0002 provenance is required:
  [`../../../docs/adr/`](../../../docs/adr/)
