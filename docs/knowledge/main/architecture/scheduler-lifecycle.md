# 采集调度生命周期（main）

适用：改采集节奏、加轮次逻辑、排查「同步卡死 / 刷新没反应 / 数据不更新」之前必读。
两份循环代码只有一份真相：装配在 `scheduler.ts`，控制流在 `collect-loop.ts`。

## 结构：装配层 / 控制流层两层拆分

- `src/main/scheduler.ts` —— **装配层**：构造轮体 `runRound`，接 `push`/`updateTray` 回调、读设置。
- `src/main/collect-loop.ts` —— **纯控制流层**：不 import electron，可被 `scripts/test-collect-loop.mjs` 单测直接加载。拆分原因的注释记录在 scheduler.ts:26-34。

## 循环形态与关键常量

- 循环是 **`while + await sleep(delay)`**，不是 `setTimeout` 链（collect-loop.ts:9-12, 82-95）；`sleep` 的句柄是闭包局部量（`sleepTimer`/`wake`），同刻只有一个睡眠者。
- `src/main/scheduler.ts:39-54`：
  - `DEFAULT_INTERVAL = 60_000`（默认刷新 60s）；用户可设 `MIN_INTERVAL = 10_000` ~ `MAX_INTERVAL = 300_000`
  - `COLLECT_BUDGET_MS = 120_000`（轮次预算；超时整轮作废）
  - `COLLECT_SLOW_WARN_MS = 45_000`（软阈值：只记「轮次偏慢」日志，不打断，collect-loop.ts:130-131）
  - 单次出网超时默认 12s（`request.ts:25`，`req.timeoutMs ?? 12000`）
- **没有失败退避**：轮间节奏固定 `intervalMs()`，失败轮不改变下一次间隔（collect-loop 每轮现读设置）。失败时的「数据层退避」是 `applyCachePolicy`（`src/shared/quality.ts`）：失败轮沿用上轮快照并标 `cached`，绝不把估算当实时（scheduler.ts:129）。

## 三条失效防线（顺序不能动）

1. **轮次号 epoch 失效闸门**：每轮 `epoch += 1`；超时处理时**先 `epoch += 1` 作废旧号，再回调**（collect-loop.ts:121-128，顺序有注释钉死）。轮体在写快照/推送/托盘**之前**必须 `current(epoch)` 校验（scheduler.ts:132 丢弃迟到采集、:146 收尾也在闸门内）——中间若有 `await` 即 TOCTOU。
2. **超时双保险**（request.ts:48-63）：`AbortController` 只对已进入 fetch 状态机的请求有效，**卡在 DNS/TCP 建连前的请求 abort 管不到**，所以再加 `Promise.race` 定时器在同一 `ms` 后 reject `AbortError`（复用该名字以命中 `shared/quality.ts` 的 `isNetworkError` 分类）。`decided` 标志（request.ts:34）防止迟到的响应改写离线记账。
3. **轮次级 deadline**（`src/main/deadline.ts:26-43` `withDeadline`）：把整轮包住，超时返回 `{ ok:false, reason:'timeout' }` 而不 reject；**不取消**原 promise——过期轮靠 epoch 机制丢弃，不靠它杀。`onTimeout` 只如实推状态、记 `timeoutAt`（scheduler.ts:169-172），不伪造数据。

## 刷新 / 退出 / 离线语义

- **合并待跑**（collect-loop.ts:183-198）：`requestRefresh()` 返回 `'started' | 'queued'`；在飞时置 `pending`（队列深度 1，点 10 次与 1 次等价，**不重置自动节奏**）。`scheduler.refreshNow()` 在 queued 时**当场**推 `scanning: true`（scheduler.ts:194），防「点了没反应」。
- **generation 代际退出**（collect-loop.ts:64, 134-137, 170）：`stop` 只置标志并 `wakeNow()`，不杀在飞轮；stop 后再 start 时旧循环靠 `myGeneration === generation` 自行退出，保证不会两条循环并行。
- **离线判定记账**（`net.ts:20, 47-68`）：模块级 `failStreak`/`lastOkAt`/`lastFailAt`；`markNetResult` 只把 `isNetworkError`（DNS/连接/超时，**不含 HTTP 4xx/5xx**）计入；`isOffline()` = `net.isOnline()` 为 false **或** `failStreak >= 2 && lastFailAt > lastOkAt`。调试开关：`BALANCEDECK_FORCE_OFFLINE`（net.ts:30-36）、`BALANCEDECK_DEBUG` 写 `/tmp/balancedeck-scheduler.log`（scheduler.ts:70-75）。

## 数据流与采样纪律

- 轮体（scheduler.ts:106-155）：`buildAdapters(await listInstances())` → `collectAll(adapters, {...})` → 按 provider 注册表过滤 enabled → `applyCachePolicy(上轮, 本轮)` → 写内存 `lastSnapshots`/`lastSync` → 收尾 `sampleUsageHistory()` + `push` + `updateTray`。
- 快照本体**不落盘**（内存 + 推窗口）；磁盘对应物只有历史采样点 `usageHistoryStore.appendBatch()`（scheduler.ts:283，`.catch()` 防拖垮采集）。
- 历史采样（scheduler.ts:246-301）：**按间隔记**（`SNAPSHOT_INTERVAL_MS = 15 分钟`）而非每采集轮记；只记 `status === 'ok'`；`pct` 不可知写 **null 不写 0**；`used`/`unit` 成对落盘；保留期读 extras `sample:usageHistoryDays`。
- IPC 面（`src/main/ipc.ts`）：`state:get`(:110) 全量拉取、`ui:refresh`(:134) → `refreshNow()`、`extras:get/set`(:250/258)（改 `refreshInterval` 等频率键触发 `reconfigure()`，改非 `ui:` 键触发刷新）、`usage:predict`(:410)、`usage:setRetention`(:421)。主动推送不走 handler，是 main 直接 `webContents.send`。

## 参考

- 失效预防的坑位总结见 [scheduler-watchdog](../troubleshooting/scheduler-watchdog.md)。
- 验证：`npm run test:collect-loop`（控制流单测）、`npm run test:deadline`。
