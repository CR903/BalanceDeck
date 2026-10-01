# Research: 同名多账号展示与测试落点（问题 5 / 7）

- **Query**: CardView 里供应商名怎么渲染；两家公司同名账号现在长什么样；区分需要在哪加标记；providers.ts 注册表读写怎么测；分组纯逻辑放哪个文件
- **Scope**: internal
- **Date**: 2026-10-01

---

## 1. 同名多账号现在长什么样（问题 5）

### 名字渲染只有一处模式，两处调用点

`CardView.tsx` 里供应商名出现两次，**写法完全相同**：

- `CardView.tsx:61`（套餐卡 PlanCard）
- `CardView.tsx:139`（余额卡 BalanceCard）

```tsx
<span className="pcard-top">
  <ProviderMark mark={s.mark} size={22} />
  <span className="pcard-name">{s.name}</span>
  <StatusDot lvl={lvl} />
</span>
```

`s.name` 直接来自 `ProviderSnapshot.name`，**没有任何后缀、去重、序号或副标题**。

`CardView` 唯一的可访问名也是裸名字（`CardView.tsx:555`）：

```tsx
aria-label={`${s.name} 详情`}
```

`title` 属性是所有卡片共用的操作提示，不含名字（`CardView.tsx:564`）：

```tsx
title="点击查看详情 · 拖拽调整顺序（⌥←/⌥→）"
```

`DetailView.tsx:280` 同样裸渲染 `<span className="brand">{s.name}</span>` ——
但**本任务不改 `DetailView.tsx`**（父任务 PRD `.trellis/tasks/10-01-p1-batch/prd.md:44` 明确处置）。

### 两家同名账号的实际视觉现状

同一个 `presetId` 的两条实例，`name` / `mark` / `kind` / `protocol` / `baseUrl` **全部相同**：

| 元素 | 值来源 | 两条同名实例是否相同 |
|---|---|---|
| 卡片名 `{s.name}` | `bind-instance.ts:23` `name: inst.name` | ✅ 相同 |
| 头像 `mark={s.mark}` | `bind-instance.ts:27` `mark: inst.presetId \|\| inst.protocol` | ✅ **相同**（同一个 logo） |
| `kind` / 卡片形态 | `isPlan(s)` → `CardView.tsx:558` | ✅ 相同 |
| `id` | `providers.ts:279` `inst:xxx-yyy` | ❌ 不同 |

即：**用户在主页上看到两张一模一样的卡片**，除了窗口切换 chip 上的百分比数字以外没有任何区分线索。

### 区分标记可以加在哪（现状提供的三个位置）

| 方案 | 落点 | 现状依据 |
|---|---|---|
| **名称后缀** | `CardView.tsx:61` / `:139` 的 `{s.name}` | `s.name` 是纯展示字符串，后缀需要**在渲染时算**，不能在采集侧写死（`bind-instance.ts:23` 直接搬 `inst.name`） |
| **卡片副标签** | `CardView.tsx:139-140` 的 `pcard-top` 里 `StatusDot` 旁；或 `:164` 的 `pcard-foot` | `QualityChip`（`:26-35`）已在 `pcard-foot` 里占位，`staleLabel(s)` 为空时返回 `null`（`:28`）→ **有现成的「可空 chip」插槽** |
| **头像色/角标** | `ProviderMark.tsx:41-52` | `markColor(mark)` 由 `provider-icons.ts` 的 `mark` 表决定；同 mark → 同色。要区分必须引入 mark 之外的第二个 key |

### ⚠ 关键约束：`ProviderSnapshot` 里没有任何可用的区分信息

`src/shared/types.ts:56-86` —— `ProviderSnapshot` 有 `id` / `name` / `kind` / `builtin` /
`mark` / `plan` / `status` / `detail` / `windows` / `models` / `modelsByWindow` /
`source` / `dataQuality` / `dataAt` / `degradedReason` / `failureReason` / `updatedAt`。

**没有 `baseUrl`，没有 `presetId`，没有 `protocol`。** 对比 `ProviderInfo`（`types.ts:89-110`）
三者俱全。

快照的身份由 `bind-instance.ts:21-28` 的 `identity` + `engine.ts:37` 的 `identityOf` 决定：

```ts
const identity: Identity = {
  id: inst.id,
  name: inst.name,
  kind: inst.kind,
  builtin: inst.builtin,
  // 图标 key：内置用预设 id，自定义用协议 id
  mark: inst.presetId || inst.protocol
}
```
```ts
return { id: a.id, name: a.name, kind: a.kind, builtin: a.builtin, mark: a.mark }
```

所以 `CardView` 想显示「同名账号的区分信息」，只有三条现状路径：

1. **`s.id` 已在手上** —— `inst:xxx-yyy` 里的时间戳部分可读，但这是实现细节，不是产品语义
2. **从 `ProviderInfo` 另取一份**（像 `ui:cardWindow:<id>` 那样，`CardView.tsx:230-241` 已经在
   为每个实例 id 批量读 extras 了）—— 同一次 `getExtras` 可以带上分组 / baseUrl
3. **给 `ProviderSnapshot` 加字段** —— 要改 `bind-instance.ts:21-28` + `engine.ts:37`
   （`identityOf` 返回 `Identity`，两个类型都在 `adapters/types.ts`）

### 一个必须注意的连带面：名称还被多处消费

同名账号的区分如果只做在 `CardView`，下列位置仍然只显示裸名字：

| 位置 | 代码 |
|---|---|
| 托盘 tooltip / 悬浮球气泡 | `PetBall.tsx:797` `` `${s.name}${ballHint}...` `` |
| 播报文本 | `App.tsx:786` `const name = s.name \|\| s.id` |
| 设置页通知对象下拉 | `App.tsx:1124` `providerNames={state.snapshots.map((s) => ({ id: s.id, name: s.name \|\| s.id }))}` |
| 设置页供应商行 | `SettingsView.tsx:104-105` `<span className="prow-name" title={p.name}>{p.name}</span>` |
| 托盘标题 | `shared/tray-text.ts:71-80` — **只取百分比/金额，不含名字**（同名不受影响） |

---

## 2. 测试落点（问题 7）

### 注册表读写的既有测试：`scripts/test-adapters.mjs` 的 T 段

`scripts/test-adapters.mjs:758-762`

```
// ═══════════════════════════════════════════════════════════════════════════════
// T. 存储与注册表（store.ts + providers.ts + buildAdapters 路由）
//    —— 这一块此前完全在回归网之外：keystore 绑着 electron，providers 又绑着 keystore
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\nT. 存储、注册表与路由')
```

**注册表一侧已经有回归网了**（文件头 `:23-26` 的注释已过时，说「仍未覆盖」）：

```js
const { createStore } = await loadTs('src/main/store.ts')       // :764
const providers = await loadTs('src/main/providers.ts')          // :765
const { buildAdapters } = await loadTs('src/main/adapters/index.ts')  // :766
```

装配与空表初始化（`:825-828`）：

```js
const regStore = createStore({ filePath: () => joinPath(tmp, 'registry.bin'), crypto: sealedCrypto })
providers.configureProviders(regStore)
// 显式写空表：否则会触发旧模型迁移，而迁移会探测真机文件（opencode auth.json / db）
await regStore.setExtra('providerInstances', '[]')
```

`providers.ts` 之所以能被纯 node 测试加载，是因为它**只依赖 `./store` 与 `./scanner`**，
不 import electron —— `providers.ts:1-8` 的 import 列表可逐条核对。

已有的 T 段断言清单（可直接追加分组用例的位置）：

| 断言 | 位置 | 覆盖 |
|---|---|---|
| T1-T7 | `:784-822` | `store.ts` 存储往返 / 磁盘格式 / 损坏重建 |
| T8 | `:830-835` | `addInstance` 内置预设身份 |
| **T9** | `:836-837` | **`同一预设可重复添加（各自 id、各自凭据）`** ← 同名场景的既有断言 |
| T10 | `:839-854` | `addInstance` 自定义实例 |
| T11-T12 | `:856-860` | `listCatalog` singleton 过滤 |
| T13-T13d | `:862-870` | `instanceInfo` 凭据来源优先级 |
| **T14** | `:873-878` | **`reorderInstances` 拖拽排序** |
| T15-T15c | `:879-883` | `removeInstance` 级联清理 |
| T16+ | `:885-904` | `buildAdapters` 路由 |

测试脚手架 `scripts/lib/load-ts.mjs:26-39`（用 esbuild 打成内存 ESM 再 `import`，
支持 `alias` 把 `electron` 换成替身）。假加密替身 `sealedCrypto` 在 `:774-778`。

### 组纯逻辑该放哪

现状有三条已被验证的落点，按「纯度」排序：

| 落点 | 现有文件 | 纯度 | 既有测试 |
|---|---|---|---|
| **`src/renderer/src/read-model.ts`** | 101 行，零 `window`/`api` import（`:1-2` 只 import types 与 format） | 完全纯函数 | `scripts/test-read-model.mjs`（已在 `npm test` 链 `package.json:31`） |
| `src/shared/*.ts` | `quality.ts` / `percent.ts` / `tray-text.ts` / `pet.ts` | 主进程 + 渲染层 + 测试三方共用 | `test-quality.mjs` / `test-percent.mjs` / `test-tray.mjs` |
| 渲染层内联 | `CardView.tsx:192-197` `reconcileOrder` | ⚠ **不可测** —— .tsx 里的本地函数，没有任何测试文件加载它 | 无 |

`read-model.ts` 的文件头（`:4-13`）说明了它为什么存在，且正是「排序该在哪一层判定」的现成论证：

```
// ═══════════════════════════════════════════════════════════════════════════════
// 供应商快照的读模型：**一个**回答「哪个窗口重要、多严重」的地方
//
// 为什么独立成模块：此前主页卡片、详情页、收起态悬浮球各写了一套 —— 同一个概念四处实现
// （CardLevel / snapLevel / severity / ballLevel，外加两份「主窗口」选择）。阈值与口径
// 分头改就会互相不一致，而且没有一处能被测试直接盯住。
//
// 分工：阈值判定仍在 format.levelOfPercent（...）；这里只决定「拿哪个数去比」「按什么排序」。
// 三处视图都必须从这里取答案。
```

**分组 / 筛选 / 排序的纯逻辑（`groupOf` / `visibleGroups` / `filterByGroup` / `orderGroups`）
形态上与 `speakableSnapshots`（`read-model.ts:84-89`）完全同构**，且它已经是
「一个 id 列表 → 一个过滤后的 snapshots 数组」的先例。

已验证该落点的加载方式（`scripts/test-read-model.mjs:11-15`）：

```js
import { loadTs } from './lib/load-ts.mjs'

const rm = await loadTs('src/renderer/src/read-model.ts')
const { fmtAmount } = await loadTs('src/renderer/src/format.ts')
const { primaryWindow, primaryWindowIndex, worstWindow, maxPercent, snapshotLevel, windowLevel, severityRank, ballLevel, speakableSnapshots } = rm
```

`speakableSnapshots` **已经在解构列表里** —— 分组过滤函数加进 `read-model.ts` 后，
在这个文件里加断言需要**零新基础设施**（不新增测试脚本、不改 `package.json`）。

⚠ 约束：**新增 `src/shared/*.ts` 文件在本仓库有先例上的阻力**。
`src/main/ipc.ts:84-88` 记录了这个模式：

```
 * 两边没有共享模块（文件所有权不许新增 shared 文件），所以由
 * `scripts/test-system-notify.mjs` 静态比对两侧字面量，与 F5 对原因码的处理同套路。
```

`src/main/ipc.ts:259-261` 重复了同一条：

```
 * 码的**字面量在渲染层 speechOut.ts 与这里**各有一份，但由 test-structure.mjs F5 静态
 * 钉住两侧一致 —— 这是「没有共享模块」下防止两份漂移的既有做法（与 E3/E5 同套路）。
 * 文件所有权（implement.md）不许新增 shared 文件，故不抽共享常量。
```

「文件所有权」本身不是 spec 规则，而是各任务 `implement.md` 里的约定
（`.trellis/tasks/archive/2026-09/09-29-*/implement.md:3`）。本任务的
`implement.md` 尚未撰写 → **这条约束对本任务是可协商的**。

### UI 层验证：`--uitest`

父任务 Cross-Child AC 明确要求「每一项都有 `--uitest` 键或等价的可观察断言」
（`.trellis/tasks/10-01-p1-batch/prd.md:55`）。

既有的可观察点范式：

| 关注点 | 位置 | 手法 |
|---|---|---|
| `hideBalance` 往返 | `qa/uitest.ts:703-729` | 读 `getExtras` + 查 DOM class `.amount-hidden`，翻两次断言可还原 |
| 拖拽排序 | `qa/uitest.ts:1910-1971` | 合成 `PointerEvent` 序列；`r.dragNoFlicker` / `r.dragSettles` / `r.dragPersist` |
| 卡片顺序 | `qa/uitest.ts:1920` | `window.api.listProviders().then(p=>p.providers.filter(x=>x.enabled).map(x=>x.id))` |
| 可信度降级渲染 | `qa/uitest.ts:1900-1906` | `window.api.debugPush(fakeSnap(...))` 注入 |

`qa/fixtures.ts` 提供 `demoSnapshot(): unknown[]`（`qa/fixtures.ts:10`）与
`fakeSnap` —— 现成的注入式测试数据源，不必造真实采集。

### `package.json` 的 `test` 链约定

`package.json:33` 的 `test` 是 17 个 `npm run test:*` 的 `&&` 串联。
父任务 PRD `:45` 已定处置：

> **`package.json` 的 `test:` 链** | 四项各自加脚本 | **合并时统一接一次**，子任务提交里先不动 `test` 链，改为在各自 `implement.md` 注明待接

即：本任务**不要改 `package.json`**，在 `implement.md` 里注明待接。
若分组纯逻辑落在 `read-model.ts`，测试可以直接追加进 `scripts/test-read-model.mjs`
（无需新增脚本、无需改 `package.json`）—— 这是冲突面最小的落点。

---

## Caveats / Not Found

- `CardView.tsx` 的拖拽实现没有单元测试覆盖，只有 `--uitest` 的集成级合成事件
  （`qa/uitest.ts:1910-1990`）。引入分组标题行后，那套 `slotRects` / `dragStyleFor`
  假设的回归验证只能靠 `--uitest`，没有更细的落点。
- `qa/fixtures.ts` 的 `demoSnapshot()` 返回 `unknown[]`，与 `ProviderSnapshot` 的类型关系未验证。
- 未找到任何 i18n / 多语言机制；所有 UI 文案是硬编码中文字符串，新增分组文案沿用即可。

## 相关 spec

- `.trellis/spec/frontend/state-management.md:170` — `ui:cardWindow:<id>` per-provider 键的先例
- `.trellis/spec/frontend/state-management.md:333` — 「一个非 `ui:` 键触发全量重采集」的判据表
- `.trellis/spec/frontend/quality-guidelines.md:137-142` — 纯函数模块的判据（无 three / 无 DOM / 无 React）
- `.trellis/spec/frontend/quality-guidelines.md:208` — 测试文件与覆盖面的登记方式
- `.trellis/spec/frontend/hook-guidelines.md:65-66` — props 注释要写明对应的 `ui:` 键
- `.trellis/spec/frontend/component-guidelines.md:103-104` — 「有持久化键的 prop 要在注释里写出键名」
