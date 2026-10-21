# 端：main（主进程）

主进程的调度、出网、持久化。这些地方的失效模式共同特征：**界面看不出异常**，
只有落盘心跳、日志或 `sample` 才知道「它没在干活」。

| 分类 | 内容 |
|------|------|
| `architecture/` | （暂无） |
| `guides/` | 同步阻塞搬进 worker 的契约与验证手法 |
| `troubleshooting/` | 调度循环看门狗、本机大库扫描（WAL/增量） |
| `best-practices/` | （暂无） |

索引见 [index.md](index.md)。
