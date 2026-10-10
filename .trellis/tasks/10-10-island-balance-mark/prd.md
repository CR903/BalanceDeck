# 灵动岛余额家logo对版

## Goal

余额家 logo 从「卡片 chip 形态」改成原型 `.picon` 形态（正圆黑盘 + 高光投影 + 呼吸/ping），
收起与展开同步，且不影响卡片视图的 chip。

## Confirmed Facts（harness vs 原型同浏览器 computed style 实测）

| 项 | 原型 `.picon`（demo.html:68,145-151） | 实现 `.isl-combo.bal .pmark` |
| --- | --- | --- |
| 尺寸 | 26×26，glyph 16 | 22×22，glyph 14（`IslandView.tsx:556`） |
| 形状 | `border-radius: 50%` 正圆 | `7px` 圆角方块（`skins.css:3736`） |
| 底色/边 | `#0b0b0d` 实黑、无边 | `rgba(255,255,255,.03)` + `1px` 描边 |
| 立体感 | `inset 0 1px 1px rgba(255,255,255,.4)` + `0 2px 8px rgba(0,0,0,.5)` | `shadow: none` |
| 动画 | `livePulse 2.2s` + `::after ringPing` | `animation: none`，无 `::after` |
| 展开态 | `picon` 26（demo.html:231） | `size={20}`（`IslandView.tsx:756`） |

已对齐、本轮不动：金额 `12px/700` + `gap 6`（`island.css:203-212`）；打码 `••••`（`IslandView.tsx:620`）；
用量家 logo 15px 圆盘 + `islBreathe`。

可直接复用的既有资产（**逐值等于原型，不新写 keyframes**）：
`islBreathe`（scale 1→1.1 / 2.2s = `livePulse`）、`islPing`（= `ringPing`）、`islShake`（= `dangerShake`），
现只挂在 `.isl-logo` 上（`island.css:139-186`）。

作用域事实：`.isl-combo .isl-logo` 是**绝对居中**的（`island.css:114-121`），塞不进余额家「logo + 金额」的行内流，
故走 `.pmark` 作用域覆盖；`island.css` 在 `main.tsx:5` 晚于 `skins.css:4` 加载，且已有覆盖先例
`.isl-combo .isl-logo .pmark`（`island.css:130`），特异性足够。

## Requirements

- R1 收起态 `.isl-combo.bal` 内 mark：26×26、glyph 16、`border-radius: 50%`、`background: #0b0b0d`、
  无 border、`box-shadow: inset 0 1px 1px rgba(255,255,255,.4), 0 2px 8px rgba(0,0,0,.5)`；
  `live/danger` 类按 `islandLevel` 挂，动画复用 `islBreathe`/`islPing`/`islShake`。
- R2 展开态 `BalanceCell` mark 20 → 26（glyph 12 → 16），同形态同动画。
- R3 作用域隔离：覆盖只在 `.isl-*` 上下文生效（`.isl-combo.bal .pmark` / `.isl-cell[data-kind='balance'] .pmark`），
  卡片视图（`CardView`/`DetailView`/picker 的 chip）保持 `skins.css` 原样，不新增全局 `.pmark` 规则。
- R4 `prefers-reduced-motion` 下余额家动画同组静止（并入既有 reduce 块）。
- R5 回归：`typecheck` + `npm test` 全绿；`test-structure` 新增断言（26/50%/#0b0b0d/无 border/双层阴影/动画名，
  先红后绿）；harness 与原型并排截图（收起含余额家、展开余额卡）。

## Acceptance Criteria

- [ ] AC1 收起余额家 computed style：26×26、radius 50%、bg `#0b0b0d`、border `0px`、双层阴影、
      `animationName` 为 `islBreathe`（danger 为 `islShake`），`::after` 有 `islPing`。
- [ ] AC2 展开 `BalanceCell` mark 26，形态同 AC1。
- [ ] AC3 卡片视图 `.pmark` 数值不变（仍 radius 7 / 描边 / 半透明底），断言为负向门。
- [ ] AC4 `npm run typecheck` 与 `npm test` 通过；并排截图落 `prototype/shots/`。

## Out of Scope

- 用量家 logo（已对版，15 vs 16 的 1px 差不动）；金额与打码文案；环几何；数据口径；
  卡片视图样式；实机 `--uitest`。

## Open Questions

- 无。
