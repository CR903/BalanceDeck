# 灵动岛高保真还原

## Goal

实现对照 `prototype/dynamic-island-demo.html?variant=B` 逐像素还原，禁止用旧功能拼凑；
启动先展示面板，收起后回到吸顶岛。

## Confirmed Facts（原型 vs 实现并排比对）

- 收起 combo：原型 36px 环 + 居中 logo（42%）+ gap 12（demo.html:81-82,154）；实现 40px 环 +
  22px logo + gap 10（`IslandView.tsx:42,463`，`island.css:60-68`）。尺寸接近，非主因。
- 收起氛围：原型有常驻 `--glow` 环境辉光 + `::before` 顶部高光线 + danger 呼吸（demo.html:39-41,49）；
  实现只有 danger 辉光，无常驻辉光/高光线（`island.css:43-59`）。**主因之一（看起来"平"）。**
- logo 动画：原型呼吸 + ping 环 + danger 抖动 + 切换 pop（demo.html:68-74）；
  实现静态（parent 任务曾降级）。**主因之一。**
- mini-pill：原型 B 无隐藏态（A 是 16×132 竖条，demo.html:26）；实现自创横条 fit-content
  + 圆点行（`island.css:100-114`）。用户要"窄"——按横向等比收窄贴原型色。
- 展开 plan 卡：原型嵌套环 40 + 图例（`nested` 开时，demo.html:233）；实现只有单环 + 并列条
  （`IslandView.tsx:627-670`），无嵌套选项。**主因之一。**
- 启动行为：现行启动即收起（`overlay.ts` 恢复逻辑）；用户要先见面板。

## Requirements

- R1 收起氛围：补常驻环境辉光（随最满家等级色）+ 顶部高光线 + danger 呼吸，数值贴原型
  （blur 22 / opacity .35 / 高光 gradient）。
- R2 logo 动画：呼吸 + ping 环 + danger 抖动（CSS keyframes，`prefers-reduced-motion` 下静止；
  性能：纯合成器属性 scale/opacity）。
- R3 combo 尺寸贴原型：36px 环 + gap 12（岛高 52 不变）；mini-pill 横向收窄贴原型色。
- R4 展开加嵌套环模式：多窗（≥2）默认嵌套环 40 + 图例，单窗单环；并列条保留为回退
  （以 R4 还原度为准，不做开关）。
- R5 启动行为：每次启动先展示主面板（卡片列表），点收起后吸顶岛居中（已决：主面板）。
  内存态强制展开，不回写持久化（下次启动依然先见面板）。
- R6 回归：`tsc` + `npm test` 全绿；harness 与原型截图并排验收。

## Acceptance Criteria

- [ ] AC1 harness 收起截图与原型 B 并排：辉光/高光/环径/间距一致（目检 + 关键 px 断言）。
- [ ] AC2 logo 有呼吸/ping 环，danger 家抖动；reduced-motion 下全静止。
- [ ] AC3 展开多窗家显示嵌套环 + 图例；单窗家单环。
- [ ] AC4 每次启动先见面板，点收起后岛在顶部居中。
- [ ] AC5 `npm run typecheck` 与 `npm test` 通过。

## Out of Scope

- A/C 变体；`••••` 打码样式；实机 `--uitest`（harness 截图即证据）。

## Open Questions

- 无（Q1 已决：主面板）。
