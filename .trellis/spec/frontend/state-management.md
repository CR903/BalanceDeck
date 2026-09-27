# State Management

> How state is managed. **There is no state library.**
> No redux / zustand / jotai / recoil / valtio / mobx — runtime deps are exactly
> `react`, `react-dom`, `three`. State is lifted into `App.tsx` and passed down by props.

---

## State Categories

| Category | Where it lives | Example |
|---|---|---|
| **Global / app state** | `App.tsx`, 13 `useState` calls, passed down as props | `state`, `view`, `openId`, `collapsed`, `skin`, `pet`, 6 boolean prefs |
| **Server state** | none — there is no cache layer. `AppState` arrives by IPC push and is stored as ordinary `useState` | `state: AppState` at `App.tsx:51` |
| **Local component state** | 39 `useState` calls in the other five components | `SettingsView.tsx` has 17 (all form/draft state) |
| **Persisted state** | main-process `extras` key/value store, mirrored into `useState` | `ui:petState`, `ui:pet`, `skin`, `refreshInterval` |
| **Non-reactive / imperative** | refs — both DOM handles and render-stable mirrors | see [`hook-guidelines.md`](./hook-guidelines.md) |
| **Cross-component imperative** | a `window` global for the 3D scene handle | `__bd_pet_scene__` |

The whole app is a single switchboard — a four-way ternary in `App.tsx:367-419`:

```tsx
// src/renderer/src/App.tsx:367-382 (abridged)
<ErrorBoundary>
<div className="app" data-skin={skin}>
  {skinCss && <style>{skinCss}</style>}
  {collapsed ? (
    <PetBall pet={pet} figure={petOn} ... />
  ) : view === 'card' ? (
    <CardView ... />
  ) : view === 'detail' ? (
    <DetailView ... />
  ) : (
    <SettingsView ... />
  )}
</div>
</ErrorBoundary>
```

Prop drilling is the accepted cost: `PetSection` receives **10 props**, forwarded through
`SettingsView`'s rest-spread (`:288` → `:653`). There is no context to avoid it.

---

## The one deliberate exception to lifting

`App` renders `PetBall` but does **not** pass `state` to it. `PetBall` opens its own
subscription:

```tsx
// src/renderer/src/App.tsx:359-370 — only pet, figure, hideBalance + 4 callbacks
<PetBall pet={pet} figure={petOn} hideBalance={hideBalance} ... />
```

```tsx
// src/renderer/src/PetBall.tsx:53, 80-83
const [state, setState] = useState<AppState>({ snapshots: [], lastSync: null, scanning: false })
...
void window.api.getState().then(setState)
return window.api.onState(setState)
```

So **two components hold independent `AppState` objects**, both fed by the same
`state:snapshot` broadcast. The reason is that `PetBall` renders in the collapsed window,
where `App`'s tree is torn down for the expanded views — passing state down would require
lifting the subscription above the view switch. **Do not copy this pattern;** it is the only
place it applies.

---

## When to Use Global State

Promote to `App.tsx` when **two or more** view subtrees need the value *and* it is not
derivable. Everything reachable from `App` is a prop; there is no other mechanism.

Things deliberately **not** global:
- `SettingsView` holds its own `skin` copy (`SettingsView.tsx:315-316`), loaded once from
  `getExtras` and written via `setSkin`. It does **not** subscribe to `onSkin`, so a skin
  change from the tray right-click menu does not update the settings radio. Known and
  unfixed.
- `SettingsView` also holds `autostart`, `refreshInterval`, `foreignLoginItem`.
- `PetBall`'s `viewSize` / `center` / `half` — measured from the live DOM, meaningless
  outside the collapsed window.

---

## Server State

There is none in the React sense. `AppState` is pushed:

```ts
// src/main/index.ts:51
getOverlay()?.webContents.send('state:snapshot', s)
```

and any screen that wants it opens a subscription. The trade-off is deliberate: this is a
single-user desktop tool with a 10–300 s refresh interval, not a multi-page app.

**Derived state is computed during render in most places** — no memo. Examples that are
intentional:

```tsx
// src/renderer/src/App.tsx:341
const current = state.snapshots.find((s) => s.id === openId)
```

```tsx
// src/renderer/src/CardView.tsx:470-476 — five counts in a row
const offline = ...
const errCount = ...
const cachedCount = ...
```

```tsx
// src/renderer/src/DetailView.tsx:177-181
const lvl = ...; const hero = ...; const heroPct = ...; const isPlan = ...; const hasModels = ...
```

Only 9 `useMemo` calls exist, all list derivations (`filter`/`map`/`sort`) or one format
dispatch — and **none of them carries a comment**. The list is in
[`hook-guidelines.md`](./hook-guidelines.md).

Three string-joins exist purely as effect dependency keys, which is a real pattern here:

```tsx
// src/renderer/src/CardView.tsx:223, 232, 298
const idsKey = configured.map((s) => s.id).join(',')
const winKeysKey = winKeys.join(',')
const orderKey = orderRef.current.join(',')
```

---

## Persistence — the `extras` key/value store

Two IPC methods, both strings only:

```ts
// src/preload/index.ts:46-47
getExtras: (keys: string[]): Promise<Record<string, string>> => ipcRenderer.invoke('extras:get', keys),
setExtras: (patch: Record<string, string>): Promise<void> => ipcRenderer.invoke('extras:set', patch),
```

Booleans are encoded by hand. **The write helper:**

```tsx
// src/renderer/src/App.tsx:87-89
const persistPet = (s: PetState): void => {
  void window.api.setExtras({ 'ui:petState': encodePetState(s) })
}
```

Full key inventory:

| Key | Encoded as | Note |
|---|---|---|
| `ui:petState` | `encodePetState` (`shared/pet.ts`) | versioned, migrates legacy ids |
| `ui:pet` / `ui:alwaysOnTop` / `ui:voiceOn` | `'1'` / `'0'` | `ui:petRing` 已随用量环开关下线（键不再读写） |
| `ui:voiceMuted` | `JSON.stringify(next)` | re-parsed with a type guard on load (`App.tsx:221`) |
| `ui:voiceEvery` | `String(minutes)` | re-validated against a whitelist (`App.tsx:227`) |
| `ui:hideBalance` | **`'1'` / `''`** | differs from the other six booleans — don't copy |
| `ui:cardWindow:<id>` | window name, e.g. `本周` | per-provider, read in `CardView` |
| `skin` / `refreshInterval` | plain id / `'10'…'300'` | |
| `interval:plan` | — | legacy read-only, migration at `SettingsView.tsx:331` |

**Writes have a side effect that depends on the prefix** — this is the part that surprises people:

```ts
// src/main/ipc.ts:191-193
if (touchedInterval) reconfigure()
// 纯界面偏好（ui:*，如隐藏余额）不触发采集，避免无畏的网络请求
else if (!Object.keys(patch ?? {}).every((k) => k.startsWith('ui:'))) refreshNow()
```

So `ui:*` writes are side-effect free; anything else triggers a full recollect. A new
non-`ui:` preference will therefore cause a network round-trip on every toggle.

**On read, re-validate.** Preferences that used to be booleans can contain anything after a
downgrade, so load sites clamp: `App.tsx:221` type-guards the muted list, `App.tsx:227`
re-validates the interval against a whitelist.

---

## Timers

11 timers in the renderer. Period, owner and cleanup are in
[`hook-guidelines.md`](./hook-guidelines.md).

One has a **self-rescheduling contract** and is the only timer worth reading in full:

```tsx
// src/renderer/src/App.tsx:279-307 (abridged)
// 立即触发一次
speakBalance()
// 自重排定时器：只有开关或间隔变化才会走到这里
const id = window.setInterval(() => speakBalance(), voiceEvery * 60 * 1000)
```

"Immediately on every run + re-arm only on `[voiceOn, voiceEvery]`" is only safe because
`speakBalance` reads the **ref mirror** rather than closing over live values
(`App.tsx:78-84`). **Do not add a fourth dependency to that array** — it will fire the
broadcast once per toggle.

---

## Common Mistakes

### Don't: read a credential from the wrong store namespace

The two `extras` namespaces are disjoint and mixing them fails silently:

- `getKey` / `setKey` → `items` (encrypted by `safeStorage`)
- `getExtra` / `setExtra` → `extras` (plaintext)

`opencodeCookie` is written with `setKey`, so reading it with `getExtra` returns `null`
forever. This produced a diagnostic tool that reported "not configured" while the app worked
fine. Same class of bug applies to anything under `persist:*` partitions.

### Don't: assume `AppState` in `PetBall` is the same object `App` has

It is not. It is a second subscription to the same broadcast. Mutating one has no effect on
the other.

### Don't: add a non-`ui:` extras key without knowing it triggers a recollect

See `ipc.ts:191-193`. A "harmless" preference write becomes a network request.

### Don't: promote a value to `App` before checking it isn't a main-process push

`collapsed` and `skin` are already pushed; storing them again invites the two to disagree.

### Don't: encode a new boolean without checking the existing spellings

Six keys use `'1'/'0'`, one uses `'1'/''`. There is no helper. Add one, or at minimum note
which spelling you matched.

## Related

- [`hook-guidelines.md`](./hook-guidelines.md) ·
  [`component-guidelines.md`](./component-guidelines.md)
- Vocabulary (`快照` / `可信度` / `采集引擎`): [`../../../CONTEXT.md`](../../../CONTEXT.md)
