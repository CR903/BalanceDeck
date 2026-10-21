# 知识索引

从日常日志沉淀的**可复用**结论。与 `docs/daily/` 的分工：daily 记「这次做了什么」，
这里记「下次不该再踩」——只收能落成判断准则的东西，不抄流水账。

两级索引：本文件是总索引，每个端目录下有自己的 `index.md`。

## 端目录

| 端 | 说明 |
|---|---|
| [`agents/`](agents/index.md) | AI 协作纪律（子代理校验、Trellis 任务产物优先等） |
| [`common/`](common/index.md) | 跨端约定与流程门禁（daily → knowledge 沉淀门禁） |
| [`frontend/`](frontend/index.md) | 渲染层：图表几何、皮肤 token、React 纪律 |
| [`main/`](main/index.md) | 主进程：采集调度、出网超时与可达性记账 |

## 知识文档总登记

| 文档 | 端 / 分类 | 一句话 |
|---|---|---|
| [subagent-verify](agents/best-practices/subagent-verify.md) | agents / best-practices | 子代理报的「已完成」必须三样都对上才算数 |
| [uitest-timing](agents/guides/uitest-timing.md) | agents / guides | uitest 断言只许「等条件成立」，不许「某一瞬间的 DOM」 |
| [daily-to-knowledge](common/best-practices/daily-to-knowledge.md) | common / best-practices | daily → knowledge 的 P2 沉淀门禁（3 问 + Checklist + 拦截规则） |
| [window-series-view](frontend/architecture/window-series-view.md) | frontend / architecture | 窗口驱动用量序列的口径对齐与回退纪律 |
| [overlay-hitbox](frontend/architecture/overlay-hitbox.md) | frontend / architecture | 透明窗命中区三纪律 + 视觉高度分层归因 |
| [prototype-fidelity-diff](frontend/guides/prototype-fidelity-diff.md) | frontend / guides | 还原原型靠并排 computed style diff，不靠目测截图 |
| [petball-mount-conditions](frontend/troubleshooting/petball-mount-conditions.md) | frontend / troubleshooting | 共享门控布尔只能管一块语义：0% 是空环不是无环 |
| [system-notify-silent-failure](frontend/troubleshooting/system-notify-silent-failure.md) | frontend / troubleshooting | macOS 关通知 = Electron 静默成功 + 真实链路自验通路 |
| [worker-offload](main/guides/worker-offload.md) | main / guides | 把同步阻塞搬进 worker：契约、降级与「打包态才能测出来」的那一半 |
| [scheduler-watchdog](main/troubleshooting/scheduler-watchdog.md) | main / troubleshooting | 永不 settle 的 await = 调度权永久丢失：预算 + 轮次号失效 + 双保险超时 |
| [local-db-scan](main/troubleshooting/local-db-scan.md) | main / troubleshooting | 本机大库扫描：WAL 活跃区不能当缓存键、JSON 列只能靠投影 + 增量 |
| [scheduler-lifecycle](main/architecture/scheduler-lifecycle.md) | main / architecture | 采集调度生命周期：预算 + epoch 闸门 + 超时双保险 + 合并待跑 |
| [persistence-map](main/architecture/persistence-map.md) | main / architecture | 持久化模型：userData 三份 JSON、keystore/usage-history 分工 |
| [adapter-protocol](main/architecture/adapter-protocol.md) | main / architecture | 适配器协议：ProviderAdapter 接口、三级路由、并行采集 |
| [view-tree-map](frontend/architecture/view-tree-map.md) | frontend / architecture | 单 overlay 窗四形态、App 单一状态持有者、read-model 契约 |
| [alert-path](frontend/architecture/alert-path.md) | frontend / architecture | 提醒链路：alertOrchestrate 收口、双闸门锁存、通知只在 main 发 |
| [shared-pure-model](common/architecture/shared-pure-model.md) | common / architecture | shared 纯函数单一真相源 + 静态测试门 + load-ts 纪律 |
| [uitest-command-map](agents/guides/uitest-command-map.md) | agents / guides | test:* 脚本映射与 smoke/uitest/shots 三模式入口 |

## 沉淀规则

1. daily 日志里出现「坑」「教训」「以后注意」这类段落 → 必须判断是否值得进这里。
   判断标准：**换一个任务里会再次遇到吗？** 会就沉淀，不会就留在 daily。
2. 每条知识必须能写成「遇到 X → 做 Y，否则 Z」。写不出这个形状的是感想，不是知识。
3. 沉淀要带**取证**（命令 / 数字 / 文件行号）。没取证的结论下一轮就会被反驳。