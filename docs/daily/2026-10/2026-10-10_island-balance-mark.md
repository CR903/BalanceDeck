# 2026-10-10 灵动岛余额家logo对版（复检 pass，截图交付）

## 起因

用户拿真机截图与原型并排问「和高保真原型一样吗」。两张不同数据/不同打码开关（已向用户确认：
图1 真机、图2 原型；无环那家是**余额家且开了隐藏**），直接目测会误判，改用同浏览器
computed style 并排取值，量出真差异。

## 真因（harness vs 原型实测）

余额家 logo 吃的是卡片 chip 形态 `skins.css:3736 .pmark`：22×22 **圆角方块 7px** + 半透明底 +
`1px` 描边 + 无阴影 + 无动画；原型 `.picon`（demo.html:68）是 **26×26 正圆 `50%` + `#0b0b0d` 黑盘 +
inset 高光 + `0 2px 8px` 投影 + `livePulse` 呼吸 + `::after ringPing`**。六项全不中，
所以真机里那家看着像「贴了张卡片」。用量家 logo / 金额 `12px/700`+`gap 6` / 打码 `••••` 已对版。

## 改了什么（`10-10-island-balance-mark`）

- `island.css`：新增**作用域覆盖** `.isl-combo.bal .pmark`、`.isl-cell[data-kind='balance'] .pmark`
  （正圆黑盘/无边/双层阴影/`position:relative`）+ 动画三块（**复用** `islBreathe`/`islPing`/`islShake`，
  逐值等于原型 `livePulse/ringPing/dangerShake`，未新写 keyframes）+ reduce 块并入。
  reduce 块必须排在动画规则**之后**（同特异性 0,3,0，放前面会被盖回去）。
- `IslandView.tsx`：收起 `size 22/glyph 14` → `26/16`；展开 `BalanceCell` `20/12` → `26/16`；
  `live|danger` 类挂到 `.pmark` 自身（与用量家同一套 `islandLevel` 判定）。
- `test-structure.mjs`：D6d 段（先 17 条 → 复检自修后 20 条）。

## 波折（复检自修 2 处断言空洞）

1. reduce 块**只钉了选择器在、没钉值是 `animation: none`** —— 把值改回 `islBreathe` 仍 0 失败；
   补按规则取值的 `D6d10c-e` 后同变异 3 红。
2. `D6d10b` 位置门**跨字符串比下标**（剥 `@media` 的串 vs 原串），且 `indexOf` 会先命中 reduce 块里
   那行同名选择器；改成同串内规则头正则锚定，对抗变异仍红。
   （实现子代理先踩的「负向正则前缀陷阱」：`\.pmark\.live` 命中 `.pmark.live::after`，补 `(?:,|\s)` 边界。）

## 验证

- `npm run typecheck` ✓；`npm test` exit 0，structure **447** 通过 / 0 失败。
- 变异验红 9 处（glyph/ping 环/reduce 选择器/裸 `.pmark`/全局 radius 7→12 等），全部先红后
  `cmp` 确认逐字节还原。
- 同浏览器 computed style 实测：收起与展开 mark 均 26×26 / glyph16 / `50%` / `rgb(11,11,13)` /
  border `0px` / 双层阴影逐字同 / `animationName: islBreathe` / `::after: islPing`；
  岛外 chip 仍 `7px`+描边+半透明底（AC3 负向门 D6d13/D6d14）。
- reduce 媒体下余额家与用量家同组 `animationName: none`（行为级实测）。
- 截图 4 张：`prototype/shots/balance-mark-{harness,proto}-{collapsed,open}.png`。
- 实机 `--uitest` 未跑（Out of Scope）。截图尺寸须用 `offsetWidth` —— `getBoundingClientRect`
  在呼吸动画中读到的是 scale 后的 27.94，不是布局盒。

## 沉淀

- `.trellis/spec/frontend/quality-guidelines.md` 新增「`test-structure` 静态断言的三个新坑」
  （跨字符串比下标 / 存在性正则缺边界 / 钉值不钉名）。
- 无新通用解法需进 `docs/knowledge/`（上一轮的「并排 computed style 对版」已沉淀在
  `docs/knowledge/frontend/prototype-fidelity-diff.md`，本轮是其复用）。
