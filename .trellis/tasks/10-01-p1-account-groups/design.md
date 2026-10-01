# Design: P1-4 多账户分组管理

## 调研结论（已核实）

| 问题 | 结论 |
|---|---|
| `ui:hideBalance` 能抄吗 | **不能，它是反面教材**。spec 自己标注 `'1'`/`''` 编码「differs from every other boolean — don't copy」（`state-management.md:161`）。应抄 `ui:voiceMuted` |
| 同名账号现在能区分吗 | **完全不能**。`mark = inst.presetId \|\| inst.protocol`（`bind-instance.ts:27`）—— 同一预设的两条实例**连 logo 都一样**。而 `CardView` 只拿 `ProviderSnapshot`，它**不含** `baseUrl`/`presetId`/`protocol`（`types.ts:56-86` vs `ProviderInfo:89-110`）→ 区分信息拿不到，必须跨进程取数 |
| 组间顺序有落点吗 | **没有**。注册表只有一个数组、`extras` 是扁平 `Record<string,string>`、`providers:reorder` 入参形状已被 `ipc.ts:175` 守卫写死。这是本任务最大的**结构性新增** |
| 性能是问题吗 | **不是**。`getExtra` 有内存 memoize（`store.ts:42-43`）→ 每轮采集 0 次磁盘读。但 `setExtra` 是**无条件整文件重写**，分组写入要照抄 `reorderInstances:348` 的「无变化不写」守卫 |
| 测试落点 | **零成本**。`scripts/test-read-model.mjs:13-15` 已 `loadTs('read-model.ts')` 且已解构 `speakableSnapshots` → 分组纯逻辑放 `read-model.ts`，**不新增测试脚本、不改 `package.json`** |

## 用户已拍板的三个语义

1. **隐藏分组 = 只不展示**（黑名单语义，照抄 `ui:voiceMuted`），**不是**停止采集。
   切回零延迟；代价是隐藏的账户仍消耗一次采集配额。
2. **组是用户自由标签**（可自建任意组），不是固定枚举。
3. **托盘优先级取全局第一位**（与 `tray-text.ts:6-7` 现有的「卡片顺序第一位」契约一致），
   不引入「当前可见组第一位」的第二套优先级。

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ providers 注册表（src/main/providers.ts）                            │
│   ProviderInstance 增字段: groupId?: string（**缺省 = 未分组**）      │
│   持久化：沿用现有 store（.map() 归一化迁移先例）                    │
└──────────────┬─────────────────────────────────────────────────────┘
               │ providers:list 已返回 ProviderInfo（增 groupId）
               ▼
┌────────────────────────────────────────────────────────────────────┐
│ App.tsx（只改这一层）                                                │
│   · 分组下拉（从 instanceInfo 去重出的组名）                          │
│   · 当前可见 id 集合 = 读 ui:groupHidden（黑名单 JSON）              │
│   · 传给 CardView 的列表按「组 + 组内顺序」排                         │
└──────────────┬─────────────────────────────────────────────────────┘
               ▼
┌────────────────────────────────────────────────────────────────────┐
│ read-model.ts（纯函数，零成本落点 —— 测试脚本已 loadTs 它）            │
│   groupNames(info[])      → 去重后的组名 + '未分组' 兜底             │
│   visibleIds(info[], hidden) → 可见实例 id 集合                       │
│   orderForDisplay(info[], order[], hidden) → 排序后的 id 列表         │
└────────────────────────────────────────────────────────────────────┘
```

## Technical Decisions

### D1 · 隐藏 = 只不展示（用户决策 1），语义照 `ui:voiceMuted`

`ui:voiceMuted`（`state-management.md` 键表）是「不要**念**给我听」——
采集照跑，只是不参与播报。分组的「隐藏」正是同一件事：不显示，但继续采集。

**为什么不复用 `enabled: false`**：那是「停用这个供应商」，会**停止采集**。
代价有两处：切回时要等一轮采集完成才有数据；而且这段时间的历史会断掉，
P1-1 的趋势图会出现空档（而我们刚做完「缺样本不补 0」，那个空档是有意义的信号）。

存储：`ui:groupHidden`，JSON 数组的**分组 id**（不是实例 id —— 隐藏整个组才是需求）。
读侧判「键缺失」只能用 `!v`（`extras:get` 对缺失键返回 `''`）。

### D2 · 组是自由标签；组名存哪（用户决策 2）

用户自由标签意味着要有增删改。但**组本身不需要独立的存储**：

- 分组的**定义**就是「哪些实例的 `groupId` 等于这个字符串」；
- 组名 = 现有实例 `groupId` 的去重集合 + 一个 `'未分组'` 兜底（`groupId` 缺省的那些）。

**决策**：不建「组注册表」。删掉一整组 = 把那些实例的 `groupId` 清空。
这样少一份要同步的真相源（组列表 vs 实例列表），少一处会不一致的地方。

代价：空组（所有成员都被删了）会自然消失 —— 这是对的，「有成员才有组」。

### D3 · `ProviderInstance` 只增一个可选字段 `groupId?: string`

不新建表、不加索引、不改 `providers:reorder` 的入参形状
（`ipc.ts:175` 的守卫写死了它是 `string[]`）。

迁移沿用既有先例：注册表读出来时用 `.map()` 归一化（旧实例补 `groupId: ''`）。
与 `petState` 的 `encodePetState` 版本化迁移同一手法。

⚠ **不存组序**（见 D4）。

### D4 · 组间顺序 = 实例数组的下标顺序（不新增维度）

调研指出「组间顺序在现有数据模型里没有落点」——注册表只有一个数组，
拖拽排序改的是数组顺序。

**决策**：**组间顺序就是该组第一个成员在数组里的位置**。
用户在卡片列表里拖出来的顺序天然隐含了组的顺序（把 A 组的卡片拖到 B 组前面，
A 组就在 B 组前面）。这样：

- 不需要「组序」这个新的持久化维度；
- `providers:reorder` 的入参形状不变，`ipc.ts:175` 的守卫不用改；
- 组内顺序也是同一条数组顺序。

代价：组的顺序**依赖成员**，当某组最后一个成员被移走时，该组的位置按剩下的成员重算。
这是可接受的（组本来就是为了「把这些放一起」，位置是次要的）。

### D5 · 同名多账号的区分：区分信息必须跨进程取（调研的核心发现）

`CardView` 只拿 `ProviderSnapshot`，它**不含** `baseUrl`/`presetId`/`protocol`，
而 `mark` 在同一预设下完全相同 —— 现在两家公司同名账号**连 logo 都一样**。

**决策**：扩展 `ProviderSnapshot`？**不** —— 那是主进程→渲染层的公共类型，
加字段会让 9 个适配器都要考虑它。

改为：`providers:list` 的 `ProviderInfo` 增一个 `distinguishKey`（如 `baseUrl` 的 host），
`App.tsx` 渲染卡片时把它作为 `ProviderMark` 的**副标题**（名称后缀）传下去。
`ProviderInfo` 本来就是「实例的身份」类型，加字段是它的本职。

⚠ 卡片名后缀要**可辨识但不喧宾夺主**：`Claude 公司` / `Claude 个人`。

### D6 · 托盘取全局第一位（用户决策 3）

`tray-text.ts:6-7` 的文件头契约是「卡片顺序第一位」。分组**不改变**这个语义 ——
隐藏只是不显示，而托盘反映的是全部账户里排序第一的那家。

**这带来一个必须想清楚的后果**：如果排序第一的那家被隐藏了，托盘显示的是**第二家**。
这是正确的（托盘必须反映真实风险），但意味着「隐藏公司账户」时托盘内容会变。
**必须在设置页文案里说清**：「隐藏只影响列表显示，托盘与提醒仍覆盖全部账户」。

否则用户会以为隐藏了公司账户就收不到它的额度告警 —— 而实际上（且应该）仍然收得到。

## Contracts

### shared/types.ts

```ts
export interface ProviderInstance {
  // …现有 9 字段不变
  /** 分组 id（组名本身）；缺省 / 空串 = 未分组。新增可选字段，不做版本号 */
  groupId?: string
}
export interface ProviderInfo {
  // …现有字段不变
  /** 同名多账号的区分依据（如 baseUrl 的 host）；缺省 = 无需区分。新增可选字段 */
  distinguishKey?: string
}
export interface ProviderSnapshot {
  // 不变 —— ⚠ 刻意不加 distinguishKey（9 个适配器都不该关心它）
}
```

### renderer/read-model.ts（新增三个纯函数，零成本落点）

```ts
/** 去重后的分组 id 列表（升序），**含** '未分组' 当有实例无 groupId */
export function groupNames(info: ProviderInfo[]): string[]
/** 未分组桶的 id（渲染与存储都不能让用户看到空字符串当组名） */
export const UNGROUPED = '未分组'

/** 可见实例 id：不在 hidden 列表里的。hidden 存的是**组 id** */
export function visibleIds(info: ProviderInfo[], hiddenGroupIds: string[]): Set<string>

/** 展示顺序：组间按「组首成员在数组里的位置」，组内按数组顺序 */
export function orderForDisplay(info: ProviderInfo[], hiddenGroupIds: string[]): string[]
```

### extras 键

| 键 | 编码 | 说明 |
|---|---|---|
| `ui:groupHidden` | `JSON.stringify(string[])` | 隐藏的**组 id** 列表。缺省 = 全部显示。**只读不写迁移**（无旧键） |

### preload 新增

```ts
setInstanceGroup: (id: string, groupId: string): Promise<ProvidersPayload>
```

## Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| `groupId` 缺省 / 空串 | 归入 `UNGROUPED` 桶（**不显示空组名**） |
| 组名超长 / 含控制字符 | 写入前截断到 32 字符并剥控制字符（会进 SVG/托盘文案） |
| 隐藏列表里有已不存在的组 id | 忽略（读侧过滤，**不清理** —— 清理是写侧的事） |
| 隐藏列表里有 `UNGROUPED` | 允许（用户可以「隐藏所有未分组的」） |
| 全部组被隐藏 | 列表显示空态，**托盘仍显示全局第一家的用量**（D6 的必然结果） |
| 实例被删除 | 组名去重时自动消失（D2 的空组语义） |
| 同名账号无 `distinguishKey` | 卡片名**不加后缀**（与今天一致，不制造「(2)」这类假区分） |

## Good / Base / Bad Cases

- **Good**：5 个实例分「公司 / 个人」两组。隐藏「公司」→ 卡片列表只剩 3 个个人账户；**托盘仍反映全部 5 家里最紧张的那家**；设置页文案已说明这一点。
- **Base**：所有实例都未分组。`groupNames` 返回 `['未分组']`，下拉只有一个选项。**界面与今天的行为一致** —— 新功能不该让老用户看到一个只有一项的下拉就算「变了」。
- **Bad**：隐藏组后托盘也只看可见的那几家。用户以为公司账户的额度告警被关掉了，实际收不到 —— 直到某天额度爆了才发现。**这就是设置页必须写明那句话的原因**。

## Tests Required

扩展 `scripts/test-read-model.mjs`（已 `loadTs('read-model.ts')`，**不新增脚本、不改 `package.json`**）：

1. `groupNames`：去重 + 升序 + 含 `UNGROUPED`；全未分组时只有一项
2. `visibleIds`：隐藏组内所有成员都被排除；隐藏 `UNGROUPED` 只排除无 groupId 的
3. 隐藏列表含不存在的组 id → 不影响结果（不抛）
4. `orderForDisplay`：组间按组首成员位置、组内按数组顺序
5. 组最后一个成员被移走 → 组位置按剩余成员重算（D4 的代价，钉住它）
6. 全部隐藏 → 返回空数组（**不抛**）
7. **纯度**：入参 `info` 数组未被就地修改（深比较）
8. 静态守卫：`read-model.ts` 内 `groupNames` / `visibleIds` / `orderForDisplay` 各只声明一次

`--uitest`：
9. 分组下拉出现且列出正确的组名；切到某组后卡片列表只剩该组成员
10. 隐藏组后**卡片列表**变化，但**托盘标题不变**（D6 的行为断言）
11. 同名两账号的卡片名带不同 `distinguishKey` 后缀

## Wrong vs Correct

#### Wrong
把分组做成注册表里的一张「组」表（独立 id、组序字段）：

- 两份真相源（组列表 + 实例的 groupId）必然在某次编辑后不一致，
  而不一致的表现是「界面显示两组、实际渲染出 7 个卡片」；
- 组序要新增一个持久化维度并拖进 `providers:reorder` 的入参形状
  （`ipc.ts:175` 的守卫写死了 `string[]`），改动面比省下的多。

#### Correct
分组就是「实例 `groupId` 字段的取值集合」，组名 = 去重结果 + 未分组兜底。
组序 = 组首成员在数组里的位置。一份真相源，`reorder` 入参形状不变。