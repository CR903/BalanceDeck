# opencode 详情页修复：周/月序列与模型受 since 保留期限制

## Goal

修复归档任务 `10-11-opencode-detail-v2-sync` 上线后、经真实会话 live 取证发现的缺陷：`cost-by-day` / `usage/models` 的 `since` 参数走约 48h 短期数据路径，导致「本周 / 本月」的用量序列只显示最近 2 天、每模型明细只含最近 2 天的模型。

## Background

见 `research/since-retention.md`（真实会话实测）。要点：`since` 超保留期会被钳制到最近约 2 天；不带 `since` 才返回完整日聚合。5 小时窗口因在保留期内，`since` 准确（实测与窗口逐分一致）。

## Requirements

### R1 周/月用量序列取全量日聚合

- 「本周」「本月」的序列改为 `GET /api/usage/cost-by-day?range=7d|30d&bucket=day`（**不带 `since`**）。
- 在 `opencode.ts` 组装 `seriesByWindow` 时，按窗口边界 `[window.startAt, window.resetAt]` **客户端裁剪**桶，保证与 meter 窗口一致。

### R2 周/月每模型明细取 range 口径

- 「本周」「本月」的每模型明细改为 `GET /api/usage/models?range=7d|30d`（**不带 `since`**）。
- 「5 小时」保持不变：`range=24h&since=<fiveHour.start>`（实测准确）。

### R3 契约与文档同步

- 更新 `research/console-api-v2.md` 与 spec `.trellis/spec/adapters/opencode-console.md`：把「`since` 覆盖 range 起点」更正为「`since` 仅适用于窗口落在 ~48h 保留期内（5h/24h）；周/月必须用 range + 客户端裁剪」。
- 更新受影响的纯函数与测试（`seriesByWindowOf` 需感知窗口边界）。

## Constraints

- 不改变鉴权与 base；不改 `shared/types.ts` 的对外形状（除非必要性最小）。
- 保持「空数组 = 官方确认无用量（key 保留）；失败 = key 不存在」契约。
- 官方不可达时仍退回本机历史并标注「本机估算」。

## Acceptance Criteria

- [ ] AC1：真实会话下，「本周」序列覆盖该自然周全部有数据日（≥2 天时不止 2 天），「本月」覆盖订阅月范围。
- [ ] AC2：「本周/本月」每模型明细为整周/整月口径（与不带 since 的 `models?range=7d|30d` 一致）。
- [ ] AC3：「5 小时」序列与每模型明细仍与窗口逐分一致（保持现状，不回归）。
- [ ] AC4：`seriesByWindow[窗口]` 的桶全部落在 `[window.startAt, window.resetAt]` 内。
- [ ] AC5：无网络/官方不可达时行为不劣化（退回本机 + 标注）。
- [ ] AC6：`npm run typecheck`、`npm run test` 全绿；spec/research 已同步更正。

## Out of Scope

- 让周/月 models 精确对齐「自然周/订阅月」边界（接口无日粒度，做不到；仅记录限制）。
- 其他端点与 UI 结构改动。
