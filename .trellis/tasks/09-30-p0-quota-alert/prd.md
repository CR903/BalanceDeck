# P0-1 额度阈值提醒与系统通知

## Goal

在现有 TTS 语音播报基础上，增加**系统通知**（macOS Notification Center / Windows Toast），并支持**可配置阈值**，让用户在额度超阈值时第一时间被提醒，延续「数据诚实」原则。

## Background

- 竞品依据：ClaudeBar（用完前通知）、AI_Usage_Dashboard（quota/reset 提醒）、Claude-God、CodeZeno 均具备系统通知；BalanceDeck 目前只有 TTS 语音播报，无系统通知。
- 对应调研报告 P0-1，Roadmap R1「额度阈值提醒（>80% 系统通知）」落地。
- 现有基建：`trigger-engine` / `alert-orchestration` / `voice`（TTS 播报 + 频率闸门 + 确认提醒）测试套件已存在，系统通知是新增输出通道。

## Requirements

1. **系统通知通道**：额度超阈值时发送系统通知（主进程 `Notification` / `Toast`），与 TTS 语音播报并存，二者可分别开关。
2. **可配置阈值**：
   - 默认：>80% 提醒一次、>95% 强提醒、重置前 1 小时提醒「即将重置」。
   - 设置页提供开关与阈值输入（全局配置，后续可按供应商扩展）。
3. **通知内容**：供应商名、窗口（5H / W / M）、当前百分比、重置倒计时、数据来源（official / cached / local）。
4. **去重防轰炸**：同一供应商 + 窗口 + 阈值只提醒一次，直到用量回落越过阈值后才重新武装（reset）。
5. **数据诚实**：当数据源为 cached / local 时，通知中明确标注「缓存 / 本机估算」，不伪装实时。
6. **与现有 trigger-engine / alert-orchestration 集成**：复用频率闸门、触发判定与确认机制，不重复造轮子。
7. **测试**：为新增的纯函数逻辑（阈值判定、去重武装/复位、通知文案）补充单元测试；UI 走查覆盖设置页。

## Acceptance Criteria

- [ ] macOS 通知 / Windows Toast 在阈值触发时出现，内容包含供应商、窗口、百分比、重置时间、数据来源
- [ ] 设置页可配置阈值与开关；默认值符合上述约定
- [ ] 同一阈值不重复提醒（去重逻辑有单元测试覆盖「触发 → 忽略 → 回落复位 → 再触发」）
- [ ] TTS 语音播报不受影响，可与系统通知分别开关
- [ ] cached / local 数据触发时通知明确标注（如 `⚠ 缓存数据` / `⚠ 本机估算`）
- [ ] 新增纯函数有单元测试；`npm test` 全部通过
- [ ] `npm run typecheck` 通过

## Notes

- 本任务为复杂实现任务：`task.py start` 前需完成 `design.md` + `implement.md`，并 curate `implement.jsonl` / `check.jsonl`。
- 与 `p0-usage-prediction` 相互独立，可并行开发（如共享文件冲突则串行合入）。