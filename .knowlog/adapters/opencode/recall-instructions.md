<!-- KNOWLOG:START (由 knowlog skill 托管；规则单一真相在根 AGENTS.md 的 KNOWLOG 托管块) -->
本仓有完整的开发文档体系（`docs/`）。写码与收尾时遵守：

- **规则以根 `AGENTS.md` 为准**：若是 `KNOWLOG` 托管块读块内；若是项目自己写的等价规范段（日志规范/知识库导航/领域路由/门禁）读那几段。本文件只是指针，不要在此复制规则。
- **动手前召回**：`bash scripts/knowledge-retrieve.sh "<任务描述或将要改的代码片段>"`
  按关键词给出"本仓已沉淀的坑位/规范 + 文档路径"，命中后请全量读那份文档再写代码。
- **任务收尾**：`bash scripts/new-daily-log.sh <slug>` → 有可复用结论 `bash scripts/new-knowledge.sh ...` → `bash scripts/check-daily-index.sh --strict` 必须绿灯。
- **涉及业务线时**：先按 `AGENTS.md` 的路由表全量加载 `docs/domain context/domain-*.md`。

> 说明（OpenCode ≥ v2）：本文件通过项目根 `opencode.json` 的 `instructions` 字段每会话注入。
> 已实测：`opencode debug config` 能看到该条，`opencode run` 时模型能读到文件内容。
> v1（`@opencode-ai/plugin` 的 `chat.message` 钩子）才支持"每轮按关键词注入"，v2 的插件 API 不同（Effect 注册式），
> 所以 v2 上"自动召回"由本文件（每会话必读的规则）＋ 上方的命令行召回共同完成。
<!-- KNOWLOG:END -->
