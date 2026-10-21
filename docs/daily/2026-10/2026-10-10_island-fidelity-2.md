# 2026-10-10 灵动岛收起比例与展开结构还原（复检 pass，截图交付）

## 起因

用户报两处与原型出入：①收起态"动画效果和立体感不明显"；②"展开面板效果也不一样"。
前两轮高保真还原靠目测只修了显眼项，这轮改用**并排 computed style diff** 一次找全。

## 真因（同浏览器实测，原型 vs harness）

- 收起：logo 20 vs 15、gap 12 vs 10、高光线 76% vs 60%、环几何两处各写一套
  （收起 `viewBox40/r17` vs 展开 `36/r15.5`）；渐变/四层阴影/glowPulse/logo ping 其实已一致。
- 展开：实现是两行 `[logo+名+状态点]/[环+图例]`，原型是**单行** `[logo26][环40·环心 %][右列 名称+图例/彩条]`；
  非嵌套缺 4px 彩条；多出原型没有的头部条；容器 padding 14/16 vs 16、渐变起点暗、
  阴影 3 层 vs 5 层（缺红晕与底部 inset 暗）、展开态 `::before/::after` 整个丢失。

## 改了什么（`10-10-island-fidelity-2`）

- `IslandView.tsx`：抽 `RING_GEO` 收起/展开同源；`PlanCell` 改单行骨架 + 环心 `fmtPercent`
  （缺失显示 `—`）；右列 = 名称 +（嵌套 ? 图例 : 文字+4px 彩条）；删 StatusDot、删头部条。
- `island.css`：logo 15 / gap 10 / 高光 60%；容器 padding 16 + 渐变 `#2b2b31 28%` + 5 层阴影；
  伪元素挂不分状态的 `.isl-body`（修掉"展开态氛围丢失"）；新增 `.isl-ringbox/.isl-ring-pct/
  .isl-cell-side/.isl-wbar`；清死规则。
- `test-structure.mjs`：L9/L9b/L9c/L7f/D6c* 共 427 断言，先红后绿。

## 波折

- 第一个 implement 子代理被服务器重启打断（TSX 完成、CSS 半截）。**用红断言集合反推剩余范围**
  （5 红精确等于 CSS 未写部分），只派补做而非重跑，避免覆盖已完成部分。
- check 子代理自修 2 条"标签超覆盖"的空洞断言（D6c5→D6c7 渲染门、L7f 缺失门，变异验证能红）
  + 1 处过期 JSDoc。

## 验证

- `npm run typecheck` ✓；`npm test` 0 失败（structure 427）。
- 程序化实测：收起 logo15/gap10/vb36/高光 60%；展开单行 26/40/右列、环心 73%、无状态点、
  无头部条、pad16、渐变与 5 层阴影、grid 两列 189.5（与原型同值）；单窗家有彩条、多窗家图例、
  无数据显示 `—`。console 仅 favicon 404。
- 并排截图 7 张：`prototype/shots/fidelity2-{harness,proto}-*.png`。
- 实机 `--uitest` 未跑（无显示服务）。

## 沉淀

- `docs/knowledge/frontend/prototype-fidelity-diff.md` + 两级 index 已更新
  （含"参照物有开关状态先切同状态"的坑）。
- `.trellis/spec/frontend/quality-guidelines.md` 新增两条 Pattern（并排 computed style 对版、
  红断言集合 = 交接态）+「one home across states」几何常量纪律。
