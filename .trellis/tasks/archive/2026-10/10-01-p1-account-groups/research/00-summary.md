# Research 汇总：P1-4 多账户分组管理

- **Task**: `.trellis/tasks/10-01-p1-account-groups`
- **Date**: 2026-10-01
- **Scope**: internal（未做外部检索 —— 本题全部答案都在本仓库内）

## 分篇

| 文件 | 覆盖问题 |
|---|---|
| [`01-registry-and-persistence.md`](./01-registry-and-persistence.md) | Q1 字段与排序、Q2 持久化与迁移、Q8 规模与性能 |
| [`02-render-pipeline.md`](./02-render-pipeline.md) | Q3 数据流与排序层次、Q4 开关范式、Q6 分组排序语义 |
| [`03-same-name-and-tests.md`](./03-same-name-and-tests.md) | Q5 同名多账号展示、Q7 测试落点 |

---

## 八个问题的答案速查

| # | 问题 | 一句话答案 |
|---|---|---|
| 1 | 字段 / 同名 / 排序 | `ProviderInstance` 9 字段（`types.ts:116-128`）；同名**无任何约束**，`name` 缺省取 `preset.name`（`providers.ts:280`）；**没有排序字段**，顺序 = `extras.providerInstances` 数组下标；id 形如 `inst:mfk3a2-x9q1b`（`providers.ts:279`），但旧模型迁移产出的是裸预设 id（`providers.ts:252`） |
| 2 | 持久化 | `extras.providerInstances` = JSON 数组字符串（`providers.ts:212/228`），落在 `userData/secrets.bin`（`keystore.ts:14`）；加字段落点是 `types.ts:116` + `providers.ts:251/278` + **`:221` 的 `.map()` 归一化**（既有先例：`.map((i) => ({ ...i, enabled: i.enabled !== false }))`，不回写磁盘） |
| 3 | 渲染数据流 | `scheduler.collect → push(AppState) → App.setState → CardView`（`scheduler.ts:103` / `App.tsx:948` / `:1170`）；**CardView 只看 `ProviderSnapshot`**；`enabled` 过滤在主进程（`scheduler.ts:81`）；排序分三层（注册表数组序 / `scheduler.resort` / `CardView.order` state），`providers:reorder` 把前两层串起来（`ipc.ts:174-180`） |
| 4 | 开关范式 | **分组显隐应抄 `ui:voiceMuted`**（按 id 列表 + `JSON.stringify` + `try/catch` 类型守卫 + 抽成 `read-model.ts` 纯函数 + 黑名单语义「空 = 全开」）；**不要抄 `ui:hideBalance`** —— spec 明确标注其 `'1'`/`''` 编码「differs from every other boolean - don't copy」（`state-management.md:161`） |
| 5 | 同名展示 | 名字在 `CardView.tsx:61` 与 `:139` 裸渲染 `{s.name}`；`mark = inst.presetId \|\| inst.protocol`（`bind-instance.ts:27`）→ **同名同预设两张卡连 logo 都一样**；⚠ `ProviderSnapshot` **没有 `baseUrl`/`presetId`/`protocol`**（`types.ts:56-86`），区分信息拿不到 |
| 6 | 排序语义 | 现状是**单一扁平序列**，三层都吃 `string[]`；**组间顺序在现有数据模型里没有落点**（注册表只有一个数组、`extras` 是扁平 map、IPC 入参形状已被守卫写死）→ 必须新增一个载体，这是本任务最大的结构性新增 |
| 7 | 测试 | 注册表回归网已存在：`scripts/test-adapters.mjs` **T 段**（`:758-904`，T9 = 同预设重复添加、T14 = 拖拽排序）；分组纯逻辑落 `read-model.ts` 可零成本接入 —— `scripts/test-read-model.mjs:13-15` 已 `loadTs` 该文件且已解构 `speakableSnapshots`；`package.json` 按父任务约定**不要动**（`10-01-p1-batch/prd.md:45`） |
| 8 | 规模 | 读：`getExtra` 有内存 memoize（`store.ts:42-43`）→ 每轮采集 0 次磁盘读、**2 次 `JSON.parse`**（`providers.ts:219`，无 parse 缓存）；加字段不改变量级。写：`setExtra` **无条件整文件重写**（`store.ts:92-97`）—— 分组是 KB 级偏好不违反契约，但写入要照抄 `reorderInstances:348` 的「无变化不写」守卫。真正的热点是 `instanceInfo` 里的 `probeCredential`（`providers.ts:365-371`，opencode 读 auth.json/db），不是注册表 |

---

## 数据模型（现状推导，非设计提案）

以下三个字段分别对应三个**互不相同**的存储位置 —— 这是理解本任务成本的关键。

```
① 实例 → 分组的归属        ProviderInstance.groupId?: string
                          落点 extras.providerInstances（数组内字段）
                          写：providers.ts addInstance:278 / setInstanceGroupId（新）
                          读：providers.ts listInstances:221 的 .map 归一化
                          分发：需过 ProviderInfo（:383）或 ProviderSnapshot（bind-instance:21）

② 组本身的元数据           组名 / 显隐 / 组间顺序
                          ⚠ 现状无处可放：extras 是扁平 Record<string,string>（store.ts:27），
                            注册表只有一个数组。新增载体，例如 ui:providerGroups = JSON
                          落点 extras（明文、ui: 前缀 → 写入不触发 refreshNow）

③ 单个实例的卡片窗口偏好   ui:cardWindow:<id> = '本周'      ← 已有的 per-instance 键族先例
                          CardView.tsx:230-241 已在为每个实例批量读 extras
                          state-management.md:170
```

**必须遵守的既有契约**（任一违反都会让现有测试报红）：

| 契约 | 依据 | 后果 |
|---|---|---|
| 界面偏好键必须带 `ui:` 前缀 | `ipc.ts:231` + `test-structure.mjs:445-451`（E8） | 非 `ui:` 写入 → 每次切换触发 `refreshNow()` 全量重采集 |
| 读侧必须重新校验（`Array.isArray` + 逐元素类型守卫） | `App.tsx:524-529` / `state-management.md:197-199` | `extras:get` 对缺失键返回 `''` 而非 `undefined`；判 `v == null` 恒为假 |
| 不新增时序数据进 `extras` | `store.ts:92-97` 全量重写 + `10-01-p1-batch/prd.md:24-25` | — |
| 不改 `package.json` 的 `test` 链 | `10-01-p1-batch/prd.md:45` | 待合并时统一接一次 |
| **不改 `DetailView.tsx`** | `10-01-p1-batch/prd.md:44` | 同名区分必须落在 `CardView` 展示层 |
| 数据诚实：`cached`/`local` 显式标注，走 `staleLabel` | `10-01-p1-batch/prd.md:26-27` | 不在新模块写第二份判断 |

---

## 推荐方案（按现状推导的最小改动路径）

以下是把新能力接到**已经验证过的既有管道**上的方式，每一步都标注了可对照的先例。
这是「现状支持什么」的推导，不是对其他可能路径的评价。

### 路径 A：分组显隐 = `ui:providerGroups`（抄 `ui:voiceMuted`）

```
读   App.tsx 一处 useEffect + getExtras(['ui:providerGroups'])
     → try { JSON.parse(...) } catch { 默认 } + 逐字段守卫（抄 App.tsx:524-529）
判   read-model.ts 新增纯函数（抄 speakableSnapshots:84-89 的「黑名单 id 列表」形状）
     → 已有测试脚手架：test-read-model.mjs:13-15 已 loadTs 该文件
写   setExtras({ 'ui:providerGroups': JSON.stringify(next) })   ← ui: 前缀，零副作用
消费 CardView 的 configured 之后（CardView.tsx:223）插一次过滤
```

- 过滤插 `CardView.tsx:223` 之后 = **插槽 B**（只影响主页网格）
- 过滤插 `scheduler.ts:85` 的 `for (const id of activeIds)` 里 = **插槽 A**（连采集与托盘一起）
- 插 `App.tsx:1170` 传给 CardView 之前 = **插槽 C**（连带影响 `SettingsView` 的 `providerNames`，
  `App.tsx:1124`）

**A 的已知后果**（现状事实，非推测）：`hideBalance` 已经同时传给两个组件
（`App.tsx:1028` PetBall / `:1172` CardView），因为 `PetBall` 是**自己 getState 的独立组件**
（`PetBall.tsx:162-163`）。选 A 或 C 时，收起态的悬浮球/托盘不会自动跟随，需要单独决定。

**托盘的连带语义**（必须一起决策）：`shared/tray-text.ts:66-68` 的 `primarySnapshot` 取的是
「卡片顺序里第一个有数据的」，而卡片顺序 = 全局扁平序列（`scheduler.ts:81` → `:85-88`）。
分组排序一旦改变这个序列，「托盘显示谁」就跟着变。

### 路径 B：同名账号区分 —— 现状的硬约束

`CardView` 手上只有 `ProviderSnapshot`，而它**不含 `baseUrl` / `presetId` / `protocol`**
（`types.ts:56-86` 对比 `ProviderInfo:89-110`）。三条现状可行的取数路径：

| 取数路径 | 要动的文件 | 现状先例 |
|---|---|---|
| **从 `ProviderInfo` 另取一份** | `CardView.tsx`（复用 `:230-241` 已有的批量 `getExtras` 或加一次 `listProviders`） | `SettingsView.tsx:332` 已独立取过；`CardView` 已有 per-instance extras 读取模式 |
| **给 `ProviderSnapshot` 加字段** | `bind-instance.ts:21-28`（`identity`）+ `engine.ts:37`（`identityOf`） | 身份重盖机制已在此处；`Identity` 类型在 `adapters/types.ts` |
| **只用 `s.name` 派生** | 仅 `CardView.tsx:61/139` | 零跨进程改动，但 `s.name` 里没有 baseUrl/preset 信息可派生 |

展示插槽（现状提供的三处）：名称后缀（`CardView.tsx:61/139` 的 `{s.name}`）、
`pcard-foot` 里的可空 chip（`QualityChip` 在 `:26-35`，`staleLabel(s)` 为空时返回 `null`）、
`pcard-top` 里 `StatusDot` 旁（`:62` / `:140`）。

⚠ **只改 `CardView` 会留下不一致**：裸名字还有 4 处消费者 ——
`PetBall.tsx:797`（悬浮球气泡）、`App.tsx:786`（播报文本）、
`App.tsx:1124`（设置页通知对象下拉）、`SettingsView.tsx:104-105`（设置页供应商行）。
（`shared/tray-text.ts:71-80` 的托盘标题只含百分比/金额，不含名字，同名不受影响。）

### 路径 C：组间顺序 —— 必须新增载体

现状三层排序全吃 `string[]`（`providers.ts:337` / `scheduler.ts:205` / `ipc.ts:174`）。
组间顺序**在现有模型里没有落点**，需要新增：
- 或者在注册表侧引入组元数据（改 `ProviderInstance` 的存储形状）
- 或者在 `ui:` 侧另开一个键存组序（与路径 A 的 `ui:providerGroups` 合并或分开）

拖拽侧的连带面（现状事实，非批评）：`CardView` 的槽位几何假设一个扁平网格 ——
`slotRects()` 按 DOM 顺序取矩形（`:324-328`）、`dragStyleFor(id, i)` 用**数组下标 `i`**
算让位位移（`:427-448`）、提交给 `reorderProviders` 的是扁平 id 数组（`:277`、`:364-368`）。
引入分组标题行会触碰 `:262-273` 注释里记录的四点设计约束（尤其是②「目标槽位由拖拽开始时
捕获的静态几何算出」）。这一段只能靠 `--uitest` 回归（既有：`qa/uitest.ts:1910-1971`）。

---

## 需要澄清的问题

**A. 需求语义（决定数据模型，必须先答）**

1. **分组显隐 = 不采集，还是只不展示？**
   现状有两条语义不同的先例：`enabled: false` 是**不采集**（`scheduler.ts:81` 过滤 +
   `adapters/index.ts:41` 跳过）；`ui:voiceMuted` 是**只不播报**。分组显隐属于哪一类？
   「每组独立显隐」若是前者，隐藏组会停止轮询，`resort` 与托盘优先级都要重新定义。

2. **组是单选可见，还是多组并显？** 即「切到公司组只看公司」还是「公司/个人各自有开关」？
   前者是一个 `activeGroup`（string），后者是一个 `hiddenGroups`（string[]）。
   两者存储形状不同，抄的先例也不同（`ui:ttsPreset` 的单值 vs `ui:voiceMuted` 的列表）。

3. **组是纯 UI 标签，还是用户可自定义的自由标签？**
   「公司 / 个人」在调研原文里是示例（`09-30-similar-projects-research/research/report.md:226`）。
   若是固定枚举（`ui:` 键存一个开关 map 即可）；若是自由输入（组名要存、要防重、要处理重命名后
   已有实例的归属）。**这两种的工作量差一个量级。**

4. **「排序」指的是组内排序、组间排序，还是两者？**
   现状只有一个全局扁平序列（`providers.ts:337`）。只做组内排序 → 沿用现有
   `reorderInstances`，改动小；同时要组间排序 → 必须新增组序载体（见路径 C）。

**B. 与既有语义的冲突（需要产品决策）**

5. **分组排序与托盘优先级的关系？**
   `shared/tray-text.ts:66-68` 的「第一优先级 = 卡片顺序第一位」是既有产品语义，
   `tray-text.ts:6-7` 的文件头把它写成了契约。分组后「第一位」指全局第一位还是当前可见组第一位？

6. **隐藏组里的供应商还发不发播报 / 通知？**
   `App.tsx:782` 的 `speakableSnapshots(ctx.snapshots, ctx.muted)` 与
   `ui:voiceMuted` 是两套独立机制。隐藏一个组是否隐含「也不播报」？
   若否 → 需要在 `alertCtxRef` 镜像（`App.tsx:555-579`）里再加一个字段（该镜像的注释
   `:553-554` 明确警告过依赖数组纪律）。

7. **同名账号的区分标记落在哪？** 名称后缀 / 卡片副标签 / 头像色 —— 三者对
   `pcard-top` 的有限横向空间（`CardView.tsx:59-62`）压力不同，也对
   `aria-label`（`:555`）与 `title`（`:564`）的要求不同。
   另：**区分信息要取自哪里**（`ProviderInfo` 另取 vs 给 `ProviderSnapshot` 加字段），
   这决定了是否要动 `bind-instance.ts` + `engine.ts`。

8. **区分标记是否要贯穿到 CardView 之外？**
   裸 `s.name` 还有 4 处消费者（`PetBall.tsx:797` / `App.tsx:786` / `App.tsx:1124` /
   `SettingsView.tsx:104-105`）。父任务只约束了「不改 `DetailView.tsx`」，
   其余位置是否也要统一，属于范围决策。

**C. 工程约束（可从现状直接判断，但需确认）**

9. **是否允许新增 `src/shared/*.ts` 文件？**
   `ipc.ts:84-88` 与 `ipc.ts:259-261` 都记录了「文件所有权（implement.md）不许新增 shared 文件」
   这条约束，并给出了替代做法（`test-structure.mjs` 静态比对两侧字面量）。
   本任务的 `implement.md` **尚未撰写** → 该约束目前未被激活，可自行决定。
   若允许 → 分组纯逻辑可放 `shared/` 供主进程与渲染层共用；
   若不允许 → 放 `renderer/src/read-model.ts`（零新基础设施，见 Q7）。

10. **`providers:reorder` 的 IPC 契约能否变更？**
    入参形状已被守卫写死（`ipc.ts:175`）：
    `if (Array.isArray(ids) && ids.every((x) => typeof x === 'string'))`。
    要传组信息需新增一个通道（如 `providers:reorderGroups`）或放宽守卫。
    通道命名的既有规则：`<domain>:<kebab-case-action>`，无常量表
    （`type-safety.md:401-404`，改动前需 `grep`）。

11. **旧实例的分组缺省值是什么？**
    `.map()` 归一化（`providers.ts:221`）需要一个具体缺省值。
    候选：空串（=「未分组」）或某个内置组名（如「默认」）。
    **若用内置组名，组名一旦被用户改名/删除，旧实例会指向不存在的组** ——
    这与 `ui:ttsPreset` 键表里记录过的「存值不能兼任未设置哨兵」是同一类陷阱
    （`state-management.md:209-211`）。

---

## 本次调研未覆盖（建议 design 阶段补）

- **拖拽 + 分组标题行的实机行为**：`CardView.tsx:262-273` 的四点设计约束经过两轮实机调优，
  引入分组标题行后的槽位几何/让位位移是否仍成立，只能实机验证。既有回归手段：
  `npm run uitest`（`qa/uitest.ts:1910-1990` 的 `dragNoFlicker` / `dragSettles` / `dragPersist`）。
- **性能实测**：`providers.ts` 的 `probeCredential`（`:365-371`，opencode 读 auth.json/db）
  在每轮 `listProviders()` 里跑，是比注册表读更热的路径。本文件只做了代码层判定，未做实测。
- **CSS / 视觉**：`src/renderer/src/skins.css` 与 `Icon` 组件的图标集
  （`components.tsx:55-78`，23 个 `IconName`，**没有 group / tag / folder 类图标**）
  未纳入本次调研。分组切换 UI 需要新增图标或复用现有。
