# Design: 面板按组分块展示

## Architecture

```
改动前                              改动后
─────────────────────────────       ─────────────────────────────
titlebar: [badge 标题 grp-select   →  titlebar: [badge 标题 …buttons]
           eye refresh]                        （select 删除）

body:                               body:
  ordered.flatMap → 单个 .pcard-grid →  groups.map → <section>
                                       ├─ 组头（组名 + 计数）
                                       └─ .pcard-grid（该组卡片）
```

## Technical Decisions

### D1 · 分块 = 渲染切分，排序逻辑不动

`shown.key()` 的"组序 × 组内拖拽序"合成键已经给出全序。分块只是在渲染时按
`groupOfId(s.id)` 把 `ordered` 切成若干段，**不改任何排序代码**。
`ordered` 的 useMemo、`reconcileOrder`、`orderForDisplay` 调用全部保留——
动排序等于动拖拽，风险不对等。

未知实例（`groupOfId` 返回空串）：归入未分组段末尾（`key()` 已让它们排最后，
切分时把空串 key 映射到 UNGROUPED 段即可，排序天然一致）。

### D2 · 组顺序复用 `groupNames`，不另起顺序源

`groupNames(instanceInfo)` 返回"自定义组升序 + 未分组末尾"。分块顺序直接用它——
第二个顺序源就是第二个真相源（design.md D2 的教训：组是成员的去重集合）。
`App.tsx` 的 `groups` memo 与 `groups` prop 随筛选管线一并删除，
CardView 内按需调用 `groupNames`（已 import，无需新增依赖）。

### D3 · 跨块拖拽语义：维持现状（组优先，不改变归属）

现状 `key()` 组优先：跨组拖拽提交的全局 order 会被组序"拉回"，视觉上弹回原组。
分块后几何仍可用（槽位按 DOM 顺序取，天然跨块），语义与改动前**逐字一致**。
"拖到别组即改 groupId"是另一个功能（需写注册表 + 采集侧语义），**明确不在本任务内**。
title 里的"拖拽调整顺序"文案保留，不用改（没承诺跨组）。

### D4 · 点不动根因的处置：删除即修复，不单修 CSS

根因是 `.grp-select` 缺 `no-drag`（标题栏 drag 区吞点击）。本任务删除该控件，
根因随之消除——**不需要**补 no-drag。但要留一条守卫意识：
标题栏新增任何交互控件必须补 `no-drag`（IconButton 已有，uitest 不覆盖此条，
靠 code review）。本任务不新增标题栏控件，此条仅记录。

### D5 · 组内卡片去标签，aria 保留组名

分块后组内每卡都打组名 = 视觉噪音。删除 `BalanceCard`/`PlanCard` 渲染中的
`GroupTag` 调用（`GroupTag` 组件本身可删——确认无他处引用后删，避免死代码）。
aria-label 的 `（${group}）` 后缀保留：读屏用户逐卡浏览时仍需组上下文，
且未知实例（空串）本来就不读组名，诚实性不受影响。

### D6 · 筛选管线删除清单（逐项，漏一项就是死代码）

CardView 内：
- `groupFilter` / `groups` / `onSetGroupFilter` props（含类型注释）
- `ALL_GROUPS_VALUE` / `ALL_GROUPS_LABEL` 常量及撞名防护注释块（控件没了，防护无对象）
- `effFilter` / `selectValue`（`ALL_GROUPS` import 若无他用一并删）
- `hidden()` 的筛选条件 → 恒 false（未知实例显示语义保留，见 D1；
  函数体可简化为 `() => false`，但保留"注册表有才筛"的注释行——
  将来若加回筛选，解开位置明确）
- `.grp-filter` 下拉 JSX（含那段单选语义注释）
- "分组已全部隐藏"空态分支（含 `empty-cta` 的回全部按钮）

App.tsx 内：
- `groupFilter` state + `applyGroupFilter`（含"无变化不写"注释块）
- `groups` memo + 传给 CardView 的两个 props
- `useEffect` 恢复 `ui:groupFilter` 的那一行（`setGroupFilter(e[...]...)`；
  整个 extras 恢复 effect 保留，只删这一行。存量键残留磁盘，读都不读，无害）

⚠ 不要动：`prow-group`（设置页归组下拉，另一功能）、`reorderProviders`、
`winPrefs`/`selectWindow`（卡片窗口偏好，与分组无关）。

### D7 · 空态只剩一种

`configured.length === 0` → "还没有配置供应商"（保留）。
`ordered.length === 0 && effFilter !== ALL_GROUPS` 分支删除。
`ordered.length === 0` 兜底分支：分块后理论不可达（无筛选即 ordered==configured），
但保留（它是"判据漏条件时的中性兜底"，删了等于拆安全网——注释里已写清此理）。

### D8 · uitest P1-4 段重写（必须同步，范围最大的一块）

删除键（控件没了，断言必红）：`grpSelect`、`grpOptions`、`grpSentinelDistinct`、
`grpFilterStored`、`grpFilterCards`、`grpFilterTrayStable`、`grpFilterNoRecollect`、
`grpEmptyState`、`grpEmptyRestore`、`grpEmptyFilterCleared`。
保留并改写：`grpSetup`（夹具不变）、`grpFixtureCard`、`grpGroupTag`（改断"组内无标签、
组头有组名"）、`grpDup*`（同名区分与筛选无关，保留；注释里"筛选"字样顺手改）。
新增键：`grpSections`（块数=组数+未分组？= fixtures 组集合）、
`grpSectionOrder`（未分组末尾）、`grpSectionCounts`（组头计数与实际卡数一致）、
`grpUngroupedBucket`（未分组实例进兜底块）。
`ui:groupFilter` 存量写入的探针步骤删除（不再有写入路径）。

⚠ 段首注释块（2185-2268 的时序假设说明）保留有效的部分，只改"筛选"相关表述。
行号会大变，改完跑全段实机验证（`--uitest` 测的是 `out/`，改完先 build——本会话踩过）。

### D9 · CSS：新增组头，删除 select，勿碰 prow

新增（沿用现有变量，无新色值）：
```css
.pcard-section { margin-bottom: 14px; }
.pcard-section-head { 组名 + 计数，沿用 --fg-dim 11px 风格，与 titlebar 字号体系一致 }
.pcard-section-head .count { 计数弱化，不抢卡片视觉 }
```
删除：`.grp-filter` / `.grp-filter .grp-select` / `:focus` 三段（约 1347-1366）。
⚠ `.prow-group`（1311-1345）是设置页归组下拉，**不动**（skins.css:1307 注释警告过构建不报错只丢排版）。

## Contracts

### CardView props 变更

```tsx
// 删除：groupFilter, groups, onSetGroupFilter
// 保留：state, hideBalance, onToggleHideBalance, onOpen, onRefresh, onSettings,
//       onCollapse, instanceInfo
```

### App.tsx 调用点变更

```tsx
// 删除：groupFilter state, applyGroupFilter, groups memo,
//       <CardView groupFilter groups onSetGroupFilter> 三个 prop,
//       extras 恢复 effect 中的 setGroupFilter 行
```

### 分块渲染形状

```tsx
{sections.map(({ group, cards }) => (
  <section key={group || UNGROUPED} role="group" aria-label={group || UNGROUPED}>
    <div className="pcard-section-head">{group || UNGROUPED}<span className="count">{cards.length}</span></div>
    <div className="pcard-grid" data-group={group || UNGROUPED}>…cards…</div>
  </section>
))}
```

⚠ 拖拽几何按 `[data-card-id]` 全局取（slotRects 不变），`gridRef` 改挂到外层容器
（ref 只有一个，挂在 body-scroll 内容根上；FLIP 的 querySelectorAll 全局查，
跨块 FLIP 天然可用）。

## Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| 只有未分组实例 | 单块"未分组"，无自定义组头 |
| 快照有、注册表无的 id | 显示在未分组块末尾，无标签 |
| `ui:groupFilter` 存量非空 | 忽略，显示全部 |
| 组被删光成员 | 组头自然消失（组是去重集合，无残留） |
| 拖拽跨块后松手 | 组序拉回原组（与改动前一致，不改变归属） |

## Good / Base / Bad Cases

- **Good**：两组 + 未分组 → 三块，组头计数与卡数一致，拖拽组内有效。
- **Base**：单组/无组 → 退化为现状单网格视觉（只有一个组头，多一行组头是可接受代价）。
- **Bad**：删 select 却留 `ui:groupFilter` 读取 → 存量用户打开面板只剩一组的卡。
  守卫是"删除清单 D6 全执行 + uitest grpSections 断言全量"。

## Tests Required

1. **uitest P1-4 段重写**（D8 键清单），实机全绿。
2. **静态守卫**：`grp-select` 在 `src/renderer/` 零出现；`groupFilter` 在
   `src/renderer/` 零出现（存量 extras 键是主进程侧字符串，不在此列）；
   `ui:groupFilter` 在 `src/renderer/` 只允许出现在注释里。
3. **反验**：任一删除项回退 → 对应 uitest 键必须红。
4. **回归**：`npm test` / `typecheck` / 全量 uitest。

## Wrong vs Correct

#### Wrong
只给 select 补 `no-drag` 交差，分块不做：

- 点不动是修好了，但用户要的是"一眼看到各组"，下拉筛选一次只能看一组——
  需求本身没被满足，修的是表象。
- 且保留筛选 = 保留 effFilter/哨兵/空态三套易错机制，维护成本不变。

#### Correct
删除筛选、按块展示：控件消失则点不动无从谈起，筛选机制的三套防护代码
（哨兵撞名/空串 value/回落）随之退役，.testing 只剩分块断言。
