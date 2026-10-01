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
│   ├── levels.ts        # one severity threshold implementation (85/60), shared by all four + tray
│   ├── quality.ts       # cache policy + staleness + network-error classification
│   ├── tray-text.ts     # every tray string lives here (both processes, unit-tested)
│   ├── pet.ts           # assistant identity model + encode/decode/migration
│   └── pet-view.ts      # the ONLY source of window dimensions for both forms
├── main/                # main process — see layering rules below
│   ├── index.ts         # 104 lines. Composition root + CLI flag dispatch. Nothing else.
│   ├── ipc.ts           # every ipcMain.handle / .on
│   ├── overlay.ts       # the floating window (expanded 384×600, or collapsed per pet-view)
│   ├── tray.ts · skins.ts · autostart.ts · human-assets.ts
│   ├── tray-badge.ts    # tray icon status dot: level → shape, plus the BGRA alpha painter
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

## `src/main/cli/` — the second entry shape (P1-6, 2026-10-01)

`src/main/cli/` holds the **`export` subcommand** (`BalanceDeck export --json`), for tmux /
iStat / prompt scripts. Three files, and the split is the whole point:

| File | Role |
|---|---|
| `export-snapshot.ts` | the **contract**: `AppState → ExportSnapshot`. No electron, no fs |
| `export-command.ts` | the **channel**: `argv → file → stdout`. No electron, no keystore |
| `export-writer.ts` | the **resident side**: deduped periodic write. No electron |

This is the `store.ts` + `keystore.ts` + `usageStore.ts` + `usage-history.ts` seam again, and
`test-structure.mjs`'s C2 guard does not even see the directory: it filters `src/main`'s
top-level `*.ts` only, so `cli/` is exempt without a new assertion.

### The two facts that decide the whole design

**1. There is no single-instance lock, so two Electron processes share nothing.**
`grep -rn 'requestSingleInstanceLock' src/` → zero hits. `scheduler.currentState()` is
module-level memory (`scheduler.ts:33-38`), so a second process cannot see it. There is no
socket, no pipe, no `MessagePort`. **A CLI process can only read what the resident process
persisted** — hence the export *file*, written by the resident side.

**2. A second process that collects will destroy the first one's history.**
`usageStore.ts:99` keeps one in-memory cache per process and `:121` rewrites the whole file.
A CLI run of `collect()` would overwrite the resident app's accumulated samples, putting
random gaps into the P1-1 trend chart — and `usagePredict`'s rate regression reads a gap as
「用量停了」. It would also rewrite `secrets.bin` through the `setKey` that
`scheduler.ts:74` injects for cookie self-healing. **CLI commands here must be pure readers.**

### argv: `process.argv`, sliced by `isPackaged`

```ts
const cliArgv = process.argv.slice(app.isPackaged ? 1 : 2)
```

Measured on Electron 37.10.3: dev argv is `[electronBin, '.', 'export', '--json']` while
packaged argv is `[exe, 'export', '--json']` — the offsets differ, so a positional subcommand
**must** be sliced. The five existing QA flags get away with `process.argv.includes(...)`
because `includes` does not depend on the offset.

⚠ **`app.argv` is `undefined` in this Electron build** (measured; the probe printed
`app.argv=undefined typeof=undefined`). The Electron docs describe it and it type-checks, so
`app.argv.slice(…)` compiles and then dies with a `TypeError` at launch. Use `process.argv`.

**Also measured:** `app.getPath('userData')` **does** work before `app.whenReady()`. The
comments in `keystore.ts` / `usage-history.ts` say the real constraint is *import order*
(static imports evaluate before the module body, which is why `BD_USER_DATA`'s `setPath` would
lose), **not** ready timing. Dispatch still sits inside `whenReady` — as the **first**
statement, before `primePrefs()` and any window/tray/scheduler work — because moving it earlier
does not pay for wrapping the whole composition root in an `if/else`.

### Never serialize a whole `ProviderSnapshot` out

`source` is free text assembled per adapter, and `opencode.ts`'s `keyTag` splices the **last 4
characters of the API key** into it (`账号1(…9dFe)`), which reaches `ProviderSnapshot.source`.
`detail` / `failureReason` can carry a response-body preview (`engine.ts` slices 200 chars) or a
GitHub username (`copilot.ts`). stdout lands in tmux config, shell history, logs and
screenshots — a far larger blast radius than the screen. So the export contract omits
`source` / `detail` / `failureReason` / `degradedReason` / `models` / `modelsByWindow` /
`mark` / `plan` **at the contract level**, not "not yet". Adding one back requires a fresh
privacy review. `scripts/test-cli-export.mjs` §C pins this with a fixture carrying all of them;
the negative assertions were measured to go red when `source` is re-added.

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

### Constraints that are **not** repository law

Three comments used to read "文件所有权不许新增 shared 文件" (`ipc.ts` above,
`renderer/systemNotify.ts:30`, `speechOut.ts:409`). Those record **one task's** file
ownership at the time (P0-1 was not allowed to touch `src/shared/`, so `NOTIFY_LEVELS` is
written on both sides and pinned by a static comparison in `test-system-notify.mjs`). They
are not a standing rule, and quoting them as one is how a known defect survives.

Concretely, `10-01-p1-tray-color` was blocked by exactly that reading: the tray needed the
85/60 severity threshold, the threshold lived in `renderer/src/format.ts` (unreachable from
the main process), and the alternatives were a second copy in the tray or a contradiction —
**at 62% the card renders orange while the tray renders green, on the same screen**, with no
layer of code able to see both. The fix was to move `levelOfPercent` into
`src/shared/levels.ts` and leave `format.ts` as a re-export, so the renderer call sites
(`CardView.tsx`, `DetailView.tsx`, `read-model.ts`, `components.tsx`) changed not one line.

**The test for adding a shared module is "will two copies disagree?", not "who created the
directory first."** `scripts/test-structure.mjs` §G now pins the single source: the `85` / `60`
literals may appear in exactly one file, and renderer consumers must keep importing through
`format.ts` rather than bypassing the re-export.

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
6. ~~`resources/human-pets/reyna-pilot/` exists locally with no producer or consumer.~~
   **Resolved 2026-10-01** (task `10-01-p1-5-resource`): deleted, and `electron-builder.yml`
   now filters it. It was 31 MB of `model.glb` — an artefact of an abandoned GLB prototype,
   referenced nowhere and unreachable from `PETS`. `scripts/test-resource.mjs` E6/E7 pin that
   the fetch list still contains only `aria`/`ray` (adding `reyna` there would make
   `fetch:humans` download 31 MB nobody uses, and — because it is *not* in `PETS` — nothing
   would ever recreate the directory once deleted).
7. `minimax`'s `findAmount` is byte-identical to `qwen`'s; `plan-utils.activeBlockRange` is
   duplicated in `opencode.ts:270-285`.

---

## Never-shipped assets: two barriers, and the proof that makes them safe

`resources/human-pets/` shipped **159 MB that no code path ever reads** — 128 MB of source
`.tga` and 31 MB of `reyna-pilot/model.glb` — for as long as it was in the repo. `du` on the
source tree found it; nothing else would have.

**Two barriers, because each covers a leak the other cannot** (2026-10-01):

| | Where | Blocks |
|---|---|---|
| 1 | `scripts/fetch-human-pets.mjs` → `sweepConvertedTga()` | new downloads: converts, then deletes the source `.tga`. Also runs **before** the `human-pets cached` short-circuit, so an already-populated machine cleans up on its next `fetch:humans` instead of printing `cached` and exiting. |
| 2 | `electron-builder.yml` `extraResources.filter` | packaging: excludes `!**/*.tga` and `!reyna-pilot/**` from whatever is on disk, including pre-existing residue barrier 1 never saw. |

Doing only (1) leaves historic residue in the package. Doing only (2) leaves 159 MB on every
developer's disk, and the next `fetch:humans` puts it back. **The `filter` starts with `'**/*'`
because electron-builder's filter is *overriding*, not additive** — two exclusion patterns and
no inclusion pattern means nothing gets copied at all.

**Sweep semantics.** Delete a `.tga` **only when the same-named `.png` already exists**. A
`.tga` whose conversion has not landed yet is not dead weight, it is the only copy; the next
run re-downloads it. A failed `unlink` logs and continues — the assets are already converted
and the build hook must not fail because a directory was read-only. Result:
`resources/human-pets` **221 MB → 62 MB**, with all 24 `.fbx` and 12 `.png` intact.

**The proof that makes deleting them safe** — this is the part to insist on. Before removing an
asset, show the runtime never asks for it, by three independent signals:

1. `pet3d/human.ts:27-33` rewrites `*.tga` → `textures/<base>.png` at URL-construction time,
   so the `.tga` name never reaches the network layer;
2. `human-assets.ts`'s `MIME` table has no `.tga` entry — the `bd-asset://` handler was never
   designed to serve it;
3. a CDP probe shows the texture requests are **all** `.png`.

Point 3 is the only one that observes the real system; 1 and 2 are inferences about the code.
`scripts/test-resource.mjs` §F re-asserts 1 and 2 on every `npm test`, so the *premise* of the
deletion is re-verified continuously — if someone later changes the loader to genuinely read
`.tga`, the suite goes red instead of the packaged app quietly breaking.

---

## Examples — well-organized modules to imitate

- **`src/main/store.ts` + `src/main/keystore.ts`** (103 + 26 lines) — a pure module with its
  platform dependencies injected, plus a 26-line production assembly. This is the cleanest
  seam in the repo.
- **`src/shared/percent.ts`** (32 lines) — one implementation, four consumers, no branching on
  caller. Its header states why: the tray, card, detail and ball must not disagree.
- **`src/shared/levels.ts`** (61 lines) — the same pattern one layer up, and the clearest
  statement of the rule above: the severity threshold moved here so the tray could use it, and
  the renderer kept its imports by re-exporting rather than by being edited. Note which ANSI
  codes it uses are the ones `NSString+ANSI.mm` **implements**, not the ones the ANSI standard
  offers — `90` is absent from that switch, so gray is `1;30`; a "reasonable-looking" code
  renders as *no color at all*, silently.
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
