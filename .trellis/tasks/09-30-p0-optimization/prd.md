# P0 优化实现：提醒通知、用量预测与素材瘦身

## Goal

把竞品调研报告（`.trellis/tasks/09-30-similar-projects-research/research/report.md`）中的 P0 优化项拆成可并行实现的子任务，并调研用免费像素宠物/玩偶素材替代 3D 真人数字人给应用瘦身的可行性。

## Background

调研报告结论：BalanceDeck 与竞品相比，最紧迫的差距集中在「分析 + 提醒」——
- 竞品普遍具备**系统通知**（ClaudeBar / AI_Usage_Dashboard / Claude-God）
- 竞品普遍具备**用量预测 / burn rate**（Claude-God / CodeZeno / opencode-quota）
- 应用体积方面，Electron 基础开销被竞品（如 quota-viewer 主打 Go+Wails ~50MB）作为攻击点；本仓库 3D 真人数字人素材（Rocketbox，每人 1 模型 + 11 条动作）体积较大，用户希望评估用轻量像素宠物/玩偶素材替代以瘦身。

## Child Task Map

| 子任务 | 交付物 | 验收要点 |
|---|---|---|
| `p0-quota-alert` | 额度阈值提醒 + 系统通知 | 阈值可配置；系统通知输出；TTS 保留可单独开关；去重防轰炸 |
| `p0-usage-prediction` | 用量预测 + 预计耗尽时间 | 基于本地历史快照的速率估算；明确标注「估算」；隐私不变 |
| `pixel-pet-assets-research` | 像素宠物/玩偶素材调研报告 | ≥8 个候选素材源/接口；含许可、格式、替代可行性结论 |

## Requirements

- 三个子任务相互独立，可并行开发/调研
- 实现类子任务复用现有 scheduler / trigger-engine / alert-orchestration / voice 测试基建
- 数据诚实原则（official / cached / local）在新增功能中必须延续

## Acceptance Criteria

- [ ] 每个子任务有独立的 `prd.md`，验收标准可测试
- [ ] 实现类子任务完成 `design.md` + `implement.md` 并通过 trellis-check 校验后，方可 `task.py start`
- [ ] 父任务最终集成检查：P0-1 / P0-2 功能在 `npm run dev` 下可用；像素素材调研结论可供后续瘦身实现任务直接使用
- [ ] 实现类子任务合入后 `npm test` 通过

## Notes

- 本任务是父任务，只承载需求映射与集成检查，不直接承载实现；实现由子任务负责。
- 每个子任务按 Trellis 流程独立 start / check / commit / archive。