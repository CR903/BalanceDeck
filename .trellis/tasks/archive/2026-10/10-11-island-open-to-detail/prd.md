# 灵动岛展开面板点击进详情

## Goal

灵动岛展开面板点击某家卡片，直接进入该供应商的详情页（与卡片视图点供应商行为一致），
省去“回卡片再点一次”。

## Background（已查证据）

- 详情路由已存在：`App.tsx:960-963 openDetail(id)`（`setOpenId` + `setView('detail')`），
  卡片视图经 `onOpen={openDetail}` 进入（`:1145`）；详情返回走 `onBack → card`（`:1137`）。
- 岛住在收起窗口，进详情须先展开窗口：`doExpand`（`:955-959`，`setCollapsed(false)` +
  `setView('card')` + `window.api.expand()`）是现成路径。
- 展开态现状：`IslandOpen`（`IslandView.tsx:677`）内 `PlanCell`（`:722`）/`BalanceCell`
  （`:799`）均无点击行为；空白点击由 `.isl-backdrop` 收起（`:691-696`）；单击岛身切换
  展开/收起（`:524` 经 finishPress），点卡片时须不误触切换。

## Requirements

- R1 展开态点击 plan/balance 卡片进入该家详情页；点击空白仍收起；单击切换展开/收起的手感不变。
- R2 进详情同时展开主窗口（收起态窗口装不下详情页），复用 `doExpand` 路径语义。
- R3 返回沿用详情页现有 `onBack → card`，不新增返回路径。

## Acceptance Criteria

- [ ] AC1 展开态单击任一供应商卡片进入其详情页（`openId` = 所点家，内容与卡片点进一致）。
- [ ] AC2 点击展开态空白仍收起；单击岛身展开/收起切换不受影响（点卡片不连带切换）。
- [ ] AC3 进详情后主窗口已展开；返回回到卡片视图。

## Out of Scope

- 不改收起态行为（单击展开、双击/右键回卡片、拖动分区）。
- 不改详情页本身（内容、返回、刷新）。

## Key Decisions

- 单击进详情（用户原话，无需双击确认）；返回路径沿用现状，不做“返回回岛”。
