# 球柱三修：读数可读 + 柱体全圆 + morph 带底盘

## 背景

`ad28f1d`（球盘底色还原 + 去雨效）实机验收，用户报三处 bug，均为该轮引入或暴露：

1. **球内字变黑看不清** —— minimal / candy 的球盘已改为暗色，但读数仍走 `var(--fg)`
  （页面前景色：minimal `#111114` 近黑、candy `#2b1b46` 深紫），深字压暗盘不可读。
   原型里三款环球的读数钉死白色（`prototype/skin-applied.html:32,34,36`）。
2. **水柱非上下全圆、呈尖头** —— 原型柱 `.col` 上下全圆（24px 宽 / radius 12px +
   顶部弯月整圆，`skin-applied.html:54-57`）；App 现状疑似弯月/顶角/柱顶波三层
   叠出尖头，或 goo 滤镜捏尖，需截图定位后修。
3. **球→柱 morph 底盘无动画** —— 吸入 530ms 关键帧只演四层
  （disc / bridge / ring / pill，`skins.css:3126-3152`），球本体底盘
   （`--ball-bg` 暗色整圆）不在任何 morph 名单，仅 hidden 态 180ms 淡出
  （`:3238-3242`），观感是"环飞走、黑盘原地淡掉"。原型是整球一起被吸入。

## 需求（只说什么算对，不写怎么做）

- B1：五款皮肤球内读数（数值 + 短标签）在各自球盘上**人眼可读**；语义仍由环色/水色承载，
  不因改字色丢失等级信息；aero 亮暗跟随与 ink 纸盘不受影响。
- B2：竖柱/横槽两向的水柱稳态均为**上下（前后）全圆胶囊**，与原型柱同观感；
  液位 0 仍是空槽（不造假水位纪律不变）。
- B3：球→柱（absorbing→hidden）与柱→球（revealing）时，**球盘底盘参与变形时间线**，
  不再出现"整圆黑盘原地静止淡出"；时序仍归 `shared/fluid.ts` 唯一口径，不另起常量。
- 约束：D6（无外阴影）、令牌驱动（页面级 `--bg/--surface/--fg` 一律不动，只动球相关令牌）、
  reduced-motion / freeze / doc-hidden 名单同步；每条修完有门禁守（先红后绿）。

## 验收标准

- [ ] AC1：5c 五帧实拍 + 人眼确认：minimal / candy 读数可读，其余三皮无退化。
- [ ] AC2：5n 柱取帧 + 原型柱并排对拍：两端全圆，无尖头；空槽仍空。
- [ ] AC3：absorbing / revealing 取帧序列：底盘与 disc 同步变形（不同步即红）；
  hidden 稳态仍只留水柱（旧"球柱并存"不回归）。
- [ ] AC4：test:structure / test:fluid / test:dock-hide / typecheck / npm test / build 全绿。
