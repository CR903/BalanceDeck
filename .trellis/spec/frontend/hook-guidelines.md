# Hook Guidelines

> How hooks are used in this project.
>
> **The single most important fact: there are no custom hooks. None.**
> `grep -E "(function|const|export (function|const))\s+use[A-Z]" src/` → no matches.
> There is no `useFoo.ts`, no `hooks/` directory, no `useDebounce`, no `useInterval`.
> Every hook call is inline in a component body.

If you find yourself writing the same hook logic twice, the project's answer is **a plain pure
function module**, not a hook. That is exactly how `read-model.ts` and `pet3d/gesture.ts`
were factored:

```ts
// src/renderer/src/read-model.ts:5-9
// 供应商快照的读模型：**一个**回答「哪个窗口重要、多严重」的地方
//
// 为什么独立成模块：此前主页卡片、详情页、收起态悬浮球各写一套 —— 同一个概念四处实现
```

```ts
// src/renderer/src/pet3d/gesture.ts:4
* 纯函数模块（无 three / 无 DOM / 无 React），scripts/test-gesture.mjs 直接跑。
```

That choice is deliberate: pure-function modules are directly unit-testable in Node, and
hooks are not.

---

## Inventory — what is actually used

| Hook | Count | Notes |
|---|---|---|
| `useState` | 52 | `App.tsx` 13, `SettingsView.tsx` 17, `PetBall.tsx` 12, `CardView.tsx` 5, `PetSection.tsx` 3, `DetailView.tsx` 2 |
| `useEffect` | 30 | every one has a cleanup except a few pure-read effects |
| `useRef` | 20 | DOM refs **and** render-stable mirrors |
| `useMemo` | 9 | all silent — no comment anywhere explains why |
| `useCallback` | 5 | all silent, all exist for effect-dependency stability |
| `useLayoutEffect` | 1 | the FLIP animation, `CardView.tsx:297` |

**Never used anywhere:** `React.memo`, `useReducer`, `useContext`/`createContext`,
`useImperativeHandle`, `useTransition`, `useSyncExternalStore`, `useDebugValue`,
`useInsertionEffect`.

If you need memoization for a *pure computation*, prefer `useMemo`. If you need a component to
skip re-render, the project has deliberately chosen not to do that — 82 assertions in
`--uitest` and a small enough tree that it has never mattered. Don't introduce `memo` casually.

---

## Data Fetching

**No data-fetching library.** No `react-query`, no `@tanstack/*`, no `swr`. Runtime deps are
exactly `react`, `react-dom`, `three` (`package.json:49-53`). There is no cache, no request
deduplication, no refetch-on-focus.

**Data is pushed from the main process over IPC.** Each screen fetches imperatively in an
effect and re-fetches after an explicit user action. The four push channels, all of which
return an unsubscribe:

| Event | Preload fn | Consumer |
|---|---|---|
| `state:snapshot` | `onState` | `App.tsx:311` **and** `PetBall.tsx:82` |
| `ui:collapsed` | `onCollapsed` | `App.tsx:312` |
| `ui:skin` | `onSkin` | `App.tsx:319` |
| `pet:cursor` | `onPetCursor` | `PetBall.tsx:187` |

Everything else is `invoke` (await a reply) or `send` (fire-and-forget). Batched loading
exists in exactly one place:

```tsx
// src/renderer/src/SettingsView.tsx:333-335
const [p, cat, ex] = await Promise.all([
  window.api.listProviders(),
  window.api.listCatalog(),
  window.api.getExtras(['skin', 'refreshInterval', 'interval:plan'])
])
```

**Subscription pattern** — the preload helper returns the remover, so the effect can return it
directly:

```tsx
// src/renderer/src/PetBall.tsx:80-83
void window.api.getState().then(setState)
return window.api.onState(setState)
```

```tsx
// src/renderer/src/PetBall.tsx:186-188 — the optional-channel variant
return window.api.onPetCursor?.((over) => setHover(over)) ?? (() => {})
```

`App.tsx:309-325` is the only place that collects them into locals (`off1/off2/off3`) and
calls them explicitly, because it also does async work in the same effect.

---

## The ref-mirror pattern (load-bearing — read this before adding a dep)

`useRef` is used for DOM refs **and** as a render-stable mirror of state that effects must
read without re-running:

```tsx
// src/renderer/src/App.tsx:78-84
   * 为什么必须如此：依赖数组里一旦带上 collapsed / view，每次收/展面板、切视图
   * 都会重跑 effect 并「立即触发一次」—— 间隔设成 1 分钟就会感觉被播报了好几次。
  const speakCtxRef = useRef({ collapsed: false, snapshots: state.snapshots, hideBalance: false, muted: voiceMuted })
  speakCtxRef.current = { collapsed, snapshots: state.snapshots, hideBalance, muted: voiceMuted }
```

The assignment during render (not in an effect) is the point: the ref is always fresh, so the
effect body can read `.current` and the dependency array can stay empty. This is what makes
the self-rescheduling voice timer possible:

```tsx
// src/renderer/src/App.tsx:279-307 (abridged)
// 立即触发一次
speakBalance()
// 自重排定时器：只有开关或间隔变化才会走到这里
```

The same trick appears at `App.tsx:63-64`, `CardView.tsx:275-276`, `PetBall.tsx:75-76` —
**without a comment**. When you add a fourth, copy the comment from `App.tsx:78-82`.

---

## Effect cleanup

Every timer, listener, observer and rAF loop has a teardown. The 17 in the renderer:

| Created | Teardown |
|---|---|
| 15 s clock `CardView.tsx:217` · 30 s clock `DetailView.tsx:155` | `clearInterval` in the same effect |
| drag watchdog + 6 window listeners `CardView.tsx:391-399` | `:401-406` |
| voice interval `App.tsx:297` | `:301-306`, plus `:280-286` early clear on disable |
| `flashTimer` `SettingsView.tsx:346` | re-arm `:345` + unmount `:348-353` |
| `bubbleTimer` `PetBall.tsx:96` | re-arm `:95` + unmount `:85-90` |
| `MutationObserver` on `data-skin` `PetBall.tsx:180` | `obs.disconnect()` `:182` |
| carousel + hitbox intervals `PetBall.tsx:214,242` | `:234`, `:243` |
| 3 global pointer listeners `PetBall.tsx:321-323` | `:324-328` |
| rAF loop `pet3d/scene.ts:766` | `cancelAnimationFrame(raf)` `:910` |
| `ResizeObserver` `pet3d/scene.ts:606` | `ro.disconnect()` `:911` |

**Timer globals come in two spellings**, both in use:
- bare `setInterval` / `clearInterval` with a local const — `CardView.tsx:217-218`
- `window.setInterval` + a `useRef<number|null>` slot, so the handle can also be cleared
  mid-effect — `App.tsx:297-306`, `SettingsView.tsx:345-350`, `PetBall.tsx:95-96`

Use the `useRef` form whenever the effect both re-arms and needs an early exit.

---

## Async effects: two conventions, only one of them safe

```tsx
// SAFE — App.tsx:345-347
let cancelled = false
void renderTrayIcon(primaryMark)
  .then(({ png1x, png2x }) => { if (!cancelled) window.api.setTrayIcon(primaryMark, png1x, png2x) })
```

```tsx
// UNGUARDED — the majority
void window.api.getExtras(keys).then(setState)
```

Unguarded sites: `App.tsx:212`, `:315`, `:318`; `CardView.tsx:238`; `SettingsView.tsx:339`
(which awaits five sequential calls). **Copy the `cancelled` form for new async effects.**

One guard exists but is inert — the loop body is synchronous with no `await`, so `alive` is
always true: `PetSection.tsx:57-66`. Do not copy it.

---

## three.js lifecycle from React

Scene creation is one effect keyed on form only, with a `eslint-disable` and a stated reason:

```tsx
// src/renderer/src/PetBall.tsx:100-123 (abridged)
useEffect(() => {
  const host = hostRef.current
  if (!host) return
  let handle: Pet3dHandle | null = null
  try {
    handle = createPet3dScene(host, petRef.current.id, { form: figure ? 'figure' : 'ball' })
  } catch (e) {
    setFailed(true)          // WebGL 不可用 → 退回 2D 圆点，功能不丢
    console.error('[pet3d] 初始化失败，退回 2D 圆点：', e)
    return
  }
  sceneRef.current = handle
  setReady(true)
  return () => { handle?.dispose(); sceneRef.current = null; setReady(false) }
  // 形态切换要换机位与窗口尺寸，直接重建场景最省心（换角色走 handle 的 setPet）
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [figure])
```

The mount point is a dedicated empty div, not the component root:
`<div className="petball-stage" ref={hostRef} />` (`PetBall.tsx:410`).

The handle is exposed over `window`, not via props or context, and the comment at
`App.tsx:91-97` says why: the scene owns choreography, the app only expresses intent.

```tsx
// src/renderer/src/App.tsx:110-123 — await the exit gesture before swapping
// 老代码在这里 setPet 紧跟 playExitAnim，退场动作实际上从没播出来过。
if (!petOn) { swap(); return }
void playGesture('exit').then(swap)
```

**Heavy module is loaded on demand** — `human.ts` (FBXLoader + SkeletonUtils, ~200 KB) is
never statically imported:

```ts
// src/renderer/src/pet3d/scene.ts:422-425
// 动态导入：human.ts 静态依赖 FBXLoader + SkeletonUtils（约 200KB），
// 只有真的要用数字人形态时才值得付这个成本（默认形态是悬浮球）。
const { instantiateHuman } = await import('./human')
```

Follow that pattern for any new heavy dependency.

---

## Common Mistakes

### Don't: put a variable in a dependency array to "keep it fresh"

That is what the ref-mirror exists for. `App.tsx:78-82` documents the failure: an interval of
60 s re-created on every panel toggle fires immediately each time, so a 1-minute setting
"feels like it spoke several times".

### Don't: derive state into state via an effect without a reason

Two sites do this and are both about **array identity**, not values:

```tsx
// src/renderer/src/CardView.tsx:225-227 — reconcile ordering when the id set changes
useEffect(() => { setOrder((prev) => reconcileOrder(prev, idsKey ? idsKey.split(',') : [])) }, [idsKey])
```

```tsx
// src/renderer/src/PetBall.tsx:220-231 — equality-guarded to avoid a re-render loop
setCenter((prev) => (Math.abs(prev.x - c.x) < 0.5 && Math.abs(prev.y - c.y) < 0.5 ? prev : c))
```

Without a guard the second one re-renders forever. If you add a third, it needs one.

### Don't: memoize a one-line filter whose output is itself a dep key

`SettingsView.tsx:492-493` does this (`presetEntries`, `protocolEntries`) and then uses the
result as a dependency. It works, but it is not a pattern to extend.

### Don't: read the scene global with a bare `any`

`PetBall.tsx:368` uses `(window as any).__bd_pet_scene__` while `App.tsx:95-97` declares the
shape properly. The `__bd_ball` / `__bd_hide` / `__bd_gesture` hooks at `PetBall.tsx:147-151`
show the correct pattern with **no** `any`:

```tsx
const w = window as unknown as {
  __bd_ball?: () => unknown
  __bd_gesture?: (id: string) => Promise<void>
}
```

### Don't: put a function into a `window` test hook

```tsx
// src/renderer/src/PetBall.tsx:143-146
// ⚠️ 返回值必须是「可结构化克隆」的纯数据：里面塞函数会让 executeJavaScript
//    的结果无法回传（报 An object could not be cloned）。调试用的操作型钩子
//    单独挂在 window.__bd_hide 上。
```

`--uitest` calls these over `executeJavaScript`; a function in the payload breaks the round
trip. Split data hooks from action hooks.

## Related

- [`component-guidelines.md`](./component-guidelines.md) ·
  [`state-management.md`](./state-management.md) ·
  [`quality-guidelines.md`](./quality-guidelines.md)
