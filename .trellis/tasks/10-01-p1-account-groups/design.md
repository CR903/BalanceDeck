# Design: P1-4 多账户分组管理

## 调研结论（已核实）

| 问题 | 结论 |
|---|---|
| `ui:hideBalance` 能抄吗 | **不能，它是反面教材**。spec 自己标注 `'1'`/`''` 编码「differs from every other boolean — don't copy」（`state-management.md:161`）。应抄 `ui:voiceMuted` |
| 同名账号现在能区分吗 | **完全不能**。`mark = inst.presetId \|\| inst.protocol`（`bind-instance.ts:27`）—— 同一预设的两条实例**连 logo 都一样**。而 `CardView` 只拿 `ProviderSnapshot`，它**不含** `baseUrl`/`presetId`/`protocol`（`types.ts:56-86` vs `ProviderInfo:89-110`）→ 区分信息拿不到，必须跨进程取数 |
| 组间顺序有落点吗 | **没有**。注册表只有一个数组、`extras` 是扁平 `Record<string,string>`、`providers:reorder` 入参形状已被 `ipc.ts:175` 守卫写死。这是本任务最大的**结构性新增** |
| 性能是问题吗 | **不是**。`getExtra` 有内存 memoize（`store.ts:42-43`）→ 每轮采集 0 次磁盘读。但 `setExtra` 是**无条件整文件重写**，分组写入要照抄 `reorderInstances:348` 的「无变化不写」守卫 |
| 测试落点 | **零成本**。`scripts/test-read-model.mjs:13-15` 已 `loadTs('read-model.ts')` 且已解构 `speakableSnapshots` → 分组纯逻辑放 `read-model.ts`，**不新增测试脚本、不改 `package.json`** |

## 用户已拍板的语义（三项，其中第 1 项于 2026-10-01 修订）

1. **筛选分组 = 只不展示**（**单选**筛选器：点某一组 = 只看它，「全部」= 都看），
   **不是**停止采集。切回零延迟；代价是被筛掉的账户仍消耗一次采集配额。
   （原为黑名单语义，见 D1 的重写说明。）
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
               │ providers:list 已返回 ProviderInfo（增 groupId / distinguishKey）
               ▼
┌────────────────────────────────────────────────────────────────────┐
│ App.tsx（只改这一层）                                                │
│   · 分组下拉（从 instanceInfo 去重出的组名）                          │
│   · 当前筛选值 = 读 ui:groupFilter（裸组名字符串，'' = 全部）         │
│   · 传给 CardView 的是筛选值，不是可见 id 集合（判定在 read-model）   │
└──────────────┬─────────────────────────────────────────────────────┘
               ▼
┌────────────────────────────────────────────────────────────────────┐
│ read-model.ts（纯函数，零成本落点 —— 测试脚本已 loadTs 它）            │
│   groupNames(info[])          → 去重后的组名 + '未分组' 兜底         │
│   visibleIds(info[], group)   → 该组的实例 id 集合（'' = 全部）        │
│   orderForDisplay(info[], group) → 排序后的 id 列表（组序 ⨯ 组内序）  │
└────────────────────────────────────────────────────────────────────┘
```

## Technical Decisions

### D1 · 筛选 = 只显示选中组（用户决策 1 于 2026-10-01 修订）

**原设计是「点组 = 藏它」（黑名单 `ui:groupHidden`），用户改为「点组 = 只看它」（单选筛选器）。**
本节已按新语义重写，末尾保留原设计的取舍理由供回看。

存储：`ui:groupFilter`，**单个组 id 的字符串**，空串 = 全部（哨兵 `ALL_GROUPS = ''`，
不另造 `'ALL'` 字面量 —— `extras:get` 对未写过的键也返回空串，两个状态合成一个）。
读侧判「键缺失」用 `e[k] || ALL_GROUPS`（**非 `== null`**：`extras:get` 对未写过的键
返回 `''`，`== null` 恒为假，这坑本仓库踩过两次）。

**为什么不复用 `enabled: false`**：那是「停用这个供应商」，会**停止采集**。
代价有两处：切回时要等一轮采集完成才有数据；而且这段时间的历史会断掉，
P1-1 的趋势图会出现空档（而我们刚做完「缺样本不补 0」，那个空档是有意义的信号）。

⚠ **语义变更的代价**：单选筛选器**无法表达「同时藏起 A 和 B，但要看 C」**。
用户若要「只看 C」，必须理解「筛选 = 只看它」而不是「藏起它」。
这是用户明确选择的心智模型（产品原话：「点组 = 只看它」），不是实现偷懒。

**旧键处理**：`ui:groupHidden` **不再读写**。它已写入过的用户配置留在 extras 里不动
（照 `ui:voiceGender` 的处置先例：不再读也不再写，旧值留着无害）——
新读侧完全忽略它，因此不需要数据迁移。

### D1b · 空态必须区分「筛空了」与「本来没卡片」（2026-10-01 uitest 发现的真 bug）

原实现：`ordered.length === 0` 就渲染「分组已全部隐藏」+「显示全部分组」按钮。

**问题**：`ordered` 为空有两个原因 ——
① 筛选值非空且把所有组都筛掉了（该显示这个空态）；
② **本来就没有卡片可显示**（首帧 IPC 未返回 / 采集失败 / 快照 id 与实例 id 对不上）。
②会**谎报**状态，而且那个按钮点了没用（筛选值本来就是「全部」，清空它没有变化）。

**决策**：判据从 `ordered.length === 0` 收紧为
`ordered.length === 0 && groupFilter !== ALL_GROUPS`（实现里用的是 `effFilter`，
即已经做过「组已消失 → 回落全部」的那个值 —— 排序与空态判据必须用**同一个**值，
否则会出现「下拉写着 A 组、列表却是全部」）。
②走中性空态（与「还没有配置供应商」同款措辞），**不渲染那个恢复按钮**。

**这是第二道防线，不是第一道。** 真正把 ② 与 ① 分开的是 `hidden` 谓词：
`hidden = byId.has(id) && !inDisplay.has(id)` —— 只筛「注册表里有、且被筛选排除掉」的 id。
「快照有、注册表里查不到的 id」（`debugPush` 注入、首帧 IPC 竞态）**根本不该算「被筛掉」**：
我们不知道它属于哪一组，凭什么替用户把它藏起来？第一版写成 `!inDisplay.has(id)` 时，
实机 `--uitest` 的 `cachedCard` / `cachedBanner` / `localChip` 三条一起红，
而界面上只表现为「卡片全没了 + 空态谎称『分组已全部隐藏』」。

> 这与「`instanceInfo` 未到手时一律不过滤」（F1 的修法）是同一条纪律的两面：
> **「什么都看不到」有两种原因，而用户看到的措辞必须诚实地区分它们** ——
> 否则界面就在说一件不成立的事，且给出的补救动作无效。

### D5b · 卡片上渲染组名标签（用户决策 5 于 2026-10-01 新增）

组名标签与 `distinguishKey` 后缀是**两件不同的事**，不能混：
- **后缀**区分「同名供应商的**不同实例**」（`Claude 公司` / `Claude 个人`）
- **组名标签**表达「这个账户属于**哪一组**」（它可能是「公司」也可能是「个人」）

⚠ 两者会同时出现在一张卡上（`Claude 公司` + 标签「公司」）—— 这看起来冗余，
但它们回答的是不同问题，且同名实例**可能同组**（那就只有后缀，没有标签差异）。
标签用 `.pcard-group` 小字样式，不与名称抢视觉层级。

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
`App.tsx` 侧由 `distinguishSuffixes()` 决定**哪些实例**需要后缀，再经 `CardView` 的
`displayName(s.name, suffix)` 渲染进卡片标题行的名称。`ProviderInfo` 本来就是
「实例的身份」类型，加字段是它的本职。

⚠ 后缀只在**同名 ≥2 家**时才加（只有一个 Claude 账号时把 host 拼到名字后面纯属噪音），
且**缺区分依据的那家仍然不加**（`read-model.ts` 的 `distinguishSuffixes` 注释记了理由）。

⚠ 卡片名后缀要**可辨识但不喧宾夺主**：`Claude 公司` / `Claude 个人`。

### D6 · 托盘取全局第一位（用户决策 3）

`tray-text.ts:6-7` 的文件头契约是「卡片顺序第一位」。分组**不改变**这个语义 ——
筛选只是不显示，而托盘反映的是全部账户里排序第一的那家。

**这带来一个必须想清楚的后果**：如果排序第一的那家被筛掉了，托盘显示的是**第二家**。
这是正确的（托盘必须反映真实风险），但意味着「筛选公司账户」时托盘内容会变。
**必须在设置页文案里说清**：「筛选只影响列表显示，托盘与提醒仍覆盖全部账户」。

否则用户会以为筛掉了公司账户就收不到它的额度告警 —— 而实际上（且应该）仍然收得到。

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

### renderer/read-model.ts（三个纯函数，零成本落点）

```ts
/** 「全部」的哨兵值。空串而不是 'ALL' —— 空串在 extras 里天然表达「没写过」 */
export const ALL_GROUPS = ''
/** 去重后的分组 id 列表（升序），**含** UNGROUPED 当有实例无 groupId */
export function groupNames(info: ProviderInfo[]): string[]
/** 未分组桶的 id（渲染与存储都不能让用户看到空字符串当组名） */
export const UNGROUPED = '未分组'

/** 筛选后的实例 id 集合。`group` 为 ALL_GROUPS 时返回全部（单选筛选器语义） */
export function visibleIds(info: ProviderInfo[], group: string): Set<string>

/** 展示顺序：组间按「组首成员在数组里的位置」，组内按数组顺序 */
export function orderForDisplay(info: ProviderInfo[], group: string): string[]
```

### extras 键

| 键 | 编码 | 说明 |
|---|---|---|
| `ui:groupFilter` | 裸字符串（组 id，或 `''` = 全部） | 当前筛选值。**取代** `ui:groupHidden` |
| ~~`ui:groupHidden`~~ | — | **不再读写**。已写入的残留值留在 extras 里不动（`ui:voiceGender` 同款处置） |

### preload 新增

```ts
setInstanceGroup: (id: string, groupId: string): Promise<ProvidersPayload>
```

## Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| `groupId` 缺省 / 空串 | 归入 `UNGROUPED` 桶（**不显示空组名**） |
| 组名超长 / 含控制字符 | 写入前截断到 32 字符并剥控制字符（会进 SVG/托盘文案） |
| 筛选值指向已不存在的组 | 读侧**回落「全部」**且不回写（`CardView` 的 `effFilter`；组会随最后一个成员被删而消失，见 D2）。⚠ 纯函数 `visibleIds` 本身返回**空集**而不回落 —— 回落是渲染层的判断，它手里有下拉选项列表能证明那个组确实没了 |
| 筛选值为 `UNGROUPED` | 允许（用户可以「只看未分组的」） |
| **选中组里一张能显示的卡都不剩** | 显示「分组已全部隐藏」空态 + 恢复按钮；**托盘仍显示全局第一家的用量** |
| **本来就没有卡片（筛选=全部 但仍为空）** | **中性空态，不谎称「分组已全部隐藏」，不渲染恢复按钮**（D1b） |
| **快照有、`instanceInfo` 里查不到的 id** | **照样显示**，且**不渲染组名标签**（`hidden = byId.has(id) && !inDisplay.has(id)`、`GroupTag` 空串返回 null）—— 我们不知道它属于哪一组，不替用户断言 |
| `instanceInfo` 未到手 | 一律不过滤（渲染骨架），**不**显示任何空态（F1 的修法） |
| 实例被删除 | 组名去重时自动消失（D2 的空组语义） |
| 同名账号无 `distinguishKey` | 卡片名**不加后缀**（与今天一致，不制造「(2)」这类假区分） |
| 同名账号**同组** | 后缀与组名标签都显示（两者回答不同问题，见 D5b） |
| 组名恰好叫「未分组」 | 与 `UNGROUPED` 兜底桶**合并**（D2 的既定语义；已知遗留，未加防护） |

## Good / Base / Bad Cases

- **Good**：5 个实例分「公司 / 个人」两组。筛选「公司」→ 卡片列表只剩 2 个公司账户；**托盘仍反映全部 5 家里排序第一位的那家**，且**采集与提醒照跑**（被筛掉的 3 个个人账户仍在采样，趋势图不断档）；设置页文案已说明这一点。
- **Base**：所有实例都未分组。`groupNames` 返回 `['未分组']`，下拉只有一个选项。**界面与今天的行为一致** —— 新功能不该让老用户看到一个只有一项的下拉就算「变了」。
- **Bad**：筛选也接到了采集或托盘上。用户以为筛掉公司账户就收不到它的额度告警，实际收不到 —— 直到某天额度爆了才发现。**这就是设置页必须写明那句话、且主进程不许读 `ui:groupFilter` 的原因**（静态门 `test-read-model.mjs` J9/J10）。

## Tests Required

扩展 `scripts/test-read-model.mjs`（已 `loadTs('read-model.ts')`，**不新增脚本、不改 `package.json`**）。
⚠ 断言编号在返工时整体重排过（黑名单 → 单选），**以 `test-read-model.mjs` 里的实际编号为准**：

1. `groupNames`：去重 + 升序 + 含 `UNGROUPED`；全未分组时只有一项
2. `visibleIds`：**选中某组 → 只返回该组成员**（不是取反）；选中 `UNGROUPED` 只返回无 `groupId` 的
3. 筛选值指向**已不存在**的组 → 返回空集（**不抛、不回落**，回落是渲染层的判断）
4. `orderForDisplay`：组间按组首成员位置、组内按数组顺序
5. 组最后一个成员被移走 → 组位置按剩余成员重算（D4 的代价，钉住它）
6. `ALL_GROUPS`（空串）时返回全部 / 空数组都**不抛**
7. **纯度**：入参 `info` 数组未被就地修改（深比较）
8. 静态守卫：`read-model.ts` 内 `groupNames` / `visibleIds` / `orderForDisplay` / `groupOf`
   / `distinguishSuffixes` / `displayName` 各只声明一次；不 import electron、不碰 DOM
9. **跨层边界守卫（J5–J20）**：判缺失用 `|| ALL_GROUPS`（非 `== null`）、写侧存裸字符串、
   读侧完全不提 `ui:groupHidden`、主进程不读 `ui:groupFilter`、设置页写明那句语义、
   空态判据含 `effFilter !== ALL_GROUPS`、`hidden` 带 `byId.has(id)`、`effFilter` 有回落、
   组名标签两种卡型都传下去、查不到实例不渲染标签、哨兵 value 含控制字符、
   哨兵→存储的映射只在 onChange 一处

`--uitest`（分组段**自建夹具**，不依赖用户机器上已有分组）：
10. 分组下拉存在、选项与注册表现算结果一致、哨兵不与真实组名撞名
11. 卡片上渲染所属组名标签（`grpGroupTag` / `grpDupGroupTag`，未分组显示「未分组」）
12. 选中某组后卡片列表只剩该组成员、存储里就是这一个组名、**托盘标题不变**、
    **`lastSync` 不变**（筛选不重发采集请求）
13. 筛到一张卡都不剩 → 「分组已全部隐藏」空态 + 一次点回全部
14. 同名两账号的卡片名带不同 `distinguishKey` 后缀（`grpDupCardName`）
15. 夹具清理干净（`grpDupCleanup`）

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