# 2026-10-06 球柱三修（读数可读 + 柱体全圆 + morph 带底盘）

## 起因

`ad28f1d` 实机验收报三处 bug（任务 `10-06-ball-column-fixes`，挂在父任务下）：

1. 球内读数在 minimal / candy 上深字压暗盘不可读；
2. 水柱疑似尖头、非上下全圆；
3. 球→柱 morph 时底盘本体无动画，只有环在飞。

## 改动

- **B1**：新增 `--ball-fg` 球专属令牌（暗盘三皮钉白、ink 纸盘深字、aero 亮深暗浅）；
  `.dot-value` / `.dot-winlabel` 改走它；暗盘三皮 `lvl-warn/danger/muted` 用 `:is()`
  单选择器让位（特异度 (0,5,0)>(0,4,0)，不用 `!important`）。页面级 `--fg` 零改动。
- **B2**：柱顶波 viewport 下移（竖柱 `top:6px+bottom:0`、横槽 `right:6px`），泡沫描线不再
  横穿弯月圆头；pill/fill 半径=短边一半 + 12px 整圆弯月（与原型同构）。空槽逻辑未动。
  未做像素定位（本机无 Xvfb，electron 不可跑）——几何实算 + 门 mutation 代替，
  实拍待实机确认。
- **B3**：底盘本体 + `::after` 玻璃罩进吸入/汇聚时间线；"定点退场"（翻转点钉 70%，与
  disc 拉丝同步），transform 零触碰（fallback 是 pill 定位祖先）；时序字面量与
  `shared/fluid.ts` 跨钉；reduced-motion / freeze / doc-hidden 三名单同步。

## check 发现的 Blocker（已修）

- aero 深色模式读数回归：文件尾部裸 `[data-skin='aero'] { --ball-fg: #1c1c1e }`
  同特异度恒覆盖 `@media dark` 那份（@media 不加特异度，后写赢）。
  修法：裸声明删除，浅色值挪进独立 `@media light` 规则；门禁 D3e 拆成
  aero-light / aero-dark 双份 + 新增 `aero-no-bare-override` 缺口门（变异验证有齿）。
- 修门时连带修：门自身的 `stripMedia` 被注释里的 `@media` 字样骗出假红（先去注释再剥块）；
  正则把顶层 `:root, [data-skin='aero']` 联合块误判（排除含 `:root` 的选择器头）；
  D3g 注释整段重复（删一段）。

## 门禁

- test:structure **342/0** · test:fluid 119/0 · test:dock-hide 155/0
- typecheck 双工程干净 · npm test 零失败 · build 通过

## 待实机确认（本机无显示环境，AC1–AC3 的像素验收签不了字）

- 5c 五帧：minimal / candy 读数可读，其余无退化（含 aero 深色模式）；
- 5n 柱：两端全圆、无尖头，低液位弯月 overhang 是否可接受；
- absorbing / revealing 序列：底盘与 disc 同步变形。
