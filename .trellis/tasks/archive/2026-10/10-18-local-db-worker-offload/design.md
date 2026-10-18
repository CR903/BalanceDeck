# 设计：本机用量首轮全量移出主线程（任务 C）

## 1. 边界与文件清单

| 文件 | 改动性质 |
|---|---|
| `src/main/adapters/local-scan-worker.ts` | **新增**。worker 入口：只做"读库 → 产出 `LocalStats`"，不含任何 electron/装配依赖 |
| `src/main/adapters/local-scan-host.ts` | **新增**。主进程侧宿主：起 worker、发请求、收结果、超时、降级、生命周期。纯逻辑（不 import electron）⇒ 可用 `loadTs` + 假 worker 单测 |
| `src/main/adapters/opencode-local.ts` | 改造：全量路径委托宿主；增量路径保持主线程（它只有 1–30ms，移出去反而增加往返与失败面） |
| `electron.vite.config.ts` | main 侧新增一个 rollup input（worker 必须被单独 emit 到 `out/main/`） |
| `src/main/index.ts` 或 `scheduler.ts` | 退出/停机时终止宿主 |
| `scripts/test-local-scan-host.mjs` | **新增**测试套件（假 worker：正常 / 抛错 / 不返回 / 迟到返回） |
| `scripts/verify-worker-packaged.mjs` | **新增**打包态验证脚本（正向 + 负向） |

## 2. 方案选择：`worker_threads` vs `utilityProcess`

| 维度 | `node:worker_threads` | `utilityProcess.fork` |
|---|---|---|
| 运行时 | 同进程内 Node 线程，`node:sqlite` 可用 | 独立 Electron 子进程，Node 能力可用 |
| 生命周期 | `worker.terminate()`，随主进程退出 | 需要显式 `kill()`，否则可能留孤儿进程 |
| 数据回传 | `postMessage` + structured clone（`Map` 可克隆） | `parentPort.postMessage`，同样可行 |
| 打包风险 | 需要一个被 emit 的独立 JS 入口，运行时用 `join(__dirname, 'local-scan-worker.js')` 定位 | 同样需要独立入口；asar 内路径解析在部分版本上有坑 |
| 崩溃影响 | 线程崩 → 主进程仍在，降级可控 | 子进程崩 → 需处理 exit 事件 |
| 额外进程开销 | 无 | 一个额外进程 |

**决定：优先 `worker_threads`**，理由：(a) 崩溃与生命周期都比子进程好收（`terminate()` + 随进程退出）；(b) 不引入额外进程（用户机器上已经有一个 638MB 的库要读，再起进程无收益）；(c) 失败面更小（子进程还要处理 spawn 失败、路径、环境变量继承）。

**保留退路**：若打包态证明 `worker_threads` 的入口加载在 asar 内不可行，则改用 `utilityProcess`（宿主接口不变，只换 §3 的传输实现）—— 这正是把宿主抽成 `local-scan-host.ts` 的原因：**换传输不改调用方**。

## 3. 契约：`local-scan-host.ts`

```ts
export interface ScanRequest { dbPath: string; sinceMs: number }
export interface ScanResult { pts: LocalPoint[]; byModel: Map<string, { cost: number; tokens: number }> }

export interface ScanHost {
  /** 全量扫描。worker 不可用/超时/抛错 → 回退 `fallback()`（主线程同步实现） */
  runFull(req: ScanRequest, fallback: () => Promise<ScanResult | null>): Promise<{ result: ScanResult | null; via: 'worker' | 'main' }>
  /** 停机：terminate worker；幂等 */
  stop(): Promise<void>
  /** 诊断：本次走了哪条路、耗时、降级原因 */
  lastRun(): { via: 'worker' | 'main'; ms: number; degradedReason?: string } | null
}

export function createScanHost(opts: {
  workerPath: string
  timeoutMs?: number          // 缺省 20_000：全量实测最坏 4.4s（load 17），20s 留足余量
  log: (msg: string) => void
}): ScanHost
```

**三条纪律**：

1. **降级必须留痕**：`via: 'main'` 时 `degradedReason` 必须有值并写 `debugLog` —— 否则"静默降级"会让本任务白做（用户看到的还是秒级卡顿，而没人知道为什么）。
2. **超时按"整次扫描"计**，不是按消息往返：worker 卡在 sqlite 页读取上时也必须能回退。
3. **迟到结果丢弃**：超时回退后，worker 若迟到返回，其结果**不得**覆盖已采用的主线程结果（与 A 的 epoch 闸门同一纪律）。

## 4. 数据流

```
冷启动/全量触发
  └─ opencode-local.ts: 需要 full
       ├─ 有 host 且 worker 可用 → host.runFull(req, fallback)
       │     ├─ worker 在 timeoutMs 内返回 → via='worker'（主线程阻塞 ≈ 0）
       │     ├─ worker 报错/超时/入口不存在 → 记 degradedReason → fallback()（主线程同步，~0.7–4s）
       └─ 无 host（如纯 node 测试环境）→ fallback() 直接跑（口径与今天逐字相同）

增量（每轮）
  └─ 仍在主线程（1–30ms），不走 worker：移出去只会多一次往返与一条新的失败路径
```

## 5. 打包（R3，本任务的核心风险）

- `electron.vite.config.ts` 的 main 侧需要**第二个 input**（例如 `local-scan-worker`），产出 `out/main/local-scan-worker.js`；运行时用 `join(__dirname, 'local-scan-worker.js')` 定位（打包态 `__dirname` 指向 asar 内的 `out/main`，Electron 的 fs 补丁允许读取，但 `new Worker()` 需要**真实文件**——这是必须实测的第一件事）。
- 若 asar 内不可直接加载：把该文件列入 `electron-builder.yml` 的 `asarUnpack`（`out/main/local-scan-worker.js`）并让路径解析同时尝试 `app.asar.unpacked`。**这正是"只在打包态复现"的那类失败**，所以 AC3 要求正向 + 负向两次验证，且必须有可复现脚本（`scripts/verify-worker-packaged.mjs`）。
- 负向验证的做法：临时把 `workerPath` 指到一个不存在的文件 → 断言出现降级日志、数据仍完整、主线程阻塞回到秒级（证明"降级确实发生"，而不是"根本没走 worker"）。

## 6. 取舍：为什么**不**顺手加"磁盘行快照"

把已解析的行快照落盘（`id → LocalPoint`）可以免掉冷启动全量，看似比 worker 更省事。**不做**，理由：

- 它引入数据格式与迁移/回滚面（B 的 `design.md` 刻意保持了"无磁盘格式变更 ⇒ 无数据面回滚风险"）。
- 它**不能替代** worker：6 小时全量核对仍是一次全量扫描，在磁盘快照方案里照样阻塞主线程（除非核对也走 worker）。
- 两个方案叠加的复杂度 > 收益；worker 是结构性解法，快照是"把冷启动变稀"，与 B 当初否决"每 10 分钟卡一次"的理由同构。

## 7. 测试策略

- `scripts/test-local-scan-host.mjs`（`loadTs` + 假 worker，全部用真实短超时）：
  1. 正常：worker 返回 → `via='worker'`，结果与 `fallback` 逐点相等；
  2. 入口不存在 → `via='main'` + `degradedReason` 有值 + 数据完整；
  3. worker 抛错 → 同上；
  4. worker 永不返回 → 在 `timeoutMs` 量级内回退，且**迟到结果被丢弃**（断言最终结果仍是 fallback 的）；
  5. `stop()` 幂等，且 `stop()` 后不再有活跃句柄（`process.getActiveResourcesInfo()`）。
- `scripts/test-local-scan.mjs` 扩展：把"全量"用例同时跑 `via='main'` 与 `via='worker'` 两条路，断言与冻结基准逐点相等（AC2）。
- `scripts/verify-worker-packaged.mjs`：打包态正向 + 负向（AC3），产出可读结论行，纳入验收取证。
- 每条护栏先弄坏一次确认变红。

## 8. 回滚形态

- 新增两个模块 + 宿主可独立存在；`opencode-local.ts` 的接入是**单点替换**（`full` 分支），回滚只需 revert 该文件与 `electron.vite.config.ts` 的 input —— 回到"主线程同步全量"，即今天已验证过的行为（不并行保留双实现）。
- 无数据格式变更 ⇒ 无数据面回滚。
