# 面板按组分块展示

## Goal

去掉标题栏的分组筛选下拉，卡片列表按组分块展示（组头 + 计数 + 卡片网格），
未分组供应商默认归入"未分组"块。顺带消除"下拉点不动"的根因（控件本身被删除）。

## Requirements

### R1 · 按组分块展示
1. 列表按 `groupNames(instanceInfo)` 的顺序分块（自定义组升序，"未分组"末尾——现成顺序，直接复用）。
2. 每块结构：组头（组名 + 该组卡片计数）+ 该组卡片网格（现有 `.pcard-grid` 复用）。
3. 组内卡片顺序沿用现有"组内拖拽序"，组间顺序沿用现有组序——只是渲染切分，不重排。

### R2 · 未分组兜底
4. groupId 空串/缺省的实例进"未分组"块（`groupOf` 归一化已存在，不新增判定）。
5. 快照有、instanceInfo 查不到的未知实例：照样显示，归入未分组块末尾，
   但**不打组标签**（不知道≠未分组，D5b 数据诚实延续）。

### R3 · 删除筛选下拉
6. 删除标题栏 `.grp-filter` 下拉及其全部管线（effFilter/selectValue/哨兵/groups prop/applyGroupFilter/groupFilter state）。
7. 存量 `ui:groupFilter` extras 键残留磁盘无害——不再读取，不写迁移代码。
8. "分组已全部隐藏"空态随筛选一并删除（无筛选即无此状态）；保留"未配置供应商"空态。

### R4 · 既有行为保持
9. 拖拽排序、FLIP 动画、窗口偏好、aria 语义、空态文案 tone——除分块必需的改动外原样保留。
10. 采集/托盘/提醒覆盖全部账户（本来就与筛选无关，删筛选后天然成立，无需额外工作）。
11. 卡片组名小标签在组内删除（分块后冗余）；aria-label 的组名后缀保留（读屏仍可辨）。

## Constraints

- **`read-model.ts` 一行都不碰**（`groupOf`/`groupNames`/`UNGROUPED`/`orderForDisplay` 全部复用）。
- **不新增存储**：不新增 extras 键（折叠态也不做，v1 块恒展开），不新增 IPC。
- **不碰采集/主进程**：改动面只在 `src/renderer/src/{CardView,App}.tsx` + `skins.css` + `uitest.ts`。
- **uitest P1-4 段必须同步重写**（见 design.md D8）——改 UI 不改其断言等于留一批必红。
- **CSS 只增组头、删 select**：`prow-group`（设置页归组下拉）别误删，skins.css:1307 有警告。
- **不新增网络请求**；缺失值保持 `null` 绝不填 0（P0 纪律延续，与本次无关但重申）。

## Acceptance Criteria

- [ ] AC1 标题栏无分组下拉，`.grp-select` 在产物 DOM 中不存在
- [ ] AC2 有 N 个组的 fixtures 下渲染 N 个块，组头文案 = 组名 + 计数，顺序与 `groupNames` 一致（未分组末尾）
- [ ] AC3 未分组实例出现在"未分组"块；未知实例（快照有、注册表无）同样显示在末尾且无组标签
- [ ] AC4 组内卡片无组名小标签；读屏 aria-label 仍含组名
- [ ] AC5 组内拖拽排序有效（FLIP 无回归）；跨块拖拽语义与改动前一致（组优先，不改变归属）
- [ ] AC6 `ui:groupFilter` 存量值存在时界面不受影响（直接忽略）
- [ ] AC7 "分组已全部隐藏"空态消失；无配置时仍是"还没有配置供应商"空态
- [ ] AC8 `npm test` 全绿（19 套件断言数对照，见 implement.md 基线）
- [ ] AC9 `npm run typecheck` 通过
- [ ] AC10 `npm run uitest` 全绿（含重写后的 P1-4 段）
- [ ] AC11 **反验实测**：回退任一删除（如恢复 select）→ 对应 uitest 断言必须红
