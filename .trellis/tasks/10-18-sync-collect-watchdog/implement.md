# 实施计划：采集轮级看门狗（孩子 A）

## 0. 前置

- 依赖：无（不依赖孩子 B）。
- 读：`prd.md` → `design.md` → `.trellis/spec/frontend/{quality-guidelines,hook-guidelines,state-management,component-guidelines}.md` → `.trellis/spec/adapters/index.md`（接缝契约）。
- 纪律：先建护栏再改行为；`tsc` 与 `npm test` 都要跑（`tsc` 不在 `npm test` 里）。

## 1. 有序清单

### 步骤 1：纯逻辑骨架（不碰产品路径）

- [ ] 新增 `src/main/deadline.ts`：`withDeadline`（`design.md` §2.1 契约）。
- [ ] 新增 `scripts/test-deadline.mjs` + 在 `package.json` 的 `test` 串注册 `test:deadline`。
- [ ] 跑 `node scripts/test-deadline.mjs`；再**故意弄坏一次**（例如把超时分支改成 reject）确认变红，然后还原。

### 步骤 2：调度循环（纯逻辑）

- [ ] 新增 `src/main/collect-loop.ts`：`createCollectLoop`（`design.md` §2.2 契约 + 轮次语义表）。
- [ ] 新增 `scripts/test-collect-loop.mjs`，覆盖 `design.md` §4 里列出的全部断言（幂等 start / started-queued / 合并 / epoch 失效 / 超时后继续 / stop / 无遗留定时器）。
- [ ] 注册 `test:collect-loop`；弄坏一次确认变红（重点弄坏"epoch 失效"那条 —— 它守的是 R2）。

### 步骤 3：出网兜底超时

- [ ] 改 `src/main/request.ts`：race + abort 双保险 + `decided` 标志（`design.md` §2.4）。
- [ ] 扩展 `scripts/test-seam.mjs`：桩 fetch 永不 settle → 断言 `AbortError` 在 `ms` 量级内抛出；并断言**迟到成功不把可达性记账清零**。
- [ ] `npm run test:seam`。

### 步骤 4：控制流切到循环

- [ ] 改 `src/main/scheduler.ts`：保留 `collect` 的轮体（采集/合并/推送/历史采样）不变；控制流改为 `createCollectLoop({ intervalMs: refreshIntervalMs, runRound, budgetMs: 120_000, slowWarnMs: 45_000, onTimeout: push+log })`。
- [ ] 轮体内（`collect`）在写 `lastSnapshots` / `lastSync` / `push` / `updateTray` **之前**加 `current(epoch)` 判断（R2）。`sampleUsageHistory` 保持在收尾路径且仍 `void … .catch()`。
- [ ] `refreshNow()` → `loop.requestRefresh()`；`reconfigure()` → `loop.reconfigure()`；`stopScheduler()` → `loop.stop()`；`startScheduler()` → `loop.start()`。保持这些导出名与签名不变（`index.ts` / `ipc.ts` 的调用点零改动）。
- [ ] `AppState` 追加 `lastTimeoutAt?: string`（`shared/types.ts`），由 `push` 带上。
- [ ] `npm run typecheck` + `npm test` 全绿。

### 步骤 5：通道与渲染层

- [ ] `ipc.ts`：`ipcMain.handle('ui:refresh', () => loop.requestRefresh())`。
- [ ] `preload/index.ts` + `renderer/src/api.d.ts`：`refreshNow(): Promise<RefreshOutcome>`。
- [ ] `DetailView.tsx`：props 加 `scanning: boolean`；刷新 `IconButton` 加 `className={scanning ? 'spinning' : ''}`；状态行按 `lastTimeoutAt` 追加最小提示。
- [ ] `App.tsx:1161` 传 `scanning={state.scanning}`。
- [ ] `qa/uitest.ts` 加一条：进详情页 → 点击刷新 → 断言按钮带 `spinning`。
- [ ] `npm run typecheck && npm test && npm run uitest`。

### 步骤 6：真机验收

- [ ] 构建并跑：`BALANCEDECK_DEBUG=1 npm run smoke`（或 dev 常驻），制造一次挂起（桩/临时把 `budgetMs` 调到 3s），确认日志出现"超时 → 复位 → 下一轮成功"，且 `balance-export.json` 的 `updatedAt` 继续前进。
- [ ] 恢复 `budgetMs`；连续观察 ≥ 10 分钟：每轮 `updatedAt` 前进、点详情页刷新按钮有反馈。
- [ ] 取证（命令 + 输出）写进本任务 `prd.md` 的验收小节与 `docs/daily/2026-10-18_sync-collect-watchdog.md`。

## 2. 验证命令

```bash
npm run typecheck
node scripts/test-deadline.mjs
node scripts/test-collect-loop.mjs
npm run test:seam
npm test
npm run uitest
BALANCEDECK_DEBUG=1 npm run smoke
```

## 3. 审查门

- **G1（步骤 2 后）**：纯逻辑两个模块 + 两套测试就绪，且逐条弄坏确认变红 → 才允许动 `scheduler.ts`。
- **G2（步骤 4 后）**：真正跑一轮 `npm test`；重点看既有 19 个测试段是否**零新增失败**（正常路径行为应逐字不变）。
- **G3（步骤 5 后）**：`uitest` 的 DOM 断言真的变红了（先不加 `spinning` 跑一次）。

## 4. 回滚点

| 回滚点 | 位置 | 影响 |
|---|---|---|
| R1 | 步骤 1-3 之后 | 纯新增 + 一处 `request.ts` 改动；revert `request.ts` 即完全回到旧超时行为 |
| R2 | 步骤 4 之后 | revert `scheduler.ts` 一个文件即回到旧控制流（不保留双实现） |
| R3 | 步骤 5 之后 | 通道/UI 独立回滚；`spinning` 只是表现层，回滚不影响采集 |

## 5. 完成后

- `docs/daily/2026-10-18_sync-collect-watchdog.md` + `docs/index.md` 追加一行（AGENTS.md 门禁）。
- 有通用解法（"预算 + epoch 失效 + 循环式调度"）→ 沉淀 `docs/knowledge/`。
- `trellis-check` → `trellis-update-spec` → commit → `/trellis:finish-work`。
