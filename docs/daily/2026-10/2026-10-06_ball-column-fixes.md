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

---

## 第二轮：像素级四修（B1–B4，2026-10-06 深夜）

### 起因

首轮 B1–B3 落地后，对照 `prototype/skin-applied.html` 逐像素比对发现四处偏差，
根因均已在 PRD 里钉死，本轮只做落地：

### B1 · dot-provider 空标读空色

- **问题**：15 个 provider mark 中 10 个无品牌色，空标 fallback 走页面级 `--fg`。
  candy 皮 `--fg=#2b1b46`（暗紫）打在暗紫底盘上几乎不可见。
- **修法**：`.dot-provider` 颜色改走 `--ball-fg`（球专属令牌，首轮已加）；
  暗盘四皮（dark/minimal/candy/aero-dark）对品牌色 mark 加
  `filter: brightness(1.4)` 提亮——deepseek/zhipu/volc 等深蓝/紫牌在暗盘上
  不满足 WCAG 2.2（对比度 <3:1），提亮后达标。
- **不改**：ink 皮不动（独立下一轮处理）。

### B2 · fluid-disc 暗盘去多余压暗层

- **问题**：dark/candy 皮的 `.fluid-disc` 比 demo 多一层底部压暗，
  导致球盘中心偏暗、与底盘色不一致。
- **修法**：删掉 dark 的 accent glow ring（`box-shadow` 里的外侧光晕）；
  删掉 candy 的底部紫阴影。minimal 只有顶光一层，保持不动。
- **对齐**：所有皮的 `.fluid-disc` 只剩顶光高光（与 demo `.ball::after` 同构）。

### B3 · fluid-column-fill 去 border-radius

- **问题**：fill 带 `border-radius: 6px` 与容器 `.fluid-pill` 的
  `overflow:hidden + border-radius: 6px` 叠加，形成「双重圆角」——
  柱端本应只有一个圆角（来自容器裁切），fill 自带圆角反而把柱端
  顶部「掐」出小尖耳。
- **修法**：删掉 `.fluid-column-fill` 的 `border-radius`。fill 现在是
  纯矩形，圆角效果完全由容器 overflow:hidden 裁切产生。
- **门改**：K4e/K8n2 从「fill === pill 同半径」反转为「fill 无 radius +
  pill 有 6px」——任何给 fill 加 radius 的回归立刻红。

### B4 · 底盘视觉挪到 ::before

- **问题**：`.petball-fallback` 是 `.fluid-pill` 的定位祖先
  （`position:absolute; left:50%; top:50%`）。morph 期间如果给 fallback
  本体加 `transform: scale(...)`，会连累 fluid-pill 的柱端终态——
  pill 被缩放后柱端高度/宽度与 pill 尺寸不再匹配，出现跳动。
- **修法**：底盘视觉（`background: var(--ball-bg)` + 4 层 inset box-shadow）
  从 `.petball-fallback` 本体挪到新建的 `.petball-fallback::before`。
  fallback 本体保持空壳（无 background 无 box-shadow），只留 press feedback
  的 `:has(:active)` 和 pour-top 动画（都不涉及 morph）。
  `::after`（玻璃罩）不动。
- **动画**：morph 时 `::before` 走 `disk-absorb-h/v`（横向/纵向）和
  `disk-reveal`，沿 `--dx/--dy` 走与 disc 同轴的曲线。translate 不带 `-50%`
  项（因为 `::before` 用 `inset:0` 铺满，中心天然对齐 disc 的
  `translate(-50%,-50%)` 后中心）。
- **三名单同步**：doc-hidden / data-freeze / reduced-motion 的停表名单
  都加了 `::before`；freeze 定帧 transform 加了 stretch/bridge/stain 三态
  的 `::before` 等效位移（与 disc 同形但去掉 `-50%`）。
- **hidden 稳态**：`::before` opacity 0（180ms transition，与 `::after` 同门），
  旧的 fallback 本体 `background: transparent; box-shadow: none` 规则删除。

### 门禁更新

- D1/D2/D6 判据从 `fallbackBody` 换到 `fbBefore`（`::before` 伪元素块）；
- K10c 从「fallback background:transparent」换到「`::before opacity:0`」；
- K4e/K8n2 从「fill === pill 同半径」反转为「fill 无 radius」；
- K10d1–d4 从 `fallback-absorb/reveal` 换到 `disk-absorb-h/v` + `disk-reveal`；
- K10d5/K10d6 的 selfRules 正则加入 `::before`（`(\[[^\]]*\]|::before|::after)*`）。

### 门禁数（第二轮后）

- test:structure **343/0**（+1：新增 K10d3 disk-absorb-v 独立时长检查）
- test:fluid 119/0 · test:dock-hide 155/0
- typecheck 双工程干净 · npm test 零失败 · build 通过

> 第三轮重做 CSS 后又加 16 条门，终值 **360/0**（见下节「门禁新增」）。
> 本节 343 是子代理那轮的数字——那轮的 CSS 写进了未被 import 的
> `skills.css`，绿灯是假的，详见「事故」一节。

### bug-back 验证（每个新门先弄红再修复回绿）

| 门 | 破坏 | 结果 | 恢复 |
|---|---|---|---|
| K4e/K8n2 | fill 加 `border-radius: 6px` | ✗ 两条红 | ✓ |
| D1 | `::before` bg 改 transparent | ✗ D1 红 | ✓ |
| D6 | 删 `::before` box-shadow | ✗ D6 红 | ✓ |
| K10c | hidden `::before` opacity 改 1 | ✗ K10c 红 | ✓ |
| K10d1 | 重命名 `disk-absorb-h/v` | ✗ K10d1+K10d3 红 | ✓ |
| K10d4 | `disk-absorb-h` 100% 改 scale(1,1) | ✗ K10d4 红 | ✓ |

---

## 第三轮：CSS 重做 + 实拍取证（10-06 晚）

### 事故：子代理把 CSS 写进了新文件

上一轮派出去的 implement 子代理把全部 CSS 改动写成了
`src/renderer/src/skills.css`（**新文件，app 从未 import**），
真正的 `skins.css` 一行未动；同时把 `scripts/test-structure.mjs`
第 91 行的读取路径从 `skins.css` 改成 `skills.css`。

后果：结构门禁读的是 app 不加载的幻影文件，**343/0 的绿灯是假绿灯**。
`npm run shots` 拍出的图仍是改动前状态——所以本轮 4 项 bug 的
像素证据此前完全不存在。

恢复时踩了第二个坑：`mv skills.css skins.css` 把改动搬回来后，
随手跟了一句 `git checkout -- src/renderer/src/skins.css`
把它还原了；`skills.css` 是 untracked 文件，无备份，**编辑全丢**。
教训：untracked 文件上的 `git checkout --` 是真删除，不是回退。

### CSS 重做（逐项对应第二节的四根因）

- **B1** `.dot-provider` 的 `color: var(--fg)` → `var(--ball-fg)`。
  首版门只验了 `--ball-fg` 令牌存在，没验回落链路——JSX 是
  `markColor(s.mark) || 'currentColor'`，7 个空品牌色 mark 走
  `currentColor`，所以 `.dot-provider` 的 color 才是它们真正的落点。
- **B2** 真因是**三层**立体叠加，不是数值偏：demo 的环球球只有
  「`--ball-bg` 渐变 + 一层 `::after` 玻璃罩」（`skin-applied.html:47-52`）；
  App 的 fallback 4 层 inset + `::after` 玻璃已与 `.ball` / `.ball::after`
  同口径，但**又**叠了 `.fluid-disc` 自己的 `--dot-top`/`--dot-bottom`
  径向渐变（candy 还多一层 accent 光晕 + 底部压暗）。删掉这层即对齐。
  三条按皮的 disc 渐变规则（dark/candy/minimal）被 `background:none`
  覆盖成死代码，一并删净不留陷阱。
- **B3** `.fluid-column-fill` 的 `border-radius: 6px` 让 fill 自身成了胶囊，
  顶上再叠 `::before` 12px 弯月圆 = 两处圆角叠加成铲形。
  demo 的 `.cfill` **没有** border-radius，圆角只来自容器
  `overflow:hidden` + `.col` 的 12px 裁切。此前 2571 行注释的推理方向
  是反的：圆点宽 = 100% = 柱宽，本就齐边，不存在"掐出尖"。
- **B4** 见上一节。`fallback-absorb` 在 70% 处把 background 从
  `var(--ball-bg)` **离散切**到 `transparent`（gradient↔transparent 不可插值，
  transition 翻转点钉 50% 不可控），翻转点与 disc 的 530ms 平滑收缩错位，
  观感是"球还在收缩、底盘先被抹掉"。搬到 `::before` 后随 transform
  一起 scale 到 0，没有翻转点，天然同步。

### 门禁新增（343 → 360，只增不减）

- **D3f 扩项**（+2）：`.dot-provider` 的 color 必须走 `--ball-fg`，
  且生效声明不得引用页面级 `--fg`。首版 D3f 只钉了 `.dot-value` 和
  `.dot-winlabel`，漏了 mark——正是漏这一条让 5c 五帧拍出来才发现。
- **D3h**（+4）：`dark`/`candy`/`minimal` 的 `.fluid-disc` 末条必须是
  `background:none`，且这三皮不得再有残留的 disc 渐变规则。
  判据用配平花括号取**整块**并扫**全部命中**——非贪婪正则会截在第一个 `}`，
  只扫首个命中则新加的渐变规则写在哪条都逃不掉。
- **K10d7**（+9）：`::before` 搬家的三名单 + 三冻结帧 + 旧关键帧删除 +
  fallback 本体必须是空壳。reduced-motion 那块用配平花括号取
  「含 `petball-fallback` 的那一个」media 块——文件里有 4 个
  `prefers-reduced-motion`，先取第一个会取到别的小块（实测只捞到 39 字符）。
- **5i/5k 探针**：shots.ts 加 `::before` 的 transform/opacity/animationName
  到日志，冻结帧是否真生效看 matrix，不靠像素猜。

### 实拍取证（本机 Electron 可用，`npm run shots`）

首轮四修此前**完全没有**像素证据，本轮补齐：

- **5c 五帧**：logo 在每一款皮肤球内均可读——dark/minimal/candy/aero
  白字（`--ball-fg` 浅），ink 深字压纸色盘（浅色盘）。B1 成立。
- **5c-ball-candy / dark / minimal**：环球三皮去掉 disc 第二层压暗后
  不再发泥，对 demo 同格球面色可肉眼比对。B2 成立。
- **5n-column-70**：柱体是"平液面 + 半圆弯月"的连续胶囊，
  无铲形/双圆角。对拍 demo `.col`/`.cfill` 同构。B3 成立。
- **5i/5k 探针**（B4 的直接证据）：
  - `5i`：`disk: matrix(1.4, 0, 0, 0.7, -5, 0)` —— 底盘随 disc
    横向拉伸 1.4×、纵向压 0.7×，向贴边偏移 5px，不再是完整圆。
  - `5k`：`disk: matrix(0, 0, 0, 0, 0, 0)` + `anim: "none"` ——
    冻结帧底盘真到 scale(0)，`disc` 同帧也是 `scale(0)`。
    `anim:none` 证明 data-freeze 的停表名单盖住了运行中的 animation。

### 残留观察（非本轮范围，未改）

1. **5k 冻结帧仍见"幽灵球"**：`::after` 玻璃罩和 `.fluid-waves` 等水层
   不在 freeze 定帧名单里，animation 被停后回到 base 状态。
   改动前也存在（当时是 fallback 的 ball-bg 做幽灵），**不是回归**。
   真实吸收入动画里 `glass-absorb` 会把玻璃罩 opacity 淡到 0，无此问题；
   这是 QA 定帧的假象，不是用户可见缺陷。
2. **环线宽是 demo 的 2 倍**：demo `stroke-width 8` @112px = App 4px @56px，
   App 实测 8px。真实差异但不在本轮范围，已单独问用户，未擅改。

---

## 第四轮：B5 ink 皮肤改造（10-07 凌晨）

用户拍板把 ink 从"米色宣纸水体球"改成参考图的"深墨盘 + 等级色弧 + 弧两端白色端点圆点"，
废弃 P6 拍板的"ink 保持纸色"。顺序按用户要求：**先 demo 后皮肤**。

### demo（prototype/skin-applied.html 加 v7）

- `SKINS` 加 v7：`accent:#ffb84d`，title「墨底琥珀弧（候选 ink，替代米色宣纸）」
- CSS 加 `.v7`（深墨底径向渐变 + 白字读数），复用全皮肤通用的 `.ball::after` 玻璃罩，
  不再叠第二层压暗（B2 刚修掉的那个坑，v7 不重复犯）
- `ball()` 加 v7 分支：满圈轨道 + 等级色进度弧（round linecap）+ 两个白色端点圆点
  （起点固定 12 点，终点 `rotate(pct*3.6deg)` 跟弧末端走）
- `COLTRACK`/`COLTICK`/`ACOL` 补 v7，标题「四款皮肤」改「五款」

**四态截图验证**（`.trellis/tmp/v7-demo-4states.png`）：41% 绿 / 78% 橙 / 92% 红 / 余额琥珀。
弧线颜色确实是**等级插值**（三档明显不同），不是锁死琥珀——用户明确反对过锁死。

### 皮肤（src/renderer/src/skins.css）

页面级 `--bg #f4f1ea` / `--fg #2a2620` **一律未动**——ink 的卡片和设置页仍是纸色，
只动球相关令牌。`[data-skin='ink']` 块改动：

- `--ball-bg` → 深墨径向渐变（`#18243f → #080c17`）
- `--ball-fg` → `#ffffff`，`--ball-rim` → 浅色描边
- `--water-display: none` / `--ring-display: block`，环几何四令牌重写（r 22 / sw 3 / round）
- 新增四个**球级颜色锚点** `--ball-ok/warn/danger/accent`

**为什么需要球级锚点**：弧线颜色 = `waterColor(pct, anchors)` 读 `.app` 上的
`--ok/--warn/--danger`。ink 的页面级锚点是纸色调（`#4f7a3a` 等），压深墨盘会发泥
（实拍 rgb(144,124,41) 就是证据）。而 `--ok/--warn/--danger` 不许动——柱内液
`background: var(--ok)` 靠它在纸色页面上可读，改成亮色柱就看不清了。

解法是加球级锚点带回落（`src/shared/water-color.ts`）：

```
function prefer(get, ballName, pageName) {
  const ball = (get(ballName) ?? '').trim()
  return ball ? ball : get(pageName)
}
```

ink 声明四个 `--ball-*`；其余四皮未声明 → 回落页面级同名令牌，**逐值相同，零回归**。
`--ball-accent` 是 PRD 之外多加的第四个：ink 的页面级 `--accent #8a6d3b` 是深金棕，
压深盘上余额弧发暗（余额球用 accent 实色、不插值），所以单独加 `#ffb84d`。

### 与 PRD 的两处刻意偏离（都有实测依据）

1. **保留 `--wave-*` / `--slosh-*`**（PRD 说删）。实测这两个令牌仍有活跃消费者，
   且消费者不在球内：`--wave-speed-a` 被 `.fluid-column-wave` 的 `column-drift` 用
   （`skins.css:2687`，**所有皮肤**都跑），`--slosh-dur` 被 `.fluid-shimmer` 的
   `column-shimmer` 用（`:2717`）。删了 ink 的柱体/柱顶浪性格就掉回 :root，
   K9a / K9h 会因值塌缩而红。只删了球内水体专用的三条：`.fluid-disc` 的宣纸压暗
   径向渐变、`.fluid-wave-c { display:none }`、`.fluid-ticks { opacity:0.4 }`，
   并把 ink 加进 `.fluid-disc { background:none }` 列表。
2. 见上「--ball-accent」。

### 端点圆点钉在球心的坑（子代理没抓到，主会话实拍抓到）

子代理交付的端点圆点 CSS 是：

```css
.ring-cap-start, .ring-cap-end {
  cx: 28px; cy: 28px;               /* ← 圆心 */
  transform-box: view-box;
  transform-origin: 28px 28px;      /* ← 也是圆心 */
}
.ring-cap-start { transform: rotate(-90deg); }
.ring-cap-end   { transform: rotate(calc(var(--arc-pct,0) * 3.6deg - 90deg)); }
```

**绕圆心旋转不会移动圆心上的点**——两个端点圆点叠在球心、被白色读数盖住，
视觉上等于没有端点。而 K11q2 的三条断言（TS 内联 --arc-pct / CSS 换算 3.6deg /
TS 无几何数字）**全绿**，shots 探针也只读 `transform`/`r`/`fill` 读不到径向定位
（纯旋转变换矩阵的 e/f 恒为 0，看不出圆点在不在圆心）。**探针漏检 + 门漏检双重失守。**

修法（一行）：圆点先落在 3 点位，再由 `rotate(-90deg)` 转到 12 点：

```css
cx: calc(28px + var(--ring-r, 22px));   /* 圆心 + 弧半径 */
```

几何核对：3 点位 (28+r, 28) 绕 (28,28) 转 -90° → (28, 28-r) = 12 点 ✓；
转 54°（pct 40）→ (28 + r·cos54°, 28 + r·sin54°) = 弧末端 ✓。

补 **K11q3** 三条门（只增不减）：cx 必须是 `28px + var(--ring-r)`、
不得是裸 `28px`、transform-origin 必须是球心。
**验齿**：把 cx 改回 `28px` → 2 条红；还原 → 绿。
shots 探针补 `capStartCx/Cy` / `capEndCx/Cy`，让径向定位进日志、不能再无声失守。

修法后 5c-form 探针（原文）：
```
5c-form: ink {... "capsDisplay":"block","capStartCx":"50px","capStartCy":"28px",
  "capStartR":"2px","capStartFill":"rgb(255, 255, 255)","arcPct":"40",
  "capEndTransform":"matrix(0.587785, 0.809017, -0.809017, 0.587785, 0, 0)",
  "capEndCx":"50px","capEndCy":"28px","capEndR":"2px"}
```
`capStartCx 50px` = 28 圆心 + 22 弧半径（3 点位），`rotate(-90deg)` 后落到 12 点；
`capEndTransform` = rotate 54° = pct40 × 3.6°，落到弧末端。
dark 皮 `capsDisplay:"none"` —— 其余四款零端点、零回归。
实拍 `5c-ball-ink` 两端白点分别在 12 点与弧末端（右下），demo 四态（绿/橙/红/琥珀）并排确认
弧线是等级插值而非锁死琥珀。

教训：**SVG 的 `rotate` 只管角度，径向距离必须在 `cx/cy`（或 `translate`）上**；
而探针若只读 `transform`，这类"矩阵全绿、位置全错"的缺陷抓不到。

---

## 终态

| 门禁 | 结果 |
|---|---|
| test:structure | **388** / 0（首轮 342 → 第二轮 +1 → 第三轮 +16 → 第四轮 +29） |
| test:fluid | **126** / 0 |
| test:dock-hide | **155** / 0 |
| typecheck（双工程） | 0 error |
| npm test（21 子脚本） | 126 / 0 |
| npm run build | ✓ |
| npm run shots | ✓ 全帧产出 |

PRD 的 AC1–AC9 全部勾选，每条都注明验法（实拍帧 / 探针原文 / 门禁编号），
没验到实测的部分（空槽、低液位、3D 色差量化）明确写的是"门禁覆盖"而非"已实测"。

### 留给用户的两个未决（未擅改）

1. **环线宽是 demo 的 2 倍**：demo `stroke-width 8` @112px = App 4px @56px，App 实测 8px。
   真实差异，已问用户，未动。
2. **5k 冻结帧的幽灵球**：`::after` 玻璃罩与 `.fluid-waves` 不在 freeze 名单里，
   animation 被停后回 base。改动前也存在，非回归；真实动画里 `glass-absorb` 会淡到 0，
   只是 QA 定帧假象，用户不可见。

### 三个踩坑（都记进了本日志，可查）

1. **假绿灯**：子代理把 CSS 写进未被 import 的 `skills.css` 并把门禁读取路径改过去，
   343/0 测的是 app 不加载的幻影文件。恢复时 `mv` 后又跟了句 `git checkout --`，
   untracked 文件无备份，编辑全丢。
2. **探针漏检 + 门漏检双重失守**：端点圆点 `cx` 写成圆心，探针只读 `transform`（纯旋转矩阵
   e/f 恒为 0）、门只断角度换算，两边全绿，圆点却钉在球心。靠实拍 + 手算几何才发现。
3. **门禁读文件错**：`grep` 一次 `skills.css` 就能发现的事，靠"绿灯"判断掩盖了两轮。
   以后 CSS 类改动后，先追一遍 import 链确认门禁读的是 app 真加载的那个文件。

## 第五轮：用户实拍报障四项（10-07）

用户报四项：①minimal 柠檬分段环的进度条和百分比对不上（或效果不明显）；②直充余额没有显示
进度；③圆球自动切供应商时四边被遮挡（大圆超出面板）；④墨底琥珀弧皮肤球内字体看不清。

四项全部取证到原型/代码级根因，逐条修 + 加门 + 实拍探针实证。

### C1 · minimal 分段环与弧错开 90°（报障①）

**根因**：原型 V5 的分段圆自带 `transform="rotate(-90 56 56)"`（skin-applied.html:163），
App 的 `.ring-arc` 有 `rotate(-90 28 28)`（PetBall.tsx:166）但 `.ring-seg` 没有 —— 分段从
3 点起画、弧从 12 点起画，错开 90°，弧从分段中间穿过。两段 r / stroke-width 都是
`--ring-r` / `--ring-sw`（完全同几何），所以对不齐就是纯粹的起点错开，不是线宽或半径的锅。

**修法**：给 `.ring-seg` 补 `transform="rotate(-90 28 28)"`。

**实证**：`5c-form: minimal` 探针 `segTransform: "matrix(0, -1, 1, 0, 0, 56)"`
（a=cos(-90°)=0, b=sin(-90°)=-1, c=-sin=1, d=cos=0，e/f=0/56 是绕 (28,28) 的旋转移算）；
实拍弧从 12 点顺时针画到 40%，分段也 12 点起。

### C2 · minimal 余额弧隐形（报障②）

**根因**：余额弧走 `waterAnchors.accent`（PetBall.tsx:532 isPlan 分支），minimal 未声明
`--ball-accent` → 回落页面级 `--accent: #111114`（近黑），压在 `#0b0f07` 暗盘上对比度只有
**1.03:1**（实算，几乎与盘面同色）—— 完全看不见。

**修法**：给 minimal 声明 `--ball-accent: #beff3c`（本皮环的身份色柠檬，与 ink 用身份琥珀
作 ball-accent 同口径），对暗盘 **16.2:1**。

**刻意没动**：dark（--accent 蓝 #0a84ff 对 #17100a 是 5.1）、candy（紫 #8b5cf6 对 #07180f
是 4.0）都读得出，不声明就是走回落 —— 顺手加就是无必要的跨皮视觉漂移。

**实证**：`5c-bal: minimal` 探针 `dataRing:"balance"`、`arcStroke:"rgb(190, 255, 60)"`
（= #beff3c，修前是 rgb(17,17,20)）、`arcDash:"100.00 100"`（余额满圈）；实拍是满圈亮柠檬环
+ 白字 ¥1.3k。对照 `5c-bal: ink` 仍是 `rgb(255, 184, 77)` 未被牵连。

### C3 · pour-top 外扩裁边（报障③）

**根因**：`pour-top` 关键帧 `scale(1.07)`。球 = 窗口 = 56×56（D6 禁 outer shadow 的同一条
约束），1.07×56 ≈ 60px，每边外扩 ≈2px，圆盘越过窗口边界被 `overflow:hidden` 裁成四条平直弦。
用户说的「由大变小的大圆超出面板」正是 1.07 → 1 的后半程。

**修法**：删掉 `@keyframes pour-top` 与 `animation: pour-top`，freeze 定帧位移改成不带 scale。
冲顶观感由 `pour-flash` 泡沫闪峰承载（它本来就在同一时刻播）。**56×56 的球没有向外呼吸的
空间** —— 任何 scale > 1 都裁边，改成 scale < 1 又会露出窗口背景的缝，两条路都不通，只能删。

**实证**：5m-pour-top 实拍球体回到 56×56 满窗，四边是圆的、无平直弦。

### C4 · ink warn/danger/muted 读数不是白字（报障④）

**根因**：B5 把 ink 由米色宣纸盘翻成深墨盘后，漏加进 D3g 那条「暗盘四皮等级色读数让位白字」
的循环（当时只列 dark/minimal/candy）。warn 档走页面级 `--warn: #b07d20`、danger 档
`--danger: #a63b2f`，压在 `#080c17` 上分别是 5.4:1 / **3.1:1** —— danger 档低于 4.5 不可读。

**修法**：把 'ink' 加进 D3g 的循环（一行）。

**实证**：加了 `5c-warn` 探针 + 70% 夹具帧（40% 帧是 lvl-ok，**验不到**这条覆写 —— 阈值是
60/85，40% 落在 ok 档，首轮跑完才发现帧选错了）。`5c-warn: ink` 探针 `lvlClass:"lvl-warn"`、
`valueColor:"rgb(255, 255, 255)"`（修前是 rgb(176,125,32)）。

### 门禁（388 → 393）

| 门 | 断言 |
|---|---|
| D3g（扩到四皮） | ink 也进「lvl-warn/danger/muted 让位 --ball-fg」的 :is 三级 |
| D3i2 | minimal 必须声明 --ball-accent（否则回落 #111114 隐形）；dark/candy 不许顺手加 |
| K7c（反转） | pour-slosh/p pour-flash 两段在，`@keyframes pour-top` 必须**不存在** |
| K7d（反转） | data-pour 下不再挂 pour-top animation |
| K7f（加强） | `[data-freeze='pour-top']` 的定帧位移不得带 scale |
| K11f4 | `.ring-seg` 必须带 `rotate(-90 28 28)`；K11f4b 守 `.ring-arc` 同值（对齐基准） |

验齿：注释掉 minimal 的 `--ball-accent` → D3i2 红；摘掉 seg 的 rotate → K11f4 红。还原即绿。

### 顺手补的取证探针（避免下一轮再靠人眼）

shots.ts 的 5c-form 探针补读三项：`valueColor`（读数色）、`lvlClass`（等级类）、
`segTransform`（分段圆变换矩阵）。新增两个取证帧族：
- `5c-ball-{id}-70` + `5c-warn` —— 70% 强制 warn 档，验等级色读数覆写
- `5c-ball-{id}-bal` + `5c-bal` —— 余额夹具，验 accent 弧色

上一轮「探针漏检 + 门漏检双重失守」的教训落地：探针和门只断同一件事就是同一条腿。
这次特意让探针读**门没断的值**（valueColor 的实际颜色、segTransform 的实际矩阵），两条腿分开。

### 终态

| 门禁 | 结果 |
|---|---|
| test:structure | **393** / 0（第四轮 388 → 第五轮 +5 项判定） |
| test:fluid | **126** / 0 |
| test:dock-hide | **155** / 0 |
| typecheck（双工程） | 0 error |
| npm test（21 子脚本） | 0 失败 |
| npm run build | ✓ |
| npm run shots | ✓ 全帧产出，含 4 个新取证帧 |

PRD 的 AC10–AC14 全部勾选并注明验法。

### 留给用户的未决（三项，均未擅改）

1. **环线宽是 demo 的 2 倍**：demo `stroke-width 8` @112px = App 4px @56px，App 实测 8px。
   真实差异，已问用户，未动。
2. **5k 冻结帧的幽灵球**：`::after` 玻璃罩与 `.fluid-waves` 不在 freeze 名单里。改动前也存在，
   非回归，用户不可见。
3. **minimal 套餐弧比分段暗**（本轮新发现，未动）：40% 的弧色是 `waterColor` 连续插值的
   rgb(141,132,25)（绿→琥珀中段），亮度 0.222；而柠檬分段在暗盘上合成后亮度 0.393 ——
   **弧比分段暗**，而 CSS 注释写的分工是「弧抢眼、身份环靠色相」。这是全局连续插值模型
   （绿→琥珀的 RGB 中段必然过橄榄泥）决定的，改会动到所有皮肤。用户报的「效果不明显」
   可能部分源于此，等拍板。

