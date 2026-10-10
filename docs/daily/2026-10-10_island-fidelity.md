# 2026-10-10 灵动岛高保真还原（复检 pass，harness 截图交付）

## 起因

全新 build 仍与原型 B 不像：缺常驻辉光/高光线、logo 静态、combo 尺寸差、
展开无嵌套环、启动即收起找不到位置。

## 改了什么（`10-10-island-fidelity`）

- `island.css`：常驻辉光（随最满家等级色 `--glow` 下发）+ 高光线 + danger 呼吸；
  logo 呼吸/ping/danger 抖动（合成器属性，reduced-motion 全静止）；
  combo 40→36 + gap 10→12；pill 收窄（padding/gap，高不动）。
- `IslandView.tsx`：`RING_SIZE` 拆 36/40/40；`PlanCell` 多窗嵌套环 40 + 图例，
  单窗回退；logo 15px（36×42%）。
- `overlay.ts`：仅启动序列内存态强制展开（不回写），收起后吸顶居中。
- `test-structure.mjs` 新增 L 章 24 条数值门。

## 验证

- harness 真机截图：`fidelity-collapsed.png`（辉光+嵌套环+居中 logo）、
  `fidelity-open.png`（嵌套+图例+余额卡），与原型同结构。
- `typecheck` ✓；`npm test` 全绿（含 L 章；dock-hide 时间敏感断言偶发抖动一次，
  重跑全绿，archive 前又跑一遍确认）。
- 复检 pass；`--uitest` 实机未做（harness 截图为交付证据）。

## 沉淀

- 截图超时系浏览器端卡死，`browser_close` 重开即好；动画页截图无需等字体，
  属工具层经验，不进 knowledge。
