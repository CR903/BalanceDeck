# knowlog 修复与知识库初始化：33 篇日志归位 + 7 篇架构知识从代码取证落库

任务：无 Trellis 任务（用户选「不建任务直接做」）。

## 起因

用户两次请求：① `npx knowlog doctor` 健康检查；② 「knowledge 里的 frontend 和 main 有什么区别？帮我按项目内容初始化 knowledge 内容」。

| # | 证据 | 观测值 |
|---|---|---|
| E1 | `npx knowlog doctor`（体检前） | FAIL：33 错误（结构）+ 66 错误（日志↔索引）+ 10 告警 |
| E2 | `ls docs/daily/`（修复前） | 33 篇日志全平铺在 daily/ 根，无月份目录 |
| E3 | `docs/index.md`（修复前） | 32 条链接全是旧扁平路径；`uitest-timing-hardening` 重复登记 2 行（L36/L39） |
| E4 | `.keyword-map.json`（修复前） | 11 篇知识文档 0 条召回规则 |
| E5 | 体检后 doctor | 三项全 PASS，`docs-doctor.sh --strict` exit=0 |

## 改了什么

| 文件 | 改动 |
|---|---|
| `docs/daily/2026-10/` | 33 篇日志 `git mv` 归位月份目录（索引同步改 `daily/2026-10/` 前缀 + 去重 L39 + 补 `hidden-ball-column-bug` 漏登记行） |
| `docs/knowledge/` | 删根下 4 个 flat 残留骨架目录（architecture/guides/troubleshooting/best-practices，仅 README+.gitkeep） |
| `docs/knowledge/<端>/<分类>/` | 11 篇旧知识按内容归类 `git mv`（如 `frontend/window-series-view.md` → `frontend/architecture/`）；每端补 README + 分类目录 .gitkeep |
| `docs/knowledge/index.md` | 重写为 by-end 两级索引 + 新增「知识文档总登记」表（18 条） |
| `.keyword-map.json` | `reindex-knowledge.sh --apply` 补 27 条召回规则 → 现 36 条 |
| **7 篇新知识**（本次初始化） | `main/architecture/{scheduler-lifecycle,persistence-map,adapter-protocol}`、`frontend/architecture/{view-tree-map,alert-path}`、`common/architecture/shared-pure-model`、`agents/guides/uitest-command-map` —— 全部经 4 个探索子代理取证（文件:行号:函数名），无凭空编写 |
| `docs/index.md` | 新增日志索引行（脚本插入后回填标题/任务名） |

## 设计取舍

### ① frontend 与 main 分端是有意的分工，不是重复

frontend = 渲染进程（看得见的错），main = 主进程（看不见的错：界面看不出异常，只有心跳/日志/sample 知道），common = 跨端约定。用户的疑问由端 README 直接口头回答并已写入 `main/README.md`。

### ② 知识归类按「失效面」不按文件名

例：`agents/uitest-timing` 归 guides（怎么写断言的方法）、`subagent-verify` 归 best-practices（判断准则）、main 三篇旧坑全归 troubleshooting、新写的生命周期/存储/协议归 architecture。

### ③ 新知识先由 `new-knowledge.sh --keywords` 占位登记，再覆写正文

脚本对已存在文件会拒绝创建（new-knowledge.sh:84），且关键词从正文提取——所以先占位（显式 --keywords 保证召回正则准确）、后覆写，规避「模板正文提取出废规则」。`--keywords` 手滑打了 `EXPLAPDED` 拼写错，事后改键为 `setClosed|primaryWindow|openDetail` 形状的正则。

### ④ 未做的：给每篇新知识配 daily 来源日志

判据：本次是「代码事实沉淀」不是踩坑复盘，`--source` 指向 `src/**` 即可，不在 daily 里编造流水账。

## 取证（命令 + 原始输出）

```bash
npx knowlog doctor            # 修复前：33+66 错误 → 修复后：三项 PASS
bash .knowlog/docs-doctor.sh --strict   # exit=0 ✅
bash .knowlog/reindex-knowledge.sh --apply  # 11 篇无规则 → 补 27 条
```
