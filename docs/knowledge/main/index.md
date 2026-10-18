# 端：main（主进程）

主进程的调度、出网、持久化。这些地方的失效模式共同特征：**界面看不出异常**，只有落盘心跳、
日志或 `sample` 才知道「它没在干活」。

| 知识 | 一句话 |
|---|---|
| [scheduler-watchdog](scheduler-watchdog.md) | 永不 settle 的 await = 调度权永久丢失：要有轮次预算 + 轮次号失效，`AbortController` 兜不住建连前挂起；收尾回调抛异常同样会杀死循环；`current(epoch)` 闸门必须与写入同处一个同步块（中间有 `await` 即 TOCTOU） |
| [local-db-scan](local-db-scan.md) | 周期性读一个**别人正在写**的大库：缓存键里放 `-wal`/`-shm` 等于没有缓存（活跃写入区 5 秒就变）；变更判据用 `PRAGMA data_version`（区分"真写了"与"只是被 touch"）；JSON 列的数据用 SQL 投影省 CPU 但省不掉页读取量，要进毫秒级只能靠增量（游标必须用**有索引**的列，`time_updated` 没有）或 worker；增量的合并键必须是行身份（rowid），用 `t\|cost` 这类内容键会把改写过的行算两遍 |
| [worker-offload](worker-offload.md) | 把同步阻塞搬进 worker：回传的必须是**能重建状态的那一份**（只回传派生结果会让下一轮增量失去快照 ⇒ 数据变空，且小夹具会掩盖它）；降级必须留痕、超时按整次操作计、迟到结果按 `seq` 丢弃、卡住的线程必须换掉；**回包「形状对」≠「内容对」**（`ok:true` + `tables:[]` 会把数字静默归零，调用方要拿独立期望校验内容，判据是**表名集合**不是行数，且要留一条"可信的空"负向前提）；`new Worker()` 能不能读 asar **只能在打包态证明**（正向 + 负向两次 + 往真实产物里植入坏 worker 的复用手法）；`sample` 里主线程的标签会在 `Main Thread`/`CrBrowserMain` 之间变、`Binary Images` 尾巴有假 sqlite 帧、"认不出主线程"会让断言空真；测事件循环空档时 `clearInterval` 必须等排队的 tick 先跑完 |
