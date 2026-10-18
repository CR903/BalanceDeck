# 采集健壮性与主进程阻塞修复（同步卡死 + 沙漏）

## Goal

把用户报的两个可见症状收敛成两条**可验证的工程约束**，而不是"再修一次看看"：

1. **采集轮次有预算**：任何一轮都不可能无限期占用调度权；超时必须回收调度权、如实推出状态，不得让后续轮次被一票否决。
2. **主进程不做大体量同步 IO**：单轮采集在主线程上的阻塞落在一个可断言的量级内，且缓存"没变"的判据必须语义正确。

本任务是**父任务**：持有需求集、任务地图与跨孩子验收口径，不在父任务内直接改代码。

## Background（确认事实，2026-10-18 实测取证）

用户原话：

- 「程序经常卡住，鼠标上去就是转圈状态」
- 「同步有时点击没有反应，比如图片中这个已经3小时没有同步了，刷新也没有反应」

取证对象是用户实跑的 `/Applications/BalanceDeck.app`（0.1.2，Electron 37.10.3），已解 asar 核对：该构建确实含 `if (running) return` 与 `LOCAL_CACHE_TTL = 120000`，下述分析对应的就是用户手上的那份代码。

| # | 证据 | 观测值 | 推论 |
|---|---|---|---|
| E1 | `balance-export.json`（挂在 `pushState` 上，`updatedAt` 每轮重新铸造 → 每轮必重写） | 冻结在 **12:39**（`updatedAt 04:39:03Z`） | 最后一轮成功采集 = 12:39 |
| E2 | `usage-history.json`（`collect` 的 `finally` 里每 15 分钟必追加） | 冻结在 **12:25** | 12:39 之后连 `finally` 都没走到 ⇒ 轮次没结束 |
| E3 | 进程 573（11:37:43 启动） | 15:35 仍在写 `state.json`，进程存活 | 边界清楚：**UI 活着、采集死了**，不是崩溃 |
| E4 | `lsof -p 573 \| grep TCP` | **0 条连接** | 卡的不是"等响应"：请求连 TCP 都没建起来 |
| E5 | `sample 573`（10s，7744 采样） | 一个线程 **99.4%** 采样陷在 `select()` | 建连前阶段（DNS/connect）的等待；`AbortController` 覆盖不到 |
| E6 | **重启验证**：同一构建、同一网络，kill 后重新启动 | `balance-export.json` 12:39 → **15:49:44**；`usage-history.json` 12:25 → **15:48:40** | **只有重启才恢复** ⇒ `running` 被永久卡死（决定性证据） |
| E7 | `~/.local/share/opencode/opencode.db` | 638 MB；31 天 assistant 消息 **25860 条 / 265 MB** | `loadLocal()` 每轮同步扫描的对象 |
| E8 | `loadLocal()` 等价口径计时 | **1935 ms/轮**（SQL 1112 + `JSON.parse` 806） | 主线程纯阻塞 = 沙漏 |
| E9 | `-wal` stamp | 5 秒内即变（`3221872@…401` → `3448472@…406`） | 缓存键含 `-wal` ⇒ 120s 缓存几乎不命中 ⇒ 等于每轮全量重扫 |

补充实测（写给 B 的设计）：`TIME_CREATED` 上有索引 `session_message_time_created_idx`；SQL 侧 `json_extract` 投影 + provider 过滤把 31 天全量从 1935ms 降到 **761ms**（且 0 次 `JSON.parse`）；换到"近 10 分钟"的增量口径是 **1ms**。表结构里 `data`（JSON 文本）是唯一数据载体，没有独立的 cost/provider 列。

## Requirements（需求集）

- **R1（A）轮次预算与看门狗**：一轮采集在有界时间内必须结束或认输；超时后调度权必须回收，`running` 不得永久为真。
- **R2（A）出网超时覆盖建连前阶段**：现有超时只有 `AbortController`，管不到 DNS/建连阶段；必须另有兜底。
- **R3（A）手动刷新有确定语义**：采集中点击刷新必须落到「开始 / 排队 / 明确拒绝」三者之一，且渲染层可感知、可显示，绝不静默丢弃。
- **R4（A）卡死可观测**：超时必须在 `BALANCEDECK_DEBUG` 日志与推送状态上留痕，不能只靠"数据不动"反推。
- **R5（B）主进程阻塞预算**：常态轮次的同步阻塞从"秒"压到"毫秒"；冷启动的全量路径也要有上界与解释。
- **R6（B）缓存键语义正确**：活跃写入区（`-wal`）不得作为"数据没变"的判据。
- **R7（B）同类隐患收口**：主进程内其它可阻塞/大体量的同步调用（同步 Keychain、同步递归扫描）改异步或加短路，且不得倒退既有诚实口径。

## 任务地图

| 孩子 | 交付物 | 独立可验收性 |
|---|---|---|
| `10-18-sync-collect-watchdog` | 采集不再永久卡死 + 刷新有确定反馈 | 可（桩适配器构造"永不 settle"即可复现并断言自愈） |
| `10-18-local-db-off-mainthread` | 每轮主进程同步阻塞降到毫秒级 | 可（可对 `loadLocal` 等价口径计时 + 断言缓存命中/增量等价性） |

**顺序**：A 先做。理由是 A 单独就能救回最痛的失效（同步永久死掉、只能重启）；B 是性能与体验，且不被 A 的产物阻塞。

## 跨孩子验收

- [ ] AC1：两个孩子各自 `npm run typecheck` + `npm test` 全绿；各自新增护栏都**先弄坏一次**确认变红（`frontend/quality-guidelines.md` 纪律）。
- [ ] AC2：A 落地后，"一轮挂起"场景在**不重启**的情况下自愈，`BALANCEDECK_DEBUG` 日志可见超时与复位。
- [ ] AC3：B 落地后，连续两轮采集（60s 间隔）主进程同步阻塞 < 100ms/轮；`sample` 中无单次 > 200ms 的主线程热点。
- [ ] AC4：真机复测两症状：连续运行 ≥ 30 分钟，`balance-export.json` 的 `updatedAt` 每轮前进；详情页点刷新有可见反馈。
- [ ] AC5：`docs/daily/2026-10-18_<slug>.md` 各一篇 + `docs/index.md` 追加（AGENTS.md 门禁）；可沉淀坑位同步 `docs/knowledge/`。
- [ ] AC6：不新增"看起来在动"的假象：超时那一轮**不伪造数据**，界面继续显示上一轮（`shared/quality.ts` 的 cached 语义），时间戳如实继续变老。

## 装机后真机复测取证（2026-10-18，窗口 10 分钟）

**前提**：`/Applications/BalanceDeck.app` 于 19:12 重建装机，`dist/mac` 与 `/Applications` 的 `app.asar` 哈希一致（`4b4d11f4…`）；解包核对新代码在包里（`COLLECT_BUDGET_MS` / `current(epoch)` / `lastTimeoutAt` / `requestRefresh` / `dbStamp` / `execFile` 全部命中）。19:53:58 以 `BALANCEDECK_DEBUG=1` 启动（pid 69845）观察。

**采集轮次**（`/tmp/balancedeck-scheduler.log`）：

```
epoch 1   本机扫描 full  736ms rows=4697
epoch 2-10 本机扫描 delta 22/26/43/23/30/28/26/49/45 ms rows≈565-571
collect done 次数 = 10        轮次超时 = 0        collect stale（迟到丢弃）= 0
cached=0 × 10（官方口径全程正常，无降级）
usage snapshot 恢复记录（故障期停在 12:25 的那条链重新在跑）
```

**心跳**（`balance-export.json` 的 `updatedAt`，每轮重铸 ⇒ 必须每次前进）：
`11:53:58 → 11:55:02 → 11:56:04 → 11:57:07 → 11:58:11 → 11:59:15 → 12:00:18 → 12:01:21 → 12:02:23 → 12:03:25`（10/10 轮全部前进，无冻结）

**主线程采样**（`sample 69845`，8s）：`sqlite` 帧 **7**；对照故障期旧样本 **22** 帧且有一个线程 99.4% 采样陷在 `select()`；新样本主线程深叶停在 CoreFoundation/libobjc 的 runloop 空转，无 sqlite/JSON 热点。

**AC 判定（如实）**：

| AC | 结论 |
|---|---|
| AC1（两孩子 typecheck + npm test 全绿、护栏先弄坏一次） | ✅ 证据见各自 `prd.md` 的变异红集 |
| AC2（挂起一轮不重启自愈，日志可见超时与复位） | ✅ 用临时 4000ms 预算实测：`轮次超时 → collect stale 丢弃 7 条迟到结果 → 下一轮成功` |
| AC3（连续两轮同步阻塞 < 100ms/轮、无 > 200ms 主线程热点） | ✅ 稳态 22–49ms/轮（首轮 736ms 除外）；采样无热点 |
| AC4（连续 ≥ 30 分钟两症状复测） | ⚠️ **部分**：窗口按用户要求从 30 分钟缩短为 **10 分钟**（10/10 轮推进、0 超时）。30 分钟窗口未跑 |
| AC5（`docs/daily/` + `docs/index.md` 门禁） | ✅ A/B 各一篇日志 + 索引行，已随归档提交 |
| AC6（超时轮不伪造数据） | ✅ 超时只推 `scanning:false` + `lastTimeoutAt`；`bodyHash` 不含 `generatedAt` ⇒ 超时推送不写盘，快照与 `lastSync` 原样 |

**未收口**：① AC4 的 30 分钟窗口未跑（用户明确要求缩短）；② 首轮全量 736ms 在应用内仍高于孩子 B 的 900ms 红线（三次隔离重测 1222/2971/4418ms），已单开 `10-18-local-db-worker-offload`；③ `--uitest` 既有 flaky 未修（HEAD 基线也红）。

## Out of Scope

- 不改数据诚实口径（`shared/quality.ts` 的 cached/local 语义、缺失值不填 0）。
- 不重构为多进程/独立采集服务；不引入状态库或自定义 hook（`frontend/hook-guidelines.md`）。
- 不重写离线探测（`net.ts` 的 `isOffline` 阈值语义保持）。
- 不动 opencode 控制台端点的抓取口径（`adapters/opencode-console.md`）。
- 不在本任务内收尾 `10-07-detail-predict-trim-heatmap` 的遗留项。
- 不新增用户可配项（超时/预算一律为常量，避免偏好面膨胀）。
