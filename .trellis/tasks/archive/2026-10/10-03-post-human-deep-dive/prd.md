# 去真人化深挖项目功能

## Goal

废除真人相关功能（真人 realism 冻结、VRoid Hub parked、移除 three.js/Rocketbox），收起态只留 2D 悬浮球；把省下的复杂度投到项目核心功能：贴边隐藏、国内订阅、皮肤市场、成本追踪、CSV 导出。

## Task map

| 子任务 | 目录 | 状态 |
|---|---|---|
| 废除真人相关功能 | `10-03-remove-human` | planning（待规划） |
| 悬浮球贴边自动隐藏 | `10-03-dock-autohide` | planning（本轮先行，PRD/design/implement 已齐） |
| 国内订阅套餐（GLM/Kimi） | 待建 | deferred（`TASKS.md` M3 未做） |
| 皮肤市场/主题包导入导出 | 待建 | deferred（`TASKS.md` M3 未做，P2-3） |
| 成本追踪（价格目录） | 待建 | deferred（P2-6） |
| CSV 导出 | 待建 | deferred（P2-2，与趋势数据联动） |

依据：`.trellis/tasks/archive/2026-09/09-30-similar-projects-research/research/report.md` §6（P0/P1 已在 09-30～10-03 交付，见归档 `10-01-p1-*`）。

## Acceptance Criteria

- [ ] 真人相关代码/素材/文档/测试下线，默认形态仅 2D 悬浮球
- [ ] 贴边隐藏交付（见子任务验收标准）
- [ ] deferred 四项各自独立成子任务，不在本父任务内直接实现

## Notes

- 父任务只做需求源与任务地图，不直接实现。
- `09-18-human-realism`（in_progress）与 `09-18-vroid-hub`（planning）冻结，待 remove-human 规划时决定归档方式。
