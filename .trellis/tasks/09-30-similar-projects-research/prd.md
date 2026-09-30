# 竞品调研：相似项目对比与优化方案

## Goal

搜索并对比与 BalanceDeck 功能相似的开源项目（AI 用量 / 额度 / 余额仪表盘、桌面悬浮卡片、菜单栏监控等），输出一份详细对比报告，并基于对比给出 BalanceDeck 可继续优化的方案。

## Background

BalanceDeck 是一个 macOS / Windows 常驻桌面的 AI 用量与余额仪表盘（Electron + React + TypeScript + three.js）：
- 聚合 Coding Plan 额度（OpenCode Go / Claude Code / Codex / GitHub Copilot）与 API 余额（DeepSeek / Kimi / 智谱 / 硅基流动 / 通义 / 火山方舟 / MiniMax）
- 悬浮卡片 + 菜单栏百分比 + 可收起 2D 圆环 / 3D 数字助理
- 数据可信度分级（official / cached / local）、隐私优先、凭据进系统密钥链
- 已具备 462 项单元断言 + 109 项 UI 断言

本任务通过 `sn-search-code` 等渠道调研相似项目，为后续功能优化与差异化定位提供依据。

## Requirements

1. 使用 `sn-search-code` 技能（GitHub 搜索为主，可辅以网页搜索）查找与 BalanceDeck 功能相似的开源项目：
   - 关键词方向：AI usage dashboard / quota monitor / API balance tracker / desktop pet / menu bar widget / coding plan usage / LLM cost monitor 等
   - 每类至少覆盖 1-2 个候选，总共不少于 6 个相似项目
2. 对每个相似项目采集以下信息：
   - 仓库地址、Star 数（如可得）、开源协议、最近活跃度
   - 技术栈（Electron / Tauri / 原生 / 纯 Web 等）
   - 支持平台（macOS / Windows / Linux / 浏览器）
   - 核心功能与数据源（支持哪些供应商 / 协议）
   - 与 BalanceDeck 的功能异同、值得借鉴的亮点
3. 输出一份**详细对比报告**（Markdown，中文），包含：
   - 对比总表（项目 × 维度）
   - 每个项目的逐项分析
   - BalanceDeck 的相对优势与短板
4. 输出**优化方案**：
   - 按优先级（P0 高 / P1 中 / P2 低）排列
   - 每项优化给出理由、参考竞品依据、建议落地方式（一句话级别即可）
   - 与 README Roadmap 对照，标注是新增还是已规划

## Acceptance Criteria

- [ ] 对比报告写入任务目录或 docs 下（如 `.trellis/tasks/09-30-similar-projects-research/research/report.md`），内容为中文 Markdown
- [ ] 报告包含不少于 6 个相似项目，每个项目都有仓库地址、技术栈、平台、核心功能与异同分析
- [ ] 报告包含一张对比总表
- [ ] 优化方案按 P0/P1/P2 分级，每项有理由与竞品依据，并与现有 Roadmap 对照
- [ ] 调研结论摘要回填到本 prd.md 的 Notes（便于后续把优化项转成实现任务）

## Notes

- 轻量调研任务，PRD-only 即可；不涉及代码实现。
- 调研过程通过 `sn-search-code`（GitHub 搜索 + API 元数据）+ 网页搜索交叉验证完成。
- 完整报告：`.trellis/tasks/09-30-similar-projects-research/research/report.md`

### 调研结论摘要

- 共调研 23 个相似项目，分 4 类：菜单栏/托盘监控（CodexBar 22k★、ClaudeBar、codenotch、CodeZeno、Claude-God 等）、本地用量/成本仪表盘（TokenTracker、token-monitor、claude-usage、dsh-cost-meter 等）、Coding Plan 额度查询器（opencode-quota、CodingPlanQuota、AI_Usage_Dashboard、quota-viewer 等）、桌面宠物（TermiPet、petto）。
- **BalanceDeck 差异化仍成立**：唯一同时覆盖「Coding Plan 额度 + API 余额 + Token Plan」并以「悬浮卡片 + 菜单栏 + 3D 数字助理 + 数据可信度分级」呈现的桌面工具。
- **最紧迫差距集中在「分析 + 提醒」**：竞品普遍具备系统通知（ClaudeBar/AI_Usage_Dashboard）、用量预测 burn rate（Claude-God/CodeZeno/opencode-quota）、历史趋势/热力图（Claude-God/TokenTracker/dsh-cost-meter），BalanceDeck 目前只有 TTS 播报与瞬时百分比。
- **优化方案优先级**：
  - P0：①额度阈值提醒 + 系统通知（Roadmap R1 落地）；②用量预测/预计耗尽时间（复用已有采集数据）
  - P1：历史趋势图、供应商覆盖扩展（Antigravity/Gemini/Cursor/OpenAI）、托盘动态颜色、多账户分组、资源占用优化（应对 Electron 太重质疑）、轻量 CLI/JSON 快照导出
  - P2：macOS WidgetKit 小组件、CSV 导出、皮肤市场（R4）、多语言 i18n、手机联动、成本追踪
- **下一步建议**：把 P0-1 与 P0-2 拆成独立 Trellis 实现任务，用户确认后执行。