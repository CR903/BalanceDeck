# Implement: 面板按组分块展示

> ### 📌 基线（实测，AC8 的对照基准 —— 直接引用，不必重测）
>
> | 套件 | 项数 |
> |---|---|
> | 全部 20 套件 `✓` 合计 | **2172**（2026-10-02 实测，OpenAI 任务基线） |
>
> ⚠ 本任务改的是渲染层 + uitest：`npm test` 的 20 套件**必须逐个与基线一致**
> （只允许 uitest 自身行为变——uitest 不在 `npm test` 内，无影响）。
> 任何一个套件变了，说明改动越界，**停下来查**。

## Ordered Checklist

### Phase 1: CardView 分块渲染（只改 `src/renderer/src/CardView.tsx`）

- [x] **1.1** 删除标题栏 `.grp-filter` 下拉 JSX（含单选语义注释块）
- [x] **1.2** 删除 props `groupFilter` / `groups` / `onSetGroupFilter`（含类型注释）
- [x] **1.3** 删除 `ALL_GROUPS_VALUE` / `ALL_GROUPS_LABEL` 常量及撞名防护注释块；
      `ALL_GROUPS` import 若无他用一并删（有他用则留，grep 确认）
- [x] **1.4** 删除 `effFilter` / `selectValue`；`shown` 的筛选条件恒 false 化
      （保留未知实例显示语义 + "将来解开位置"注释行）
- [x] **1.5** 删除"分组已全部隐藏"空态分支（含 `empty-cta` 回全部按钮）；
      保留"未配置"与兜底空态
- [x] **1.6** 按 design.md Contracts 形状加分块渲染（`section[role=group]` + 组头 + 网格）；
      `gridRef` 改挂外层容器；`slotRects`/FLIP 选择器不变（全局 `[data-card-id]`）
- [x] **1.7** 删除组内卡的 `GroupTag` 调用（确认 `GroupTag` 无他处引用后删组件）；
      aria-label 组名后缀保留
- [x] **1.8** `npm run typecheck` 通过（每改完一个文件跑一次，别攒到最后）

### Phase 2: App.tsx 管线删除（只改 `src/renderer/src/App.tsx`）

- [x] **2.1** 删除 `groupFilter` state + `applyGroupFilter`（含注释块）
- [x] **2.2** 删除 `groups` memo + `<CardView>` 的三个 props
- [x] **2.3** 删除 extras 恢复 effect 中的 `setGroupFilter` 行（effect 本体保留）
- [x] **2.4** `npm run typecheck` 通过；确认 `groupNames` import 在 App.tsx 是否仍有用
      （无用则删，有用则留——grep 确认，不猜）

### Phase 3: CSS（只改 `src/renderer/src/skins.css`）

- [x] **3.1** 新增 `.pcard-section` / `.pcard-section-head` / `.count`（沿用现有变量，无新色值）
- [x] **3.2** 删除 `.grp-filter` / `.grp-select` / `:focus` 三段
- [x] **3.3** 确认 `.prow-group`（1311-1345）未动（设置页归组下拉，另一功能）；
      确认 `.icon-btn` 的 `no-drag` 未动
- [x] **3.4** 实机看一眼（`npm run build` + 开面板）：组头排版正常，无裸奔控件
      （skins.css 缺类名构建不报错，只丢排版——肉眼是唯一的守卫）

### Phase 4: uitest P1-4 段重写（`src/main/qa/uitest.ts`）

- [x] **4.1** 按 design.md D8 键清单删除筛选键断言，新增四个分块键；
      改 `grpGroupTag` 为"组内无标签、组头有组名"；`grpDup*` 保留并改"筛选"表述
- [x] **4.2** 删除 `ui:groupFilter` 写入探针步骤（无写入路径了）
- [x] **4.3** `npm run build` 后跑全量 `--uitest`，P1-4 段全绿
      ⚠ 改完先 build 再测（`--uitest` 测的是 `out/`，旧产物会测出假绿/假红）

### Phase 5: 收尾验证

- [x] **5.1** `npm test` → 20 套件与基线逐个一致
- [x] **5.2** `npm run typecheck` → clean
- [x] **5.3** 静态守卫：`grp-select` 在 `src/renderer/` 零出现；
      `groupFilter` 在 `src/renderer/` 零出现；
      `ui:groupFilter` 在 `src/renderer/` 只允许出现在注释
- [x] **5.4** **反验**：恢复 select（或任一删除项）→ 对应 uitest 键必须红；
      跑完恢复，复跑确认全绿
- [x] **5.5** **存量回归**：extras 里写一个非空 `ui:groupFilter` → 面板显示全部，不受影响

## Review Gates

- [x] `npm test` 通过，且 20 套件断言数 == 基线
- [x] `npm run typecheck` 通过
- [x] 全量 `--uitest` 通过（含重写后的 P1-4 段）
- [x] 静态三守卫全绿
- [x] 反验实测红集 + 存量回归验证
- [x] `trellis-check` 对照 prd.md 的 **11 条 AC** 逐条复核

## Rollback

| 改动 | 回滚 |
|---|---|
| CardView 分块 | `git checkout -- src/renderer/src/CardView.tsx`（单文件） |
| App.tsx 管线删除 | `git checkout -- src/renderer/src/App.tsx` |
| skins.css | `git checkout -- src/renderer/src/skins.css` |
| uitest P1-4 | `git checkout -- src/main/qa/uitest.ts`（注意：回滚产品代码必须同步回滚 uitest，\
否则新断言对旧 UI 全红——顺序：先回滚 uitest，再回滚产品代码，或一起回滚） |

⚠ uitest 与产品代码是锁步对：任何单边回滚都会红。回滚操作必须双边一起做。
