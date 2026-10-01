# Implement: P1-4 多账户分组管理

## Ordered Checklist

### Phase 1: 类型与注册表

- [ ] **1.1** `src/shared/types.ts`
  - [ ] `ProviderInstance` 增 `groupId?: string`（可选，无版本号）
  - [ ] `ProviderInfo` 增 `distinguishKey?: string`
  - [ ] ⚠ `ProviderSnapshot` **不加**字段（9 个适配器都不该关心它）
- [ ] **1.2** `src/main/providers.ts`
  - [ ] `setInstanceGroup(id, groupId)`：写前**清洗**（截断 32 字符、剥控制字符）
  - [ ] 读出注册表时用 `.map()` 归一化（旧实例补 `groupId: ''`）—— 沿用 `encodePetState` 的迁移先例
  - [ ] ⚠ 照抄 `reorderInstances:348` 的「**无变化不写**」守卫（`setExtra` 是无条件整文件重写）
  - [ ] `ProviderInfo` 组装时填 `distinguishKey`（如 baseUrl 的 host；无则空串）
- [ ] **1.3** `src/main/ipc.ts`：新增 `providers:setGroup`，**逐字段复验**
  - [ ] `id` 非空字符串；`groupId` 字符串（空串 = 移出分组）
  - [ ] 入参形状**不改** `providers:reorder`（`ipc.ts:175` 的守卫保持原样）

### Phase 2: 纯函数 read-model.ts（零成本落点）

- [ ] **2.1** `src/renderer/src/read-model.ts` 新增三个导出
  - [ ] `UNGROUPED = '未分组'` 常量
  - [ ] `groupNames(info)`：去重 + 升序 + 含 `UNGROUPED`（当存在无 groupId 的实例）
  - [ ] `visibleIds(info, hiddenGroupIds)`：不在隐藏列表里的实例 id 集合
  - [ ] `orderForDisplay(info, hiddenGroupIds)`：组间按组首成员位置、组内按数组顺序
- [ ] **2.2** 纯函数纪律：不改 `now` 语义、不碰 DOM、**入参不被就地修改**

### Phase 3: 渲染层

- [ ] **3.1** `src/renderer/src/App.tsx`
  - [ ] extras 读 `ui:groupHidden`（⚠ 判「键缺失」只能用 `!v`，`extras:get` 对缺失键返回 `''`）
  - [ ] 分组下拉：选项 = `groupNames(...)`
  - [ ] 传给 `CardView` 的列表用 `orderForDisplay(...)` 排序
  - [ ] 切换分组的回调：写 `ui:groupHidden`
  - [ ] `setInstanceGroup` 的 IPC 接线
  - [ ] ⚠ **只改 App.tsx，不碰 `DetailView.tsx`**（趋势图子任务正在用它）
- [ ] **3.2** `src/renderer/src/CardView.tsx`
  - [ ] 同名多账号时名称后缀加 `distinguishKey`（如 `Claude 公司`）
  - [ ] 无 `distinguishKey` 时**不加后缀**（与今天一致，不造「(2)」假区分）
- [ ] **3.3** 设置页文案（**不是可选项**）：明确写
      「隐藏只影响列表显示，托盘与提醒仍覆盖全部账户」—— 否则用户会以为隐藏后收不到告警

### Phase 4: CSS

- [ ] **4.1** `skins.css` 加分组下拉的 class（沿用 `.field` / `.section-title` 既有规则与 token）

### Phase 5: 测试

- [ ] **5.1** 扩展 `scripts/test-read-model.mjs`（**不新增脚本、不改 `package.json`** —— 见父任务 prd.md）
  - [ ] 覆盖 design.md Tests Required 第 1–8 条
  - [ ] 第 5 条（组末成员移走后位置重算）钉住 D4 的已知代价
  - [ ] 第 7 条（入参深比较）必须实测，不能只写断言
- [ ] **5.2** `src/main/qa/uitest.ts` 加断言（design.md 第 9–11 条）
  - [ ] 分组下拉列出正确组名；切组后列表只剩该组成员
  - [ ] 隐藏组后**卡片列表**变、**托盘标题不变**（D6 的行为断言）
  - [ ] 同名两账号卡片名带不同后缀
  - [ ] ⚠ 若托盘/趋势图子任务也在改 `uitest.ts`，各自只加自己的键，合并时人工去重

## Review Gates

- [ ] `npm test` 通过
- [ ] `npm run typecheck` 通过
- [ ] **反验**：把 `visibleIds` 改成按实例 id 过滤（而非组 id）→ 5.1 必须报红
- [ ] **反验**：把 `orderForDisplay` 改成纯数组顺序（不分组）→ 5.1 第 4 条必须报红
- [ ] `trellis-check` 对照 prd.md 验收标准逐条复核

## Rollback

- **纯增量**：`groupId` / `distinguishKey` 都是**可选**字段，旧数据读出来即缺省。
  回滚 = 撤代码 + 清 `ui:groupHidden`（注册表里的 `groupId` 残留无害，读侧忽略）。
- ⚠ 但**不做数据迁移回滚**：已分组的数据会留在注册表里。若要彻底清空需手工编辑
  `secrets.bin` 的 extras —— 因此**不写自动迁移**，读侧 `.map()` 归一化已经够用。