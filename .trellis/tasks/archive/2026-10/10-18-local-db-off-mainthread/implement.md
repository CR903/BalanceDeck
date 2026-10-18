# 实施计划：本机用量扫描移出阻塞路径（孩子 B）

## 0. 前置

- 依赖：无（与孩子 A 互不依赖；`package.json` 的 `test` 串两边都会加一行 —— **若并行实施，此项要串行合入**）。
- 读：`prd.md` → `design.md` → `.trellis/spec/adapters/index.md` → `.trellis/spec/frontend/type-safety.md`。
- 纪律：先建护栏再改行为；`npm run typecheck` 与 `npm test` 都要跑。

## 1. 有序清单

### 步骤 1：夹具与"旧口径基准"先立起来

- [ ] 新增 `scripts/test-local-scan.mjs`：用 `node:sqlite` 建临时表（照抄 `design.md` §3 引用的真实 DDL：`session_message(id, session_id, type, seq, time_created, time_updated, data)`+ 两个索引），插入覆盖性数据：正常行 / `cost<=0` / 非 `opencode-go` / 新老两代字段形状（`providerID` 顶层 vs `model.providerID`）/ 边界时间。
- [ ] 在套件里**先实现一份"旧口径基准"**（整条 `data` 取回 + `JSON.parse` + 现有的 `parsePoint` 判据），作为等价性比对的**参照物**。它是本任务最重要的护栏：口径不许漂。
- [ ] 注册 `test:local-scan`；此时只跑基准自检（旧口径内部一致性）。

### 步骤 2：投影 + 缓存键（R1/R2）

- [ ] 新增 `src/main/adapters/opencode-local.ts`：`createLocalScanner` + 单条 `json_extract` 投影 + `dbStamp()`（**不含 `-wal`/`-shm`**）+ TTL 10 分钟 + `lastRun()` 诊断。
- [ ] 断言（AC1）：只动 `-wal` → `mode === 'cache'`；动主库 → `'full'`；TTL 到期 → `'full'`。
- [ ] 断言（AC2 上半）：`scan()` 的结果与步骤 1 的旧口径基准**逐点相等**（`pts` 与 `byModel`）。
- [ ] 弄坏一次确认变红（把 `-wal` 加回 stamp 应让 AC1 变红）。

### 步骤 3：增量（R3）

- [ ] 加内存行快照 `Map<id, LocalPoint>` + `watermark = max(time_updated)` + 回退 10 分钟窗口；合并按 `id` 覆盖，最后按 `t > since` 裁窗口。
- [ ] 断言（AC2 下半）：**增量累积 == 一次性全量**（逐点）。
- [ ] 断言（AC3）：改大某行 `cost` 并推进 `time_updated` → 只出现一次且是新值；删行 → 结果里消失。
- [ ] 弄坏一次：把合并键从 `id` 换成 `t|cost`，AC3 必须变红，然后还原。

### 步骤 4：接回 `opencode.ts`

- [ ] `loadLocal()`/`localCache`/`fileStamp`/`localDbStamp` 从 `opencode.ts` 移除，改为模块级 `createLocalScanner({ detectDbPath })` 装配；`loadLocal(nowMs)` 保留同名同签名（调用点零改动）。
- [ ] 全量/增量的耗时与行数写 `debugLog`（R4）：`本机扫描 full 761ms rows=14029` / `delta 1ms rows=70`。
- [ ] `npm run typecheck` + `npm test`：既有 19 段**零新增失败**（尤其 `test-adapters` / `test-read-model` / `test-cli-export` / `test-quality`）。

### 步骤 5：同型隐患（R6/R7）

- [ ] `antigravity.ts`：`execFileSync` → `execFile`（promisify，`timeout: 5000`）+ 5 分钟凭据缓存；失败级联语义不变。
- [ ] `test-adapters.mjs` 加静态守卫：`opencode-local.ts` 与 `antigravity.ts` 整文件零 `execFileSync`。
- [ ] `claude.ts` / `codex.ts`：目录 `mtime` 短路（`Map<dir, {mtimeMs, files[]}>`）；补"目录未变 → `readdir` 不被调用"的计数桩断言。
- [ ] 若 §5.2 的改动回归面超预期：允许在本任务内标 deferred，**但必须**把结论写进 `docs/knowledge/`（判据与理由），不许静默放着。

### 步骤 6：真机验收

- [ ] 冷启动全量耗时与稳态增量耗时实测（638 MB 真库）：目标 < 900ms / < 50ms（AC4）。命令形如：

```bash
node -e "…用 opencode-local 的 scan(now) 计时…"   # 或 scripts/test-local-scan.mjs --real
```

- [ ] 跑起应用（`BALANCEDECK_DEBUG=1`），看两轮日志：第二轮应是 `delta` 且毫秒级。
- [ ] `sample <主进程 pid>` 10s：主线程无单次 > 200ms 热点（AC7），且不再出现 1.9s 的单点阻塞。

## 2. 验证命令

```bash
npm run typecheck
node scripts/test-local-scan.mjs
npm run test:adapters
npm test
BALANCEDECK_DEBUG=1 npm run dev   # 或 smoke，看 full → delta 两轮日志
```

## 3. 审查门

- **G1（步骤 1-2 后）**：等价性基准跑通且**新实现与旧口径逐点相等** —— 这是本任务的总闸门，不通过不许接回 `opencode.ts`。
- **G2（步骤 4 后）**：`npm test` 零新增失败（口径不许漂）。
- **G3（步骤 5 后）**：静态守卫先变红一次再变绿。

## 4. 回滚点

| 回滚点 | 位置 | 影响 |
|---|---|---|
| R1 | 步骤 2-3 之后 | `opencode-local.ts` 与测试是纯新增，产品路径未动 |
| R2 | 步骤 4 之后 | revert `opencode.ts` 一个文件即回到旧的 `loadLocal`（不并行留双实现） |
| R3 | 步骤 5 之后 | `antigravity` / `claude` / `codex` 三处互相独立，可分别 revert；无磁盘格式变更 ⇒ 无数据面回滚 |

## 5. 完成后

- `docs/daily/2026-10-18_local-db-off-mainthread.md` + `docs/index.md` 追加一行（AGENTS.md 门禁）。
- 沉淀 `docs/knowledge/`：候选两条 —— ①「活跃写入区（WAL）不能当缓存键」②「JSON 列里的数据：SQL 投影省内存，但页读取量只能靠增量或 worker 消除」。
- `trellis-check` → `trellis-update-spec` → commit → `/trellis:finish-work`。
