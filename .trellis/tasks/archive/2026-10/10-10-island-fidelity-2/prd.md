# 灵动岛收起比例与展开结构还原

## Goal

对照 `prototype/dynamic-island-demo.html?variant=B`（嵌套圆环开）逐项还原两处偏差：
收起态比例失衡（logo/gap/高光/环几何），展开态结构不同（两行 vs 单行横排、无彩条、容器阴影缺层）。

## Confirmed Facts（同浏览器实测，原型 vs harness 并排取 computed style）

### 收起态

| 项 | 原型 | 实现 | 出处 |
| --- | --- | --- | --- |
| logo 边长 | 15px | 20px | `.combo-logo` vs `.isl-logo` |
| 容器 gap | 10px | 12px | `.tisland` vs `.isl-strip` |
| 高光线 ::before 宽 | 60%（318/430） | 76%（225/296） | 两边 `::before` rect |
| 环几何 | viewBox 36 / r 15.5·11.5·7.5 / stroke 3.5·3.2 | viewBox 40 / r 17·12.5·8 / stroke 3.2 | svg 属性 |
| 渐变 / 四层阴影 / glowPulse 2.6s / ::after 红晕 blur22·.35 / logo ping | 一致 | 一致 | 已核，不动 |

### 展开态

- 结构：原型 `.tcell > .top(单行) = [picon 26] [ring40·环心 `73%` 9px/700] [flex:1 > .name 12px + .legend]`；
  实现 `.isl-cell-top(logo20+name+StatusDot) / .isl-cell-mid(环 + 图例)` 两行。**主因。**
- 非嵌套时原型 `.wins` = 每窗「11px 文字 `#98989f` + 4px `.wbar`（track `#333`，`i` 宽=百分比、色=等级色）」gap 6；
  实现只有文字，**无进度条**。
- 嵌套图例：原型 `.legend` 是 `右列` 内 `<span><i色点/>5小时73%</span>`；实现 `.isl-legend` 挂在环下方。
- 原型 cell 内**无 StatusDot**（等级靠环/条颜色表达）。
- 容器：padding `16` vs 实现 `14px 16px`；渐变起点 `#2b2b31 0→#0b0b0d 28%` vs `#232328 0→…30%`；
  阴影 5 层（外投影 + danger 红晕 `rgba(255,69,58,.333) 0 0 24px` + inset 顶高光 + inset 底暗 `-8px 18px rgba(0,0,0,.7)` + 1px inset ring）
  vs 实现 3 层（缺红晕、缺底部 inset 暗）。
- 展开态原型仍有 `::before` 高光线（60%、opacity .7）与 `::after` 红晕（blur22、.35）；实现展开态两者皆空。
- 实现有原型没有的头部条 `.isl-open-head`（提示文案 +「展开面板」按钮）。

## Requirements

- R1 收起比例：logo 20→15（环 36 内 42%）、strip gap 12→10、高光线宽 76%→60%、
  环 SVG 改 viewBox 36 + r 15.5/11.5/7.5 + stroke 3.5/3.2（≤3 环口径不变）。
- R2 展开结构：cell 改单行横排 `[logo 26] [环40 含环心百分比] [右列 = name + 图例/窗口条]`，
  去 StatusDot；嵌套与非嵌套共用该骨架（右列内容分别为图例 / 文字+4px 彩条）。
- R3 窗口条：非嵌套恢复 `.wbar` 4px（track `#333`，`i` 宽 = percent、色 = 等级色）。
- R4 容器：padding 16、渐变起点 `#2b2b31` 28%、阴影补红晕与底部 inset 暗（5 层）、
  展开态补 `::before`/`::after`（与收起同参，随 `--glow`）。
- R5 去头部条 `.isl-open-head`（提示/按钮）；保留点击空白收起与双击回卡片语义（挂到现有 backdrop/手势）。
- R6 回归：`typecheck` + `npm test` 全绿（含 D6/L 章数值断言同步改）；harness 与原型并排截图验收。

## Acceptance Criteria

- [ ] AC1 收起并排截图：logo 15、gap 10、高光 60%、环几何一致，断言入 `test-structure`。
- [ ] AC2 展开并排截图（嵌套开）：单行横排 + 环心百分比 + 右列图例；（嵌套关）：文字 + 4px 彩条。
- [ ] AC3 容器 padding 16 / 渐变 `#2b2b31` / 5 层阴影 / 展开态高光线与红晕可见。
- [ ] AC4 展开态无头部条，收起/双击手势语义不回归。
- [ ] AC5 `npm run typecheck` 与 `npm test` 通过。

## Out of Scope

- 数据口径（percent/levels/read-model）、dwell 隐藏时序、拖拽与钳制、`••••` 打码、
  mini-pill 形态（上任务已定）、实机 `--uitest`。

## Open Questions

- 无。
