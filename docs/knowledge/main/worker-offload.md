# 把同步阻塞搬进 worker：契约、降级与「打包态才能测出来」的那一半

任务来源：`.trellis/tasks/10-18-local-db-worker-offload`（2026-10-18）。
适用场景：主进程里有一段**只有同步 API** 的重活（本仓库是 `node:sqlite` 的 `DatabaseSync`），
把它移出主线程。

## 1. 先确认「搬得动」的是哪一半

- **遇到**：一段同步重活，想整体搬走。
- **做**：先问「**状态**在哪」。本仓库的全量扫描产出两类东西：
  ① 消费形状（`pts` / `byModel`）② **行快照**（`rowid → 行`），而后者是**增量游标的身份**。
  只搬走「跑」，把状态留在主线程，就必须把状态**原样回传**。
- **否则**：只回传 `pts`（没有 rowid）⇒ 主线程下一轮增量失去快照 ⇒ **数据变空**。
  这不是慢，是错，而且只在「表行数 > 回看窗口」时才看得出来 —— 小夹具会把它掩盖成绿灯。

> 同型判断：搬走的是「计算」还是「状态」？回传的必须是**能重建状态的那一份**，不是最好看的那一份。

## 2. 三条必须留痕的纪律

| 纪律 | 为什么 | 怎么钉 |
|---|---|---|
| **降级留痕** | 静默降级 = 用户还在卡，而没人知道为什么（本任务的全部意义被吃掉） | `lastRun().degradedReason` 有值 + 写 `debugLog`；断言「去掉它即红」 |
| **超时按整次操作计** | 卡在同步页读取上时，按消息往返计时根本不会触发 | 定时器从 `postMessage` 起算，到收到结果为止 |
| **迟到结果丢弃** | 与 `collect-loop` 的 epoch 闸门同一类事故：旧结果盖在新结果上 | 请求带 `seq`，回包 `seq` 不匹配即丢弃并留痕 |

**卡住的线程必须换掉**：同步 API 没法取消，超时后那个线程会一直卡着。
`workerBad` 记住「这个线程不能再用」，下次先 `terminate()` 再新建。断言方式是**数 fixture 的启动记账**
（真子线程入口启动时往一个文件追加一行）—— 「换掉了」是可数的事实，不是推断。

## 3. 回包的「形状对」≠「内容对」

**遇到**：传输层只校验了回包的**形状**（是不是对象、`seq` 对不对），于是「成功但内容缺失」的回包被当成成功。

**本仓库实例（2026-10-18 核查代理**在打包态**实测）**：worker 回 `{ seq, ok: true, rows: 0, tables: [] }`，
宿主形状校验全过 ⇒ `本机扫描 full 658ms rows=0 pts=0 via=worker` ——
界面上的本机数字**静默归零**，`via` 还是 `worker`、没有 `degradedReason`，
而下一轮是 `delta`（只补回看窗口内的行）⇒ 要等下一次全量核对（≤1h）才可能恢复。

**为什么它必然发生**：worker 侧的口径函数把「探测表失败」也容忍成「没有表」（与旧实现同款容忍），
所以一次瞬时错误就会产出**结构合法**的空快照。传输层不可能知道"这张库本该有几张表"。

**做**：在**调用方**（认识口径的那一层）拿一个**独立期望**去校验内容，不合格就按降级处理
（回退到与 worker 同一份实现的主线程路径）。

```ts
// opencode-local.ts —— expectedTables 来自主线程自己那条连接
const got = new Set((snap?.tables ?? []).map((t) => t.name))
const missing = expectedTables.filter((n) => !got.has(n))
if (r.via === 'worker' && missing.length > 0) { /* 留痕 + 回退主线程 */ }
```

**判据必须是「集合」而不是「数量」**：行数为 0 可以是真相（31 天没用过），**缺表不是**。
把两者混在一起，守卫就会退化成「永远降级」—— 所以负向前提（表名齐 + 0 行 ⇒ **仍走 worker**）
与正向断言一样必须写。

**怎么证明守卫有牙齿**：夹具 worker 用**真子线程**分别回 `tables: []` / 连字段都没有 / 只少一张表
（三条都要红），再加一条「表名齐、0 行 ⇒ 不降级」（不许退化成永远降级）。

## 4. 「打包态才能测出来」的那一半

**遇到**：`new Worker(path)` 在 dev 态好好的，打包后静默降级。
**做**：正向 + 负向**两次**验证，缺一不可，而且要**能一键复现**（`scripts/verify-worker-packaged.mjs`）。

- **正向**：从 `.app` 启动，日志里必须出现 `via=worker`。
  只断言「应用能起来」是不够的 —— 静默降级时应用一样好好的，甚至更快出数，看起来像成功。
- **负向**：把 worker 路径指到一个不存在的文件（调试缝 `BD_LOCAL_SCAN_WORKER`），
  必须出现 `via=main degraded=…` 且数据规模与正向相当。
  没有这一步，正向的绿灯也可能只是「反正它总会走主线程」的巧合。

**结果（2026-10-18 实测，Electron 37 / asar）**：`new Worker()` **能**直接读 asar 内的文件，
不需要 `asarUnpack`。但这**只能在打包态证明**，不能靠文档推断。

### 复用手法：往**真实产物**里植入坏 worker

正向/负向都只测了「入口在不在」。要证明**降级路径本身**在真实产物里生效（而不是只在单测里），
不必重跑 `dist:mac`：**复制 `.app` → `npx asar extract` → 换掉 `out/main/local-scan-worker.js`
→ `npx asar pack` → 用副本跑 `--smoke`**。让坏 worker 从环境变量选坏法，三种坏法就能共用同一个
已打包产物（省两次打包）。实测三种：顶层抛错 / 回错形状 / 回「成功但缺表」的空快照 ——
第三种正是 §3 那个洞，只有打包态复测才暴露得出来。

```bash
cp -R /Applications/X.app /tmp/x-broken.app
npx asar extract /tmp/x-broken.app/Contents/Resources/app.asar /tmp/x-asar
# 改 /tmp/x-asar/out/main/<worker>.js（读 process.env 决定怎么坏）
npx asar pack /tmp/x-asar /tmp/x-broken.app/Contents/Resources/app.asar
BD_...=1 /tmp/x-broken.app/Contents/MacOS/X --smoke     # 看日志里的 via=/degraded=
```

⚠ 用 `cp -R` 时**目标父目录必须先存在**（否则 `cp` 静默失败，后面 `asar extract` 报
`ENOENT`，看起来像 asar 坏了）。asar 里没 `app.asar.unpacked` 时可以直接用 `asar pack` 重打；
签名会失效，但只要不被打上 quarantine 属性，直接 spawn 可执行文件仍能跑起来。

### 附带一个真踩到的坑：`__dirname` 不是 `out/main`

`rollup` 把共享模块放进 `out/main/chunks/*.js` 时，`__dirname` 是那个 chunks 目录 ——
`join(__dirname, 'worker.js')` 直接指到不存在的路径。**dev 态第一次跑就红了**：

```
本机扫描降级：worker 抛错：Cannot find module '…/out/main/chunks/local-scan-worker.js'
```

做法：按「同级 → 上一级」探测；**找不到时返回同级候选而不是空串**（空串会退化成「没配 worker」的
静默降级）。

## 5. 用 `sample` 证明「阻塞真的搬家了」

`sample <pid> N -file out.txt` 的调用图按线程分块，1ms 一采 ⇒ **某线程里 sqlite 帧的样本数 ≈ 它陷在
sqlite 里的毫秒数**。四处必须注意，否则会得到相反的结论：

1. **主线程的标签会变**：启动早期是 `Main Thread`，随后重命名成 `CrBrowserMain`
   （同一台机器、同一个应用，两次采样分别拿到这两个名字）。只认其中一个 ⇒ 主线程认不出来 ⇒
   它的帧被算进「其余线程」⇒ 正负向的结论**整个反过来**。
2. **认不出主线程时必须让断言失败**：`mainFrames === 0` 在「一个都没认出来」时也成立 ——
   这是典型的**空真**。所以先断言「认出了主线程吗」。
3. **`Binary Images:` 尾巴里有 `libsqlite3.dylib` 字样** —— 不切掉就会把静态链接当成主线程在做 sqlite。
4. 只数**真干活的**帧（`StatementSync::All` / `sqlite3VdbeExec` …）；`UserDefinedFunction::xDestroy`
   这类符号两侧都会零星出现（符号化偏移的产物），拿它当判据等于没有判据。

**判据要写成「主线程最长连续样本 ≤ 50ms」，不是「主线程 0 帧」** —— 主线程自己那条只读连接上
还有 `PRAGMA data_version` / `MAX(rowid)` 探针，它会碰 sqlite（实测 0–1ms）。

实测（本机 638MB 库，装机后的 `.app`，连续三次一致）：

| | 主线程最长连续 sqlite 样本 | 其余线程 |
|---|---|---|
| 正向（走 worker） | **0–1 ms** | 976–1268 ms |
| 负向（降级回主线程） | **943–1229 ms** | 0 ms |

**另一条路是测事件循环空档**（1ms 定时器，见 `docs/daily/2026-10-18_local-db-worker-offload.md`）：
worker 路径 16ms / 主线程降级 1192ms / 纯同步 1200ms。
⚠ 那个探针第一版测出「降级 3ms」的假数字：**阻塞期间排队的 tick 回调要等阻塞结束才能跑，
而 `clearInterval` 在 `await` 的续体（微任务）里执行，比那个宏任务更早** —— 最大空档永远记不到。
必须让排队的 tick 先跑一次再清定时器。

## 6. 别把「移出主线程」当成「变快」

worker 那条路**墙钟更慢**：线程启动 + 模块加载 + 结构化克隆要多花 1–3s（实测：worker online 81ms，
空往返 18ms，但整轮 `full` 从 1120ms 变成 2901–7154ms，视机器负载）。
收益是**主线程空出来了**，不是出数更快。写验收结论时必须这么写，否则下一轮会有人拿"墙钟没变快"
来反驳。

## 7. 顺带的收益：间隔可以按判据收紧

「全量核对 6 小时一次」当初是为了避免「每 10 分钟卡一次」。worker 之后主线程的实测空档从
~1200ms 降到 **16ms**（sqlite 采样 ≤1ms），这条理由不成立 ⇒ 收紧到 1 小时，把「窗口外改值/删行」
的最大陈旧度从 6h 收到 1h。
**代价也要一起写**：24 轮/天 × ~265MB 页读取；以及**降级时**变成每小时一次 0.7–3s 的主线程冻结 ——
这正是「降级必须留痕、必须尽快修」的另一个理由。
