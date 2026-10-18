# 实施计划：本机用量首轮全量移出主线程（任务 C）

## 0. 前置

- **依赖（硬）**：`10-18-local-db-off-mainthread` 已归档（已完成）。
- **前置约束（重要）**：父任务的装机后真机复测（AC3/AC4）必须先结束，**才能**开始本任务的实施。理由：本任务的验收含"打包态验证"，会重新 `dist:mac` 并覆盖 `/Applications/BalanceDeck.app` —— 在复测测量窗口内重装会让测量对象中途换包，把父任务的取证作废。
- 读：`prd.md` → `design.md` → `.trellis/spec/adapters/local-db-scan.md`（B 的既有契约，不许改口径）→ `.trellis/spec/adapters/index.md` → `.trellis/spec/frontend/state-management.md`（采集循环契约：超时与迟到结果丢弃的既有纪律）。
- 纪律：先建护栏再改行为；`npm run typecheck` 与 `npm test` 都要跑。

## 1. 有序清单

### 步骤 1：宿主骨架（纯逻辑 + 假 worker）

- [ ] 新增 `src/main/adapters/local-scan-host.ts`（`design.md` §3 契约：`runFull` / `stop` / `lastRun`；降级必须留痕；超时按整次扫描计；迟到结果丢弃）。
- [ ] 新增 `scripts/test-local-scan-host.mjs`，覆盖 `design.md` §7 的 5 条（正常 / 入口不存在 / 抛错 / 永不返回 + 迟到丢弃 / stop 幂等 + 无遗留句柄）。
- [ ] 注册 `test:local-scan-host`；弄坏一次确认变红（重点：去掉 `degradedReason` → 第 2/3 条必须红；去掉迟到丢弃 → 第 4 条必须红）。

### 步骤 2：worker 入口 + 构建接线

- [ ] 新增 `src/main/adapters/local-scan-worker.ts`：只做"读库 → 产出 `{ pts, byModel }`"，逻辑**复用** B 的投影 SQL（不许复制第二份口径 —— 抽公共函数，两边 import 同一份）。
- [ ] `electron.vite.config.ts` 的 main 侧加第二个 input，产出 `out/main/local-scan-worker.js`；`npm run build` 后确认该文件真的存在。
- [ ] 接入 `opencode-local.ts`：**只有 `full` 分支**走宿主，`delta`/`cache` 保持主线程（`design.md` §4）。
- [ ] `npm run typecheck` + `npm test`：既有 22 段零新增失败（尤其 `test-local-scan` 的等价性断言）。
- [ ] 扩展 `test-local-scan.mjs`：全量用例同时跑 `via='main'` 与 `via='worker'`，断言与冻结基准逐点相等（AC2）。

### 步骤 3：打包态验证（G2，本任务的核心门）

- [ ] 新增 `scripts/verify-worker-packaged.mjs`：正向（从 `dist` 的 `.app` 启动 → 日志证明 `via='worker'`）+ 负向（把 `workerPath` 指向不存在文件 → 断言降级日志出现、数据完整、主线程阻塞回到秒级）。
- [ ] 若 asar 内 `new Worker()` 加载失败：按 `design.md` §5 用 `asarUnpack` + 双路径解析修，然后**重跑同一脚本**确认正向通过。若 `worker_threads` 在打包态被证明不可行 → 换 `utilityProcess`（宿主接口不变，只换传输）。
- [ ] 装机：`npm run dist:mac` + 覆盖 `/Applications/BalanceDeck.app`，再跑一次正向验证（AC3）。

### 步骤 4：生命周期与收尾收益

- [ ] 退出/停机时终止宿主（`app` 退出路径 + `stopScheduler()`）；断言退出后 `ps` 无残留（AC5）。
- [ ] R6 决策：实测"把全量核对间隔从 6h 收紧到 X"时的主进程阻塞是否仍 < 50ms。收紧 → 写数字 + 断言；不收紧 → 在 `prd.md` 写明理由与陈旧度上界。
- [ ] `npm run typecheck` + `npm test` 全绿；新护栏弄坏一次。

### 步骤 5：真机验收

- [ ] 装机后跑 ≥ 10 分钟：`balance-export.json` 的 `updatedAt` 每轮前进；首轮窗口内 `sample <pid>` 无 > 200ms 主线程热点（AC1/AC8）。
- [ ] 取证（命令 + 输出）写进 `prd.md` 验收小节与 `docs/daily/2026-10-18_local-db-worker-offload.md`。

## 2. 验证命令

```bash
npm run typecheck
node scripts/test-local-scan-host.mjs
node scripts/test-local-scan.mjs
npm test
npm run build && node scripts/verify-worker-packaged.mjs      # 打包态正向 + 负向
npm run dist:mac                                              # 装机验证（注意 §0 的前置约束）
```

## 3. 审查门

- **G1（步骤 1 后）**：宿主纯逻辑 + 5 条测试就绪，且降级留痕与迟到丢弃逐条弄坏确认变红 → 才允许接 worker。
- **G2（步骤 3 后）**：**打包态**正向 + 负向都通过。这一门不通过就不算完成 —— 本任务的全部风险都在这。
- **G3（步骤 4 后）**：`npm test` 零新增失败（口径不许漂）。

## 4. 回滚点

| 回滚点 | 位置 | 影响 |
|---|---|---|
| R1 | 步骤 1-2 之后 | 两个新模块 + 构建 input 是纯新增；`opencode-local.ts` 的 `full` 分支回滚即回到已验证的主线程全量 |
| R2 | 步骤 3 之后 | `asarUnpack`/`utilityProcess` 的改动各自独立可 revert |
| R3 | 步骤 4 之后 | 生命周期与核对间隔独立可 revert |

## 5. 完成后

- `docs/daily/2026-10-18_local-db-worker-offload.md` + `docs/index.md` 追加一行（AGENTS.md 门禁）。
- 沉淀 `docs/knowledge/`：候选「打包态才能复现的 worker 入口问题：正向 + 负向两次验证是唯一可靠的判据」。
- `trellis-check` → `trellis-update-spec`（`.trellis/spec/adapters/local-db-scan.md` 补宿主契约）→ commit → `/trellis:finish-work`。
