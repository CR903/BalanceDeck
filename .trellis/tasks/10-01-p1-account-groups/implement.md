# Implement: P1-4 多账户分组管理

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

- [x] **2.1** `src/renderer/src/read-model.ts` 新增三个导出
  - [x] `UNGROUPED = '未分组'` 常量
  - [x] `groupNames(info)`：去重 + 升序 + 含 `UNGROUPED`（当存在无 groupId 的实例）
  - [x] `visibleIds(info, hiddenGroupIds)`：不在隐藏列表里的实例 id 集合
  - [x] `orderForDisplay(info, hiddenGroupIds)`：组间按组首成员位置、组内按数组顺序
- [x] **2.2** 纯函数纪律：不改 `now` 语义、不碰 DOM、**入参不被就地修改**

### Phase 3: 渲染层

- [x] **3.1** `src/renderer/src/App.tsx`
  - [x] extras 读 `ui:groupHidden`（⚠ 判「键缺失」只能用假值兜底，`extras:get` 对缺失键返回 `''`）
  - [x] 分组下拉：选项 = `groupNames(...)`
  - [x] 传给 `CardView` 的列表用 `orderForDisplay(...)` 排序
  - [x] 切换分组的回调：写 `ui:groupHidden`
  - [x] `setInstanceGroup` 的 IPC 接线
  - [x] ⚠ **只改 App.tsx，不碰 `DetailView.tsx`**（趋势图子任务正在用它）
- [x] **3.2** `src/renderer/src/CardView.tsx`
  - [x] 同名多账号时名称后缀加 `distinguishKey`（如 `Claude 公司`）
  - [x] 无 `distinguishKey` 时**不加**后缀（与今天一致，不造「(2)」假区分）
- [x] **3.3** 设置页文案（**不是可选项**）：明确写
      「隐藏只影响列表显示，托盘与提醒仍覆盖全部账户」—— 否则用户会以为隐藏后收不到告警

### Phase 4: CSS

- [x] **4.1** `skins.css` 加分组下拉的 class（沿用 `.field` / `.section-title` 既有规则与 token）

### Phase 5: 测试

- [x] **5.1** 扩展 `scripts/test-read-model.mjs`（**不新增脚本、不改 `package.json`** —— 见父任务 prd.md）
  - [x] 覆盖 design.md Tests Required 第 1–8 条
  - [x] 第 5 条（组末成员移走后位置重算）钉住 D4 的已知代价
  - [x] 第 7 条（入参深比较）必须实测，不能只写断言
- [x] **5.2** `src/main/qa/uitest.ts` 加断言（design.md 第 9–11 条）
  - [x] 分组下拉列出正确组名；切组后列表只剩该组成员
  - [x] 隐藏组后**卡片列表**变、**托盘标题不变**（D6 的行为断言）
  - [x] 同名两账号卡片名带不同后缀
  - [x] ⚠ 若托盘/趋势图子任务也在改 `uitest.ts`，各自只加自己的键，合并时人工去重
- [x] **5.3**（`trellis-check` 补）`scripts/test-adapters.mjs` 的 **T 段补注册表侧回归**
      —— 分组纯逻辑有 read-model 兜着，但**写盘 / 清洗 / 「无变化不写」守卫 /
      distinguishKey 取值**只有真 store 的那一段能测（`test-adapters.mjs` T21a–T21o）。
      不新增脚本、不改 `package.json`。

## Review Gates

- [x] `npm test` 通过（17 套件全绿，1621 项断言）
- [x] `npm run typecheck` 通过
- [x] `npm run build` 通过（并据产物核对分组 CSS **确实**在，见下方 F3）
- [x] **反验 ①**：`visibleIds` 改成按实例 id 过滤 → **实测红 9 条**（I11/I13/I14/I18/I21/I22/I24/I27/I29）
- [x] **反验 ②**：`orderForDisplay` 改成纯数组顺序 → **实测红 3 条**（I20/I23/I24）
- [x] **反验 ③（新增）**：`orderForDisplay` 改成按组名字母序 → 实测红 2 条（I23/I25）
- [x] **反验 ④（新增）**：去掉 `setInstanceGroup` 的「无变化不写」守卫 → 实测红 4 条（T21i/i2/j/j2）
- [x] **反验 ⑤（新增）**：`distinguishKey` 写成裸 `baseUrl` → 实测红 2 条（T21m/T21n）
- [x] **反验 ⑥（新增）**：`ui:groupHidden` 判缺失改成 `??` / `== null` → 实测红（J6）
- [x] **反验 ⑦（新增）**：`scheduler.ts` 读 `ui:groupHidden` → 实测红（J8）
- [x] **反验 ⑧（新增）**：删掉设置页那句文案 → 实测红（J9）
- [x] **反验 ⑨（新增）**：去掉 `instanceInfo` 空守卫 → 实测红（J11）
- [x] **反验 ⑩（新增）**：空态按钮改回 `for (…) onToggleGroup(g)` → 实测红（J12）
- [x] **反验 ⑪（新增）**：哨兵 value 退回裸「全部」→ 实测红（J13）
- [x] `trellis-check` 对照 prd.md 验收标准逐条复核 → **PASS_WITH_FIXES**（16/16 AC 达成，
      修了 7 处；见下方「check 发现的缺陷」）

## `trellis-check` 发现的缺陷（已修）

按「静默失效」优先排序。前 5 条都是**不抛不红、只是功能悄悄没了**。

| # | 文件 | 失效形态 | 修法 |
|---|---|---|---|
| F1 | `CardView.tsx` | `instanceInfo` 还没到手（首帧 IPC 未返回 / `providers:list` 失败）时 `orderForDisplay` 返回空集，拿空集过滤会把**每一张卡**都滤掉 → 用户看到「分组已全部隐藏」这个**与事实相反**的空态，且那个按钮点了也回不来。顺带：未分组实例的 `groupId` 是空串（假值），裸读会把它们踢出组序，**拖拽名次成了死代码**（今天恰好不出错只因 `resort` 让两序同步，是巧合） | `instanceInfo.length === 0` 时一律不过滤、只按拖拽序排；组序改用 read-model 的 `groupOf` |
| F2 | `CardView.tsx` + `App.tsx` | 空态的「显示全部分组」写成 `for (const g of hiddenGroups) onToggleGroup(g)` —— 循环里每一轮都从**同一份闭包**的 `hiddenGroups` 出发，`setHiddenGroups` 被旧值覆盖 N 次，净效果是**只放开最后一组**。下拉里的「全部」项同理：它 toggle 一个不存在的哨兵组 id，点它是**纯空操作**，隐藏之后没有回来的路 | 新增 `onShowAllGroups`（一次清空黑名单），下拉「全部」与空态按钮都走它 |
| F3 | `skins.css` | 分组那一节用了 **CSS 不认的 `//` 行注释**。构建**不报错**，但解析器把它当非法选择器连同后面的规则一起吞掉 —— 实测产物里 `.prow-group` / `.grp-note` / `.grp-filter .grp-select` **全部不存在** | 改成块注释；已在注释里记下实测结论 |
| F4 | `--uitest` 分组探针 | 按「单选当前组」写，而存储是**黑名单**：先点 G2..Gn 再点 G1 → G1 也被藏 → 列表全空 → `grpHideCards` 必红；还原时点「全部」在旧实现下只多加一个哨兵，卡片回不来 → `grpRestore` / `grpHiddenCleared` 也必红。`--uitest` 不在 `npm test` 链里，所以这两条错一直没人跑出来 | 探针按黑名单语义重写；顺带加了「全隐藏 → 空态 → 一次点回全部」这条真正走得到空态的路径（受控 select 在只剩一组可见时会自钉在那一项，值没变时 React 会吞掉 change，所以每步先回「全部」再点目标组） |
| F5 | `providers.ts` | `sanitizeGroupId` 的 32 字符截断按 UTF-16 码元计数，emoji 占 2 个码元 → 第 32 位落在代理对中间时切出**半个字符**（U+FFFD），而组名会一路进 `<option>`、SVG 与托盘文案 | 截断后去掉结尾的落单高位代理；并补 T21e/T21e2 |
| F6 | `providers.ts` / `uitest` | `test-adapters.mjs` **整个 T 段没被碰** —— 注册表侧（清洗 / 「无变化不写」守卫 / `.map()` 归一化 / `baseUrlHost`）**零测试**，正好是约束里点名要照抄 `reorderInstances` 守卫的那一处 | T 段补 T21a–T21o（19 项），含用**调用计数**判「无变化不写」（比文件内容是恒绿的门） |
| F7 | `test-read-model.mjs` | 纯度断言的编号与 I25/I26 重复（重名会让失败信息指向错那条）；AC 12/2/3/4 这几条**没有任何守卫** | 重新编号为 I31/I32；补 J5–J13（判缺失写法 / 主进程不读 groupHidden / 设置页文案 / 空守卫 / 一次清空 / 哨兵撞名），每条都实测过反验会红 |

**未做（留给后续，不在本任务范围）**

- `read-model.ts` 里分组判定没有独立的「组是否存在」判断 —— 组名只在删除实例时自然消失（D2 的刻意语义）。
- `--uitest` 跑不到「单组可见」这一支时会整段 `skip`（需要用户恰好有 ≥2 个组、且其中一组有已配置成员）。
- 下拉的交互是「点某组 = 藏它，再点 = 放回」，不是「点某组 = 只看它」。storage 仍与 design.md 的黑名单契约一致，
  但如果用户预期的是筛选器语义，那是产品决策，需要主会话拍板后再改（会牵动 `ui:groupHidden` 的读侧）。

## Rollback

- **纯增量**：`groupId` / `distinguishKey` 都是**可选**字段，旧数据读出来即缺省。
  回滚 = 撤代码 + 清 `ui:groupHidden`（注册表里的 `groupId` 残留无害，读侧忽略）。
- ⚠ 但**不做数据迁移回滚**：已分组的数据会留在注册表里。若要彻底清空需手工编辑
  `secrets.bin` 的 extras —— 因此**不写自动迁移**，读侧 `.map()` 归一化已经够用。
