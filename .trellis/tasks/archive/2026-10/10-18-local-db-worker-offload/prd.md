# 本机用量首轮全量移出主线程（worker/utilityProcess）

## Goal

把"本机用量扫描的**首次全量**仍同步阻塞主线程"这一项从秒级降到与稳态同量级（毫秒级），并顺带把全量核对的陈旧度上界收下来。

本任务的存在理由是**判据被触发**，不是"顺手优化"：`10-18-local-db-off-mainthread` 的 `design.md §6` 明确写了「若真机冷启动 > 900ms（AC4 红线），回来做 worker」。

## Background（实测取证，2026-10-18）

| # | 证据 | 观测值 |
|---|---|---|
| E1 | 隔离热页冷启动（三次重测） | **1222 / 2971 / 4418 ms**，三次全部越过 900ms 红线 |
| E2 | 同条件旧实现对照 | 新实现是它的 **2.31–3.37 倍**（投影+增量真实有效，不是实现差异） |
| E3 | 应用内首轮 | **1075–2858 ms**（冷页 + 启动竞争 + load 13–17） |
| E4 | 剩余成本性质 | `json_extract` 省掉了 JS 堆与 2.6 万次 `JSON.parse`，但**省不掉 ~265MB `data` 页读取** —— 结构性 |
| E5 | 运行时可用的 API | Node 22 的 `node:sqlite` **只有同步 API**（`DatabaseSync`）⇒ 主线程内无解 |
| E6 | 当前代价转移 | 全量核对被迫从 10 分钟放宽到 **6 小时**（否则等于每 10 分钟卡 0.7–3s）⇒ 窗口外改值/删行的最大陈旧度 = 6h |

（E1–E4 来自 `10-18-local-db-off-mainthread` 的验收取证与核查代理复测；E6 来自其 `prd.md` 的 AC4 说明。）

## Requirements

- **R1 首轮全量不再阻塞主进程**：应用内首轮扫描期间，主进程同步阻塞 < 50ms（与稳态同量级），而不是秒级。
- **R2 口径逐点等价**：worker 产出的 `LocalStats`（`pts` + `byModel`）必须与主线程版本**逐点相等**；缺失值仍不填 0；tokens 仍只来自本机且仍标「本机」。
- **R3 打包态可用（本任务的核心风险）**：产物必须在**打包态**（asar 内）能正确加载 worker/utilityProcess；验证方式必须可复现，且**必须包含一次负向验证**（故意破坏 worker 路径 → 证明降级路径真的生效、不是"看起来跑通了"）。
- **R4 失败降级**：worker 起不来 / 抛错 / 超时 → 回退主线程同步扫描（记日志），**不得**因此丢数据、让界面空白或让应用不可用。
- **R5 生命周期干净**：应用退出与 `stopScheduler()` 后不留孤儿进程/线程/句柄（`ps` 与 `process.getActiveResourcesInfo()` 可断言）。
- **R6 陈旧度上界（顺带收益，可选）**：全量核对间隔可从 6h 收紧（判据由实测决定：收紧后主进程阻塞不得越 R1）。若收紧，必须有实测数字与断言；若不收紧，必须在 `prd.md` 写明理由，不许静默放过。

## Out of Scope

- 不改增量游标口径（rowid + 600 行回看 + 合并按行 `id`）—— 那是 B 的既定契约（`.trellis/spec/adapters/local-db-scan.md`）。
- **不新增磁盘行快照文件**：把已解析行落盘能免掉冷启动全量，但它会引入数据格式与迁移/回滚面（B 刻意保持了"无数据格式变更"）。本任务只做"移出主线程"，不叠加持久化。
- 不重构采集为多进程/独立服务；不动官方口径、UI、托盘、历史采样。
- 不改 `claude`/`codex`/`antigravity` 的既有实现（B 已收口）。

## Acceptance Criteria

- [x] AC1：应用内首轮全量期间主进程同步阻塞 < 50ms；`sample <pid>` 在首轮窗口内无单次 > 200ms 的主线程热点（对照 E3 的 1075–2858ms）。
- [x] AC2：worker 结果与主线程版本**逐点等价**（`pts` + `byModel`），复用/扩展 `scripts/test-local-scan.mjs` 的等价性基准；tokens 口径与缺失值口径零漂移。
- [x] AC3：**打包态**正向验证：从 `dist` 的 `.app` 启动，日志证明 worker 真的被加载（而不是静默降级到主线程）；**并且**做一次负向验证：故意破坏 worker 路径/入口 → 断言降级日志出现且数据仍完整。
- [x] AC4：降级路径的三种触发（起不来 / 抛错 / 超时）都回退主线程并记日志，结果与不降级时逐点相等。
- [x] AC5：应用退出后 `ps` 无残留 worker/utility 进程；`stopScheduler()` 后无遗留句柄。
- [x] AC6：`npm run typecheck` + `npm test` 全绿；每条新护栏先弄坏一次确认变红。
- [x] AC7：R6 的结论有实测数字（收紧则给阻塞数字 + 断言；不收紧则写明理由与陈旧度上界）。
- [x] AC8：真机复测：连续 ≥ 10 分钟 `balance-export.json` 的 `updatedAt` 每轮前进，且首轮不再出现秒级卡顿。

---

## 验收取证（2026-10-18 实施，装机后实测）

> 完整版（含每条护栏的变异红集、`sample` 解析的四个坑）在
> `docs/daily/2026-10-18_local-db-worker-offload.md`；可复现脚本：
> `node scripts/verify-worker-packaged.mjs [--app <path>]`。

### AC1 主线程阻塞

```
$ node /tmp/bd-block-probe.mjs        # 1ms 定时器测主线程最大空档，真库 638MB / 5182 行
① worker 路径  : 墙钟 1212ms  rows=5182  主线程事件循环最大空档 16ms（935 tick）
② 主线程降级 : 墙钟 1259ms  rows=5182  主线程事件循环最大空档 1192ms（76 tick）
③ 同步全量   : 墙钟 1199ms  rows=5182  主线程事件循环最大空档 1200ms（24 tick）
```

打包态 `sample`（1ms 一采，数字≈毫秒；装机后的 `.app`，连续三次一致）：

| | 主线程最长连续 sqlite 样本 | 其余线程 |
|---|---|---|
| 正向（`via=worker`） | **0–1 ms** | 976–1268 ms |
| 负向（`via=main` 降级） | **943–1229 ms** | 0 ms |

**结论：16ms < 50ms，主线程 sqlite 最长连续 1ms < 200ms**（对照 E3 的 1075–2858ms）。

### AC3 打包态正向 + 负向（连续三次 17/0）

```
① 正向：从 .app 启动 → 必须走 worker
     2026-10-18T13:11:09.025Z opencode: 本机扫描 full 4989ms rows=5184 pts=5184 via=worker
  ✓ P2 via=worker   ✓ P3 rows=5184 pts=5184   ✓ P5 主线程 sqlite 最长 1ms   ✓ P6 其余线程 1268ms
② 负向：BD_LOCAL_SCAN_WORKER=/nonexistent/balancedeck-worker.js
     2026-10-18T13:11:34.509Z opencode: 本机扫描 full 2574ms rows=5184 pts=5184 via=main degraded=worker 抛错：Cannot find module '/nonexistent/balancedeck-worker.js'
  ✓ N1 出现降级日志   ✓ N3 via=main   ✓ N4 degradedReason 有值   ✓ N5 rows=5184 pts=5184   ✓ N6 主线程最长 977ms
③ 正向 vs 负向：pts/rows 差异 ≤ 1%（两次都是 5184 / 5184）
结果：17 通过 / 0 失败
```

**asar 内不需要 `asarUnpack`** —— Electron 37 里 `new Worker()` 能直接读 asar（正向实测一次就过）。

### AC4 降级三种触发

`scripts/test-local-scan-host.mjs` H2（入口不存在）/ H3（顶层抛错）/ H4（超时）各自断言
`via='main'` + `degradedReason` 有值 + 回退实现被调用一次；集成层 `L7j–L7l` 断言降级结果与
冻结的旧口径**逐点相等**。

### AC5 停机

```
$ pkill -f "BalanceDeck.app/Contents/MacOS/BalanceDeck"; sleep 4
$ ps aux | grep "[B]alanceDeck"     # → 无输出（worker 是进程内线程，无孤儿进程）
```

`H5a–H5g`：`stop()` 幂等、停机后不再起线程、在飞请求被结算、无遗留 `Timeout`
（`process.getActiveResourcesInfo()` 计数回到基线）。

### AC6 套件 + 变异

```
node scripts/test-local-scan.mjs        结果：123 通过 / 0 失败
node scripts/test-local-scan-host.mjs   结果：49 通过 / 0 失败
npm run typecheck                       两个 tsconfig 都过
npm test                                23 段全绿
```

| 变异 | 红集 |
|---|---|
| `degrade()` 不写 `degradedReason` | 8 |
| 超时回调什么都不做 | 8 |
| `ensureWorker()` 无视 `workerBad` | 1（H4j） |
| `stop()` 只清 `pending` 不清定时器 | 1（H5g） |
| `fullSnapshot` 丢掉 worker 回传的 `tables` | 5（含 L7u） |
| `FULL_RESCAN_MAX_AGE_MS` 改回 6h | 1（L5j） |
| `defaultWorkerPath` 去掉「上一级」候选（打包态） | 3（P2/P4/P6） |
| 产品日志去掉 `via=`（打包态） | 3（P2/P6/N3） |

### AC7 R6（收紧全量核对间隔）

**收紧到 1 小时**。判据 = AC1 的实测数字（主线程空档 16ms / sqlite 最长 1ms，红线 50/200ms），
所以「短间隔 = 卡顿」这条当初否决短间隔的理由不再成立。断言：`test-local-scan.mjs` **L5j**。
代价（写进代码注释与日志）：24 轮/天 ≈ 6.4GB/天页读取、~36s/天**子线程** CPU；
降级态下变成每小时一次 0.7–3s 的主线程冻结。陈旧度上界：**1h**（原 6h）。

### AC8 真机复测（常驻 16 分钟）

```
$ /tmp/bd-accept-monitor.sh
=== 观测 663s：见到 11 个不同 generatedAt，其中 10 次前进，最大间隔 67s ===

$ grep "本机扫描" /tmp/balancedeck-scheduler.log      # 16 轮
12:34:24 本机扫描 full  1160ms rows=5010 pts=5010 via=worker
12:35:27 本机扫描 delta   54ms rows=572  pts=5021
…（其后每轮 47–80ms）
12:50:07 本机扫描 delta   50ms rows=567  pts=5134
降级次数：0
```

⚠ 本 AC 原文写的是 `balance-export.json` 的 `updatedAt`，实际字段是 **`generatedAt`**，
且写盘是**内容哈希去重**的（`exportWriter.maybeWrite`）⇒ 内容不变就不写，
「每轮前进」在空闲时段本不成立。所以同时用「本机扫描行每轮前进」+「`generatedAt` 变化」两个判据。

### 核查补记（2026-10-18，trellis-check 独立复测）

- 独立重跑 `node scripts/verify-worker-packaged.mjs`：**17/0**（正向 `full 4590ms rows=5326 pts=5326 via=worker`、
  主线程 sqlite 最长 1ms、其余线程 916ms；负向 `via=main degraded=…` 主线程 739ms、rows/pts 5333）。
  `asar list` 确认 worker 在 `app.asar` 内、无 `app.asar.unpacked` ⇒ 「不需要 asarUnpack」成立。
- **打包态植入坏 worker**（复制 `.app` → 换 asar 内的 worker → 重打 → `--smoke`）：

| 坏法 | 打包态实测 |
|---|---|
| 顶层抛错 | `via=main degraded=worker 抛错：…`，`rows=5369 pts=5369` ✅ |
| 回错形状（非对象） | 留痕 → 20s 超时 → `via=main degraded=…超时`，`rows=5379 pts=5379` ✅ |
| `ok:true` + `tables: []` | ❌ 修复前 `via=worker rows=0 pts=0`（本机数字**静默归零**） |

- 上表第三行是核查发现的**新缺陷，已修**：`fullSnapshot()` 的回包校验从「形状」扩到「内容」——
  以**表名集合**为判据（0 行可以是真相，缺表不是），缺表即留痕 + 回退主线程同一份实现。
  修复后同一坏 worker 在打包态：`via=main degraded=worker 回传的快照缺少表 session_message、message（主线程看到 2 张）`，
  `rows=5428 pts=5428`。
- 新增断言 `L7w–L7z2`（8 条，含"可信的空"负向前提）；去掉守卫 ⇒ **7 红**。
  变异抽查 4 组与自述一致（8 / 1 / 5 / 1 红）。
- `npm test` 段数勘误：**任务前 23 段 → 任务后 24 段**（自述写的是 23 段）。
- ⚠ `/Applications/BalanceDeck.app` 里装的是**修复前**的包（21:09）。本次打包态复验用的是
  「复制 `.app` + 新 `out/` 重打 asar」，没有覆盖常驻实例 —— 修复要重新 `npm run dist:mac` + 安装
  才会进用户手上那份。

### 未完成 / 存疑

1. 首轮**墙钟**比主线程慢 1–3s（线程启动 + 模块加载 + 结构化克隆）——「不卡主线程」的代价，
   不是缺陷；要连出数时间也压掉得做「启动即预热 worker」，本任务不做。
2. 1h 间隔在**降级态**更重（每小时一次 0.7–3s 主线程冻结）。没有做「按 `via` 自适应间隔」——
   那会让间隔依赖上一轮结果，多一个状态源。
3. `scripts/verify-worker-packaged.mjs` 的 `sample` 取证是**时序相关**的（已用「多轮短窗直到
   看见 sqlite 工作」+「认出了主线程吗」前置断言抗漂移），它是取证脚本，不是单测。
4. `defaultWorkerPath()` 的「同级 → 上一级」是对**构建产物布局**的容忍，没有独立断言；
   真正的守门是打包态正向验证（P2）。
5. 回包只校验**表名集合**，不校验行内容（worker 若回表名正确但少一段 rowid 区间的快照，
   主线程识别不出：「行数变少」与「用户真的少用了」不可区分）。这一层靠「两条路调同一份
   `scanFullSnapshot`」保证，不靠校验 —— 不要再加「行数对不上就降级」，它会在窗口边界误判。
6. 缺表降级会**每次全量都重试**（worker ~0.7s + 主线程回退 ~2s，每小时一次）。没有做
   「把这种 worker 标坏、下次不再用」：那需要宿主暴露"作废线程"的接口，而宿主是纯传输层、
   不认识 payload 语义。代价有界且留痕，收益是分层不被打破。
7. **降级态下 1h 间隔 = 每小时一次 0.7–3s 主线程冻结**（任务前的常态是每 6 小时一次）。
   核查代理判定：接受。理由 = 判据（降级必须留痕、必须尽快修）不变，而「按 `via` 自适应间隔」
   会让间隔依赖上一轮结果（多一个状态源）并把降级变得更舒服、更难被发现。

## 装机复验（主会话，2026-10-18 21:43）

核查修复后重新 `npm run dist:mac` 并覆盖 `/Applications/BalanceDeck.app`（`app.asar` 哈希
`5e346f03…`，与 `dist/mac` 一致），在**装机产物**上跑 `verify-worker-packaged.mjs`：

- 第 1 次：**16 通过 / 1 失败** —— 失败项是 `P6`（"sqlite 工作在别的线程上"），实测主线程与
  其余线程**都是 0 帧**；同一次里 `P1–P4` 全绿（`full 3517ms rows=5523 pts=5523 via=worker`、
  无降级日志）⇒ **worker 确实被加载并干活了**，只是采样窗口没套住那次扫描。
- 第 2 次：**17 通过 / 0 失败** —— 主线程 sqlite `0 帧/0ms`（红线 50ms/200ms），worker 线程
  `最长连续 1276ms`；负向 `via=main degraded=Cannot find module` 且 `rows=pts=5526` 完整。

**结论**：装机产物上打包态加载 worker 成立（asar 内直接加载，无需 `asarUnpack`）。
⚠️ 同时如实记一条：`P6` 属**时序相关判据**（存疑项 3 的同一件事），单次 16/1 **不等于**
回归 —— 判据本身不成立时 `P1–P4` 会同时变红；下次见到 `P6` 单独失败，先看 `P1–P4` 与
"其余线程帧数"，再决定是否重跑，不要直接改 `asarUnpack`。

