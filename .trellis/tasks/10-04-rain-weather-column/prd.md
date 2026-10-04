# 雨滴天气原地水柱余额水：R4返工

## Goal

上一轮用户验收打回 6 点：雨滴式倒水（多处落下、溅水花、沿壁流下汇入底部）、
修波浪溢出球外、修白线与波浪脱节、皮肤天气大差异（暴雨/海啸等）、贴边原地变柱
（不再滑进屏幕）、余额供应商满水+水柱。本任务一次落地。

## Requirements

- R4-1 雨滴倒水：N 滴从不同 x 落下（固定伪随机位置，确定性可测），中间滴触水溅水花，
  近壁滴落下后沿内壁形成短 trickle 流下汇入底部；删除单条 pour-stream。
- R4-2 溢出：稳态 goo 输出裁进圆（clip-path），morph 态不裁（桥要出圆）；像素断言圆外≈0。
- R4-3 白线：泡沫带（foam ribbon，跟 A 同参数、3px 厚）盖住 B/C 冒头；白线画在带上。
- R4-4 天气：aero春雨 / dark海啸 / minimal平静 / candy暴雨 / ink雾雨。
  雨滴数·大小·水花·荡漾幅度·涌浪性格分档，换皮一眼可辨（用户已同意映射）。
- R4-5 原地变柱：贴边隐藏不再滑出屏幕；球拉丝吸向边侧→原地立起 12px 宽温度计水柱
  （屏边常驻可见），点击/悬停恢复；hiddenBounds/peekHitbox 口径随之改。
- R4-6 余额水：余额类（直充）满水（fluidLvl=1）+ 满柱，水色先按 accent 色出实例，
  用户看效果再定最终色。

## Acceptance Criteria

- [x] 雨滴：5l 取帧可见多滴+水花+壁 trickle；单滴位置确定性（单测 pin 伪随机表）
  → 5l-probe（7滴/5可见/splash5/trickle2）+ 像素雨区均色≈水绿；用例10 pin 表；K7/K9j 门
- [x] 圆外溢出像素≈0（5-ball 走查，goo 光晕纪律延续）
  → ::after inset:1px + 稳态 goo clip；5-ball-2/5l 圆外=8（AA）；K10a/K10b
- [x] 泡沫带存在且跟 A 同参数（K 门）；B/C 冒头被盖住（走查）
  → waveBand + .fluid-foam（drift-a/speed-a）；K9d扩展/K9g
- [x] 5 天气可辨：雨滴数/水花/荡漾幅度逐皮不同（shot+探针）
  → 天气变量×5皮（K9h）+ 雨滴数 3/4/5/6/7（K9j）+ slosh 幅度/时长变量（K9i）
- [ ] 贴边：窗口不滑出屏幕；终态为屏边 12px 水柱；e2e dockHide/dockEdges 按新口径绿
- [x] 余额：满水+满柱 accent 色实例可走查；相关 e2e/结构门同步更新
  → accent 锚点 + 满水满柱；e2e petNoRingOnBalance/petWaterColumn/dockFluidLevel 全绿
- [ ] `npm run test` + `npm run typecheck` 全绿（收尾时重验）

## Notes

- R4-5 动主进程几何（hiddenBounds/peekHitbox），单测 test-dock-hide.mjs + uitest bounds 断言同步改。
- R4-6 改"余额无水"纪律（uitest fail:fake-level 分支 + 结构门），改完先红后绿。
- 天气映射用户已确认；余额色用户要先看实例再定（默认 accent）。
