# 2026-10-10 灵动岛mini微调与穿透修复（复检 pass）

## 起因

- mini 点距小、条偏厚；窗口未真贴顶（有距离）；mini 态点不着、穿透到桌面。

## 真因（穿透）

隐藏稳态主进程用居中 132×26 覆盖命中且不采信渲染上报，但渲染 pill 跟 `posX`、
宽 fit-content、top 10px——三处全对不上，点 pill 必穿透。

## 改了什么（`10-10-island-mini-tune`）

- R1：dots gap 5→10，pill 高 26→22（`MINI_PILL_H` 经删除落实，与 R3 自洽），D6b/D6b2/L6 同步。
- R2：窗口 y 锁 `wa.y`（启动/show/拖拽/snapBack 四处，x 自由）；岛 `top:0`。
- R3：隐藏稳态信渲染实测矩形，`peekHitbox` pill 分支 + `MINI_PILL_*` 全删，
  过渡期全窗可点，原位收缩保留。
- 顺手：`skins.css:2469` 死注释改实（渲染实测矩形上报）。

## 验证

- `typecheck` ✓，`npm test` 全绿；复检 pass（断言真伪、钳制公式、契约删除逐项成立）。
- harness 有隐藏态/顶部截图（`.playwright-mcp/` 未跟踪）；真机点击唤出留用户目检。

## 沉淀

- 覆盖命中"主进程为准"的旧契约，在渲染能实测精确矩形时反而不如信任上报——
  跨层契约应写"谁更准听谁的"，本条只记日志，spec 层无此类条目可挂，不更新 knowledge。
