<!-- KNOWLOG:START (由 knowlog skill 托管；规则单一真相在根 AGENTS.md 的 KNOWLOG 托管块) -->
本仓有完整的开发文档体系（`docs/`）。写码与收尾时遵守：

- **规则以根 `AGENTS.md` 为准**：若是 `KNOWLOG` 托管块读块内；若是项目自己写的等价规范段（日志规范/知识库导航/领域路由/门禁）读那几段。这段只是指针，不要在此复制规则。
- **动手前召回**：`bash scripts/knowledge-retrieve.sh "<任务描述或将要改的代码片段>"`（关键词触发，给提示 + 文档路径；命中后全量读该文档）
- **任务收尾**：`bash scripts/new-daily-log.sh <slug>` → 有可复用结论 `bash scripts/new-knowledge.sh ...` → `bash scripts/check-daily-index.sh --strict` 必须绿灯
- **涉及业务线时**：先按 `AGENTS.md` 路由表全量加载 `docs/domain context/domain-*.md`
<!-- KNOWLOG:END -->
