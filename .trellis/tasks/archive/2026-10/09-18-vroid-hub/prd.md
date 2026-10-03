# VRoid Hub account sync

> **已从父任务 `09-18-vroid-pet` 解绑（2026-09-26）。** 父任务已归档，本任务独立存在。
> 父任务原本记录的依赖前提已经满足（真人助理渲染管线已就位，Aria / Ray 在跑）。
> 需求仍**未探索**，下面的 Goal 是 2026-09-18 写下的一句愿望，不是需求分析。

## Goal

OAuth VRoid Hub account to list and download user characters automatically

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## 开工前必须先答的

- **为什么现在要这个？** 两位真人助理（Microsoft Rocketbox，MIT，已内置）已经在用了。
  Hub 同步唯一独有的价值是「换成用户自己在 VRoid 上做的角色」——
  也就是 `09-18-vroid-pet` 父 PRD 里 Open questions 提到的那条路。用户当初评估过一次
  觉得「没时间手工捏角色」，但那是在「只能用 VRM 本地导入」的前提下；
  现在是**自动从 Hub 拉**，前提变了，结论可能也变了。**先确认这个前提还成立。**
- **素材体积与许可证**：Hub 角色的 VRM 体积/授权条款需要核过。
  项目既有约束是「素材不进仓库，走 `bd-asset://` + `extraResources` 缓存到 `userData`」，
  新的外部拉取源是否沿用同一条路，要写清楚。
- **角色与「数字助理」定位的关系**：`CONTEXT.md` 明确「助理，不是宠物」，
  只有身份 + 动作，没有养成。Hub 角色是否也要受这条约束（禁止养成）？

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
