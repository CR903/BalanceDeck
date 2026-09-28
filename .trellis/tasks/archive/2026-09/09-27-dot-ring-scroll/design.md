# 设计：2D 小圆环的窗口切换、套餐分流与数字递增

配套 `prd.md`。本文件只讲**技术怎么落**，需求与验收见 PRD。

---

## 1. 边界与不变量

**在内**（全部在 `PetBall.tsx` + `skins.css` + `App/Section/ipc` 的设置删除）：

- 球形态 `.petball-fallback` 的渲染：环的可见性、窗口索引、中心读数、动画
- `.petball-hit` 上的滚轮交互
- 「显示用量环」设置的全链路拆除

**在外**（一行都不动）：

- 人物形态（`.petball-stage` + `pet3d/*`）、脚下的读数胶囊
- `read-model.ts` 的窗口选择与等级判定（**只复用，不改**）
- 主卡片 / 详情页的窗口 tab
- 采集、数据质量降级

**不变量**：

1. `worstWindow()` / `ballLevel()` / `windowPercent()` 的语义不变 —— 它们是唯一口径，
   球只是**不再无条件调用** `worstWindow()`
2. 窗口索引与供应商选择**只在内存**，无新持久化键
3. `hideBalance` 下**绝不**出现数字（动画、中间态、切换都不行）

---

## 2. 数据流：两个索引

```
state.snapshots ──sort(severityRank)──> snaps[]
                                          │
   idx ─────────────────────────────────> snaps[idx] ──> s: ProviderSnapshot
                                                              │
   winIdx ──────────────────────────────── (clamped) ────> s.windows[winIdx] ──> w
                                                              │
                                       windowPercent(w) ──> pct ──> 环的弧长
                                             │
                            fmtPercent(pct) / fmtAmount(w.used, w.unit) ──> 中心读数
```

新增状态：`const [winIdx, setWinIdx] = useState(0)`（`PetBall.tsx:56` 旁边）。

`worst`（`PetBall.tsx:265`）被 `winIdx` 取代：

```ts
// 现状：const worst = useMemo(() => worstWindow(s), [s])
const w = s?.windows.length ? s.windows[clampIdx(winIdx, s.windows.length)] : undefined
const pct = w ? windowPercent(w) : null
```

`ballLevel(s, worst)` → `ballLevel(s, w)`（同一签名，只是换了入参）。

### 切换供应商时窗口索引怎么落 —— **已定 B：固定 `windows[0]`**（2026-09-27）

```ts
// advanceProvider(dir) —— 换人的唯一入口（自动轮播与滚轮横向步进都调它）
setIdx((i) => (i + dir + count) % count)
setWinIdx(0)                      // 落位到 windows[0]（5 小时），两个 setState 同帧批处理
```

**回退到 A 的改法**（若实测换人后第一眼的 5H 占比过小、可读性差，一行即可）：

```ts
setWinIdx(s && s.windows.length ? s.windows.findIndex((w) => w === worstWindow(s)) : 0)
```

依据 `prd.md` §6。

### 索引变更的两种语义，必须分开（**合并会互相打断**）

| 触发 | 语义 | 处理 |
|---|---|---|
| `idx` 变化（自动轮播 / 手动左右切） | 换人 → **重置**窗口 | `setWinIdx(0)`，**与 `setIdx` 在同一次调用里批处理** |
| `s.windows.length` 变化（数据刷新） | 同一个供应商的窗口数量变了 → **夹紧**，不打断浏览 | 只 `clamp` |

**换人的两条路径必须走同一个 helper**（`advanceProvider(dir)`：`setIdx` + `setWinIdx(0)`）——
自动轮播的 `setInterval` 与滚轮的横向步进都调它。两条 `setIdx` 会被 React 批处理成一次
渲染，`winIdx` 与 `s` 永远同帧更新。

> **反面**：若用 `useEffect(() => setWinIdx(0), [idx])` 去重置，渲染会先用**旧 `winIdx`**
> 画一帧新供应商的窗口，再被 effect 打回 0 —— 中心数字闪一下别的读数，还可能让动画
> 起点算错。effect 版不可取。

所以下面那个 effect 的依赖**必须是 `windows.length` 而不是 `s`** ——
依赖 `s` 的话，每次数据刷新（60 秒一次）都会把用户正在看的窗口打回 0，
滚轮浏览会被周期性重置。

```ts
useEffect(() => {
  const n = s?.windows.length ?? 0
  setWinIdx(n === 0 ? 0 : clampIdx(winIdx, n))   // 先夹紧，防止越界
}, [s?.windows.length])                           // 注意：是长度，不是 s —— 数据刷新不应打断浏览
```

供应商**切换**的两条路径（自动轮播 tick、滚轮横向步进）**都调 `advanceProvider(dir)`**
（内部 `setIdx` + `setWinIdx(0)`）—— 不许各写各的，也不许改成 effect 重置（见上）。

---

## 3. 环的渲染契约（R1 + R2 + R3）

判定顺序固定为三层，**每层失败就少画一层**，不得合并成一个大布尔：

| 层 | 条件 | 画什么 |
|---|---|---|
| L1 有环吗 | `s.kind !== 'balance'` | `false` → 连 `.dot-ring-track` 都不画（只留素圆盘） |
| L2 有轨道吗 | L1 成立 | 画 `.dot-ring-track`（**与 `pct` 无关** —— 套餐供应商即使这个窗口算不出比例，环也该在） |
| L3 有填充弧吗 | L1 且 `pct != null` | 画 `.dot-ring-fill`，`strokeDasharray` 由 `pct` 算 |

**去掉 `showRing`**：`PetBall.tsx:455` 的 `{showRing && pct != null && ...}` →
`{pct != null && ...}`，`PetBall.tsx:35/36/48` 的 prop 一并删除。

L2「轨道与 `pct` 解耦」是新增的语义，要写注释说明**为什么**：PRD 的 AC3.3 要求
「无 `limit` 的窗口仍有轨道」，如果沿用「`pct != null` 才画」的写法，无 `limit` 的
窗口会显示成一个素圆盘 —— 用户会读成「这个供应商没环」，与 R2 混淆。

**`kind` 判定复用既有口径**：`CardView.tsx:557` 已是
`s.kind === 'balance' ? 'balance' : 'plan'`。抽成 `shared/quality.ts` 的
```ts
export const isPlan = (s: { kind: string }): boolean => s.kind !== 'balance'
```
两处共用，避免「卡片说是余额、球说是套餐」。

---

## 4. 滚轮交互（R4）

### 4.1 事件挂在哪

`onWheel` 挂到 `.petball-hit`（`PetBall.tsx:423`），与现有的
`onPointerDown/Move/Up/ContextMenu` 并列。

**可行性已核实**：`overlay.ts:405` 光标命中时 `setIgnoreMouseEvents(false, {forward:true})`，
滚轮送达渲染层；未命中时穿透到桌面 —— 所以 AC4.5「不新增命中区」天然满足。

不调 `preventDefault()`：`.petball` 是 `overflow:hidden`、无可滚动祖先，
浏览器默认行为本来就是空操作。而且 React 的 `onWheel` 是 passive 语义，
调 `preventDefault` 会告警。

### 4.2 方向判定 + 防惯性（AC4.2 / AC4.4）

触控板一次轻扫能发出**几十个** wheel 事件、像素和可达 500–2000px。
用「每次事件直接切一次」会在一个手势里跳过十几个条目 —— 这就是 AC4.4 要防的。

采用**分轴累积 + 门槛 + 冷却**：

```ts
const THRESHOLD   = 60   // |累计像素|，够一格
const COOLDOWN    = 250  // ms，同一轴两次切换的最短间隔
const GESTURE_GAP = 150  // ms，超过即视为「断流 = 新手势」→ 清残量
const wheel = useRef({ accY: 0, accX: 0, lastY: 0, lastX: 0, lastEvent: 0 })

onWheel = (e) => {
  const now = performance.now()
  const dy = e.deltaY, dx = e.deltaX

  // ① 断流清残量（必须在累加之前）
  if (now - wheel.current.lastEvent > GESTURE_GAP) {
    wheel.current.accY = 0
    wheel.current.accX = 0
  }
  wheel.current.lastEvent = now

  // ② 每个事件只喂**主导轴**：斜向手势不至于同时切两个维度
  if (Math.abs(dx) > Math.abs(dy)) {
    wheel.current.accX += dx
    // ③ 判据必须是 Math.abs(累加量)，方向取累加量的符号（见下）
    if (Math.abs(wheel.current.accX) >= THRESHOLD && now - wheel.current.lastX > COOLDOWN) {
      advanceProvider(wheel.current.accX > 0 ? 1 : -1)   // 左右（换人 → 同时 setWinIdx(0)）
      wheel.current.accX = 0; wheel.current.lastX = now
    }
  } else if (dy !== 0) {
    wheel.current.accY += dy
    if (Math.abs(wheel.current.accY) >= THRESHOLD && now - wheel.current.lastY > COOLDOWN) {
      stepWindow(wheel.current.accY > 0 ? 1 : -1)        // 上下
      wheel.current.accY = 0; wheel.current.lastY = now
    }
  }
}
```

**三个常量各挡一件事**：

| 常量 | 挡什么 | 只有它时会怎样 |
|---|---|---|
| `THRESHOLD` | 手指抖动 | 惯性手势累计量是阈值的 10 倍以上，照样连跳 |
| `COOLDOWN` | 惯性连发（AC4.4） | 鼠标滚轮单格 `deltaY ≈ 100` 会在同一批事件里误触发两次 |
| `GESTURE_GAP` | **手势结束后的残量** | 见下，这是唯一不靠常量值而是靠「断流」判定的一条 |

**残量为什么必须清（2026-09-27 复核补记）**：`acc` 只在**触发切换**时归零，被 `COOLDOWN`
挡下的事件会继续累加。一次 30 个 `deltaY:40` 的惯性手势走完，`accY` 可能残留 `1000+`
像素而一步未切；此时冷却已过期，**下一次哪怕只有 1px 的轻微滚动也会立刻过阈值**
—— 误切一格，且用户完全无感。`GESTURE_GAP` 在累加之前断流清零，把残量限制在
「一次连续手势」内部；`150ms` 是因为触控板惯性事件是连续到达（间隔 <15ms），
而人重新起手的间隔必然 >150ms。鼠标滚轮同理：单格内 `100 >= 60` 仍一格一跳，
不受断流影响（清完再累加，首格照样过阈值）。

**方向为什么取累加量符号而不是 `dx/dy` 符号**：`acc` 里可能有同一手势内上一次同向的
残量，取当前事件符号会让「累计量」与「方向」不自洽。清残量之后两者等价，
但取 `acc` 符号在任何情况下都对。

**`deltaMode` 差异**（设计必须覆盖）：Chrome 下鼠标滚轮通常报 `deltaMode: 0`（像素），
个别平台/`deltaMode: 1`（行）。`deltaMode: 1` 的一格是 `deltaY: 3`，
累计 3 次才到 60 —— 正好也是「一格一跳」。**不需要分支处理**，但要在验收时实测确认。

### 4.3 手动动作暂停轮播（AC4.3）

现有实现是固定 6 秒 `setInterval`（`PetBall.tsx:256`），没有「暂停」概念。

PRD 要求「8 秒内不推进、第 9 秒起恢复」。用固定 `setInterval(6000)` + 一个
`holdUntil` 守卫**做不到**：手动操作发生在第 5.9 秒时，下一个 tick 在第 6 秒就被
`holdUntil=13.9` 挡掉，下一个 tick 在第 12 秒…… 最早也要第 12 秒才动，
**实测体验是「说了 8 秒却等了 12 秒」**。

改成**秒级 tick + 两个时间戳**：

```ts
const lastAdvance = useRef(0)   // 上次自动推进的时刻
const holdUntil   = useRef(0)   // 手动操作要求的暂停截止

useEffect(() => {
  if (count <= 1) return
  const t = window.setInterval(() => {
    const now = Date.now()
    if (now < holdUntil.current) return                    // 还在暂停期
    if (now - lastAdvance.current < AUTO_MS) return        // 满足 6 秒节奏
    lastAdvance.current = now
    advanceProvider(1)   // 必须走换人唯一入口：裸 setIdx 会漏掉 setWinIdx(0)
  }, 1000)
  return () => window.clearInterval(t)
}, [count])
```

手动操作时：`holdUntil.current = Date.now() + 8000`。
**代价**：1 秒定时器而非 6 秒。**收益**：`setIdx` 才引起重渲染，1 秒 tick 本身
零渲染开销，而语义精确到 ±1 秒 —— AC4.3「第 9 秒起恢复」可以被断言验住。

`lastAdvance` 同时保证：暂停结束后第一跳落在 `max(手动时刻+8s, 上次推进+6s)`，
不会一恢复就连跳两下。

---

## 5. 数字递增动画（R5）

### 5.1 核心分离：**显示值 ≠ 目标值**

现状 `value` 是个 `useMemo` 直接返回字符串（`PetBall.tsx:270-277`）。
动画需要一个**逐帧变化的数字**，所以拆成两层：

```ts
type Reading =
  | { k: 'lit'; text: string }              // 非数值：直接落定，不参与动画
  | { k: 'num'; target: number; fmt: (n: number) => string; hide: boolean }
```

- `k: 'lit'`：`!` / `—` / `…` / `••••` —— **完全绕过动画**
- `k: 'num'`：`target` 是真实数值，`fmt` 是该次渲染该用的格式化器

`fmt` 由 `pct != null ? (n) => fmtPercent(n) : (n) => fmtAmount(n, w!.unit, {compact:true})`
给出 —— 所以**百分比与金额走同一套动画机制**（PRD：「数值和用量比都要」）。

### 5.2 动画触发来源（PRD 的两条规则）

| 触发 | 起点 |
|---|---|
| `idx` / `winIdx` 变化（切供应商 / 切窗口） | `0` |
| `target` 数值变化但索引没变（数据刷新） | **当前显示值** |
| 索引没变且目标没变 | 不动画（直接保持） |

实现要点：**动画起点在 effect 里按「什么变了」决定**，不是在渲染里猜。
用一个 `prevRef` 记住 `{idx, winIdx, targetNum}`：

```ts
useEffect(() => {
  if (reading.k !== 'lit') { start(reading.target, animateFrom()) }
}, [reading.k === 'num' ? reading.target : null, idx, winIdx])
```

`animateFrom()`：`idx`/`winIdx` 变 → `0`；否则 → `display.current`（当前显示值）。

### 5.3 rAF 实现约束

```ts
const raf = useRef<number | null>(null)
const display = useRef(0)   // 当前显示值（数字）
```

- `cancelAnimationFrame(raf.current)` **必须在每次 start 前调用**，否则快速连切
  会有多条 rAF 并发 → AC5.5 失败（最终值是最后一次 start 的目标，但中途会串）
- 结束时 `display.current = target` **精确赋值**，不用最后一帧的插值 ——
  否则 `easeOut` 收尾会留 `40.999999` 这类尾差 → AC5.2 失败
- 渲染时 `fmt(display.current)`；**`.small` 分类（`value.length > 4`）用目标值算**，
  否则动画中途长度变化会来回切字号（`PetBall.tsx:466`）
- 卸载时 `cancelAnimationFrame`（`return () => { if (raf.current) cancelAnimationFrame(raf.current) }`）
- `hideBalance` 命中 → `k:'lit'`，**从不构建数字**，`display.current` 不被读取
  → AC5.3 天然满足，不靠「记得跳过」

参数：**600ms + easeOut（`1-(1-t)^3`）**。600ms 是「看得见在动、又不嫌慢」的下限；
`tabular-nums` 已在 `.petball.no3d .dot-value`（`skins.css:1717`）上，
数字宽度不抖、`max-width: 42px` 不会因动画撑开。

### 5.4 与 `.small` / `max-width: 42px` 的关系

金额走 `compact`（如 `$24.6`、`$1.2k`），动画中途会经过 `0` → `$1` → `$12` → `$24.6`。
`fmt` 每帧调用保证格式一致（不会出现中间态是裸数字）。
`display: grid; place-items: center`（`.petball-fallback`）已居中，长度变化不偏移。

---

## 6. 窗口短标签（**已定：加，只在多窗口时显示** — 2026-09-27）

**为什么必须有**：多时限供应商切窗口时，中心数字从 `5.2%` 变成 `33%`，但**没有任何标识
说明现在看的是 5H 还是周**。用户不知道「挨个显示」停在了哪个 —— 没有标签这个功能就是盲切。

**方案**：`.petball-fallback` 内加 `<span className="dot-winlabel">`，取值
`shortWindowLabel(w.name)`（`shared/tray-text.ts:15`，现成：`5H` / `W` / `M`）。

- 位置：**左下角**，与右上角的可信度角标对角
- **仅当 `s.windows.length > 1` 时渲染**（单窗口显示 `5H` 是噪音）
- 仅球形态；人物形态不变
- `skins.css` 新增 `.dot-winlabel`（现无此规则）

### 几何推导（先算再写，别靠目测）

56×56，圆心 (28,28)，环外缘 `r = 24.5`（r=22 + stroke 5/2）。
角上能容下的**最大正方形**边长 `s` 满足 `(28-s)·√2 ≥ 24.5` → **`s ≤ 10.68px`**。
（沿对角线的 15.1px 是**误导值** —— 正方形靠角不是靠对角线，这个坑上一轮踩过。）

文本是扁矩形、不是正方形，所以可取窄而高的一条：取 **`font-size: 9px`**，
盒子约 `x ∈ [1,13]`、`y ∈ [49,55]`，其**离圆心最近的点 (13,49)**：

```
√((28-13)² + (49-28)²) = √(225 + 441) = √666 = 25.8  >  24.5   ✓ 余 1.3px
```

**余量只有 1.3px，这是本设计最紧的地方。** 门：实拍截图必须人工确认不压环 ——
压了就退到 `font-size: 8px`（余量 3.0px），**不许**把标签挪进环内去换空间。

---

## 7. 设置拆除（R1）

`showRing` 的完整链路（**七处**，一处都不能漏，否则编译或运行时静默失败）：

| 文件 | 行 | 要删/改 |
|---|---|---|
| `shared/types.ts` | `PetMenuModel` 附近 | `ring` 字段 |
| `PetBall.tsx` | 35, 36, 48 | `showRing` prop 与默认值 |
| `PetBall.tsx` | 453, 455 | 门控 `{showRing && ...}` → `{...}` |
| `PetSection.tsx` | 11, 19, 20, 36, 144-149 | 整行 `.enable-row` + prop（注释「三个开关」→「两个开关」） |
| `App.tsx` | 67, 68, 148, 151, 178, 192-196, 212, 217, 381, 395 | state、`togglePetRing`、`toggle-ring` 分支、`getExtras` 列表、两个 prop |
| `main/ipc.ts` | 251 | 菜单项 |
| `qa/uitest.ts` | 644-692 | `petRingToggle` + `petRingSaved` 两条断言 |

**`ui:petRing` 孤儿键**：停止读写即可，**不写清理代码**（为一个已下线的偏好加迁移逻辑
不划算，且读不到的键无副作用）。`getExtras` 列表里删掉这个 key（`App.tsx:212`）。

**注意**：`PetSection.tsx` 的 `三个开关` 文案在 `:11` 与可能的 `title` 属性里各一处，
都要改 —— 留着会指向已不存在的开关。

---

## 8. QA 断言设计（含「先弄坏一次」）

按本仓纪律：**每条新断言必须先弄坏一次确认会红**，且**不留永真假护栏**
（`09-27-ball-form-dot` 刚抓到 `petBallNoBubble` 靠 4.2s 泡泡寿命尾部侥幸生效）。

新增/改写：

| 断言 | 守什么 | 怎么弄坏 |
|---|---|---|
| `petRingAlwaysOn`（替代 `petRingToggle`） | 套餐供应商 `pct` 有值时必有填充弧 | 把 `{pct != null && ...}` 改成 `{false && ...}` → 必红 |
| `petRingRemoved` | 设置页无「显示用量环」行、右键菜单无该项 | 恢复那行 JSX → 必红 |
| `petNoRingOnBalance` | balance 供应商 `.petball-fallback` 内**零个** `.dot-ring-*` | 把 `isPlan()` 改成恒 `true` → 必红 |
| `petWindowCycle` | 上下滚轮后中心读数与 `strokeDasharray` 都变 | 去掉 `setWinIdx` → 必红 |
| `petProviderCycle` | 左右滚轮后 `data-pet` 变、且窗口回到 `windows[0]` | 去掉 `advanceProvider` → 必红 |
| `petCarouselResetsWindow` | 自动轮播推进后窗口**也**回到 0（守住「换人唯一入口」） | 在轮播 tick 里另写 `setIdx` 不重置窗口 → 必红 |
| `petWheelHold` | 手动切换后 8 秒内 `idx` 不推进 | 删掉 `holdUntil` 守卫 → 必红 |
| `petWheelInertia` | **连发 30 个 wheel 事件只跳 1 格** | 去掉 `COOLDOWN` → 必红 |
| `petCountUp` | 切窗口时能截到 `0 < 中间态 < 目标` | 把 `animateFrom()` 恒返 `target` → 必红 |
| `petCountUpExact` | 动画结束 = 目标值（无尾差） | 结束时不赋值 `display.current = target` → 必红 |
| `petWinLabel` | 多窗口时左下角有短标签**且随切换变化**；单窗口供应商**无**该标签（AC3.6） | 删掉 `.dot-winlabel` 的渲染 → 必红 |
| `petFigureNoWheel` | 人物形态滚轮**不**切窗口 —— 守 `if (figure) return`（`design.md` §9 标的最易漏项，R6） | 去掉 handler 的 figure 早退 → 必红 |
| `petHideBalanceNoAnim` | `hideBalance` 下不出现数字跳动 | 让 `••••` 走 `k:'num'` → 必红 |
| `petFigureUnchanged` | AC6.1 的人物形态逐位对照 | — （基线比对，不弄坏） |

合计 **14 条：13 条须逐条弄坏验证 + 1 条基线比对**。

**滚轮断言的可行方式**：合成事件对 React 处理器有效（与 `:active` 不同 —— `:active`
由 UA 合成器驱动，合成事件点不亮；`onWheel` 是 React 监听，`dispatchEvent` 会触发）：

```js
document.querySelector('.petball-hit')
  ?.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }))
```

**惯性断言**：连发 30 个 `deltaY: 40`（累计 1200px）→ 断言窗口索引只推进 1 格。
去掉 `COOLDOWN` 就会推进 20 格 → 必红。

---

## 9. 兼容与回滚

- **不新增持久化键** → 无迁移
- **`ui:petRing` 孤儿键**留在 extras 里，无副作用
- 回滚：单次提交，`git revert` 即可；`showRing` 链路是一组独立改动，删掉设置
  不会破坏其余功能（`PetSection` 由三个开关变两个，无布局依赖）
- 人物形态：`PetBall.tsx` 的改动全部限定在 `dot2d` 分支与 `.petball-hit`，
  人物形态 `dot2d === false` 时根本不渲染 `.petball-fallback`，
  但**滚轮处理器挂在 `.petball-hit` 上、人物形态也渲染它** ——
  ⇒ 必须在 handler 内部加 **`if (figure) return`**，否则人物形态下滚轮也会切窗口
  （R6 违规）。**这是最容易漏的一处。** （**勘误 2026-09-28**：本任务规划阶段此处写成 `if (!figure) return`，**方向反了** —— `figure` 为真即人物形态，写成 `!figure` 会挡住球形态、人球表现整体互换。实现时已纠正为 `if (figure) return`，并由 `petFigureNoWheel` 弄坏验证证到。）

---

## 10. 取舍记录

| 决定 | 取舍 |
|---|---|
| `k:'lit'` / `k:'num'` 两态而非「字符串拼接」 | 代价是多一层类型；收益是 `••••` **不可能**进入动画（结构上排除，不靠记得跳过） |
| 1 秒 tick 而非 6 秒 interval | 多一个 1 秒定时器；换来 AC4.3「8 秒」可被精确断言 |
| 分轴累积 + 冷却（两个常量） | 比「一次事件一跳」复杂；但这是 AC4.4 唯一可靠的解法 |
| 窗口标签放角（已定要） | 与「安静小圆点」有张力；余量仅 1.3px，实拍压环则退 8px，见 §6 |
| 不缓存 `windows[winIdx]` 到持久化 | 少一个 `ui:` 键；代价是重启后回到默认窗口 —— 可接受，桌面资产本来就该是「开箱即展示最要紧的」 |
| 抽 `isPlan()` 到 shared | 多一个导出；换来卡片与球永不劈叉 |
