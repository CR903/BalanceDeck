# 技术设计：球形态回到 2D 小圆环

## 边界

只动**球形态**这条分支。人物形态（213×293 / three.js / 动作编排 / 材质 / 打光）
一行不改 —— 那是 `09-18-human-realism` 的地盘。

```
                    figure = false                figure = true
                  ┌───────────────────┐         ┌──────────────────────┐
                  │ 2D 小圆环（DOM）    │         │ three.js 场景        │
                  │ window 56×56       │         │ window 213×293       │
                  │ 无 WebGL           │         │ WebGL + FBX + mixer  │
                  └───────────────────┘         └──────────────────────┘
                            │                              │
                            └────── 命中区上报 ────────────┘
                                   （主进程按此判定穿透）
```

## 核心决策：球形态不构造场景，而不是「构造一个空场景」

`createPet3dScene` 在 `scene.ts:151` **无条件** `new THREE.WebGLRenderer(...)`，
`PetForm` 只有 `'ball' | 'figure'` 两个成员，**没有**「不渲染任何东西」的形态。
所以「球形态也建场景但不画球」需要改动 three.js 初始化路径 —— 那是把一个
「渲染引擎」改造成「可关闭的渲染引擎」。

**正确做法是让调用方不要构造它。** 判据：

| 方案 | 改动面 | 风险 |
|---|---|---|
| A. 场景内加「空形态」 | `scene.ts` 初始化 + `PetForm` 联合 + `FORMS` + 所有 `rig.ball` 分支 | 高：18 处 `rig.ball` 分支要重新审；`WebGLRenderer` 仍被创建（省不了显存，达不到 R1） |
| **B. 球形态不调用 `createPet3dScene`** | `PetBall.tsx` 一个 effect 的守卫 + CSS + 死码 | 低：人物路径零改动 |

选 **B**。这同时**真的省显存**（不创建 WebGL 上下文），而 A 做不到。

## 状态模型

现状只有一个 `failed`（WebGL 初始化抛异常）。球形态变 2D 后需要区分三种情况：

| `figure` | `failed` | 呈现 | 场景 |
|---|---|---|---|
| false | false | **2D 小圆环** | 不创建 |
| false | true | 2D 小圆环（同上） | 不创建 |
| true | false | 3D 人物 | 创建 |
| true | true | 2D 小圆环（**兜底**） | 创建失败 |

所以 **2D 圆环的渲染条件是 `!figure || failed`**，而不是现在的 `failed`。

> 第四行是**必须保留的韧性**：老显卡/驱动异常时人物形态仍要有可用界面。
> 这一条不能因为「球形态本来就是 2D」而顺手删掉 —— 它服务的是人物形态的失败路径。

## 复用现有兜底 JSX，而不是复活 `CollapsedDot`

`PetBall.tsx:441-462` 的 `.petball-fallback` 已经是几乎完全一致的东西：
`viewBox="0 0 56 56"`、`r=22`、`strokeWidth=5`、`rotate(-90 28 28)`、
`.dot-value` + `value.length > 4 ? 'small' : ''`。

**为什么不复活 `d5a028e` 的 `CollapsedDot.tsx`？** 那份组件的逻辑（严重度排序、
5s 轮播、8px 拖拽、tooltip 拼装）早已在 `PetBall.tsx` 里重写了一遍，且现在
`App.tsx` 有自己的 `AppState` 订阅与 `center`/`half`/`viewSize` 测量。搬回旧组件
会引入第三份状态来源 —— 那正是 `state-management.md` 里记的已知不一致
（两处 `AppState`、两处 skin 状态）会进一步恶化。

**只复用这段 JSX，把触发条件从 `failed` 改成 `!figure || failed`。**

## 补回环的 CSS（R3 —— 这是修 bug，不是加功能）

现状核实：

```tsx
// PetBall.tsx:445
<circle className="dot-ring-track" cx="28" cy="28" r="22" fill="none" strokeWidth="5" />
```

`fill="none"` + **没有 `stroke` 属性** → SVG 默认 `stroke: none` → **环不可见**。
全项目 grep：`dot-ring-track` 零 CSS 规则；`dot-ring-fill` 唯一规则在
`.dot-btn.stale` 下，而 `.dot-btn` 这个类**既无 CSS 规则也无 TSX 引用**
（`d5a028e` 的遗留）。

也就是说**今天 WebGL 失败时，用户看到的是一个纯色圆盘 + 数字，环根本没画出来**。
本任务顺手把它修好 —— 成本是零（CSS 已经在首版里写过）。

从 `d5a028e:skins.css` 取回的规则：

```css
.dot-ring-track { stroke: var(--track); }
.dot-ring-fill  { stroke: var(--ok); transition: stroke-dasharray 600ms var(--ease), stroke var(--dur) var(--ease); }
.dot-btn.lvl-warn   .dot-ring-fill { stroke: var(--warn); }
.dot-btn.lvl-danger .dot-ring-fill { stroke: var(--danger); }
.dot-btn.lvl-muted  .dot-ring-fill { stroke: var(--fg-faint); }
```

**类名要改成当前代码的形状**：现状是 `.petball.no3d .dot-value`（`skins.css:1711`），
不是 `.dot-btn .dot-value`。沿用 `.petball.no3d` 作用域（它已经承载了这个兜底块的
全部样式），只把**缺失的环规则**加进去，并顺带删掉 `.dot-btn.stale` 这两条孤儿规则。

**几何不一致要一并修**：`.petball-fallback` 是 `60×60`（`skins.css:1691-1692`）而
SVG `viewBox` 是 `56 56`（`PetBall.tsx:444`）。56×56 窗口下 `60×60` 会溢出。
统一成 **56×56**，SVG 直接铺满（`width/height: 100%` 已有）。

## 命中区（R5）

现在两个来源：

```tsx
// PetBall.tsx:198-204  无场景时
const w = hostRef.current?.clientWidth ?? FIGURE_VIEW.width
const h = hostRef.current?.clientHeight ?? FIGURE_VIEW.height
window.api.setPetHitbox({ x: w / 2 - 30, y: h / 2 - 30, width: 60, height: 60 })
```

注意兜底值用了 `FIGURE_VIEW` —— 球形态下这是个**错的默认值**（213×293），
只是因为 60×60 落在任何窗口里都居中偏上才没暴露。改成 `BALL_VIEW`。

主进程侧不用改：

```ts
// overlay.ts:373-375 —— 唯一的门槛是 > 0，无最小尺寸
hitbox = rect && rect.width > 0 && rect.height > 0 ? rect : null
// overlay.ts:383-384 —— pad = 3 的外扩
const pad = 3
```

56 + 3×2 = 62px 的可点范围，在 90ms 的轮询节奏下完全够用。
`clampToWorkArea` 无最小值（`overlay.ts:232-234`），不会裁。

## 死码清理（R4）

| 文件 | 清什么 | 保留什么 |
|---|---|---|
| `scene.ts` | 球几何 266–391（126 行）、`applyTokens` 的球材质 505–517、`levelRgb`/`refreshColors` 525–536、`updateHitRect` 球分支 561–567、`step` 的高光漂移 750–754、`ringOn`、`buildFill` 调用、`dispose` 材质表里 9 个球材质 | `shadowFloor` / `blob`（人物形态的地面阴影，`scene.ts:226-227` 明确说明）、`applyForm`、人物分支全部 |
| `rig.ts` | `CAM_DISTANCE` `CAM_PITCH` `CAM_Y` `SHELL_EDGE_R` `BAND_R` `BAND_TUBE` `RING_R` `RING_TUBE` `RING_HALO_TUBE`（9 个）、`FORMS.ball` | `BALL_RADIUS` / `BALL_CENTER_Y`（`GROUND_Y` 的输入，间接被人物用） |
| `pet-view.ts` | `BALL_VIEW` 改 56×56 | `FIGURE_VIEW` 不动 |
| `pet3d/projection.ts` | 整个文件（`sphereNdcHalf` 唯一运行时消费者是球分支的 `updateHitRect`） | —— |
| `skins.css` | `.petball-center-value` 4 条（1489–1510，球形态专属）、`.petball.hover .petball-stage` 缩放（1581–1589，注释自承「球体本身由 WebGL 画」）、`@keyframes petball-pop`（1604–1615，**全项目零引用，已经死了**）、`.dot-badge` + `.dot-btn.stale` 三条（2069–2086） | `.petball` 容器、`.petball-stage`、`.petball-hit`、`.petball-caption`、`petball-value`、`petball-dots`、`petball-label`、`petball-badge`、`petball-bubble`、`petball-rename`、`.petball.no3d` 块（改造后成为球形态主样式） |

**`PetForm` 联合的处置**：`'ball' | 'figure'` 里 `'ball'` 变死成员。
但**不删** —— `FORMS` 的 `Record<PetForm, …>` 强制穷尽，删了要动整条链。
保留 `ball` 项但让它只剩 `ball: true`（语义：「球形态 = 3D 球装饰」已经恒假）。
这一条在注释里写清，避免后人以为是漏删。

> 取舍：留一个语义上已死掉的联合成员，比连锁改 `rig.ts` / `scene.ts` / `PetBall.tsx`
> 的类型签名更划算，且**有注释标注**，不构成误导。

## QA 面（R6/R7 —— 本任务最大的工作量）

### `uitest.ts`（35 条 `pet*` + 3 条非 `pet*` 受影响）

| 断言 | 处置 |
|---|---|
| `uitest.ts:106` `ball3d` | **删** —— 断言球形态有 WebGL canvas，与新设计相反 |
| `uitest.ts:532` `petBallWindow` | 保留（用 `BALL_VIEW` 常量，**必须确认它读的是常量不是字面量**） |
| `uitest.ts:533` `petBall3d` | **反转** —— 球形态应当 `!canvas` |
| `uitest.ts:539` `petBallCenterValue` | 改为断言 2D 环（`.petball-fallback` / `.dot-ring-fill`）存在 |
| `uitest.ts:171` `refreshThenCollapse` | **必须改** —— `bounds().width === 200` 是**硬编码字面量**，不是 `BALL_VIEW` |
| `uitest.ts:429` `petFigureOnly` | **重写** —— 正则 `/Sphere\|Torus\|Tube/` 在球几何删干净后**永不可能匹配**，留着就是假护栏（R7） |
| `uitest.ts:420` `petCenterValue` | 复核 —— 它断言 figure 下 `.petball-center-value` 不存在；新结构下该类只被人物分支引用，结论应仍成立，但**要重新验证而不是假设** |
| 其余 30 条 | 人物形态或形态无关，逐条复核后保留 |

### `ballshot.ts`

`BD_ONLY` / `BD_ISOLATE` / `BD_DEBUG_RING` 三个 env 全部依赖
`window.__bd_ball().dump`（场景的物体清单）。球形态无场景 → 三者失效。

**处置：明确标为「仅人物形态有效」**，并在球形态下打印一行说明而不是静默无效 ——
静默无效的 env 是最坏的形态（用户会以为它坏了）。
`BD_SETTINGS` 的 `petInfo:` 打印同理（`__bd_ball` 在球形态仍存在，但字段全为 `null`）。

### `test-projection.mjs`

§2（`:62-108`）与 §3（`:110-135`）是球专属：前者用 `rig.BALL_*` 交叉核对 three 的投影，
后者断言「200×210 窗口里球投影直径 ≈112px」。随球形态删除。
§1（`:36-59`）是 `sphereNdcHalf` 的纯数学（传字面量、不 import rig），与形态无关 ——
但它测的函数随 `projection.ts` 一起删了，所以 §1 也走。
**整个文件随 `projection.ts` 删除**，`package.json` 去掉 `test:projection`。

### `test-structure.mjs`

`ballshot.ts` 被 B4 的目录闭集断言钉住 —— **文件不能删**，只能改内容。

## 数据流与失败语义

```
采集 → AppState → PetBall（两条独立订阅）
                      │
        ┌─────────────┴─────────────┐
     figure=false                figure=true
        │                           │
   纯 DOM 计算                 createPet3dScene
   worstWindow(pct)                    │
   value = fmtPercent(pct) 或紧凑金额   ├─ 成功 → 人物 + 地面阴影
   window.api.setPetHitbox(56×56)      │
   无 WebGL、无 3D 资源加载        └─ 抛异常 → failed=true → 回落 2D 圆环
```

**球形态下这些一律不发生**：`createPet3dScene`、FBX 解析、`AnimationMixer`、
`three` 的 shader 编译、GPU 显存占用。`scene.ts:422-425` 那条「默认形态不下载 human
分包」的优化从此**变成无条件成立** —— 因为默认形态就是人物形态以外的那一个。

## 兼容性

- 无新依赖、无新设置项、无持久化键变更。
- `ui:pet`（是否开个性人物）语义不变；`ui:petRing`（用量环开关）在球形态下**失效**
  —— 2D 环就是那个环。**处置**：右键菜单里「用量环」项在球形态下要么隐藏、要么置灰；
  不能让它变成一个点了没反应的死开关。这是本任务**唯一一处 UI 行为需要额外决策**的点。
- 老用户持久化的窗口位置/尺寸在形态切换时由 `resizeCollapsed` 夹回工作区
  （`overlay.ts:71-80`），56×56 不会越界。

## 实施顺序与回滚

| 步 | 内容 | 可独立回滚 |
|---|---|---|
| 1 | `BALL_VIEW` → 56×56 + `PetBall.tsx` 守卫（球形态不建场景）+ 2D 环 CSS 补齐 | 是（3 个文件） |
| 2 | 命中区改用 `BALL_VIEW` 默认值 | 是 |
| 3 | 死码清理（`scene.ts` / `rig.ts` / `skins.css` / 删 `projection.ts`） | 是 |
| 4 | QA 同步（`uitest` / `ballshot` / `test-projection` / `package.json`） | 是 |
| 5 | 右键菜单「用量环」在球形态下的处置 | 是 |

**步 1 就能验收**（视觉上已经是小圆环），步 3 只是把不再用的代码删掉。
所以若步 3 出问题，可以停在步 1 + 步 2 交付，留死码比回滚视觉更划算。

## 风险

| 风险 | 应对 |
|---|---|
| 删掉球几何后 `petFigureOnly` 恒过（假护栏） | R7 强制重写；并在步 4 逐条复核 35 条断言 |
| `uitest` 因 userData 污染报假失败 | R8 要求验收时 `BD_USER_DATA=<临时目录>`；隔离本身单独立项 |
| 56px 在高 DPI 屏上点击目标偏小 | 主进程已有 `pad = 3` 外扩（62px）；`--uitest` 的 `petPierce` 断言 `hb.width > 20` 仍成立 |
| 人物形态被误伤 | 人物路径**零改动**是本设计的硬约束；步 3 每删一块都要确认没有人物引用 |
| `ui:petRing` 变成死开关 | 步 5 专门处置 |
| 球形态下 `window.__bd_ball` 字段全 null，部分诊断脚本失效 | 在 `ballshot` 里显式提示，不静默 |
