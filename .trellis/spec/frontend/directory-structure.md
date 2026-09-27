# Directory Structure

> How code is organized in BalanceDeck. Electron 37 + electron-vite + React 18 + TypeScript,
> plain CSS, no lint config, hand-rolled test scripts.
>
> This spec documents **what the tree actually looks like today**, not a target layout.

---

## Directory Layout

```
src/
├── shared/              # compiled into BOTH tsconfig projects — the only cross-process code
│   ├── types.ts         # cross-process contract (ProviderSnapshot, ProviderWindow, DataQuality…)
│   ├── percent.ts       # one percentage implementation, shared by tray/card/detail/ball
│   ├── quality.ts       # cache policy + staleness + network-error classification
│   ├── tray-text.ts     # every tray string lives here (main-only consumer, unit-tested)
│   ├── pet.ts           # assistant identity model + encode/decode/migration
│   └── pet-view.ts      # the ONLY source of window dimensions for both forms
├── main/                # main process — see layering rules below
│   ├── index.ts         # 104 lines. Composition root + CLI flag dispatch. Nothing else.
│   ├── ipc.ts           # every ipcMain.handle / .on
│   ├── overlay.ts       # the floating window (expanded 384×600, or collapsed per pet-view)
│   ├── tray.ts · skins.ts · autostart.ts · human-assets.ts
│   ├── store.ts         # pure credential store (no electron) — filePath + crypto injected
│   ├── keystore.ts      # production assembly of store.ts using safeStorage
│   ├── net.ts           # reachability accounting (2-strike offline threshold)
│   ├── request.ts       # the ONLY production impl of CollectContext.request
│   ├── providers.ts · scheduler.ts · scanner.ts
│   ├── opencode-auth.ts · opencode-details.ts
│   ├── adapters/        # 17 files — the provider layer
│   └── qa/              # exactly 5 files; nothing outside index.ts may import this
├── preload/index.ts     # one `api` object, 107 lines
└── renderer/src/
    ├── main.tsx         # 10 lines: StrictMode + the single skins.css import
    ├── App.tsx          # all global state + the view switchboard
    ├── CardView.tsx · DetailView.tsx · SettingsView.tsx · PetBall.tsx · PetSection.tsx
    ├── ProviderMark.tsx · components.tsx     # presentational primitives
    ├── read-model.ts · format.ts · voice.ts  # pure logic, no React
    ├── api.d.ts         # derives Window.api from preload
    └── pet3d/           # three.js, zero React: scene/human/gesture/clips/rig/tokens/projection
```

Non-`src` directories:

| Dir | Git | Role |
|---|---|---|
| `scripts/` | tracked | 34 files: 10 unit tests, 3 generators, 3 QA/diagnostic, 15 debug probes, 2 in `lib/` |
| `docs/adr/` | tracked | 3 architecture decision records |
| `build/` | tracked | electron-builder resources + generated icons (`badge.png`, `icon.png`, `tray.ico`, …) |
| `resources/` | **ignored** | third-party avatar assets, fetched by `npm run fetch:humans`; shipped via `extraResources` |
| `refs/` | **ignored** | local-only third-party reference images; no script reads it |
| `out/` `dist/` | **ignored** | build output / packaged installers |
| `.trellis/spec/` | tracked | these specs; see `adapters/` for the main-process external-API contract |

---

## The `adapters/` layering — the rule that matters most

**`src/main/adapters/` must not statically import `electron` or `net.ts`.** Outbound network
access is an injected capability (`CollectContext.request`), which is what lets adapters run
in plain Node under test.

Verified: no file under `adapters/` has a static `electron` import. `net.ts` is imported by
exactly two files — `request.ts:1` and `scheduler.ts:5` — and neither is in `adapters/`.
Both files state the rule themselves:

```ts
// src/main/adapters/types.ts:6-7
// 这个模块刻意不 import electron，也不 import net.ts —— 出网是注入的能力

// src/main/adapters/engine.ts:7-8
// 这个模块**不 import electron**，也不 import net.ts —— 出网能力由 CollectContext 注入
```

**But adapters are *not* fs-free, on purpose.** Five code adapters read local files directly,
which is exactly why they stay code-implemented rather than declared:

```ts
// src/main/adapters/opencode.ts:1-3
import { join } from 'path'
import { existsSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
```

Two adapters reach electron **dynamically**, inside a `try`, and degrade gracefully:

```ts
// src/main/adapters/opencode.ts:243
const { readPartitionCookie } = await import('../opencode-auth')  // opencode-auth.ts:1 imports electron
```

**Protocol vs adapter** — the vocabulary is defined in `CONTEXT.md:13-27` and matches the code:

| | `adapters/protocols.ts` | `adapters/index.ts` `CODE_ADAPTERS` |
|---|---|---|
| What | pure data + pure `read(body)` functions | full `ProviderAdapter` implementations |
| Count | 8 declared (`PROTOCOLS`), 9 selectable (`SELECTABLE_PROTOCOLS`) | 7 code adapters |
| Factory | `createProtocolAdapter(decl, inst)` | `bindInstance(base, inst)` |
| Needed when | plain endpoint + response shape | request signing, browser sessions, local files, legacy endpoints |

`adapters/index.ts:41-59` routes: declared → code → `generic` fallback. Reasons a protocol
cannot be declared are enumerated at `adapters/index.ts:16-22` (signing: qwen-bss/volc-billing;
sessions/files: opencode-go/claude-code/codex/copilot; legacy: minimax).

`CollectContext` (`adapters/types.ts:24-36`) carries exactly five members — `now`, `getKey`,
`getExtra`, `setKey?`, `request`. The `request` member is the whole seam:

```ts
// src/main/adapters/types.ts:32-34
// 生产实现见 src/main/request.ts …，测试注入桩，因此适配器可以在纯 node 里跑完整链路
```

---

## `src/main/qa/` — a closed set

Exactly five files, and `scripts/test-structure.mjs` asserts the directory listing
**verbatim**, so a sixth file turns the suite red:

```js
// scripts/test-structure.mjs:46
ok(qaFiles.join(',') === 'ballshot.ts,fixtures.ts,modes.ts,shots.ts,uitest.ts', …)
```

| File | Role |
|---|---|
| `modes.ts` | one entry point per mode + `setupTestApp` + `resolveDiagnosticCred` |
| `uitest.ts` | UI interaction automation → `Record<string,string>` of assertion results |
| `shots.ts` | design-review screenshots into `/tmp/balancedeck-shots/` |
| `ballshot.ts` | collapsed-state only, driven by ~10 `BD_*` env vars |
| `fixtures.ts` | `demoSnapshot()` — pure, no electron, callable from unit tests |

Enforced boundaries (all in `test-structure.mjs`):

```js
:35  index.ts ≤ 500 lines                        // it is 104
:36  no executeJavaScript in index.ts            // UI driving belongs to qa/
:37  no runUiTest / runShots definitions in index.ts
:64  renderer/ and shared/ never import qa/
:71  main/ modules other than index never import qa/
```

---

## Module Organization

**One screen per file; the renderer is a flat list, not a feature tree.** There is no
`features/` or `screens/` directory. Sub-components live inside their consuming file and are
*not* exported:

```tsx
// src/renderer/src/CardView.tsx
:25  function QualityChip(     :37  function PlanCard(    :127 function BalanceCard(    :176 function Skeleton(
```

**three.js lives in `renderer/src/pet3d/` and touches no React.** `scene.ts` (948 lines)
exposes an imperative handle; `gesture.ts` (381) is a pure state machine with no three/DOM/React
so Node tests can drive it directly; `rig.ts` is the single source of camera/form constants.

**`src/shared/` is in both tsconfig projects** (`tsconfig.node.json:15` and
`tsconfig.web.json:15`) — that is *how* one file type-checks in both processes. Every import
across it is relative; the declared `@shared/*` path alias is **unused**.

---

## Naming Conventions

| Thing | Convention | Example |
|---|---|---|
| Files | kebab-case, one topic each | `opencode-cookie.ts`, `pet-view.ts`, `read-model.ts` |
| Components | PascalCase `.tsx` | `CardView.tsx`, `ProviderMark.tsx` |
| IPC channels | `<domain>:<kebab-case-action>`, inline literals (no constant table) | `state:snapshot`, `providers:update`, `pet:hitbox` |
| QA env vars | `BD_*` (harness) / `BALANCEDECK_*` (product) | `BD_PET_ID`, `BALANCEDECK_FORCE_OFFLINE` |
| CSS classes | ad-hoc widget prefix + element, e.g. `pcard-` `prow-` `dwin-` `wmodels-` `petball-` | `.pcard-amount`, `.dwin-foot` |
| Branch prefix | no scope prefix; commits use conventional commits in Chinese | `fix(uitest): 刷新频率按类名定位…` |

There is **no** channel-name constant module, so channel strings live twice by necessity
(`preload/index.ts` and `main/ipc.ts`) plus once more for main→renderer pushes
(`main/index.ts:51`). Search before changing one.

---

## Known inconsistencies (state, don't "fix" silently)

1. **Adapters layer is electron-free statically, not dynamically** — `opencode.ts:243` reaches
   electron through a guarded dynamic import.
2. **Three stale comments** (`adapters/collect.ts:8`, `adapters/bind-instance.ts:15`,
   `adapters/index.ts:62`) still say `index` imports `../providers`; it no longer does.
3. **`tsconfig.web.json:15` includes `src/preload/index.d.ts`, which does not exist.**
4. `qa/shots.ts:10` imports `app` from electron and never uses it.
5. `qa/ballshot.ts` keeps 4-space indentation on purpose (`:6-7` explains why).
6. `resources/human-pets/reyna-pilot/` exists locally with no producer or consumer.
7. `minimax`'s `findAmount` is byte-identical to `qwen`'s; `plan-utils.activeBlockRange` is
   duplicated in `opencode.ts:270-285`.

---

## Examples — well-organized modules to imitate

- **`src/main/store.ts` + `src/main/keystore.ts`** (103 + 26 lines) — a pure module with its
  platform dependencies injected, plus a 26-line production assembly. This is the cleanest
  seam in the repo.
- **`src/shared/percent.ts`** (32 lines) — one implementation, four consumers, no branching on
  caller. Its header states why: the tray, card, detail and ball must not disagree.
- **`src/renderer/src/read-model.ts`** (99 lines) — "one place that answers *which window
  matters and how severe*". Created because the same concept had four implementations.
- **`src/main/adapters/opencode-console-api.ts`** (159 lines) — a constants module with
  **zero imports**, so both the cookie path and the details path can depend on it without a
  cycle.

## Related

- Vocabulary & architecture: [`../../../CONTEXT.md`](../../../CONTEXT.md)
- ADR-0001 protocol owns the query · ADR-0002 provenance is required · ADR-0003 one-shot cutover:
  [`../../../docs/adr/`](../../../docs/adr/)
- External-API contract: [`../adapters/opencode-console.md`](../adapters/opencode-console.md)
