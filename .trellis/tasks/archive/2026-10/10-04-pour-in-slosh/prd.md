# 倒水入场与荡漾平息

## Goal

窗口出现（mount）时：水从球顶之上倒进来、液面冲高到"差点冲出瓶口"、再晃两下慢慢平息。
切供应商/窗口时重播完整倒水（G1 评审结论：存在感优先于克制）。

## Requirements

- 入场（`data-pour="in"`，mount 时挂）：① 灌入 `.fluid-waves translateY(-60px→0)` 600ms ease-in；
  ② 冲顶 overshoot：整球 `scale 1→1.07→1` 250ms + 高光线 opacity 闪峰；
  ③ 荡漾平息：`.slosh` 包裹层 `translateX ±8px→0` 衰减包络 1.8s。播完 JS 摘属性，不留尾巴。
- 轻晃（`data-pour="tick"`，切供应商/窗口时挂）：±3px、400ms，只播③的小版本。
- 评审结论（G1，2026-10-04）：用户要求**每次切换供应商/窗口都播完整倒水**（存在感优先于克制）。
  落点：`data-pour="in"` 的挂载点从 mount 扩大到"mount + 每次 idx/winIdx 切换"；
  `data-pour="tick"` 档位删除，不留第二套包络（同一件事两种播法是漂移源）。
  若走查嫌烦，回退点 R2 仍有效（摘挂载即无入场），届时另起评审再定。
- 全部走 CSS 合成器动画，不触发逐帧 React 重渲染（液面 `d` 只算一次终态）。
- reduced-motion：不挂 `data-pour`，直接终态（计时器不启动）。
- `--uitest`/`--shots` 可冻结取帧：`pour-mid`（灌入中）、`pour-top`（冲顶）。

## Acceptance Criteria

- [x] 启动录屏：看得出"倒进来 → 冲高 → 晃两下 → 平息"三段，2.5s 内结束，不拖沓
  → 时序单测用例 8（600+250+1600=2450ms）；实机取帧 5l-pour-mid（绿质心上移 62px ≈ freeze -30px×2，灌入位移精确）
  与 5m-pour-top（非透明 +948px、四角填充 0→4，overshoot scale 精确）；视频录制 harness 不支持，以两端定帧 + 时序单测为据
- [x] 切供应商/窗口时重播完整倒水（G1 评审结论），不只小幅一晃
  → effect 依赖 [idx, winIdx]，`data-pour` 每次重挂 + POUR_TOTAL_MS 后摘除（K7a/K7b）
- [x] reduced-motion 下直接终态，无动画残留属性
  → JS 门控（K7g），CSS 无需兜底；OS 级验证需切系统设置，留用户侧
- [x] 5 皮肤走查无方框、无糊字（动效只动 goo 内形状）
  → 本轮 shots 全帧正常产出（含 5c 五皮肤）；pour-top 整球 scale 250ms 为设计内观感
- [x] `npm run test` + `npm run typecheck` 全绿
  → 全套件零失败（基线 6 项环境红除外，已对照）；typecheck 双工程干净；`npm run build` 通过

## Notes

- 技术细节见父任务 `design.md` D2。顺序在水色任务之后（冲顶闪的高光与水色同源）。
- 时序常量入 `shared/fluid.ts`（POUR_*），J2b 门同步扩到 `POUR_`；结构门从 K7a 起编号（K5 已有波浪暂停组占用）。
- freeze `pour-mid/pour-top` 不依赖 data-pour 存活（自带终态位移）；fallback 本体需显式 `animation:none`，
  否则 running 的 pour-top 会盖掉定帧 transform。
- 取帧 caveat：5l/5m 间可能隔一次 6s 轮播 tick（不同供应商），对比只看位移/溢出量，不看水色/水量。
