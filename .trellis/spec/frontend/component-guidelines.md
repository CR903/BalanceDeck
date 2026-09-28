# Component Guidelines

> How components are built in this project. React 18, plain CSS, **no** UI framework,
> no `React.memo`, no context, no state library.
>
> Renderer inventory: 9 `.tsx` files, ~2,900 lines of component code, one 2,366-line stylesheet.

---

## Component Structure

**One screen per file, flat.** There is no `features/` tree. File → exported component is 1:1:

| File | Lines | Export |
|---|---|---|
| `App.tsx` | 423 | `export default function App` — the only default export in the renderer |
| `CardView.tsx` | 606 | `export function CardView` |
| `SettingsView.tsx` | 753 | `export function SettingsView` |
| `PetBall.tsx` | 545 | `export function PetBall` |
| `DetailView.tsx` | 293 | `export function DetailView` |
| `PetSection.tsx` | 213 | `export function PetSection` |
| `ProviderMark.tsx` | 87 | `export function ProviderMark` |
| `components.tsx` | 253 | six named primitives: `Ring`, `MiniBar`, `Bar`, `StatusDot`, `Icon`, `IconButton` |

**Return type is always annotated `React.JSX.Element`** (or `| null` for early-return components):

```tsx
// src/renderer/src/components.tsx:8
export function Ring({ pct, lvl, size = 68, stroke = 6, dim = false }: { pct: number; lvl: Level; size?: number; stroke?: number; dim?: boolean }): React.JSX.Element {
```

```tsx
// src/renderer/src/CardView.tsx:25 — the nullable variant
function QualityChip({ s }: { s: ProviderSnapshot }): React.JSX.Element | null {
```

**No `React.FC`, no `React.FunctionComponent`, no `PropsWithChildren`.** Most files do not
import `React` at all — `React.JSX` comes from the global namespace. Only `components.tsx:1`
and `ProviderMark.tsx:1` do `import type React from 'react'`, and `main.tsx:1` imports the
value for `StrictMode`.

**No component accepts `children`.** Every component is self-closing; the largest one
(`SettingsView`, 753 lines) is 456 lines of straight JSX. Do not introduce `children` when
adding a component — pass a node prop if you must.

**One class component**, the error boundary, and it is load-bearing:

```tsx
// src/renderer/src/App.tsx:22-24
/** 渲染层兜底：任何未捕获渲染异常显示可重载界面，避免"假死"白屏 */
class ErrorBoundary extends Component<{ children: React.ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null }
```

---

## Props Conventions

Three styles coexist. **Inline anonymous object type in the destructured parameter** is the
dominant one — use it for new sub-components:

```tsx
// src/renderer/src/CardView.tsx:127
function BalanceCard({ s, now, hide }: { s: ProviderSnapshot; now: number; hide: boolean }): React.JSX.Element {
```

Use a **named `export interface XxxProps`** when a component has more than ~5 props:

```tsx
// src/renderer/src/PetBall.tsx:23-36
export interface PetBallProps {
  pet: PetState
  /** 收起态是否为「个性人物」形态（关闭 = 默认的 2D 小圆环，省显存/不加载角色素材） */
  figure: boolean
  ...
  hideBalance: boolean
}
```

Intersect to reuse another component's props rather than re-listing them:

```tsx
// src/renderer/src/SettingsView.tsx:281-298
export function SettingsView({ onBack, onDataChanged, ..., ...petProps }: {
  onBack: () => void
  ...
} & PetSectionProps): React.JSX.Element {
// and the blind forward at :653
<PetSection {...petProps} />
```

**Rules that hold everywhere:**
- Callbacks are `on*`, always explicitly typed, never `React.Dispatch`:
  `onOpen: (id: string) => void`, `onMenu: () => Promise<string | null>`.
- A prop is optional **only** when it is destructured with a default (`size = 68`,
  `dim = false`) or is genuinely nullable (`models?`, `onClick?`).
- Per-prop JSDoc in Chinese is used on non-obvious props and is worth writing:
  ```tsx
  // src/renderer/src/SettingsView.tsx
  /** 该供应商是否已静音（不参与语音播报） */
  muted: boolean
  ```
- **Document props by their persisted key** when one exists: `figure` → `ui:pet`,
  `alwaysTop` → `ui:alwaysOnTop`. The comment above is what lets a reader find the storage.

---

## Styling Patterns

**One stylesheet, imported exactly once**, and it is token-driven:

```tsx
// src/renderer/src/main.tsx:4
import './skins.css'
```

```css
/* skins.css:1-5 — the file's own contract */
BalanceDeck — 设计系统
令牌驱动：所有组件消费语义变量；皮肤 = 覆盖令牌（新增皮肤零代码）。
风格：macOS 原生质感 —— 克制的层次、克制的色彩、克制的动效。
```

**How a skin works** — a `[data-skin='…']` attribute on the app root redefines CSS variables;
5 built-ins (`aero`, `dark`, `minimal`, `candy`, `ink`) plus a
`@media (prefers-color-scheme: dark)` block. External skins are raw CSS text injected inline:

```tsx
// src/renderer/src/App.tsx:369-370
<div className="app" data-skin={skin}>
  {skinCss && <style>{skinCss}</style>}
```

Tokens are resolved on **`.app`, not `body`** — the stylesheet says so explicitly at
`skins.css:202-204` because getting it wrong is a common breakage.

**three.js reads the same custom properties** via `getComputedStyle`, so the 3D layer follows
skins without any code change per skin:

```ts
// src/renderer/src/pet3d/tokens.ts:86-88
export function readSkinTokens(el: HTMLElement): SkinTokens {
  try {
    const cs = getComputedStyle(el)
```

Skin changes reach the 3D layer three ways: a 60 ms re-read on `[pet.id, ready]`
(`PetBall.tsx:137-140`), a `MutationObserver` on `.app`'s `data-skin` (`PetBall.tsx:177-183`),
and `handle.setSkin()` from the `ui:skin` IPC push.

**Class naming** is a loose widget-prefix convention, **not** BEM — there is no `__element` or
`--modifier` anywhere. Ad-hoc 2–8 letter prefixes, measured from 305 top-level selectors:

| Prefix | Widget |
|---|---|
| `pcard-` | home card |
| `prow-` | settings provider row |
| `dwin-` | detail window |
| `wmodels-` | models inside a window |
| `model-` | models on the detail page |
| `petball-` | collapsed 3D surface |
| `pet-` | settings assistant section |
| `pmark-` | provider icon |

Unprefixed shared vocabulary: `.app`, `.ring`, `.bar`, `.section`, `.field`, `.switch`,
`.icon-btn`, `.tag`, `.sk-line`, `.saved-flash`, `.err-boundary`, …

**Severity has three separate spellings** — know which one you are in before adding a fourth:

| Spelling | Where | Source of truth |
|---|---|---|
| `lvl-${level}` | cards, detail, ball, ring/bar | `Level` union in `format.ts:55` |
| `dotLevel(): string` returning `'lvl-muted'` | settings list dots (`SettingsView.tsx:50-53`) | returns a bare `string`, not `Level` |
| bare `.ok` / `.warn` / `.danger` | home status line (`CardView.tsx:506`) | `skins.css:314-322` |

`wmodels-` and `model-` are near-identical grids that deliberately do **not** share a naming
family, but do share a `grid-template-columns: 1fr auto 44px` rule.

**A class with no CSS rule is a test hook.** `SettingsView.tsx:680` `className="refresh-interval"`
has no rule in `skins.css`; it exists only so `--uitest` can target it
(`qa/uitest.ts:251`), and the reason is written at `uitest.ts:247`. If you add a test-only
class, say so in a comment.

---

## Accessibility

There is no ARIA layer, and the reason is architectural, not negligence: this is a
**transparent, frameless, always-on-top window** where hit-testing is done manually.

- The window is `frame: false, transparent: true, alwaysOnTop`, with `contextIsolation: true,
  nodeIntegration: false` (`overlay.ts:150-154`).
- Click-through is implemented by the **main process** deciding whether a point lands in the
  hit rect, not by CSS `pointer-events`. The renderer only reports geometry:
  ```ts
  // src/main/ipc.ts:278-284
  ipcMain.on('pet:hitbox', (_e, rect: {…} | null) => { … })
  ```
- `IconButton` forwards the raw event so the caller can `setPointerCapture` — pointer state is
  managed imperatively (`PetBall.tsx:339`).
- Interactive elements that would normally carry `aria-label` carry `title` instead
  (e.g. the refresh button, `uitest`'s `b.title === '返回'`).

**When adding a control:** give it a `title` (it doubles as the `--uitest` selector) and an
explicitly typed `onClick`. Do not introduce `role`/`aria-*` expecting it to change behaviour —
it will not, because the window is mouse-transparent by default.

---

## Common Mistakes

### Don't: label a number with the wrong provenance

```tsx
// WRONG — tokens now come from the server, the label still says "local machine"
<span className="model-tokens">本机 {fmtAmount(m.tokens, 'token')}</span>

// RIGHT — derive from the row's own `source`; say "mixed" when it is mixed
{m.source === 'console' ? '服务端' : '本机'} {fmtAmount(m.tokens, 'token')}
```

Introduced 2026-09-26 when the opencode console began supplying tokens. The UI rendered
"控制台每月" above "本机 880.1M". **Search for every string naming a data source when you
change where data comes from:** `grep -rn "本机\|官方" src/renderer/`.

### Don't: give a missing value a plausible-looking zero

`quota` / `percent` are `undefined` for console-sourced rows and the renderer shows `—`:

```tsx
{m.percent != null ? fmtPercent(m.percent) : '—'}
```

Filling them with `0` rendered `$0 / 0%`, which is a claim, not a gap.

### Don't: create state that already lives in `App`

`PetBall` keeps its **own** `AppState` subscription instead of receiving the prop. That is a
documented exception, not a pattern to copy — see `state-management.md`.

### Don't: call `setState` from an unmount cleanup

```tsx
// src/renderer/src/PetBall.tsx:116-120
return () => {
  handle?.dispose()
  sceneRef.current = null
  setReady(false)          // ← runs during unmount
}
```

Works today; it is the kind of thing that produces a React warning the moment the tree
reparents. Clear refs in cleanup, move state resets into an effect body.

### Don't: put a bare `switch` on a severity class into TSX

The home status line is a 7-deep nested ternary (`CardView.tsx:478-490`). It is the worst
construct in the renderer. Use `read-model.ts`'s `snapshotLevel` / `worstWindow` instead.

### Don't: change a cross-form rule without asking whether it holds in the other form

`.petball-hit` / `.petball-fallback` / `.dot-value` are **shared by both forms** — the fallback
is the 2D ring *and* the figure's WebGL-unavailable path. Before editing one, ask: *does this
rule still hold when the other form is active?*

Concretely, from 2026-09-28: `.petball-fallback` had `backdrop-filter: blur(24px) saturate(180%)`
with the comment "磨砂桌面背景". It could not do that job — the window is `transparent: true`
and the page has no samplable backdrop — and in the dark skin it rendered as a light frame
around the ball. A comment promising a capability the code does not have is worse than no
comment. Same class of error: a token whose name says "page surface" being used for the ball.

### Don't: put an outer `box-shadow` on an element that is the size of the window

The overlay window is `transparent: true` and sized **exactly** to its content
(`BALL_VIEW` 56×56 = `.petball-fallback` 56×56). An outer shadow therefore has nowhere to go —
it is still painted, and the **window clips the circular halo into a square**: the four regions
inside the window but outside the circle keep their alpha, so a light rounded square appears
around a `border-radius: 50%` disc. Three misdiagnoses in a row (blame `backdrop-filter`, then
the native window layer, then an "opaque window background") before the bisection landed on it;
`design.md` §9 of task `09-28-dot-frame-label-carousel` has the full record.

Guard: structure gate `D6` in `scripts/test-structure.mjs` judges a **list** of pet-window
full-bleed selectors (`.petball-fallback`, its `:active` press state, `.petball-rename input`,
`.petball-hit`) — every top-level-comma layer of each `box-shadow` must
start with `inset`, and `.petball-fallback` must additionally keep ≥1 layer so its 3D does not
silently disappear. Layers are split on **top-level** commas only (`rgba(0,0,0,0.28)` contains
commas; so does `color-mix(in srgb, var(--ok) 18%, transparent)`).

#### The second instance, and why "it looks deliberate" is not a defence

`.petball-rename input` is 168×28 — **wider than the 56×56 window it lives in** — and its
`0 6px 20px rgba(0,0,0,0.35)` halo covered **100% of the window's 112×112 pixels**, exactly like
the ball's did. It shipped reading as "an intentional field shadow" and was left alone for three
days; the user then asked for it to go (2026-09-28). So the question to ask is not "is this
shadow wanted?" but **"does this element's box equal, or exceed, the window's box?"** — the window
clips whatever is there into a rectangle either way.

#### Why the 384×600 expanded window is *not* affected — the reason is not "it's inset"

Worth stating because the intuitive reason is **wrong**, and a wrong reason is what would let
someone break it. Measured on real `1-card.png` / `8-drag-preview.png` captures (2× device
pixels): a `.pcard`'s right border sits at **x ≈ 369.5 CSS in a 384-wide window — only 14 px of
clearance** — and `.pcard.dragging` carries `var(--shadow-pop), 0 14px 30px rgba(0,0,0,0.22)`
(36 px + 30 px blur in the dark skin). Its darkening band runs out to **x = 383, the last pixel
of the window, without fading back to the background**: the shadow really *is* being cut by the
window boundary. It is safe anyway because `.card` is `width:100%; height:100%` +
`border-radius:16px` + `overflow:hidden` and carries **no box-shadow of its own**, so every
descendant's ink overflow is clipped to the card's *rounded* rect. Pixel proof: the alpha contour
at the right edge tapers symmetrically — x=370 → rows 0..600, x=376 → 2..598, x=382 → 8..592 —
and **0 pixels outside that rounded rect carry any alpha**. The same measurement in the broken
ball form was 100% out to the window diagonal.

So the latent risk lives in `.card`, not in the individual shadows: drop its `overflow:hidden` or
set its `border-radius: 0` and the expanded window grows the same square frame. (No guard for
that yet — a `.card` assertion is the natural home, deliberately not added by task `09-28`,
whose scope is the pet window.)

### Don't: pin an expectation to a value that depends on text length

The figure baseline (`FIG_BASE` in `uitest.ts`) pins 8 fields byte-for-byte. Seven are
geometry; `overlay`'s **width** is a function of the caption string (label width + padding),
so pinning `77` couples a figure-form assertion to which provider happens to be on screen.
Seven geometry fields stay pinned; `overlay` is checked structurally instead. Apply the same
test to any new baseline field: *if changing this number requires changing a string somewhere
else, it is not a figure-form property.*

### Don't: extend the dead pet CSS

`skins.css:2105-2366` (262 lines) targets the removed SVG-sprite pets
(`mochi`/`shiba`/`dino`/`penguin`/`slime`); `.dot-badge` and `.dot-btn.stale` likewise.
`PetBall.tsx:408` still sets `data-pet={pet.id}` but only `.petball` consumes it. Do not
write new rules in that region.

## Related

- State & timers: [`state-management.md`](./state-management.md) · [`hook-guidelines.md`](./hook-guidelines.md)
- Vocabulary: [`../../../CONTEXT.md`](../../../CONTEXT.md)
