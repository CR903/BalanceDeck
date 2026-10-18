# 端：main（主进程）

主进程的调度、出网、持久化。这些地方的失效模式共同特征：**界面看不出异常**，只有落盘心跳、
日志或 `sample` 才知道「它没在干活」。

| 知识 | 一句话 |
|---|---|
| [scheduler-watchdog](scheduler-watchdog.md) | 永不 settle 的 await = 调度权永久丢失：要有轮次预算 + 轮次号失效，`AbortController` 兜不住建连前挂起；收尾回调抛异常同样会杀死循环；`current(epoch)` 闸门必须与写入同处一个同步块（中间有 `await` 即 TOCTOU） |
| [local-db-scan](local-db-scan.md) | 周期性读一个**别人正在写**的大库：缓存键里放 `-wal`/`-shm` 等于没有缓存（活跃写入区 5 秒就变）；变更判据用 `PRAGMA data_version`（区分"真写了"与"只是被 touch"）；JSON 列的数据用 SQL 投影省 CPU 但省不掉页读取量，要进毫秒级只能靠增量（游标必须用**有索引**的列，`time_updated` 没有）或 worker；增量的合并键必须是行身份（rowid），用 `t\|cost` 这类内容键会把改写过的行算两遍 |
