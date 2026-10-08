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

- [x] AC1：5c 五帧实拍 + 人眼确认：minimal / candy 读数可读，其余三皮无退化。
  → 已验（2026-10-07）：dark / minimal / candy / aero / ink 五帧逐张看图，logo 每一款都读得清。
- [x] AC2：5n 柱取帧 + 原型柱并排对拍：两端全圆，无尖头；空槽仍空。
  → 已验：5n-column-70 与 `prototype/skin-applied.html` 的 .col/.cfill 并排，液面是连续胶囊、无铲形；
  空槽无假液头由 K8e / K8n3（`:not(:empty)`）/ K8m1b 门禁覆盖（无空槽实拍帧）。
- [x] AC3：absorbing / revealing 取帧序列：底盘与 disc 同步变形（不同步即红）；
  hidden 稳态仍只留水柱（旧"球柱并存"不回归）。
  → 已验：5i/5j/5k 三帧 + 探针，`disk: matrix(1.4,0,0,0.7,-5,0)` 与 disc 同步形变，
  5k stain 帧 disk 与 disc 同为 `scale(0)` 且 `anim:"none"`；hidden 稳态只留水柱。
- [x] AC4：test:structure / test:fluid / test:dock-hide / typecheck / npm test / build 全绿。
  → 已验：structure **388**/0、fluid 126/0、dock-hide 155/0、typecheck 0 error、npm test 126/0、build ✓。

---

## 第二轮（2026-10-06 22:10 实拍后追加）

首版（`4de3412`）只补了门禁，像素验收缺失。本机 Electron 可用，`npm run shots` 已产出全部
帧；对拍 `prototype/skin-applied.html` 与 `skin-refs.html` 后追加四项。
**以下根因均为像素/源码取证所得，不靠猜。**

### B4：球盘退场是"啪"地消失，不是被吸入

- 现象：贴边吸走时黑盘仍存在且突然消失。
- 根因：`skins.css:3287-3301` 的 `fallback-absorb` 在 **70% 处把 `background` 从
  `var(--ball-bg)` 离散切成 `transparent`**（gradient ↔ transparent 不可插值，只能离散跳），
  翻转点在 371ms；而 disc 是 530ms 平滑收缩到 `scale(0)`。两者不同步，观感是"球还在收缩，
  底盘先被抹掉"。
- 约束：**不许**给 `.petball-fallback` 加 `transform`（它是 `.fluid-pill` 的定位祖先，
  缩放会连累柱的吸入终态，历史已验过）；D6 无外阴影不变。

### B5：ink 皮肤按参考图改造为深底琥珀弧（环形态）

- 用户参考图：深底圆球 + 琥珀色进度弧 + **弧开口两端各一个白色端点圆点** + 中心读数。
- 决定（用户已拍板）：**把 ink 改成图里这样，废弃米色宣纸版**——这翻掉 P6 的"ink 保持纸色"。
  `skin-applied.html` 增补 ink 段作为真相源；`skin-refs.html` 同步。
- 语义纪律不破：弧色仍走等级的连续插值（`water` 内联，不在 CSS 写死 ok/warn/danger）；
  参考图里是琥珀色只是因为那一刻的等级落点，**不许**把 ink 锁死成琥珀。
- ink 由水体皮改环形态：`--water-display: none` / `--ring-display: block` / 环几何四令牌重写；
  米色宣纸的旧水效块（`fluid-disc` 棕色渐变、`wave-c` display:none、`ticks` opacity 0.4）随形态
  一并退役，不留下死代码。

### 首版三修的实测根因（补记，供实现时直接采信）

- **B1 球内 logo 黑**：`PetBall.tsx:987` `markColor(s.mark) || 'currentColor'` → 15 个 mark 里
  7 个品牌色为空，回落到 `--ball-fg`（首版已建）。首版门只验了 `--ball-fg` 存在，**没验回落链路**
  是否真走 `--ball-fg`。5c-ball-candy 实拍：暗紫方块压深绿盘，不可读 → 链路上仍有断点，须逐皮验。
- **B2 3D 把颜色压黑**：真因是**双层立体叠加**。demo 只有一层（`.ball::after` 玻璃罩，
  `skin-applied.html:47-52`）；App 叠了两层——`.petball-fallback` 的 inset box-shadow（`:2127+`）
  **加上** `.fluid-disc` 自己的径向渐变（`:2373-2384` 的 `--dot-top`/`--dot-bottom`，candy 还有
  第三层 `rgba(120,90,200,0.28)`）。第二层是 demo 没有的额外压暗，"绿底发黑"的真凶。
  **是结构问题，不是数值调参**。
- **B3 柱体弯月形**：真因是 `.fluid-column-fill { border-radius: 6px }`（`:2575-2578`）——
  fill 自身已是胶囊，顶上再叠 `::before` 12px 整圆弯月，**两处圆角叠加**成"圆头+圆帽"的
  铲形/弯月形。demo 的 `.cfill` **无 border-radius**（纯矩形），圆角只来自容器
  `overflow:hidden` + `border-radius:12px` 裁切。此前 `:2571-2574` 的注释推理方向错了：
  圆点宽 = 100% = 柱宽，两者本就齐边，不存在"掐出尖"。

## 需求（第二轮）

- B4：吸走/回弹全程**不出现"底盘先被抹掉、球还在动"**的错位；球盘随变形同步收没，
  时序仍归 `shared/fluid.ts`。
- B5：ink 呈深底 + 等级色进度弧 + **弧两端白色端点圆点**，中心读数可读；与 demo 新增 ink 段
  同观感；旧宣纸水效不残留。

## 验收标准（第二轮）

- [x] AC5：5c-ball-ink 实拍 + demo ink 段并排：深底、等级色弧、双端点圆点、读数可读。
  → 已验（2026-10-07，含一次返修）：demo 四态截图确认弧线是**等级插值**（41% 绿 / 78% 橙 / 92% 红 /
  余额琥珀），不是锁死琥珀；`5c-form: ink` 探针 `capsDisplay:"block"`、`capStartCx:"50px"`
  （= 28px 圆心 + 22px 弧半径，3 点位）、`capEndTransform: matrix(0.5878,0.8090,-0.8090,0.5878,0,0)`
  （= rotate 54° = pct40 × 3.6°）；实拍两端白点分别在 12 点与弧末端。
  返修：首版端点圆点 `cx` 写成圆心 28px、`transform-origin` 也是圆心 → 绕圆心旋转不位移，
  两点叠在球心被读数盖住，探针只读 transform 抓不到。改为 `cx: calc(28px + var(--ring-r))`，
  补 K11q3 三条门 + 探针补读 cx/cy。
- [x] AC6：5c 五帧重拍：logo 在**每一款**皮肤球内均可读（含 7 个空品牌色的 mark），
  其余四皮 3D 不再压黑（对 demo 同格球面色偏差可肉眼比对）。
  → 已验：五帧逐张看图，mark 在 dark / minimal / candy / aero / ink 上都读得清（B1 门 D3f 覆盖机制）；
  「不再压黑」机制侧由 D3h 覆盖（环球四皮 `.fluid-disc` 的 `background:none` + 无残留渐变规则），
  色差是肉眼比对，未做量化采样。
- [x] AC7：5n 柱取帧 + demo 柱并排：液面是"平液面 + 半圆弯月"的连续胶囊，无铲形/双圆角；
  低液位仍是圆珠而非尖头；空槽仍空。
  → 已验：5n-column-70 与 demo `.col`/`.cfill` 并排，连续胶囊、无铲形（B3 门 K4e 反转为"fill 无 radius"）；
  低液位/空槽由 K8e / K8n3（`:not(:empty)`）/ K8m1b 门禁覆盖，无对应实拍帧。
- [x] AC8：morph 吸走/回弹帧序列：全程无"底盘已没、球还在收缩"的错位；
  hidden 稳态只留水柱（不回归"球柱并存"）。
  → 已验：5i/5j/5k 三帧 + 探针，5i `disk: matrix(1.4,0,0,0.7,-5,0)` 与 disc 同矩阵同形变，
  5k stain 帧 disk `scale(0)` + `anim:"none"` 与 disc 同时收尽；hidden 稳态只留水柱（球柱并存不回归）。
- [x] AC9：全链门禁绿 + 每条新门禁**验齿**（加回 bug 应红、还原应绿）。
  → 已验：structure 388/0、fluid 126/0、dock-hide 155/0、typecheck 0 error、npm test 126/0、build ✓。
  验齿：B3→K4e（fill 加 `border-radius:6px` 红）、B4→D1/D6/K10c/K10d1-4、B5→K11q3
  （cx 改回 28px 红 2 条）、D3h（四皮逐一删 `background:none` 红）。

## 第三轮（2026-10-07 用户实拍报障追加）

### C1：minimal 分段环与进度弧错开 90°，「进度条和百分比对不上」
原型 V5 的分段圆自带 `transform="rotate(-90 56 56)"`（skin-applied.html:163），App 只给
`.ring-arc` 加了 `rotate(-90 28 28)`、`.ring-seg` 漏了 —— 分段从 3 点起画、弧从 12 点起画，
弧从分段中间穿过。两段 r / stroke-width 都是 `--ring-r` / `--ring-sw`（完全同几何），所以对不齐
是纯粹的起点错开，不是线宽或半径的锅。

### C2：minimal 余额弧完全隐形，「直充的余额没有显示进度」
余额弧走 `waterAnchors.accent`（PetBall.tsx:532 isPlan 分支），minimal 未声明 `--ball-accent`
→ 回落页面级 `--accent: #111114`（近黑），压在 `#0b0f07` 暗盘上对比度只有 **1.03**（实算）——
完全看不见。取柠檬 `#beff3c`（本皮环的身份色，与 ink 用身份琥珀作 ball-accent 同口径），
对暗盘 **16.2:1**。dark / candy 未声明但回落值本来可读（5.1 / 4.0），不动 —— 加了就是无必要的
跨皮视觉漂移。

### C3：切供应商的倒水冲顶把球撑出窗口，「四边被遮挡」
`pour-top` 关键帧 `scale(1.07)`。球 = 窗口 = 56×56（D6 禁 outer shadow 的同一条约束），
1.07×56 ≈ 60px，每边外扩 ≈2px，圆盘越过窗口边界被 `overflow:hidden` 裁成四条平直弦。
56×56 的球没有向外呼吸的空间 —— 删掉整球外扩，冲顶观感由 `pour-flash` 泡沫闪峰承载。

### C4：ink 深墨盘的 warn/danger/muted 读数不是白字，「圆球内字体看不清」
B5 把 ink 由米色宣纸盘翻成深墨盘后，漏加进 D3g 那条「暗盘四皮等级色读数让位白字」的循环
（当时只列 dark/minimal/candy）。warn 档走页面级 `--warn: #b07d20`、danger 档 `--danger:
#a63b2f`，压在 `#080c17` 上分别是 5.4:1 / **3.1:1** —— danger 档低于 4.5，不可读。

## 需求（第三轮）
- C1：minimal 的分段与进度弧同起点（12 点），读得出「弧覆盖到第几段」。
- C2：minimal 的余额弧在暗盘上看得见，且与「套餐的等级色弧」读感区分得开。
- C3：切供应商的倒水入场全程不超出 56×56 窗口，球体四边永远是圆的。
- C4：ink 球内读数在任何等级下都是白字。

## 验收标准（第三轮）
- [x] AC10：5c-ball-minimal 实拍 + 探针：分段与弧同起点 12 点。
  → 已验：`5c-form: minimal` 探针 `segTransform: "matrix(0, -1, 1, 0, 0, 56)"`（正是
  rotate(-90 28 28)：a=cos=0 / b=sin=-1 / c=-sin=1 / d=cos=0，e/f 由绕 (28,28) 旋转移算）；
  实拍弧从 12 点顺时针画到 40%，分段也 12 点起，第 1 段被弧完全覆盖、第 2 段被覆盖前半。
- [x] AC11：minimal 余额弧在暗盘上可见（探针读 arcStroke 必须是柠檬，不是近黑）。
  → 已验：`5c-bal: minimal` 探针 `dataRing:"balance"`、`arcStroke:"rgb(190, 255, 60)"`
  （= #beff3c）、`arcDash:"100.00 100"`（余额满圈）；实拍是满圈亮柠檬环 + 白字 ¥1.3k。
  对照 `5c-bal: ink` 仍是 `rgb(255, 184, 77)`（身份琥珀，未被牵连）。
- [x] AC12：倒水入场全程不超窗。
  → 已验：`@keyframes pour-top` 与 `animation: pour-top` 全删（K7c / K7d 负向断言），
  freeze 定帧位移改成不带 scale（K7f）；5m-pour-top 实拍球体回到 56×56 满窗，四边是圆的、
  无平直弦。
- [x] AC13：ink 球内读数在 warn / danger / muted 档都是白字。
  → 已验：`5c-warn: ink` 探针 `lvlClass:"lvl-warn"`（70% 夹具强制 warn 档 —— 40% 帧是 lvl-ok，
  验不到这条覆写）、`valueColor:"rgb(255, 255, 255)"`（修前是页面级 `--warn #b07d20` =
  rgb(176,125,32)）。对照 `5c-warn: minimal` 同样白字。
- [x] AC14：structure 393/0（+5 项判定）、fluid 126/0、dock-hide 155/0、typecheck 0 error、
  npm test 21 子脚本 0 失败、build ✓；新门验齿。
  → 已验：D3g 扩到四皮（+1）、D3i2（+2）、K7c/K7d/K7f 反转（+1）、K11f4（+2）；
  structure 388 → 393。验齿 D3i2（注释掉 minimal 的 --ball-accent 红）+ K11f4（摘掉 seg 的
  rotate 红），还原即绿 393/0。

