# Research: 渲染层数据流与既有开关范式（问题 3 / 4 / 6）

- **Query**: App.tsx 怎么拿 listProviders → 怎么传给 CardView；排序在哪一层（`providers:reorder` IPC + scheduler.resort）；分组筛选插在哪一层；`ui:hideBalance` 与 `ui:voiceMuted` 的读/写/重置范式；组内 vs 组间排序语义
- **Scope**: internal
- **Date**: 2026-10-01

---

## 1. 数据流全链路（问题 3）

### 主进程 → 渲染层：只有 `snapshots`，没有注册表

```
scheduler.collect()                        scheduler.ts:60
  ├─ listInstances()  → buildAdapters()    scheduler.ts:69
  ├─ collectAll(...)  → fresh[]            scheduler.ts:70
  └─ listProviders()  → activeIds          scheduler.ts:80-81
       └─ for (const id of activeIds)      scheduler.ts:85-88  ← 顺序 = 注册表顺序
            merged.push(applyCachePolicy(prev, next))
  push?.({ snapshots: lastSnapshots, ... }) scheduler.ts:103
        │
        ▼ IPC 'state:snapshot'
App.tsx:947-948
  void window.api.getState().then(setState)
  const off1 = window.api.onState(setState)
        │
        ▼
App.tsx:98  const [state, setState] = useState<AppState>({ snapshots: [], ... })
App.tsx:1170-1178  <CardView state={state} hideBalance={hideBalance} ... />
```

**`CardView` 从头到尾只拿到 `AppState`（其中 `snapshots: ProviderSnapshot[]`），
不接触 `ProvidersPayload` / `ProviderInfo` / `ProvidersPayload.scanHits`。**

`ProvidersPayload`（`types.ts:166-169`）只在两个地方被消费：

| 消费者 | 位置 |
|---|---|
| 设置页 | `SettingsView.tsx:332` `window.api.listProviders()` |
| 排障 | `qa/uitest.ts:1920, 1969` |

### `enabled` 过滤发生在主进程，不在渲染层

`src/main/scheduler.ts:79-88`

```ts
// 被禁用/删除的供应商从展示中移除；顺序按注册表（= 用户拖拽排序）
const registry = await listProviders()
const activeIds = registry.filter((p) => p.enabled).map((p) => p.id)
...
for (const id of activeIds) {
  const next = freshById.get(id)
  if (next) merged.push(applyCachePolicy(prevById.get(id), next))
}
```

`buildAdapters` 同样跳过 `enabled: false`（`adapters/index.ts:41`，
测试断言 `scripts/test-adapters.mjs:902`：`'T16 禁用实例被跳过，顺序与注册表一致'`）。

**结论：`enabled` 是「主进程不过滤 → 渲染层根本看不到」。** 这是现有的「按实例显隐」范式。
分组显隐若照抄这一范式，语义是「不采集」；若只想「不展示」，则应在渲染层过滤。

`CardView` 里唯一的过滤是 `status !== 'nodata'`（`CardView.tsx:223`）：

```ts
const configured = useMemo(() => snaps.filter((s) => s.status !== 'nodata'), [snaps])
```

### 排序发生在三层

| 层 | 位置 | 做什么 |
|---|---|---|
| 注册表（持久层） | `providers.ts:337-351` `reorderInstances` | 按 `ids` 重排 `extras.providerInstances` 数组，写盘 |
| 内存快照 | `scheduler.ts:205-210` `resort(ids)` | 按 `ids` 重排 `lastSnapshots`，**立即 push + updateTray，不重新采集** |
| 渲染层 | `CardView.tsx:256-260` `ordered` | 按本地 `order` state 排 `configured` |

`providers:reorder` IPC 把前两层串起来（`src/main/ipc.ts:173-180`）：

```ts
// 拖拽排序：持久化顺序并立即重排已推送的快照（无需重新采集）
ipcMain.handle('providers:reorder', async (_e, ids: string[]) => {
  if (Array.isArray(ids) && ids.every((x) => typeof x === 'string')) {
    const changed = await reorderInstances(ids)
    if (changed) resort(ids)
  }
  return providersPayload()
})
```

`resort` 本体（`src/main/scheduler.ts:204-210`）：

```ts
/** 拖拽排序后按新顺序重排快照并立即推送（无需重新采集） */
export function resort(ids: string[]): void {
  const index = new Map(ids.map((id, i) => [id, i]))
  lastSnapshots = [...lastSnapshots].sort((a, b) => (index.get(a.id) ?? 999) - (index.get(b.id) ?? 999))
  push?.({ snapshots: lastSnapshots, lastSync, scanning: running, offline: isOffline() })
  updateTray?.(lastSnapshots, { offline: isOffline() })
}
```

### 渲染层的顺序 state（第三层）是本地的，权威在主进程

`CardView.tsx:222-228` + `:256-260`

```ts
const snaps = state.snapshots
const configured = useMemo(() => snaps.filter((s) => s.status !== 'nodata'), [snaps])
const idsKey = configured.map((s) => s.id).join(',')
const [order, setOrder] = useState<string[]>([])
useEffect(() => {
  setOrder((prev) => reconcileOrder(prev, idsKey ? idsKey.split(',') : []))
}, [idsKey])
...
const ordered = useMemo(() => {
  if (!order.length) return configured
  const rank = new Map(order.map((id, i) => [id, i]))
  return [...configured].sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999))
}, [configured, order])
```

`order` 初值是 `[]` → 首帧直接用 `configured`（即主进程推送的顺序）。之后由
`reconcileOrder`（`CardView.tsx:191-197`，保留已有顺序、新出现的追加末尾）维护。

两个提交点，都是 `setOrder(next)` + `void window.api.reorderProviders(next)`：

- 拖拽落位 `CardView.tsx:364-368`
- 键盘 ⌥←/⌥→ `CardView.tsx:463-467`

### 分组筛选该插在哪一层 — 三个可选插槽（现状给出的）

| 插槽 | 位置 | 效果 | 代价 |
|---|---|---|---|
| **A. 主进程 `collect`** | `scheduler.ts:85` 的 `for (const id of activeIds)` | 隐藏组不再采集、托盘也不再取它 | 每轮判一次；`resort` 也得知道分组顺序；托盘「第一优先级」语义要重新定义 |
| **B. `CardView` 渲染层过滤** | `CardView.tsx:223` `configured` 那一步 | 只影响主页网格 | 托盘 / `primarySnapshot`（`tray-text.ts:66-68`）仍按全量第一优先级，**托盘会显示一个看不见的卡片** |
| **C. `App.tsx` 切 `state.snapshots`** | `App.tsx:1170-1178` 传给 CardView 前 | 一次性影响 CardView + `SettingsView` 的 `providerNames`（`App.tsx:1124`） | `PetBall` 收起态是**另一个组件自己 getState**（`PetBall.tsx:162-163`），不受 App.tsx 影响 |

⚠ 现成的证据说明 B/C 的分裂是真实存在的：`hideBalance` 就同时传给了两个组件
（`App.tsx:1028` → PetBall、`App.tsx:1172` → CardView），因为「收起态」是独立的数据通路。

---

## 2. 既有开关范式对照（问题 4）

### `ui:hideBalance`（全局显隐）

| 侧 | 位置 | 代码 |
|---|---|---|
| 状态 | `App.tsx:105` | `const [hideBalance, setHideBalance] = useState(false)` |
| 读 | `App.tsx:519-520` | `getExtras([...]).then(e => { setHideBalance(e['ui:hideBalance'] === '1') })` |
| 写 | `App.tsx:545-549` | `setExtras({ 'ui:hideBalance': next ? '1' : '' })` |
| 第二写点 | `App.tsx:503-506`（悬浮球右键菜单） | 同一份 setter，两处入口 |
| 传给谁 | `App.tsx:1028`(PetBall) / `:1172`(CardView) | 两个消费者 |
| 消费 | `CardView.tsx:519-521`（眼睛图标 `eyeOff`/`eye`）、`:576`（`hide={hideBalance}`）→ `BalanceCard` `:144-147` 渲染 `••••` | |

**它的编码是 `'1'` / `''`（空串 = 关）—— 唯一一个这么写的布尔。**
spec 明确标注（`.trellis/spec/frontend/state-management.md:161`）：

```
| `ui:hideBalance` | **`'1'` / `''`** | differs from every other boolean - don't copy |
```

「重置模式」：`hideBalance` 没有重置入口，只有一个 toggle。uitest 里的「还原」是**测完翻回去**，
不是产品功能（`src/main/qa/uitest.ts:712-729`）：

```ts
const flip = async (): Promise<{ hidden: boolean; masked: boolean }> => {
  await clickEye()
  await sleep(400)
  return {
    hidden: await readHidden(),
    masked: (await exec("!!document.querySelector('.pcard.balance .amount-hidden')")) === true
  }
}
const first = await flip()          // 翻一次，断言状态翻转
const back  = await flip()          // 再翻一次，断言回到原值
```

### `ui:voiceMuted`（按供应商静音）—— **这才是分组显隐该抄的**

| 侧 | 位置 | 代码 |
|---|---|---|
| 状态 | `App.tsx:119-120` | `const [voiceMuted, setVoiceMuted] = useState<string[]>([])` |
| 读 | `App.tsx:524-529` | 见下 |
| 写 | `App.tsx:293-298` | 见下 |
| 传给谁 | `App.tsx:1043`（SettingsView）/ `:1123`（`mutedProviders`）/ `alertCtxRef` 镜像 `:564, 592` | 多个消费者 |
| 消费 | `App.tsx:782` `speakableSnapshots(ctx.snapshots, ctx.muted)` → `read-model.ts:84-89` | 纯函数 |

**写侧**（`App.tsx:293-298`）—— 数组整体重写：

```ts
/** 某个供应商要不要播报（写进 ui:voiceMuted 的「不播报」列表） */
const toggleVoiceFor = (id: string): void => {
  const next = voiceMuted.includes(id) ? voiceMuted.filter((x) => x !== id) : [...voiceMuted, id]
  setVoiceMuted(next)
  void window.api.setExtras({ 'ui:voiceMuted': JSON.stringify(next) })
}
```

**读侧**（`App.tsx:524-529`）—— `try/catch` + 类型守卫 + 逐元素过滤：

```ts
try {
  const muted = JSON.parse(e['ui:voiceMuted'] || '[]') as unknown
  setVoiceMuted(Array.isArray(muted) ? muted.filter((x): x is string => typeof x === 'string') : [])
} catch {
  setVoiceMuted([])
}
```

**消费侧**（`src/renderer/src/read-model.ts:84-89`）—— 纯函数，且注释说明了
「存不播报的 id 而不是允许播报的 id」这个方向性选择：

```ts
export function speakableSnapshots(
  snapshots: ProviderSnapshot[],
  muted: readonly string[] = []
): ProviderSnapshot[] {
  return snapshots.filter((s) => s.status === 'ok' && !muted.includes(s.id))
}
```

### 两个范式的差异（决定分组抄哪个）

| 维度 | `ui:hideBalance` | `ui:voiceMuted` |
|---|---|---|
| 粒度 | 全局布尔 | **按实例 id 的列表** |
| 编码 | `'1'` / `''`（spec 说别抄） | `JSON.stringify(string[])` |
| 读侧校验 | 无（`=== '1'` 天然收敛） | `Array.isArray` + 逐元素 `typeof === 'string'` |
| 过滤发生 | 渲染层（各组件各自判） | **纯函数模块 `read-model.ts`**，一处 |
| 语义方向 | — | 「黑名单」：空列表 = 全开，老用户零行为变化 |
| 落 extras 前缀 | `ui:`（无副作用） | `ui:`（无副作用） |

**分组显隐应当照抄 `ui:voiceMuted`**：它是按 id 的列表、需要类型守卫、需要「空 = 默认全开」的
向后兼容姿态、需要抽成 `read-model.ts` 里的纯函数让测试能盯住。`ui:hideBalance` 的 `'1'`/`''`
编码被 spec 明确标为反面教材。

**前提**：`ui:` 前缀是硬门禁 —— `src/main/ipc.ts:230-231`

```ts
// 纯界面偏好（ui:*，如隐藏余额）不触发采集，避免无畏的网络请求
else if (!Object.keys(patch ?? {}).every((k) => k.startsWith('ui:'))) refreshNow()
```

由 `scripts/test-structure.mjs:443-451` 静态钉死：

```js
const appExtrasKeys = [...appSrc2.matchAll(/setExtras\(\s*\{\s*'([^']+)'/g)].map((m) => m[1])
const nonUi = appExtrasKeys.filter((k) => !k.startsWith('ui:'))
ok(nonUi.length === 0, `E8 extras 键全部 ui: 前缀（...越界键：${nonUi.join(', ') || '无'}）`)
```

⚠ 判据只匹配 `setExtras({ '字面量' })` 形态。用模板键（如 CardView 的
`` setExtras({ [`ui:cardWindow:${id}`]: name }) ``，`CardView.tsx:253`）**解析不到** ——
新增的 per-instance 键天然绕过 E8，但 `CardView.tsx:230-253` 的 `ui:cardWindow:<id>`
已经确立了这条先例。

---

## 3. 分组排序的语义（问题 6）

### 现状：只有一个维度

`reorderInstances(ids: string[])`（`providers.ts:337`）与 `resort(ids: string[])`
（`scheduler.ts:205`）的参数都是**扁平的实例 id 数组**，隐含「一个全局序列」。
拖拽槽位计算 `slotIndexAt`（`CardView.tsx:334-349`）也假设了一个扁平的 `[data-card-id]` 网格。

### 引入分组后需要回答的：拖拽改的是哪一层

从现有代码能读出的确定事实：

1. `CardView` 的 `slotRects()`（`:324-328`）按 **DOM 顺序**取槽位。若引入分组标题行，
   标题行进入/退出网格会改变槽位数与几何 → `dragRef.slots` 的静态几何假设（注释 `:262-273`
   的四点设计要点②）需要重新审视。
2. `dragStyleFor(id, i)`（`:427-448`）用**数组下标 `i`** 算让位位移
   （`const shift = from < to && i > from && i <= to ? -1 : ...`）。分组标题若不是
   `[data-card-id]` 元素，`i` 的语义就会与 `orderRef.current` 的下标错位。
3. `orderRef.current = ordered.map(s => s.id)`（`:277`）—— 提交给
   `reorderProviders(next)` 的是**扁平 id 数组**，不含组信息。组间顺序在当前协议里无处表达。
4. `resort(ids)` 用 `index.get(a.id) ?? 999` 排 `lastSnapshots` —— **托盘标题取的是
   `primarySnapshot`，即这个序列里第一个有数据的**（`shared/tray-text.ts:66-68` + `:71-80`）。
   分组排序一旦改变这个序列，「托盘显示谁」的语义就跟着变。

### 是否要存「组的顺序」这个新维度

现状给出的结构事实：

- 注册表是**一个** JSON 数组，顺序即全局序（`providers.ts:212/228`），
  **没有第二个数组**可以放组顺序
- `extras` 是一个扁平 `Record<string, string>`（`store.ts:27`），
  组顺序只能作为**另一个 JSON 字符串值**存在某个新键里
- `reorderInstances` 的排序对未列出的实例一律排到末尾（`providers.ts:343-345`）
- IPC 协议 `providers:reorder(ids: string[])`（`ipc.ts:174`）的入参形状已被
  `Array.isArray(ids) && ids.every(x => typeof x === 'string')` 守卫写死

即：**组间顺序在现有数据模型里没有落点**，必须新增一个载体（注册表侧的组元数据，
或 `ui:` 侧的偏好键）。这是本任务最大的结构性新增，不是加字段。

---

## Caveats / Not Found

- 没有找到任何现成的「分组 / 标签」数据模型或 UI 骨架（`grep -rn "group\|tag\|分组"`
  在 `src/` 下只命中 MiniMax 的 `groupId` API 参数与无关注释）。
- `CardView` 的拖拽实现（`:262-468`）经过两轮实机调优，注释 `:262-273` 明确记录了
  「拖拽期间绝不改动 DOM 顺序」「目标槽位由拖拽开始时捕获的静态几何算出」等约束。
  引入分组标题行会触碰这些假设 —— 具体影响面需要在 design 阶段实测，本文件不作判断。
- 未找到 `App.tsx` 之外的第二个「读注册表」的渲染层通路；`SettingsView` 是唯一的
  `listProviders()` 消费者（`SettingsView.tsx:332`）。

## 相关 spec

- `.trellis/spec/frontend/state-management.md:153-176` — `extras` 键表全文
- `.trellis/spec/frontend/state-management.md:181-195` — `ui:` 前缀与 `refreshNow()` 副作用
- `.trellis/spec/frontend/state-management.md:197-216` — 读侧重新校验 + `extras:get` 返回 `''`
- `.trellis/spec/frontend/state-management.md:374`（quality-guidelines）— 「extras 读不出『缺失』与『空』」
- `.trellis/spec/frontend/hook-guidelines.md:65-66` — props 文档要写明对应的持久化键
