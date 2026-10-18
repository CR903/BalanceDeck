# 采集健壮性与主进程阻塞修复（父任务收尾）：同步卡死 + 每轮 2 秒沙漏

任务：`.trellis/tasks/10-18-sync-stall-and-mainthread-block`（父任务，三个孩子均已归档）

## 起因

用户两个症状（2026-10-18）：

- 「程序经常卡住，鼠标上去就是转圈状态」
- 「同步有时点击没有反应……已经 3 小时没有同步了，刷新也没有反应」

定位过程与实测证据见父任务 `prd.md` 的 Background 表（E1–E9）。最关键的一条是**重启验证**：
同一构建、同一网络，kill 后重启，`balance-export.json` 12:39 → 15:49:44、`usage-history.json`
12:25 → 15:48:40 —— **只有重启才恢复** ⇒ `running` 被永久卡死。

## 改了什么（三个孩子）

| 孩子 | 交付 | 归档提交 |
|---|---|---|
| `10-18-sync-collect-watchdog` | 轮级预算 120s + epoch 失效闸门 + 刷新 started/queued + 出网 race/abort 双保险 + DetailView 反馈 | `0c4f8ef` / `8904a2a` |
| `10-18-local-db-off-mainthread` | 本机 `opencode.db` 扫描：SQL 投影 + rowid 增量 + 缓存键剔除 `-wal`；稳态 1935ms → 22–49ms | `0c4f8ef` / `b5cbc75` |
| `10-18-local-db-worker-offload` | 首次全量移出主线程（worker 宿主 + 打包态正负向验证）；全量核对 6h → 1h | `6b9bb6d` / `9ef6c93` |

## 跨孩子验收（逐条）

| AC | 结论 | 证据 |
|---|---|---|
| AC1 两孩子 typecheck + npm test 全绿、护栏先弄坏一次 | ✅ | 各自 prd 的变异红集（A 8 组、B 12 组、C 8 组） |
| AC2 挂起一轮不重启自愈 | ✅ | 临时 4000ms 预算实测：`轮次超时 → collect stale 丢弃 7 条迟到结果 → 下一轮成功` |
| AC3 连续两轮同步阻塞 < 100ms/轮、无 > 200ms 主线程热点 | ✅ | 稳态 22–49ms/轮；打包态主线程 sqlite 最长连续 0–1ms（红线 200ms） |
| AC4 连续 ≥ 30 分钟两症状复测 | ✅ | 见下「装机后长窗口取证」 |
| AC5 日志 + 索引门禁 | ✅ | 三个孩子各一篇日志 + 索引行；父任务本篇 |
| AC6 超时轮不伪造数据 | ✅ | 超时只推 `scanning:false` + `lastTimeoutAt`；`bodyHash` 不含 `generatedAt` ⇒ 超时推送不写盘，时间戳如实变老 |

## 装机后长窗口取证（2026-10-18 21:50 → 10-19 00:46）

装机产物：`/Applications/BalanceDeck.app`，`app.asar` 哈希 `5e346f03…`（与 `dist/mac` 一致）。

```
实例：pid 68582，21:50:06 启动，00:46 仍存活（2.9 小时）
心跳：balance-export.json  mtime 00:46:58，updatedAt 2026-10-18T16:46:56Z（= 本地 00:46:56）
历史采样（只在 collect 的 finally 里跑 ⇒ 它是"采集循环活着"的直接证据）：
  21:50 之后采样点 11 个：10-18 21:57 → 10-19 00:34
  相邻间隔：中位 15.6 分钟，最大 15.9 分钟
  > 25 分钟的断点：无
  窗口总长：2.6 小时
```

**判据成立**：AC4 要求 ≥30 分钟且每轮前进；实测 2.6 小时、11 个采样点、**无一处超过 25 分钟的断点**
⇒ 采集循环在这段时间里一次都没停。对照故障期（冻结 3 小时、刷新无反应、只能重启）。

另有 10 分钟窗口的逐轮记录（前一轮会话）：10 轮、0 超时、10/10 轮 `cached=0`、
首轮 `full 736ms` 之后全部 `delta 22–49ms`、`updatedAt` 每轮前进。

## 未完成 / 存疑

1. **AC4 的窗口口径**：原写"≥30 分钟"，实际取到 2.6 小时连续采样（超出要求）；
   最早那次 10 分钟窗口是按用户要求缩短的，两个口径都记在 `prd.md` 里。
2. **首轮全量 736ms** 仍高于孩子 B 的 900ms 红线（隔离重测 1222/2971/4418ms）——
   已由孩子 C 的 worker 化解决（打包态主线程 sqlite 0–1ms）；C 自己的存疑项见其日志。
3. **`--uitest` 的 flaky 已单独修掉**（`10-18-uitest-timing-hardening`，翻转键 1 → 0），
   它曾是"每次验收都要打折"的工具问题，不再构成本任务的存疑。
4. **「跑完 `app.quit()` 不退」**（间歇、既有；spec `quality-guidelines.md:601` 早有记载）
   仍未定位，只影响 QA 跑法，不影响产品运行。
5. **`10-07-detail-predict-trim-heatmap` 的遗留**与本任务无关，但它要求的
   `.trend-cell`/`.trend-head` 断言确认**从未存在**（真实类名 `.trend-chart`/`.trend-bar`/
   `.trend-records-*`）—— 供它收尾时改判据或改为截图走查。

## 后续

- 父任务归档后，本轮的三个孩子 + 两个顺带任务（`10-18-docs-gate-files`、
  `10-18-uitest-timing-hardening`）全部闭环。
- 剩余活跃任务：`10-04-water-fluid-redesign`（父，4/5）、`10-04-skin-fluid-redesign`
  （等人眼动态终验）、`10-07-detail-predict-trim-heatmap`（等实机视觉走查）。
