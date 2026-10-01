# Implement: P1-4 多账户分组管理

> ⚠ **本文档有两代内容。**「Ordered Checklist」/「Review Gates」/「`trellis-check` 发现的缺陷」
> 记录的是**第一版（`e34f3ac`，黑名单 `ui:groupHidden`）**的清单与结论 ——
> 那些 `ui:groupHidden` / `onToggleGroup` / `onShowAllGroups` 的描述**已随返工全部作废**。
> **当前实现契约一律以文末「返工记录」与 `design.md` 的 D1 / D1b / D5b 为准。**

## Ordered Checklist

### Phase 1: 类型与注册表

- [x] **1.1** `src/shared/types.ts`
  - [x] `ProviderInstance` 增 `groupId?: string`（可选，无版本号）
  - [x] `ProviderInfo` 增 `distinguishKey?: string`
  - [x] ⚠ `ProviderSnapshot` **不加**字段（9 个适配器都不该关心它）
- [x] **1.2** `src/main/providers.ts`
  - [x] `setInstanceGroup(id, groupId)`：写前**清洗**（截断 32 字符、剥控制字符）
  - [x] 读出注册表时用 `.map()` 归一化（旧实例补 `groupId: ''`）—— 沿用 `encodePetState` 的迁移先例
  - [x] ⚠ 照抄 `reorderInstances:348` 的「**无变化不写**」守卫（`setExtra` 是无条件整文件重写）
  - [x] `ProviderInfo` 组装时填 `distinguishKey`（如 baseUrl 的 host；无则空串）
- [x] **1.3** `src/main/ipc.ts`：新增 `providers:setGroup`，**逐字段复验**
  - [x] `id` 非空字符串；`groupId` 字符串（空串 = 移出分组）
  - [x] 入参形状**不改** `providers:reorder`（`ipc.ts:175` 的守卫保持原样）

### Phase 2: 纯函数 read-model.ts（零成本落点）

> ⚠ 第二参已由 `string[]`（黑名单）改为 `string`（单个组 id），并新增 `ALL_GROUPS = ''`。

- [x] **2.1** `src/renderer/src/read-model.ts` 新增导出
  - [x] `UNGROUPED = '未分组'` 常量 · `ALL_GROUPS = ''` 哨兵
  - [x] `groupNames(info)`：去重 + 升序 + 含 `UNGROUPED`（当存在无 groupId 的实例）
  - [x] `visibleIds(info, group)`：**单选** —— 返回该组成员（`ALL_GROUPS` 时全部）
  - [x] `orderForDisplay(info, group)`：组间按组首成员位置、组内按数组顺序
- [x] **2.2** 纯函数纪律：不改 `now` 语义、不碰 DOM、**入参不被就地修改**

### Phase 3: 渲染层

- [x] **3.1** `src/renderer/src/App.tsx`
  - [x] extras 读 `ui:groupFilter`（⚠ 判「键缺失」只能用 `|| ALL_GROUPS`，`extras:get` 对缺失键返回 `''`）
  - [x] 分组下拉：选项 = `groupNames(...)`
  - [x] 传给 `CardView` 的是**筛选值**（判定在 read-model，不是可见 id 集合）
  - [x] 切换筛选的回调 `applyGroupFilter`：写 `ui:groupFilter`，带「无变化不写」守卫
  - [x] `setInstanceGroup` 的 IPC 接线
  - [x] ⚠ **只改 App.tsx，不碰 `DetailView.tsx`**（趋势图子任务正在用它）
- [x] **3.2** `src/renderer/src/CardView.tsx`
  - [x] 同名多账号时名称后缀加 `distinguishKey`（如 `Claude 公司`）
  - [x] 无 `distinguishKey` 时**不加**后缀（与今天一致，不造「(2)」假区分）
  - [x] 卡片组名标签 `.pcard-group`（查不到实例 → **不渲染**，D5b 的数据诚实）
  - [x] `effFilter`：筛选值指向已消失的组 → 读侧回落「全部」，排序与空态判据**共用**它
  - [x] `hidden = byId.has(id) && !inDisplay.has(id)`：未知实例**不该**算「被筛掉」
  - [x] 空态拆成「筛空了」/「本来没卡片」两支（D1b）
- [x] **3.3** 设置页文案（**不是可选项**）：明确写
      「筛选只影响列表显示，托盘与提醒仍覆盖全部账户」—— 否则用户会以为筛掉后就收不到告警

### Phase 4: CSS

- [x] **4.1** `skins.css` 加分组下拉的 class（沿用 `.field` / `.section-title` 既有规则与 token）
  - [x] `.pcard-group` 只用**既有 token**（`--surface-sunken` / `--fg-faint`），5 套皮肤全覆盖

### Phase 5: 测试

- [x] **5.1** 扩展 `scripts/test-read-model.mjs`（**不新增脚本、不改 `package.json`** —— 见父任务 prd.md）
  - [x] 覆盖 design.md Tests Required 第 1–9 条
  - [x] 第 5 条（组末成员移走后位置重算）钉住 D4 的已知代价
  - [x] 第 7 条（入参深比较）必须实测，不能只写断言
- [x] **5.2** `src/main/qa/uitest.ts` 加断言（design.md 第 10–15 条）
  - [x] 分组下拉列出正确组名；选中某组后列表只剩该组成员
  - [x] 筛选后**卡片列表**变、**托盘标题不变**、**`lastSync` 不变**（D6 + 「不重发采集请求」）
  - [x] 筛到零卡 → 空态 + 一次恢复
  - [x] 卡片组名标签（两种卡型）
  - [x] 同名两账号卡片名带不同后缀
  - [x] ⚠ 分组段**自建夹具**（不依赖用户机器上已有分组），结束前删干净并断言
  - [x] ⚠ 若托盘/趋势图子任务也在改 `uitest.ts`，各自只加自己的键，合并时人工去重
- [x] **5.3**（`trellis-check` 补）`scripts/test-adapters.mjs` 的 **T 段补注册表侧回归**
      —— 分组纯逻辑有 read-model 兜着，但**写盘 / 清洗 / 「无变化不写」守卫 /
      distinguishKey 取值**只有真 store 的那一段能测（`test-adapters.mjs` T21a–T21o）。
      不新增脚本、不改 `package.json`。

## Review Gates

> ⚠ 下列反验编号是**第一版**的。返工后重测的红集见文末「返工记录」。

- [x] `npm test` 通过
- [x] `npm run typecheck` 通过
- [x] `npm run build` 通过（并据产物核对分组 CSS **确实**在，见下方 F3）
- [x] **反验 ①**：`visibleIds` 改成按实例 id 过滤 → 有红
- [x] **反验 ②**：`orderForDisplay` 改成纯数组顺序 → 有红
- [x] **反验 ③（新增）**：`orderForDisplay` 改成按组名字母序 → 有红
- [x] **反验 ④（新增）**：去掉 `setInstanceGroup` 的「无变化不写」守卫 → 有红（T21i/i2/j/j2）
- [x] **反验 ⑤（新增）**：`distinguishKey` 写成裸 `baseUrl` → 有红（T21m/T21n）
- [x] **反验 ⑥（新增）**：判缺失改成 `??` / `== null` → 有红
- [x] **反验 ⑦（新增）**：主进程读分组筛选键 → 有红
- [x] **反验 ⑧（新增）**：删掉设置页那句文案 → 有红
- [x] **反验 ⑨（新增）**：去掉 `instanceInfo` 空守卫 → 有红
- [x] **反验 ⑩（新增）**：空态按钮改回逐个 toggle → 有红
- [x] **反验 ⑪（新增）**：哨兵 value 退回裸「全部」 → 有红
- [x] `trellis-check` 对照 prd.md 验收标准逐条复核 → **PASS_WITH_FIXES**（第一版 16/16 AC）

## `trellis-check` 发现的缺陷（第一版，已修）

按「静默失效」优先排序。前 5 条都是**不抛不红、只是功能悄悄没了**。
⚠ F2 的修法（`onShowAllGroups` 一次清空黑名单）已随返工作废 —— 现在是
`onSetGroupFilter(ALL_GROUPS)` 一次写空串（单选语义下没有「黑名单」可言）。

| # | 文件 | 失效形态 | 修法 |
|---|---|---|---|
| F1 | `CardView.tsx` | `instanceInfo` 还没到手（首帧 IPC 未返回 / `providers:list` 失败）时 `orderForDisplay` 返回空集，拿空集过滤会把**每一张卡**都滤掉 → 用户看到「分组已全部隐藏」这个**与事实相反**的空态，且那个按钮点了也回不来。顺带：未分组实例的 `groupId` 是空串（假值），裸读会把它们踢出组序，**拖拽名次成了死代码**（今天恰好不出错只因 `resort` 让两序同步，是巧合） | `instanceInfo.length === 0` 时一律不过滤、只按拖拽序排；组序改用 read-model 的 `groupOf` |
| F2 | `CardView.tsx` + `App.tsx` | 空态的「显示全部分组」写成 `for (const g of hiddenGroups) onToggleGroup(g)` —— 循环里每一轮都从**同一份闭包**的 `hiddenGroups` 出发，`setHiddenGroups` 被旧值覆盖 N 次，净效果是**只放开最后一组**。下拉里的「全部」项同理：它 toggle 一个不存在的哨兵组 id，点它是**纯空操作**，隐藏之后没有回来的路 | 第一版：新增 `onShowAllGroups` 一次清空黑名单。**返工后**：`onSetGroupFilter(ALL_GROUPS)` 一次写空串（语义从黑名单换成单选，问题本身消失） |
| F3 | `skins.css` | 分组那一节用了 **CSS 不认的 `//` 行注释**。构建**不报错**，但解析器把它当非法选择器连同后面的规则一起吞掉 —— 实测产物里 `.prow-group` / `.grp-note` / `.grp-filter .grp-select` **全部不存在** | 改成块注释；已在注释里记下实测结论 |
| F4 | `--uitest` 分组探针 | 探针的交互假设与实现语义对不上（首版是黑名单存储、探针按「单选当前组」写），`--uitest` 不在 `npm test` 链里，所以一直没人跑出来 | 返工后整段重写：**单选语义 + 自建夹具**（不依赖用户机器上已有分组）+ 主动触发 collect |
| F5 | `providers.ts` | `sanitizeGroupId` 的 32 字符截断按 UTF-16 码元计数，emoji 占 2 个码元 → 第 32 位落在代理对中间时切出**半个字符**（U+FFFD），而组名会一路进 `<option>`、SVG 与托盘文案 | 截断后去掉结尾的落单高位代理；并补 T21e/T21e2 |
| F6 | `providers.ts` / `uitest` | `test-adapters.mjs` **整个 T 段没被碰** —— 注册表侧（清洗 / 「无变化不写」守卫 / `.map()` 归一化 / `baseUrlHost`）**零测试**，正好是约束里点名要照抄 `reorderInstances` 守卫的那一处 | T 段补 T21a–T21o，含用**调用计数**判「无变化不写」（比文件内容是恒绿的门） |
| F7 | `test-read-model.mjs` | 纯度断言的编号与其它条重复（重名会让失败信息指向错那条）；多条 AC **没有任何守卫** | 重新编号；补跨层边界守卫 J5–J20（判缺失写法 / 主进程不读筛选键 / 设置页文案 / 空守卫 / `byId.has` / `effFilter` 回落 / 组名标签 / 哨兵撞名 …），每条都实测过反验会红 |

**未做（留给后续，不在本任务范围）**

- `read-model.ts` 里分组判定没有独立的「组是否存在」判断 —— 组名只在删除实例时自然消失（D2 的刻意语义）。
  读侧的回落由渲染层的 `effFilter` 承担（它手里有下拉选项列表）。
- 组名恰好叫「未分组」的自建组会与 `UNGROUPED` 兜底桶合并（D2 的既定语义，未加防护）。
- 卡片组名标签只进 `CardView`；`PetBall` 气泡、播报文本、设置页通知对象下拉仍是裸 `s.name`
  （research Q8 列出的范围决策，第一版与返工都未扩）。

## Rollback

- **纯增量**：`groupId` / `distinguishKey` 都是**可选**字段，旧数据读出来即缺省。
  回滚 = 撤代码 + 清 `ui:groupFilter`（注册表里的 `groupId` 残留无害，读侧忽略）。
  旧的 `ui:groupHidden` 残留值同样无害（读侧完全忽略它）。
- ⚠ 但**不做数据迁移回滚**：已分组的数据会留在注册表里。若要彻底清空需手工编辑
  `secrets.bin` 的 extras —— 因此**不写自动迁移**，读侧 `.map()` 归一化已经够用。

---

## 返工记录（2026-10-01 第二次）

第一版（`e34f3ac`）是**黑名单**语义（`ui:groupHidden`），本轮按用户的新决策改成
**单选筛选器**（`ui:groupFilter`），并修了实机 `--uitest` 挖出的两个真 bug。

### 改动清单

| 文件 | 改动 |
|---|---|
| `read-model.ts` | 新增 `ALL_GROUPS = ''`；`visibleIds` / `orderForDisplay` 第二参数由 `string[]`（黑名单）改为 `string`（单个组 id） |
| `App.tsx` | `hiddenGroups: string[]` → `groupFilter: string`；读 `e['ui:groupFilter'] || ALL_GROUPS`；写 `setExtras({ 'ui:groupFilter': group })`；`ui:groupHidden` **不再读写** |
| `CardView.tsx` | props 换 `groupFilter` / `onSetGroupFilter`；新增 `GroupTag`（卡片组名标签）与 `effFilter`（组已消失 → 回落全部）；**修 `hidden` 谓词**；空态拆成「筛空了」/「本来没卡片」两支 |
| `SettingsView.tsx` | 文案改「筛选只影响列表显示，托盘与提醒仍覆盖全部账户」 |
| `skins.css` | 新增 `.pcard-group`（块注释） |
| `qa/uitest.ts` | 分组段整段重写（单选语义 + **自建夹具**）；dup 探针补 API Key；新增轮询 `waitFor` |
| `test-read-model.mjs` | I 段按新语义整体重写（I11–I33）；J2 段重写为 J5–J20 |

### 两个真 bug 的根因（都不是「以为的那个」）

**R1 · `cachedCard` / `cachedBanner` / `localChip` 三条一起红。**
`--uitest` 用 `debugPush` 注入 id 为 `fake-provider` 的快照，而 `fake-provider` 不在注册表里。
第一版的 `shown.hidden(id) = !inDisplay.has(id)` 把这类快照**整张滤掉**，于是 `ordered` 空 →
渲染「分组已全部隐藏」空态。基线证据（`cachedCard` 的失败消息里就是那一屏）：
`:: BalanceDeck 离线 · 1 项为缓存数据 … 全部 未分组 分组已全部隐藏 …`。
顺带说明第一版 `key()` 里那条「未知实例排到末尾」的分支在第一版里是**死代码**（已被 `hidden` 先滤掉）。
**修法**：`hidden = byId.has(id) && !inDisplay.has(id)` —— 只筛「注册表里有且被筛选排除」的 id。
这条同时就是 ③ 的真正修法（③ 的判据收紧是第二道防线）。

**R2 · `grpDupCardName` 红且消息为空。** 与 ③ **无关**。根因是探针加实例时**只填了名称与
地址、没填 API Key** → 适配器铸的是 `noDataSnap`（`status: 'nodata'`）→ `CardView` 的
`configured` 过滤掉 `nodata` → **根本没有卡片**。所以 `grpDupHost`（注册表层）绿而界面层红。
**修法**：`addCustom` 补 key 参数 + `waitFor` 轮询到两张卡真的出现（固定 sleep 600ms 会读到上一帧）。

### 反验实测红集（`node scripts/test-read-model.mjs`）

| # | 注入 | 红 |
|---|---|---|
| 1 | `visibleIds` 改成按实例 id 过滤 | **8**（I13/I14/I15/I16/I20/I23/I24/I26） |
| 2 | `orderForDisplay` 改成纯数组顺序 | **2**（I22/I25） |
| 3 | 空态判据退回 `ordered.length === 0` | **1**（J12） |
| 4 | `hidden` 退回 `!inDisplay.has(id)`（R1 回归） | **1**（J15） |
| 5 | `ui:groupFilter` 判缺失改成 `== null` | **2**（J5/J6） |
| 6 | 去掉 `effFilter` 的「组已消失 → 回落全部」 | **1**（J16） |
| 7 | `GroupTag` 对未知不再返回 null（谎称「未分组」） | **1**（J18） |

> 反验 2 的红从第一版的 3 条降到 2 条，不是护栏变弱。**第二次 check 独立复核了这一点**：
> 把测试里 9 个 `orderForDisplay` 调用逐个枚举，逐一比对「聚合输出」与「纯数组序输出」是否
> 真的不同 —— **理论上能区分两条路径的只有 I22 / I25 两个**（两个交错夹具 × `ALL_GROUPS`），
> 其余 7 个（含全部带筛选值的、以及 `mixed` / `moved` / 汉字组名这三个**连续分组**夹具）
> 在两种实现下输出完全相同。实测红集 `{I22, I25}` 与理论上限**逐条吻合** ——
> 门已经顶到单选语义允许的强度，不是被削弱。

---

## 第二次 check（返工验收，2026-10-01）

独立跑了实机 `--uitest`、复现了全部反验、并逐条核对了 prd 的 AC。结论 **PASS_WITH_FIXES**。

### 实机 `--uitest` 实测（`npm run build` 后 `npx electron . --uitest`）

| 轮次 | 键数 | ok | fail | 说明 |
|---|---|---|---|---|
| 返工后（实现方报告） | 164 | 146 | — | **数字不可复现** |
| check 第 1 轮 | 164 | 126 | 15 | 13 条 `vrs*` 假红 + `grpDupCardName` + `petFigureUnchanged` |
| check 修完探针后 | **164** | **140** | **1** | 唯一 fail = `petFigureUnchanged`（本机 DPR 已知 flake） |

`petFigureUnchanged` 逐字段核对：`win` / `stage` / `rect` / `center` / `stride` / `petReady`
/ `idx` / `pet` / `caption` **九个字段全等**，只有 `canvas` 不同
（`FIG_BASE` 记的 `[426, 586, 213, 293]` 是 2× 设备像素，本机 DPR=1 读回 `[213, 293, 213, 293]`）。
符合 spec「十个字段里只有 canvas 变了就说明是 DPR」的判据，**不修**。

### 第二次 check 修的 4 处

| # | 文件 | 失效形态 | 修法 |
|---|---|---|---|
| G1 | `qa/uitest.ts`（**vrs 段，非本任务**） | 那一段测「总开关**关着**时配置区不渲染」，前提是进来时它就是关的。本机 `ui:ttsOn='1'`（用户自己开着的真实状态）→ 第一条报 `fail:shown-while-off`，接着那次 click 把**已经开着**的开关又关一次 → **整段 13 条 `vrs*` 一起崩**。崩在 TTS 段，与 P1-4 毫无关系，却把验收数字淹成「15 红」 | 断言前按 DOM 实际状态点一次开关归位（`ui:ttsOn` 由 `SettingsView` 挂载时读一次，IPC 直写不会重渲染，只能点） |
| G2 | `qa/uitest.ts` | `grpDupCardName` **实测红**：两个同名实例先后加，第二次 `addCustom` 返回时第一轮 collect 还在路上；自然轮询周期 60s，探针只等 10s → 界面上稳定只出现**一张** `uitest-dup` 的卡（`grpDupHost` 绿）。**探针的时序假设比被测行为还不确定** | 新增 `forceCollect()`（点标题栏「立即刷新」）后再 `waitFor`，预算 10s → 20s。**R2 的诊断（没给 key → nodata）是对的但不完整**：key 确实补上了，卡片还是等不到 |
| G3 | `qa/uitest.ts` | `grpFilterNoRecollect` 的测量窗口 ~1s，而后台调度每 60s 自己跑一轮 —— 落进窗口就报**假红** | 测前把 `refreshInterval` 挪到 300、等它诱发的 recollect 落定再取基线，读完立刻还原 |
| G4 | `qa/uitest.ts` | `grpFilterCards` 写的是 `left.every(x => expIds.has(x))`。而 cached/local/error 三段留下的 `debugPush` 快照（`fake-provider`）**不在注册表里**，它出现与否取决于那一段之后有没有真采集落过 → 潜在的偶发红。而且这正是本任务刚修掉的那个 bug 的形状：**替一张我们不知道归属的卡断言「它属于别的组」** | 改成 `expIds.has(x) \|\| !knownIds.has(x)`，并把 `knownIds` 提到两处断言共用 |
| G5 | `CardView.tsx` | 卡片 `aria-label` 是裸 `${s.name} 详情`，而 `aria-label` **覆盖**卡内全部可见文本 → 读屏用户听到的还是两个一模一样的名字，P1-4 想解决的问题在无障碍通道上原样复发 | 后缀与组名都进 `aria-label`；组名为空串时不提「未分组」（沿用 D5b 的数据诚实） |

### 第二次 check 复核过的门（全部实测会红）

| 注入 | 红 |
|---|---|
| `visibleIds` 改成按实例 id 过滤 | **8**（I13/I14/I15/I16/I20/I23/I24/I26） |
| `orderForDisplay` 改成纯数组顺序 | **2**（I22/I25） |
| `orderForDisplay` 改成按组名字母序 | **2**（I25/I27） |
| 空态判据退回 `ordered.length === 0` | **1**（J12） |
| `hidden` 退回 `!inDisplay.has(id)`（R1 回归） | **1**（J15） |
| 去掉 `effFilter` 的回落 | **1**（J16） |
| `ui:groupFilter` 判缺失改 `== null` | **2**（J5/J6） |
| `GroupTag` 对未知谎称「未分组」 | **1**（J18） |
| 去掉 `instanceInfo` 空守卫 | **1**（J14） |
| 主进程读 `ui:groupFilter` | **1**（J9） |
| 删掉设置页那句文案 | **1**（J10） |
| 空态按钮改回逐组 toggle | **1**（J13） |
| 下拉哨兵映射退回裸值 | **1**（J20） |
| 读侧重新引入 `ui:groupHidden` | **2**（J6/J8） |
| `visibleIds` 就地修改入参 | **5**（I14/I20/I24/**I32/I33**） |
| `sanitizeGroupId` 去掉清洗 | **7**（T21b/c/d/e/e2/j/j2） |
| 去掉「无变化不写」守卫 | **4**（T21i/i2/j/j2） |
| `distinguishKey` 写成裸 `baseUrl` | **2**（T21m/T21n） |
| 去掉 `.map()` 的 `groupId` 归一化 | **1**（T21f） |
| 重复声明 `visibleIds` | `loadTs` 抛「Multiple exports」→ 脚本非零退出 |
| `read-model` 引入 `document` / `window` | 各 **1**（J3） |
| `read-model` import electron | **1**（J2） |

> 判据修正一处：J17 原先判「`group={groupOfId(s.id)}` 字面量出现在两种卡型的 JSX 里」。
> G5 把组名提到循环体里算一次（同一个值同时喂 `aria-label` 与两种卡型），J17 随之改判
> 「循环体算出 `group` → 两种卡型都收到 `group`」，并补 **J17b**（`groupOfId` 对未知返回空串）。
> 改完的 J17 / J17b 各注入 4 次，均实测会红。

### 文档一致性（第二次 check 修的）

- `design.md`：架构图仍写「读 `ui:groupHidden`（黑名单 JSON）」、`visibleIds(info[], hidden)` /
  `orderForDisplay(info[], order[], hidden)` 带了一个**并不存在的第三参**、「用户已拍板的三个语义」
  第 1 条仍是黑名单、D5 说后缀走 `ProviderMark` 副标题（实际是 `displayName()` 进 `.pcard-name`）、
  Good/Bad 案例与 Tests Required 1–11 全是黑名单措辞 —— 全部改成单选语义并补 D5b/空态/D1b 的条目。
- `implement.md`：Phase 2/3/5 的清单、Review Gates、F2/F4/F7 的描述、「未做」里那条
  「下拉的交互是藏它…需要主会话拍板」（用户**已经**拍板并返工完了）、Rollback 里的 `ui:groupHidden`
  —— 全部对齐返工后的事实，并加了两代内容的分界说明。
- `prd.md`：Notes 里的断言编号 `I30` / `I19` 是返工重排**之前**的（现为 `I31` / `I21`），
  AC 里的 `|| '全部'` 改为 `|| ALL_GROUPS`（哨兵是**空串**不是 `'全部'`），`visibleIds` 那条同理。

### 与 prd.md 的一处刻意偏离（已回写 prd.md）

AC 原文写「筛掉所有组 → 显示**「分组已全部隐藏」**空态」。单选语义下**不存在**「所有组都被藏起来」
这个状态（选一个组就一定看得见那个组），所以本轮保留的是**判据 + 恢复按钮**（`ordered.length === 0
&& effFilter !== ALL_GROUPS` + 「显示全部分组」），文案沿用 AC 点名的原句未改。

### 已知遗留

- `CardView` 里第三个空态分支（有 `configured` 却零卡片）**当前不可达** —— 留作兜底并在注释里
  写明了理由，不是「看着像验证的假门」。
- `--uitest` 的分组段**自建夹具**（4 个临时实例，结束前删干净，`grpDupCleanup` 断言），
  因此不再依赖用户机器上已有 ≥2 个分组；代价是这一段比原来多 ~20 秒。
- 组名恰好叫「未分组」的自建组会与 `UNGROUPED` 兜底桶合并（design.md D2 的既定语义），
  本轮未加防护（会让「只看未分组」顺带显示那个组）。
- 卡片组名标签与后缀只进 `CardView`：`PetBall` 气泡、播报文本、设置页通知对象下拉仍是裸 `s.name`
  （research Q8 的范围决策；两轮都未扩，父任务的约束是「不改 `DetailView.tsx`」）。
- `vrs` 段那条「先把开关归位」的修法只解决了**进来时开着**；如果上一轮 run 崩在
  `vrsPowerOn` 之后、没能把开关关回去，本轮开头会多点一次把它关掉 —— 归位方向是对的，
  但它依赖 `.vrs-power` 的 class 语义（该 class 改名时这条会静默变成空操作）。
