# 本机用量首轮全量移出主线程：worker 化 + 全量核对间隔 6h → 1h

任务：`.trellis/tasks/10-18-local-db-worker-offload`（任务 C，父任务 `10-18-sync-collect-watchdog` 的最后一个孩子）

## 起因

上一个任务（孩子 B）把本机 `opencode.db` 扫描的**稳态**压到了 22–49ms（SQL 投影 + rowid 增量），
但**首次全量**仍是主线程上的一次同步阻塞，判据被触发：

| # | 证据 | 观测值 |
|---|---|---|
| E1 | 隔离热页冷启动（三次重测） | **1222 / 2971 / 4418 ms**，三次全部越过 900ms 红线 |
| E2 | 同条件旧实现对照 | 新实现是它的 2.31–3.37 倍（投影+增量真实有效，不是实现差异） |
| E3 | 应用内首轮 | **1075–2858 ms** |
| E4 | 剩余成本性质 | `json_extract` 省掉了 JS 堆与 2.6 万次 `JSON.parse`，**省不掉 ~265MB `data` 页读取** —— 结构性 |
| E5 | 运行时可用的 API | Node 22 的 `node:sqlite` **只有同步 API**（`DatabaseSync`）⇒ 主线程内无解 |
| E6 | 代价转移 | 全量核对被迫从 10 分钟放宽到 6 小时 ⇒ 窗口外改值/删行的最大陈旧度 = 6h |

`design.md §6` 早就写了「若真机冷启动 > 900ms，回来做 worker」。本轮就是回来做 worker。

## 改了什么

| 文件 | 改动 |
|---|---|
| `src/main/adapters/local-scan-host.ts` | **新增**。worker 宿主：起线程 / 发请求 / 超时 / 降级 / 迟到丢弃 / 停机。纯传输层（不 import electron、不运行时依赖 `opencode-local`），可被 `loadTs` + 真子线程夹具单测 |
| `src/main/adapters/local-scan-worker.ts` | **新增**。worker 入口：只做「读库 → 产出全量行快照」，不含任何 electron/装配依赖 |
| `src/main/adapters/opencode-local.ts` | 抽出 `openLocalDb` / `detectTables` / `projectFull` / `projectDelta` / `absorbRows` / `deriveStats` / `scanFullSnapshot`（**worker 与主线程降级路径调同一份**）；`full` 分支委托宿主；`LocalRun` 增 `via` / `degradedReason`；新增 `stop()`；`FULL_RESCAN_MAX_AGE_MS` 6h → **1h** |
| `src/main/adapters/opencode.ts` | 装配：注入 `workerPath: defaultWorkerPath` 与 `log: debugLog`；扫描日志行加 `pts=` / `via=` / `degraded=`；新增 `stopLocalScan()` |
| `src/main/adapters/index.ts` | 再导出 `stopLocalScan`（scheduler 的 import 形状不变） |
| `src/main/scheduler.ts` | `stopScheduler()` 里 `void stopLocalScan()`（线程随进程消亡，但显式终止能立刻释放 db 句柄与定时器） |
| `electron.vite.config.ts` | main 侧**第二个 rollup input** → `out/main/local-scan-worker.js`（`new Worker()` 只认真实文件） |
| `scripts/lib/build-worker.mjs` | **新增**。用 esbuild（vite 自带）把 worker 入口打成真文件，供单测当真子线程入口 |
| `scripts/test-local-scan-host.mjs` | **新增**测试套件（49 断言）：正常 / 入口不存在 / 顶层抛错 / 永不返回+迟到丢弃 / 停机幂等 / 未知形状 / 线程健康性 |
| `scripts/test-local-scan.mjs` | 新增 **L7**（worker 全量 == 主线程全量、增量仍走主线程、大表上行快照必须装回来、降级等价）+ **L5j**（R6 间隔上界） |
| `scripts/verify-worker-packaged.mjs` | **新增**。打包态**正向 + 负向**验证，并用 `sample` 取主线程调用图（AC1/AC3 的取证脚本） |
| `package.json` | 注册 `test:local-scan-host`，在 `test` 串里排在 `test:local-scan` **之前** |

## 设计取舍（三处与设计稿不同，都是被实测逼出来的）

### ① 回传的是**行快照**，不是 `LocalStats`

`design.md §3` 把 `ScanResult` 写成 `{ pts, byModel }`。**这条形状是致命的**：主线程的增量游标
按 **rowid** 累积（`local-db-scan.md` §3「Cursor」），而 `pts` 里没有 rowid —— 只回传派生结果，
主线程下一轮增量就**失去行快照**，结果是数据变空（不是变慢，是变错）。

改成回传「每张表的 `rowid → {tc, p}`」，派生交给主线程用**同一份** `deriveStats` 算。
口径仍然只有一处，而 delta 契约完整保留。

> 这个坑差点被夹具掩盖：夹具表只有十几行，远小于 600 行回看窗口，下一轮增量顺手把整张表
> 重读了一遍 —— **拿掉 `installSnapshot` 后小表上的断言全绿**。所以 `L7o–L7v` 专门造了一张
> 900 行的表：只有表 > 回看窗口时，「窗口外的行」才只能来自快照。

### ② `__dirname` 不是 `out/main` —— 路径解析必须容忍 chunk 目录

第一版 `defaultWorkerPath()` 直接 `join(__dirname, 'local-scan-worker.js')`。
dev 态第一次跑就红了：

```
本机扫描降级：worker 抛错：Cannot find module '…/out/main/chunks/local-scan-worker.js'
```

因为 rollup 把 `local-scan-host.ts` 与 `opencode-local.ts` 一起放进了
`out/main/chunks/*.js`（两个入口共享），`__dirname` 是那个 chunks 目录。
改成「同级 → 上一级」两处探测；**两处都没有时返回同级那个候选而不是空串** ——
返回空串会变成「没配 worker」的静默降级，正是本任务要消灭的东西。

### ③ 全量核对间隔 6h → **1h**（R6）

当初否决短间隔的理由是「全量是 0.7–3s 的主线程同步阻塞，10 分钟一次等于每 10 分钟卡一次」。
worker 之后这条理由不成立：**实测主线程事件循环最大空档 16ms**（见下）。
所以按判据收紧到 1 小时：

- 收益：窗口外改值/删行的最大陈旧度 **6h → 1h**；
- 代价（有界且写在这里）：每轮全量读 ~265MB 页（多为页缓存命中）+ ~0.7–3s 的**子线程** CPU，
  24 轮/天 ≈ 6.4GB/天页读取、~36s/天 CPU；
- ⚠ 降级时这条间隔意味着**每小时**一次 0.7–3s 的主线程冻结，而不是每 6 小时 ——
  这是「降级必须留痕、必须尽快修」的另一个理由。

## 取证（命令 + 原始输出）

### 1. 主线程阻塞（AC1）—— 事件循环空档探针

```
$ node /tmp/bd-block-probe.mjs          # 1ms 定时器测主线程最大空档，真库 638MB / 5182 行
① worker 路径  : 墙钟 1212ms  rows=5182  主线程事件循环最大空档 16ms（935 tick）
② 主线程降级 : 墙钟 1259ms  rows=5182  主线程事件循环最大空档 1192ms（76 tick）
③ 同步全量   : 墙钟 1199ms  rows=5182  主线程事件循环最大空档 1200ms（24 tick）
```

**16ms < 50ms（AC1 红线）**，而同样的工作在主线程上是 1192–1200ms。

> ⚠ 探针第一版测出「降级 3ms」这种反直觉结果 —— 因为**阻塞期间排队的 tick 回调要等阻塞结束
> 才能跑，而 `clearInterval` 在 await 的续体（微任务）里执行，比那个宏任务更早**，于是最大空档
> 永远记不到。加了「结束后 `sleep(30)` 让排队的 tick 先跑一次」才拿到真数字。
> 这条记在这里，是因为它会让人得出完全相反的结论。

### 2. 打包态正向 / 负向（AC3，`scripts/verify-worker-packaged.mjs`）

装机（`/Applications/BalanceDeck.app`）后跑，**连续三次 17/0**（下面取其中一次）：

```
① 正向：从 .app 启动 → 必须走 worker
  ✓ P1 日志里有「本机扫描 full」那一行（说明首轮全量真的跑了）
     2026-10-18T13:11:09.025Z opencode: 本机扫描 full 4989ms rows=5184 pts=5184 via=worker
  ✓ P2 **via=worker**（不是静默降级到主线程）—— 实测 worker
  ✓ P3 真的读到了本机数据（rows=5184 pts=5184）
  ✓ P4 正向那轮没有出现降级日志
     sqlite 采样（1ms 一采，数字≈毫秒）：主线程[Main Thread] 帧1/最大1ms；其余线程 帧10/最大1268ms
  ✓ P5a 前置：在 sample 里**认出了主线程**（认不出 ⇒ 下面那条"主线程 0 帧"是假绿）
  ✓ P5 主线程在 sqlite 里的最长连续样本 ≤ 50ms —— 实测 1ms / 1 帧
  ✓ P6 sqlite 工作在**别的线程**上（worker 真的在干活）—— 实测最长连续 1268ms

② 负向：把 workerPath 指到不存在的文件 → 必须降级且数据完整
  ✓ N1 出现**降级日志**（降级路径真的被走到了，不是"看起来跑通了"）
     2026-10-18T13:11:34.509Z opencode: 本机扫描 full 2574ms rows=5184 pts=5184 via=main degraded=worker 抛错：Cannot find module '/nonexistent/balancedeck-worker.js'
  ✓ N3 via=main（回退到主线程同步扫描）
  ✓ N4 degradedReason 有值（降级必须留痕）
  ✓ N5 数据仍然完整（rows=5184 pts=5184）
     sqlite 采样：主线程 帧7/最大977ms；其余线程 帧0/最大0ms
  ✓ N6 主线程**陷在 sqlite 里**（降级真的把全量搬回了主线程）—— 实测最长连续 977ms

③ 正向 vs 负向：本机数据的规模必须相当
  ✓ C1/C2 pts、rows 差异 ≤ 1%（两次都是 5184 / 5184，差 0）
结果：17 通过 / 0 失败
```

**asar 内不需要 `asarUnpack`** —— Electron 37 里 `new Worker()` 能直接读 asar。
脚本第一版先跑正向，红了才按 `design.md §5` 上 `asarUnpack`；实测一次就过，所以没加。

> ⚠ `sample` 的调用图里，**主线程的标签会变**：启动早期是 `Main Thread`，随后重命名成
> `CrBrowserMain`（同一台机器、同一个应用，两次采样分别拿到这两个名字）。只认其中一个 ⇒
> 主线程认不出来 ⇒ 它的帧被算进"其余线程" ⇒ **结论整个反过来**（正负向都报反）。
> 所以断言里加了 `P5a/N6a` 前置：「认出了主线程吗」—— 认不出时那两条"主线程 0 帧"是假绿。

### 3. 应用内首轮（dev 态 `npx electron . --smoke`）

```
2026-10-18T12:12:44.575Z opencode: 本机扫描 full 7154ms rows=4826 pts=4826 via=worker
2026-10-18T12:12:49.989Z opencode: 本机扫描 delta 41ms rows=568
```

worker 启动 + 全量的**墙钟**是 1.2–7.2s（load average 43 时测得 7154ms；隔离测量下 worker online
81ms、全量 1625ms）——**比主线程跑更慢，但主线程是空的**。这是本任务的取舍：首轮出数晚一点，
界面不卡。

### 4. AC8 真机复测（装机后常驻运行 16 分钟）

```
$ /tmp/bd-accept-monitor.sh              # 每 4s 采一次 balance-export.json
20:36:53 t+0s   generatedAt=2026-10-18T12:36:31.844Z
20:37:35 t+41s  generatedAt=2026-10-18T12:37:34.187Z
…（共 11 个不同值）
=== 观测 663s：见到 11 个不同 generatedAt，其中 10 次前进，最大间隔 67s ===

$ grep "本机扫描" /tmp/balancedeck-scheduler.log      # 16 轮
12:34:24 本机扫描 full  1160ms rows=5010 pts=5010 via=worker
12:35:27 本机扫描 delta   54ms rows=572  pts=5021
12:36:29 本机扫描 delta   80ms rows=582  pts=5041
…（其后每轮 47–80ms）
12:50:07 本机扫描 delta   50ms rows=567  pts=5134
降级次数：0
```

首轮 `full` 走 worker，其后**每轮都是 delta（47–80ms）**，`pts` 单调前进（5010 → 5134），
**0 次降级**，`generatedAt` 每轮前进（最大间隔 67s，含采集本身的 2–3s）。

> ⚠ `prd.md` 写的字段是 `updatedAt`，实际是 **`generatedAt`**；而且写盘是**内容哈希去重**的
> （`exportWriter.maybeWrite`），内容不变就不写 —— 所以「每轮前进」在空闲时段本来就不成立。
> 上面同时用了「本机扫描行每轮前进」+「`generatedAt` 变化」两个判据。

### 5. 停机后无残留（AC5）

```
$ pkill -f "BalanceDeck.app/Contents/MacOS/BalanceDeck"; sleep 4
$ ps aux | grep "[B]alanceDeck"          # → 只剩 grep 自己的 shell
```

worker 是**进程内线程**（不是 `utilityProcess`），所以「无孤儿进程」是结构性的；`stop()` 另外
保证了句柄与定时器被释放（`H5a–H5g` 断言，含 `process.getActiveResourcesInfo()` 的 Timeout 计数）。

### 6. 单元套件

```
node scripts/test-local-scan.mjs        结果：123 通过 / 0 失败
node scripts/test-local-scan-host.mjs   结果：49 通过 / 0 失败
npm run typecheck                       两个 tsconfig 都过
npm test                                24 段全绿（任务前 23 段 + 新增的 local-scan-host）
```

> ⚠ 段数勘误：实施自述写的是「23 段全绿」，实测**任务前是 23 段、任务后是 24 段**
> （`git show HEAD:package.json` 的 `scripts.test` 拆出 23 个 `npm run`）。
> 核查代理补跑修复后套件时数字为：`test-local-scan` **132 通过 / 0 失败**、
> `test-local-scan-host` 49 / 0、`npm test` **24 段 / 0 红**。

### 7. 每条新护栏「弄坏一次」的红集（实测）

| 变异 | 红集 |
|---|---|
| `degrade()` 不写 `degradedReason` | **8**：H2d/H2e/H3b/H4c/H4h/H5c/H6b/H6g |
| 超时回调什么都不做（不再按整次扫描计） | **8**：H4b–H4h + H4j |
| `ensureWorker()` 无视 `workerBad`（卡住的线程不换） | **1**：H4j |
| `stop()` 只清 `pending` 不清定时器 | **1**：H5g |
| `fullSnapshot` 丢掉 worker 回传的 `tables` | **5**：L7d/L7e/L7q/**L7u**/L7l |
| `FULL_RESCAN_MAX_AGE_MS` 改回 6h | **1**：L5j |
| `defaultWorkerPath` 去掉「上一级」候选（打包态） | **3**：P2/P4/P6 —— 日志实测 `via=main degraded=Cannot find module '…/out/main/chunks/local-scan-worker.js'` |
| 产品日志去掉 `via=`（打包态） | **3**：P2/P6/N3 —— 没有这条日志就再也证明不了「走了 worker」 |

（M5 的第一次版本只红了 3 条，且 **L7h 没红** —— 那就是上面「①」里说的夹具太小掩盖缺陷。
补了 900 行大表的 `L7u` 之后才真的红。）

## 核查代理独立复测（2026-10-18，trellis-check）

独立重跑与**打包态植入坏 worker**的复测结果。除一处新发现的缺陷（已修）外，实施自述的
数字与红集全部复现。

### 1. 打包态正/负向：独立重跑 `node scripts/verify-worker-packaged.mjs`

**17 通过 / 0 失败**，与自述一致（数字是这一轮自己的）：

```
① 正向  本机扫描 full 4590ms rows=5326 pts=5326 via=worker
        sqlite 采样：主线程[Main Thread] 帧1/最大1ms；其余线程 帧9/最大916ms   ✓ P2/P3/P4/P5a/P5/P6
② 负向  本机扫描 full 3201ms rows=5333 pts=5333 via=main degraded=worker 抛错：Cannot find module '/nonexistent/…'
        sqlite 采样：主线程 帧7/最大739ms；其余线程 帧0/最大0ms                ✓ N1–N6
③ C1/C2 pts 差 7（≤1%）                                                        ✓
```

`npx asar list …/app.asar` 确认 `/out/main/local-scan-worker.js` **在 asar 内**、
`Contents/Resources/app.asar.unpacked` **不存在** ⇒ 「asar 内直接可加载、不需要 asarUnpack」成立。

### 2. `sample` 判据的牙齿（把函数源码切出来喂真实采样文件，不手抄副本）

| 检查 | 结果 |
|---|---|
| 正常解析（正向样本） | `mainFound=true`，主线程帧 1/最大 1ms，其余线程 9/916ms |
| 正常解析（负向样本） | `mainFound=true`，主线程帧 7/最大 **739ms**，其余线程 0 |
| **变异**：主线程正则收窄成只认 `CrBrowserMain` | 两个样本都 `mainFound=false`，主线程帧被算进"其余线程"（正向样本变成"其余线程 10 帧/916ms"）⇒ **P5a/N6a 会变红**，前置断言不是空真 |
| `Binary Images:` 尾巴 | 尾巴里有 2 处 `sqlite` 字样；切掉后"真干活"帧 9/6 处 ⇒ 不切会把静态链接当成主线程在跑 sqlite |

本轮两次采样的主线程标签都是 `Main Thread`（不是 `CrBrowserMain`）—— 只认后者的版本会
把结论整个反过来，这正是那个前置断言存在的理由。

### 3. 打包态植入坏 worker（核查代理自建，三种坏法）

做法：复制 `.app` → 解开它的 `app.asar` → 换掉 `out/main/local-scan-worker.js` → 重新 pack →
`--smoke` 跑。坏法由 worker 启动时读的环境变量选择，所以三种坏法共用同一个已打包产物。

| 坏法 | 打包态实测 |
|---|---|
| 顶层抛错 | `本机扫描降级：worker 抛错：…` → `full 2259ms rows=5369 pts=5369 via=main degraded=worker 抛错：…` ✅ 数据完整 |
| 回错形状（`postMessage('…')`） | 留痕「worker 回了不认识的形状，已忽略」→ 20s 超时 → `full 23112ms … via=main degraded=worker 在 20000ms 内没有返回` ✅ 有界、不冒充成功 |
| 回 `ok:true` + `tables: []` | ❌ **修复前**：`full 658ms rows=0 pts=0 via=worker` —— 本机数字**静默归零** |

**第三行是本次核查发现并修掉的缺陷**（见下节「补丁」）。它正好落在 R4 的
「不得因此丢数据、让界面空白」与 `quality-guidelines.md` 的
「不许把未知填成可信的零」上：`installSnapshot` 对缺表只打了 debug 日志，
`via` 仍是 `worker`、没有 `degradedReason`，而下一轮是 `delta`（只补回看窗口内的行），
要等下一次全量核对（≤1h）才可能恢复。

### 4. 补丁：回包校验从「形状」扩到「内容」

判据是**表名集合**，不是行数：31 天没用过 opencode ⇒ 0 行是真相（允许）；
**缺表**不是真相 —— worker 侧的 `detectTables` 把 `sqlite_master` 探测失败也容忍成「没有表」
（与旧实现同款容忍），一次瞬时错误就会回一个「成功」的空快照。

`opencode-local.ts` 的 `fullSnapshot()` 里：worker 回包缺任何一张主线程看到的表 ⇒
记 `degradedReason`（`worker 回传的快照缺少表 …（主线程看到 N 张）`）→ 走**同一份**
`scanFullSnapshot` 回退主线程。

修复后**同一坏 worker 在打包态**：

```
① 新构建 / 真 worker     本机扫描 full 2395ms rows=5427 pts=5427 via=worker
② 新构建 / 坏 worker     本机扫描降级：worker 回传的快照缺少表 session_message、message（主线程看到 2 张） ⇒ 回退主线程同步扫描
                         本机扫描 full 1899ms rows=5428 pts=5428 via=main degraded=worker 回传的快照缺少表 …
```

新增断言 `L7w/L7x/L7y`（空快照）/ `L7w2/L7y2`（连字段都没有）/ `L7w3/L7y3`（只少一张表）
/ `L7z/L7z2`（**负向前提**：表名齐但 0 行 ⇒ 仍走 worker，守卫不许退化成"永远降级"）。
去掉守卫 ⇒ **7 红**（L7w/L7x/L7y/L7w2/L7y2/L7w3/L7y3）。

### 5. 变异抽查（独立重做，与自述逐条对照）

| 变异 | 自述红集 | 实测红集 |
|---|---|---|
| `degrade()` 不写 `degradedReason` | 8 | **8**（H2d/H2e/H3b/H4c/H4h/H5c/H6b/H6g）✅ |
| `ensureWorker()` 无视 `workerBad` | 1（H4j） | **1**（H4j）✅ |
| `fullSnapshot` 丢掉 worker 回传的 `tables` | 5（L7d/L7e/L7q/L7u/L7l） | **5**（同）✅ |
| `FULL_RESCAN_MAX_AGE_MS` 改回 6h | 1（L5j） | **1**（L5j）✅ |
| （新增）去掉「缺表 ⇒ 降级」守卫 | — | **7**（见上） |

`defaultWorkerPath()` 的机制另用独立探针验证（把入口打进**模仿构建产物布局**的目录树再跑）：
从 `out/main/chunks/` 里解析 → 命中**上一级**的 `out/main/local-scan-worker.js`；
`app.asar` + `app.asar.unpacked` 都在 → 优先 unpacked；`BD_LOCAL_SCAN_WORKER` 覆盖生效；
`loadTs`（`data:` URL）里 → 空串（不起 worker）。
**变异**：去掉「上一级」候选 ⇒ 解析到 `…/out/main/chunks/local-scan-worker.js`（不存在）⇒
打包态必然降级 —— 自述的「3 红（P2/P4/P6）」成因复现。

### 6. 未随本次核查改变的两条

- **R6（6h → 1h）**：判据（主线程空档 16ms / sqlite ≤1ms）成立，`L5j` 钉住 `≤ 1h`
  （注意它断言的是**上界**，再收紧到 30 分钟仍绿 —— 这是有意的，收紧不是回归）。
  降级态下这条间隔意味着**每小时**一次 0.7–3s 的主线程冻结（对照任务前的常态是每 6 小时一次）——
  代价已写在代码注释与本文，**建议不在本轮**做「按 `via` 自适应间隔」：那会让间隔依赖上一轮结果
  （多一个状态源），并且会把降级变得更舒服、更难被发现，而判据一直是"降级必须留痕、必须尽快修"。
- **`/Applications/BalanceDeck.app` 里装的是修复前的包**（21:09 构建）。本次核查的打包态复验
  用的是「复制 `.app` + 用新 `out/` 重打 asar」，没有覆盖常驻实例；修复要**重新
  `npm run dist:mac` + 安装**才会进用户手上那份。

## 验收结论

| AC | 结论 |
|---|---|
| AC1 | ✅ 主线程事件循环最大空档 **16ms**（红线 50ms）；打包态 `sample` 主线程 sqlite 最长连续 **1ms**（红线 200ms），降级对照 943–1229ms |
| AC2 | ✅ `L7d/L7e/L7q/L7u`：worker 全量与主线程全量**逐点相等**（`pts` + `byModel`），且与冻结的旧口径基准相等 |
| AC3 | ✅ 打包态正向 `via=worker` + 负向 `via=main degraded=…`（`scripts/verify-worker-packaged.mjs`，连续三次 17/0）；asar 内直接可加载，无需 `asarUnpack` |
| AC4 | ✅ 三种触发都有断言：入口不存在（H2）、顶层抛错（H3）、超时（H4）；降级结果与走通时逐点相等（L7l）。**核查补丁**：worker 回「成功但缺表」的空快照也降级（`L7w–L7y3`，打包态实测） |
| AC5 | ✅ `stop()` 幂等、停机后不再起线程、无遗留 `Timeout` 句柄（H5a–H5g）；worker 是进程内线程，退出后 `ps` 无残留（核查代理另跑两轮 `.app` 副本，退出后 `pgrep` 零残留） |
| AC6 | ✅ `npm run typecheck` + `npm test` 全绿（**24 段**，任务前 23）；**8 条**变异全部实测变红（上表），核查代理独立重做 4 组一致，并为自己新增的守卫再补 1 组（缺表 ⇒ 降级，去掉即 **7 红**） |
| AC7 | ✅ 收紧到 1h，理由与代价见「设计取舍 ③」，断言 `L5j`；判据数字 = 主线程空档 16ms |
| AC8 | ✅ 常驻 16 分钟：11 个 `generatedAt` 全部前进（最大间隔 67s），16 轮扫描中首轮 full 走 worker、其余 15 轮 delta 47–80ms，0 次降级 |

## 未完成 / 存疑（明确写出，不粉饰）

1. **首轮墙钟变长**：worker 那条路比主线程多花 1–3s（线程启动 + 模块加载 + 结构化克隆）。
   这是「不卡主线程」的代价，不是缺陷。若将来要连出数时间也压掉，得做「启动即预热 worker」——
   本任务不做（会引入一条新的常驻线程生命周期）。
2. **降级时全量核对变成每小时一次卡顿**：1h 间隔的代价在降级态更重（0.7–3s × 24/天）。
   已用日志留痕 + `L7k` 断言暴露；没有做「按 `via` 自适应间隔」—— 那会让间隔依赖上一轮结果，
   多一个状态源，收益不抵复杂度。
3. **`sample` 取证是时序相关的**：脚本用「多轮 4s 短窗直到看见 sqlite 工作」来抗漂移，
   并加了「认出了主线程吗」的前置断言；但它仍然是**取证脚本**，不是单测。
4. **`local-scan-worker.js` 与 `out/main/chunks/*.js` 的相对位置是构建约定**：
   `defaultWorkerPath()` 按「同级 → 上一级」探测来容忍 chunk 目录，但没有断言「构建产物布局」。
   真正的守门是打包态正向验证（P2）—— 它红了就说明约定被破坏。
5. **回包只校验了「表名集合」，没校验行内容**：worker 若回一个表名正确、行内容错误（例如
   少了某段 rowid 区间）的快照，主线程无法识别 —— 唯一能识别的是行数级别的异常，而
   「行数变少」与「用户真的少用了」不可区分。所以这一层只能靠「两条路调同一份
   `scanFullSnapshot`」（口径只有一份）来保证，不能靠校验。**不要再加"行数对不上就降级"**：
   它会在窗口边界上误判（两次扫描之间的行数本来就会变）。
6. **缺表降级会一直重试**：worker 若持续回缺表快照，每次全量核对都会先等 worker（~0.7s）
   再回退主线程（~2s）。没有做「把这种 worker 标坏、下次不再用」——那需要宿主暴露
   "作废线程"的接口（宿主目前是纯传输层，不认识 payload 语义）。代价是每小时多约 1 秒，
   收益是保持宿主与口径的分层。
