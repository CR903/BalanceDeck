# 知识召回适配器

每个 agent 的注入机制不同，但**匹配逻辑只有一份**：`scripts/recall-core.py`。
这里的每个子目录都只是"把 core 的输出送进该 agent 的上下文"的薄适配器。

| 目录 | 目标 agent | 机制 | 装到项目里的位置 | 可否自动验证 |
|------|-----------|------|------------------|--------------|
| `claude/` | Claude Code | `UserPromptSubmit` 命令钩子（stdin JSON / stdout JSON） | `.claude/hooks/docs-recall.py` + `.claude/settings.json` 合并 | ✅ `claude` CLI 可跑；也可直接喂 stdin 单测 |
| `codex/` | Codex CLI | **与 Claude 同形**的钩子契约，配置在 `.codex/hooks.json` | `.codex/hooks/docs-recall.py` + `.codex/hooks.json` 合并 | ✅ `codex exec` 非交互可跑；stdin 单测 |
| `opencode/` | OpenCode ≥ v2 | TS 插件，`.opencode/plugins/*.ts` 启动时自动加载，`chat.message` 钩子每轮触发 | `.opencode/plugins/docs-recall.ts` | ✅ 插件加载可查日志；端到端需一次真实会话 |
| `dsh/` | DeepSeek Harness | **`agent/pre-step` waterfall**（官方每轮注入 seam）：插件注册该事件，把召回结果当一条带来源的 `UserMessage` 追进本轮进入批次 | `.dsh/docs-recall.patch.yml` + `.dsh/bridge/`（免安装，patch 里写 `name: ./bridge`） | ✅ 机制已定位并落地：`bash adapters/dsh/verify.sh`（6 项，全只读/dry-run）+ `bridge/selftest.mjs` 16 条断言；端到端仍需一次真实会话 |
| `cursor/` | Cursor | 项目规则文件 `.cursor/rules/*.mdc` | `.cursor/rules/knowlog.mdc` | 文件级 |
| `gemini/` | Gemini CLI | 项目上下文文件 `GEMINI.md` | `GEMINI.md`（追加托管块） | 文件级 |
| `copilot/` | GitHub Copilot | `.github/copilot-instructions.md` | 同左（追加托管块） | 文件级 |
| （无适配器） | 其它 agent（Aider / Cline / Roo / Qwen / iFlow / Antigravity / Kilo / Windsurf / Devin / Amp / Zed…） | 没有可靠的"每轮注入"机制 | 靠根 `AGENTS.md` 托管块（各家都会读）+ 手动/脚本调用 `bash scripts/knowledge-retrieve.sh "<prompt>"` | 用通用的 `--agent generic` 落地 |

## 统一约定

1. **单一真相**：规则文本（日志/知识/领域/门禁）住在 `AGENTS.md` 的 `KNOWLOG` 托管块；
   各 agent 的规则文件只写"去看托管块 + 什么时候跑召回命令"，**不复制**规则内容。
2. **失败必须安静**：钩子/插件抛异常会污染甚至中断宿主会话，所以 core 与所有适配器都吞异常、退出 0。
3. **可手动兜底**：任何 agent 都能用 `bash scripts/knowledge-retrieve.sh "<prompt>"` 得到同样结果——
   适配器只是把它变成"自动的"，不是让它"只有装了适配器才存在"。

## 安装

```bash
bash scripts/install-recall.sh --list                 # 看本机装了哪些 agent、各自会写什么
bash scripts/install-recall.sh --agent auto           # 按检测到的 agent 全部装（幂等）
bash scripts/install-recall.sh --agent claude,codex,opencode
bash scripts/install-recall.sh --agent cursor,gemini,copilot
bash scripts/install-recall.sh --agent generic
bash scripts/install-recall.sh --agent auto --dry-run # 只看计划
```
