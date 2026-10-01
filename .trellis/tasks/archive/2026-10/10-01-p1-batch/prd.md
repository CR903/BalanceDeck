# P1 批次：趋势图 / 托盘配色 / 账户分组 / JSON 导出

## Goal

落地竞品报告 P1 档的四项优化，四项**并行开发、分别验收**：

| 子任务 | 交付物 | 来源 |
|---|---|---|
| `10-01-p1-trend-chart` | 详情页 7/30 天用量趋势图（轻量 SVG） | P1-1 |
| `10-01-p1-tray-color` | 托盘按阈值着色 + 状态点角标 | P1-3 |
| `10-01-p1-account-groups` | 账户分组/标签 + 每组独立显隐与排序 | P1-4 |
| `10-01-p1-cli-export` | `balancedeck export --json` | P1-6 |

调研依据：`.trellis/tasks/archive/2026-09/09-30-similar-projects-research/research/report.md` 第 4 节 P1 档。

## Background

P0 批次已全部完成并归档（额度阈值提醒 + 系统通知、用量预测与预计耗尽时间），
其中 **P0-2 落下的本机快照存储（`src/main/usageStore.ts`，30 天分窗口、15 分钟粒度）
是 P1-1 趋势图与 P1-6 JSON 导出的现成数据源** —— 四项里两项不需要新增数据采集。

P0 阶段积累的两条硬约束在本批次继续有效：

1. **`setExtra` 每次全量重写整个文件** → 时序数据不得走 `extras`（见
   `.trellis/spec/frontend/state-management.md`「extras 装不下时序数据」契约）
2. **数据诚实**：任何展示或导出里 `cached` / `local` 必须显式标注，
   取自 `shared/quality` 的 `staleLabel`，**不在新模块里写第二份判断**

## Task Map（父子结构）

```
10-01-p1-batch（本任务：需求集 / 任务图 / 跨子任务验收 / 最终集成评审）
├── 10-01-p1-trend-chart     （读 usageStore + usagePredict 既有产物）
├── 10-01-p1-tray-color      （读 tray.ts / tray-text.ts）
├── 10-01-p1-account-groups  （写 providers 注册表 + 卡片列表）
└── 10-01-p1-cli-export      （读 scheduler.currentState + usageStore）
```

**父子结构不是依赖系统。** 各项的真实约束写在各自 `prd.md` 里，已知冲突如下：

| 冲突项 | 涉及子任务 | 处置 |
|---|---|---|
| `App.tsx`（账户分组要加分组切换 UI，趋势图要加区块） | groups ↔ trend-chart | 趋势图只改 `DetailView.tsx`，账户分组只改 `App.tsx` 的**列表层**，两者文件不重叠 |
| `DetailView.tsx` | trend-chart（加区块） | P1-4 不改 `DetailView.tsx`（同名多账号区分落在 `CardView` 的展示标签上） |
| `package.json` 的 `test:` 链 | 四项各自加脚本 | **合并时统一接一次**，子任务提交里先不动 `test` 链，改为在各自 `implement.md` 注明待接 |
| `extras` 键表 | groups（分组配置）↔ cli-export（导出不含分组） | 键名各占各的命名空间，无重叠 |

## Cross-Child Acceptance Criteria

- [ ] `npm test` 全绿（四项的新测试脚本都已接入 `test` 链）
- [ ] `npm run typecheck` 通过
- [ ] 无新增网络请求（沿用 P0 的纪律：四项都不该引入出网调用）
- [ ] 数据诚实：`cached` / `local` 在**每一处**新增展示与导出里都显式标注，且判定统一走 `staleLabel`
- [ ] 不新增时序数据落到 `extras`（唯一的时间序列仍是 `usage-history.json`）
- [ ] 每一项都有 `--uitest` 键或等价的可观察断言（不留「只有逻辑测试、界面无人验证」的缺口）
- [ ] 本父任务的 spec 更新（Phase 3.3）覆盖四项新增的跨进程契约

## Out of Scope

- **P1-2 供应商覆盖扩展**：补新适配器是另一类工作（各有各的协议与 fixture），不塞进本批次
- **P1-5 资源占用优化**：其中「评估 Tauri 迁移」是一个独立的调研任务，另开
- **像素宠物瘦身**（另一条研究线）：结论已记录在
  `.trellis/tasks/archive/2026-09/09-30-pixel-pet-assets-research/` ——
  **没有合适的 2D 宠物素材就等于废掉整个数字助理**，因此该线暂缓，
  等真正拿到可用素材再动，不是现在能启动的工程任务

## Notes

- 四个子任务**并行**推进，各自定义、实现、验收、提交。
- 并行冲突面已在 Task Map 里逐项列出；合并时按「先合不改公共文件的，最后统一接 `test` 链」处理。
- 每项都是**复杂任务**（动到跨进程契约或已有模块），`task.py start` 前各自需要
  `prd.md` + `design.md` + `implement.md`。