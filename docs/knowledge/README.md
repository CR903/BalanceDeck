# 知识库（BalanceDeck）

> **结构化记忆** — 把「已经被验证过的结论」沉淀到这里：坑位、约定、最佳实践。
> 本项目是**多端结构（by-end 布局）**：知识先分端（`agents / common / frontend / main`），
> 每个端下再按四分类（`architecture / guides / troubleshooting / best-practices`）归档。

## 📁 结构

```
docs/knowledge/
├── README.md          # 本文档
├── index.md           # 总索引（新增知识后脚本会自动登记）
├── .keyword-map.json  # 召回规则：正则 → 提示 + 文档（关键词触发注入）
├── agents/            # AI 协作纪律（子代理校验、uitest 时序）
├── common/            # 跨端约定与流程门禁（daily → knowledge 沉淀门禁）
├── frontend/          # 渲染层：图表几何、皮肤 token、React 纪律
└── main/              # 主进程：采集调度、出网超时与可达性记账
```

每端的 `README.md` 是该端的导读，`index.md` 是该端的分端索引。

| 分类 | 放什么 |
|------|--------|
| `architecture/` | 数据口径、结构契约、启动流程、数据模型（长期事实） |
| `guides/` | 规范与约定（怎么做事、操作配方、部署流程） |
| `troubleshooting/` | 踩坑复盘（**症状 → 根因 → 正确做法 → 判据**） |
| `best-practices/` | 判断准则、门禁、做得好的模式 |

## ✍️ 贡献规范

1. **先问值不值得**：这条结论会被**重复踩**或**被反复问**吗？会 → 沉淀；一次性任务细节留在日志里
2. **命名**：`kebab-case.md`，名字要能看出问题（`stale-binary-verify.md` 好过 `bug-0723.md`）
3. **登记**：`bash .knowlog/new-knowledge.sh <端> <分类> <name> "<说明>"`（自动更新两级索引 + 挂召回规则）
4. **一句话说明**：索引里的「说明」列写清收益，不要写"优化了 XX"

## 🤖 关键词召回（非全量注入）

```bash
bash .knowlog/knowledge-retrieve.sh "修复导出单位换算"      # 手动召回（命中给提示 + 文档路径）
bash .knowlog/new-keyword.sh "consumeRate|换算系数" "同名单位不再乘系数" "docs/knowledge/frontend/troubleshooting/xxx.md"
bash .knowlog/install-recall.sh --list                     # 把召回装到各 agent（钩子/插件/规则文件）
```

## 🔍 全量检索

```bash
grep -rn "关键词" docs/knowledge/ docs/daily/ "docs/domain context/"
grep -n "关键词" docs/knowledge/index.md docs/knowledge/<端>/index.md   # 先查索引最快
```
