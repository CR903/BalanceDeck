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
| `ui:pet` / `ui:alwaysOnTop` | `'1'` / `'0'` | `ui:petRing` 已随用量环开关下线、`ui:voiceOn` 已随播报迁移下线（两者都**只读不写**） |
| `ui:voiceMuted` | `JSON.stringify(next)` | re-parsed with a type guard on load (`App.tsx:423`) |
| `ui:voiceGender` | — | **已下线**（2026-09-29，`09-29-voice-settings-refactor`）。系统语音性别改由 `petGender(pet.id)` 每轮现算，不再读也不再写；旧值留在 extras 里不动。它是「谁替我说话」的第二个开关，与选助理问的是同一件事 |
| `ui:hideBalance` | **`'1'` / `''`** | differs from every other boolean — don't copy |
| `ui:ttsOn` | `'1'` / `'0'` | replaces the retired `ui:voiceOn` (read on load for migration) |
| `ui:ttsPreset` | preset id, `'mytts'` / `''` | `''` = 自定义服务 |
| `ui:ttsConfig` | `JSON.stringify` | TTS service (url/voice/**style**/speed). **Never holds a token**. `style` 是 2026-09-29 新增的字段，旧配置里根本没有这个键（那时 `requestAudioBlob` 写死了 `'general'`），读不到是常态 —— 加载处补默认值，不要当异常 |
| `ui:ttsTriggers` / `ui:ttsTriggerOn` | `JSON.stringify` | 5 thresholds / their on-off flags, split for validation |
| `ui:ttsHistory` | `JSON.stringify` | sampled snapshots, cap `ui:ttsHistoryCap` (default 100) |
| `ui:ttsTextFormat` | `'simple'` / `'detailed'` | |
| `ui:ttsVisual` / `ui:ttsFallback` / `ui:ttsRoutine` | `'1'` / `'0'` | |
| `ui:ttsRoutineEvery` / `ui:ttsHistoryCap` | `'60'` / `'100'` | |
| `ui:cardWindow:<id>` | window name, e.g. `本周` | per-provider, read in `CardView` |
| `ui:notifyOn` / `ui:notifyConfig` | `'1'`/`'0'` / `JSON.stringify` | 系统通知（P0-1）。**与 TTS 开关完全独立** —— 放在一起会让「关掉语音」顺手关掉通知 |
| `ui:predictOn` / `ui:predictConfig` | `'1'`/`'0'` / `JSON.stringify` | 用量预测（P0-2）。`ui:predictConfig` **只存 `windowDays`**；`retentionDays` 归主进程的 `sample:usageHistoryDays` 所有（见下） |
| `skin` / `refreshInterval` | plain id / `'10'…'300'` | |
| `interval:plan` | — | legacy read-only, migration at `SettingsView.tsx:331` |
| `sample:usageHistoryDays` | `String(n)` | **故意非 `ui:` 前缀** —— 保留期是采集侧配置，需要能触发重排。走主进程专用通道 `usage:setRetention`（不经过 `setExtras`） |

> `ui:voiceEvery` (旧「播报间隔」) 已随播报迁移**彻底下线**：不再读也不再写。设置页里那个
> 下拉与 `ui:ttsRoutineEvery` 不是同一个东西 —— 别把旧键加回来「保持兼容」，它没有任何
> 执行方，留着只会让用户以为设置生效了（`PetSection.tsx` 的注释记了同一次教训）。

**Every key the broadcast feature writes must carry the `ui:` prefix** — the side effect below
turns a non-`ui:` write into a full recollect. `test-structure.mjs` E8 parses the `setExtras`
calls in `App.tsx` and fails on any key without the prefix, so a new `ui:tts*` key can't drift.

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

**⚠ `extras:get` returns `''` for a key that was never written** (`ipc.ts:198`:
`out[k] = (await getExtra(k)) ?? ''`) — **not** `undefined`. So on the read side:

- "never set" is `!v`, **not** `v == null` and **not** `typeof v === 'string'`. Both of those
  were written in `App.tsx` and both silently never fired: the `ui:ttsPreset` default left
  every fresh install in the custom-service branch (no URL → no broadcasts at all), and the
  `ui:voiceOn` → `ui:ttsOn` migration was dead code, so users who had broadcasting enabled
  lost it on upgrade.
- Do not let a *stored* value double as the "unset" sentinel. The custom-service option uses
  `value="custom"`, not `value=""` — with `''` a user who picks a custom endpoint is
  indistinguishable from one who never chose, and gets flipped back on restart.
- A controlled `<select>` falls back to the **first option** when no option matches its value,
  so asserting `select.value` cannot detect this class of bug. Assert the branch that rendered.

`test-alert-orchestration.mjs` L38 pins the first rule's blast radius (no pending keys in
extras) and `--uitest`'s `vrs*` block pins the rest.

---

## Timers

Timers in the renderer. Period, owner and cleanup are in
[`hook-guidelines.md`](./hook-guidelines.md).

**Three of them have a self-rescheduling contract** (re-arm inside the callback rather than
`setInterval`), and all three are the broadcast timers. They are the ones worth reading in full,
because the contract below only holds for a re-arming chain.

```tsx
// src/renderer/src/App.tsx:608-617 — 待确认轮询（重复提醒 + 倒计时共用这一条）
const armAlertTimer = (): void => {
  alertTimerRef.current = window.setTimeout(() => {
    evaluateAlerts()
    if (alertPendingRef.current.length > 0) setAlertNow(Date.now())
    armAlertTimer()          // ← 自重排
  }, ALERT_TICK_MS)          // 30s 轮询，不是精确的 5 分钟边界
}
armAlertTimer()
```

```tsx
// src/renderer/src/App.tsx:639-645 — 定时兜底播报
const scheduleNext = (): void => {
  voiceTimerRef.current = window.setTimeout(() => { speakRoutine(); scheduleNext() },
    ttsRoutineEvery * 60 * 1000)
}
```

The alert tick **polls** every 30 s rather than aiming at an exact 5-minute boundary: a repeat
that fires 20 s early is harmless, whereas an exact schedule would have to compensate for
sleep/wake. Polling is idempotent — it goes through the same `evaluateAlerts` as the data-push
effect, so both paths hit the same latch + pending gate and cannot double-broadcast. There is
deliberately **no `speakBalance()`-style "fire immediately on every run"** any more: the trigger
source is the collected data, not the clock.

**The dependency-array contract, restated for the current code.** These chains are safe *only*
because their callbacks read the `alertCtxRef` mirror rather than closing over live values.
The chains that arm them have a deliberately tiny dependency list:

| Effect | Dependencies | Why nothing more |
|---|---|---|
| data-push evaluate | `[ttsOn, state.snapshots]` | the trigger **is** the data |
| pending poll | `[ttsOn]` | adding anything rebuilds the chain on every push, pushing the next repeat's baseline later |
| routine timer | `[ttsOn, ttsRoutine, ttsRoutineEvery]` | these three genuinely change *when* the next fire is due |

**Do not add a dependency to the pending-poll chain** (nor a third `useState` dependency to the
data-push one beyond the data) without moving the new value into `alertCtxRef` first. The
regression is not subtle — every toggle fires a broadcast — but it is *quiet*, and the old
`speakBalance` design ("fire immediately on every run") made it look intentional.

**A fourth timer exists, and it is NOT self-rescheduling**: the reachability backoff probe
(`App.tsx` `stepProbe` / `runProbe`, pure state machine in `speechOut.probeStep`). It only exists
while the TTS service is failing — `5s → 15s → 1min → 5min`, then it stops — and it re-arms from
`stepProbe`, not from a `setInterval`. Two things make it easy to get wrong:

- **`delayMs === null` does not mean "stop probing".** It also means *the chain is still running*
  or *this round is exhausted*. Only `next.unreachable === false` (recovered) may clear a pending
  timer; clearing on `null` pushes the next probe out forever and the feature silently dies.
- **Its "am I still mounted?" flag must be reset in the effect body, not only in cleanup.**
  The renderer mounts under `<React.StrictMode>` (`main.tsx`), and React 18 runs every effect as
  mount → cleanup → mount in development. A ref written to `false` in cleanup and never restored
  stays `false` for the rest of the session, so `runProbe` discards every result — the probe
  silently stops working in `npm run dev` while production looks fine.

It deliberately **does not share a ref or a chain with the broadcast timers**: folding it into the
pending-poll chain would rebuild it on every data push. The `ttsOn === false` effect clears it
along with the latch and pending queue — the user turned broadcasting off, so nothing should still
be calling the service behind their back.

> Historic note: this section used to describe a `setInterval` + `speakBalance` + `voiceOn` /
> `voiceEvery` shape. That code is gone (the broadcast moved to `ui:tts*` + the trigger engine);
> the spec was updated when 09-29-tts-smart-broadcast landed, per its own design.md D7.

---

## Common Mistakes

### Don't: read a credential from the wrong store namespace

The two `extras` namespaces are disjoint and mixing them fails silently:

- `getKey` / `setKey` → `items` (encrypted by `safeStorage`)
- `getExtra` / `setExtra` → `extras` (plaintext)

`opencodeCookie` is written with `setKey`, so reading it with `getExtra` returns `null`
forever. This produced a diagnostic tool that reported "not configured" while the app worked
fine. Same class of bug applies to anything under `persist:*` partitions.

### Don't: put a secret in `extras` — it is plaintext

`extras` is stored as plain text; only `items` goes through `crypto.encrypt` (`store.ts:68-90`).
`preload` exposes only `getExtras`/`setExtras`, so a new secret needs its own IPC pair that
lands in `items` — see `tts:setSecret` / `tts:getSecret` in `ipc.ts`, keyed `tts:secret:<id>`.

Validate `id` before it reaches a storage key (`^[A-Za-z0-9_-]{1,64}$`): a colon in `id` would
collide with the namespace prefix. The renderer does need the plaintext at request time (to
build an `Authorization` header), so the guarantee being made is **never plaintext at rest** —
hold it in a ref, not `useState`, so it does not ride along in React state.

### Don't: assume `AppState` in `PetBall` is the same object `App` has

It is not. It is a second subscription to the same broadcast. Mutating one has no effect on
the other.

### Don't: add a non-`ui:` extras key without knowing it triggers a recollect

See `ipc.ts:222-231`. A "harmless" preference write becomes a network request.

**Two independent reasons a key can be unfit for `extras`; check both.**

| Rule | Symptom if broken | Enforced by |
|---|---|---|
| A non-`ui:` key triggers a full recollect | Setting a sampling parameter silently does nothing (the recollect re-reads the old value) | key inventory above; `ipc.ts:382-383` (the P0-2 comment stating the rule) |
| **`setExtra` rewrites the whole file every call** | At write frequency, the write volume becomes absurd — see below | `test-usage-store.mjs` H1/H2 |

**`setExtra` is O(entire file), not O(what changed).** `store.ts:60-64`:
`setExtra` mutates the in-memory map and then `persist()` → `writeFileSync(filePath(), JSON.stringify(cache))`
— the **entire** `secrets.bin`, credentials included, on **every single key write**.

So the ceiling is set by *write frequency × file size*, not by how much of the key you touch.
Measured 2026-09-30 while building the usage-prediction snapshot store:

| Data | Size | At its natural write rate |
|---|---|---|
| 30-day per-window usage snapshot @ 60s | ≈ 8–12 MB | **≈ 200 GB written per day** |
| Same @ 15-min sampling | ≈ 600 KB | ≈ 1.4 GB per day |

Both are unacceptable, so the snapshot went to its own file (`userData/usage-history.json`,
`src/main/usageStore.ts`) with its own `createStore`-shaped factory. **Size the data against
the write rate before reaching for `extras`** — a few KB of preferences is fine, a time series
is not, and the difference is invisible until it is on disk.

### Don't: gate a shared evaluator behind only one of its channels' switches

`evaluateAlerts()` drives two output channels: TTS (`ui:ttsOn`) and system notification
(`ui:notifyOn`). They are **independent by design** — a user who silences the voice usually
wants the notification, and the notification's settings live *outside* `{ttsOn && …}` in
`VoiceReminderSection.tsx` for exactly that reason.

The effect that drives it read `if (!ttsOn) return`. `ui:ttsOn` ships **disabled by default**
while `ui:notifyOn` ships **enabled**, so on a fresh install the notification channel was
unreachable — the toggle in settings looked live, and `npm test` plus `tsc` were both green.

```tsx
// ✗ one channel's switch gates both
useEffect(() => { if (!ttsOn) return; evaluateAlerts() }, [ttsOn, state.snapshots])

// ✓ any channel being on wakes the evaluator
useEffect(() => { if (!ttsOn && !notifyOn) return; evaluateAlerts() }, [ttsOn, notifyOn, state.snapshots])
```

Then the per-channel decision moves **inside** `evaluateAlerts`, with each channel's own
early return *before* its side effects — not one shared early return after them:

```tsx
notifyLatchRef.current = ctx.notifyLatched = d.nextNotifyLatched
if (d.notify) void window.api.notifyShow(d.notify)
if (!ctx.ttsOn) return false          // ← after notify, before any TTS state mutation
```

**The rule:** when a function drives N independent outputs, the early return is
`!a && !b && …` (any output wanted), and each output's own guard sits at the head of
*its* block. Guarding with one channel's flag is the single most likely way to ship a
channel that is dead on default settings. Pinned by `test-alert-orchestration.mjs`
M10/M11 (switch off ⇒ no latch) and M20/M22 (latch written back into the mirror).

### Don't: latch "what was consumed this round" when the candidates outnumber the consumers

`checkNotify` may return several candidates (one per provider). Only **one** notification can
be shown per round, and the latch must survive the ones that did not get shown:

```ts
// ✗ latches only the winner → providers 2..N are permanently swallowed
const nextNotifyLatched = new Set(notifyLatchKeys([notify]))
// ✗ keeps the previous set → a condition that clears never re-arms (violates "fall → re-trigger")
const nextNotifyLatched = new Set(ctx.notifyLatched)

// ✓ what is *still true* this round, i.e. every surviving candidate
const nextNotifyLatched = new Set(notifyLatchKeys(candidates))
```

Compare the TTS side: `nextLatched = new Set(latchKeys(speakable))` — it latches the **filtered
hits**, never the one that was spoken. Same rule, same reason: the latch records *"still
holding"*, so a cleared condition releases it and the next crossing re-fires.


**Problem.** A quota guard (1/min, 10/hour) placed on a public broadcast entry point also
throttles things that have nothing to do with quota. The 「测试播报」 button inherited it: the
second click was silently dropped — no sound, no log, no message. Worse, it then *latched*:
`onTtsOk` only fires after a successful TTS playback, so once the gate was in the way the
unreachable flag could never clear itself.

**Why it's bad:** the user sees 「提示服务不可达 + 点了没反应」 and concludes the feature is
broken. Neither symptom is the service's fault, and the two are causally linked — fixing
either alone changes nothing.

**Instead:** mark the item, not the path.

```ts
export type SpeechItem = { text: string; urgent: boolean; bill: boolean }
// playOne: if (item.bill && !allowCall(Date.now())) return
```

| Producer | `bill` | Why |
|---|---|---|
| scheduled / alert broadcasts | `true` | unattended; the quota guard exists for these |
| user-initiated test | `false` | a deliberate click is not something to rate-limit |

**Corollary — any self-healing retry needs a restart cooldown.** The alert poll re-fires every
30 s behind the 1/min gate, so 「new failure → start a new probe chain」 means ~1/min. With a
4-step backoff that is ~4 probes/min, unbounded over a long outage. `probeStep` therefore
records `exhaustedAt` and refuses to restart within `PROBE_RESTART_COOLDOWN_MS`. Clear it on
recovery — otherwise a service that just came back stays un-probed for the whole cooldown.

### Don't: reset a "component is alive" ref only in the cleanup function

**Problem.** `probeInFlightRef.current = false` in an effect's cleanup, never restored in the
body. React 18's `<StrictMode>` double-invokes effects in dev (mount → cleanup → mount) while
refs survive the fake unmount, so the flag stuck at `false` for the whole session and every
probe result was discarded. Production looked perfect; `npm run dev` was silently broken.

**Why it's bad:** no throw, no log — the only symptom is 「自愈在我机器上不生效，打包后却好」.
That sends you debugging the wrong layer entirely.

**Instead:** reset in the effect body, set false only in cleanup, and keep a guard (K18) that
fails if the reset moves back into the cleanup.

### Don't: put a long-interval timer in a window that throttles in the background

**Problem.** `BrowserWindow` defaults to `backgroundThrottling: true` (`electron.d.ts:18215`).
Chromium then does *intensive throttling* on the hidden/unfocused window's `setTimeout` — timers
of 1 minute or more get clamped to the minimum rate. The overlay window is *permanently*
unfocused (it is a floating badge), so this is not an edge case; it is the normal state.

**Why it's bad:** the failure is silent. The timer still fires, just late — possibly much
later. Nothing in the UI looks wrong, and there is no error to grep for. A 1-hour broadcast
timer becomes "some time after an hour, if the OS feels like it".

**Instead:** set it in `overlay.ts` where the window is constructed:

```ts
webPreferences: {
  // 后台节流必须关掉：窗口常态是「用户没在看它」，而 Chromium 对隐藏/非聚焦窗口的
  // setTimeout 会做 intensive throttling（1 分钟以上的定时器被降到最低频率）。
  backgroundThrottling: false
}
```

Companion setting, same feature: unattended audio (`new Audio().play()` with no user gesture)
is blocked by the autoplay policy. `session.defaultSession.setAutoplayPolicy()` **does not
exist** in this Electron version — verified against `electron.d.ts`, where `autoplayPolicy`
only appears as a `webPreferences` field. The working form is a process-wide switch, placed
before `app.whenReady()`:

```ts
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
```


### Don't: promote a value to `App` before checking it isn't a main-process push

`collapsed` and `skin` are already pushed; storing them again invites the two to disagree.

### Don't: encode a new boolean without checking the existing spellings

Six keys use `'1'/'0'`, one uses `'1'/''`. There is no helper. Add one, or at minimum note
which spelling you matched.

### Don't: call `fetch` from the renderer — CSP will reject it before it leaves the page

`src/renderer/index.html` sets `connect-src 'self' data: blob: bd-asset:`. The renderer may
only talk to itself and those three internal schemes; any other origin is refused by the
browser with `TypeError: Failed to fetch`. The message looks like a network failure, so it
gets mis-read as "service is down" — and no amount of service-side verification will
contradict that, because `curl` is not subject to CSP.

**Instead:** send the request from the main process over IPC. `src/main/ipc.ts` is the
established home for outbound HTTP (`adapters`, `request.ts`, `tts:speak`); the renderer
passes `{url, headers, body}` and gets bytes or a reason-coded error back.

| Renderer wants to… | Do this |
|---|---|
| fetch a JSON/binary API | IPC handler in `src/main/ipc.ts` |
| load local assets | `bd-asset://` (already allow-listed) |
| blob/data URLs | already allow-listed |

**The CSP is a red line.** Do not widen `connect-src` to make a fetch work — that converts a
per-feature bug into a page-wide egress hole. `test-structure.mjs` F1 locks the value
verbatim; if it goes red, the fix is to move the request, not to edit `index.html`.

Related: [`../guides/external-api-integration.md`](../guides/external-api-integration.md)
Step 9 (verify from the layer that actually issues the request).

## Related

- [`hook-guidelines.md`](./hook-guidelines.md) ·
  [`component-guidelines.md`](./component-guidelines.md)
- Vocabulary (`快照` / `可信度` / `采集引擎`): [`../../../CONTEXT.md`](../../../CONTEXT.md)
