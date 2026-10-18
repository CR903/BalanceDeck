# 本机用量首轮全量移出主线程（worker/utilityProcess）

## Goal

后续任务（由 10-18-local-db-off-mainthread 的 design.md §6 判据触发，两个孩子任务的核查代理一致建议单开）：本机用量扫描的首次全量仍同步阻塞主线程。实测：隔离热页 1222/2971/4418ms 三次全部越过 900ms 红线（同条件旧实现是它的 2.31–3.37 倍，证明投影+增量真实有效）；剩余成本是 ~265MB data 页读取量，属结构性，只能靠移出主线程消除。附带收益：全量核对可从 6 小时收紧（甚至常驻），把窗口外改值/删行的最大陈旧度一起收掉。风险面：electron-vite 主进程 worker 需独立构建入口 + out/main 资源解析与 asar 内路径，失败只在打包态复现（本仓无 CI 兜底），因此必须先出 design.md 评估 utilityProcess 与 worker_threads 两条路。

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
