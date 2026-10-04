# 2026-10-04 倒水入场与荡漾平息（10-04-pour-in-slosh）

## 交付

`data-pour="in"` 三段串行：① 整水体从球顶灌入（600ms）② 整球冲顶 overshoot 1.07 + 高光闪峰（250ms）
③ slosh 包裹层衰减荡漾（1600ms），总 2450ms。mount + 每次切供应商/窗口重播（G1 结论：存在感优先）。
reduced-motion 下不挂属性，直接终态。

## 改动

- `src/shared/fluid.ts`：POUR_FILL/TOP/SLOSH/TOTAL（600/250/1600/2450），J2b 门同步扩到 `POUR_`
- `PetBall.tsx`：pour state + `[idx, winIdx]` effect（POUR_TOTAL_MS 后摘除）；`.slosh` 位移层；freeze 钩子认 `pour-mid/pour-top`
- `skins.css`：四段 keyframes + data-pour 挂载规则 + freeze 定帧（`pour-top` 需给 fallback 本体显式 `animation:none`）
- `shots.ts`：`5l-pour-mid` / `5m-pour-top` 取帧；结构门 K7a–K7g；单测用例 8

## 验证

- `test:fluid` 86/86，`test:structure` 155/155，`typecheck` 干净，`npm test` 全绿，`npm run build` 通过
- K7 六探针在旧版全红（`git show HEAD` 直验）；K 编号从 K7 起（K5 已被波浪暂停组占用，撞号已修）
- 实机：5l 绿质心上移 62px（≈ freeze -30px×2，精确）；5m 非透明 +948px、四角 0→4（1.07 溢出精确）
- caveat：5l/5m 间可能隔一次 6s 轮播 tick，对比只看位移/溢出量

## 坑位

1. animation 优先级高于 transform 声明：定帧必须先 `animation:none`（含 fallback 本体，暂停名单里原来没它）。
2. `.slosh` 必须 `position:absolute` 抽离 grid 流，否则挤进环心两行。
3. `pour-top` 关键帧必须带 `translate(-50%,-50%)`（fallback 靠 transform 居中）。
