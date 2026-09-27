# 执行计划：球形态回到 2D 小圆环

顺序原则：**先让视觉变成小圆环（可验收），再清理死码，最后同步 QA。**
步 1 结束就能交付 —— 步 3/4 只是把不再用的代码与断言收拾干净，
出问题时可以停在步 1+2（留死码比回滚视觉划算）。

## 进度快照

| 步 | 内容 | 状态 | 门 |
|---|---|---|---|
| 0 | 取证：首版规格、现状、QA 面、死码足迹 | ✅ 完成 | 见 `prd.md` / `design.md` |
| 1 | 球形态走 2D 环：尺寸 + 守卫 + 补回环 CSS | ✅ 完成 | 视觉已是 56px 小环，环可见 |
| 2 | 命中区改用 `BALL_VIEW` | ✅ 完成 | 穿透语义不退化 |
| 3 | 死码清理（`scene.ts` / `rig.ts` / `skins.css` / 删 `projection.ts`） | ✅ 完成 | 人物路径零回归 |
| 4 | QA 同步（`uitest` / `ballshot` / `test-projection` / `package.json`） | ✅ 完成 | 9 套件 0 失败；uitest 85 ok / 0 fail |
| 5 | 「显示用量环」在球形态下的行为 | ✅ 完成 | 不是死开关（新断言已「先弄坏一次」验过） |
| 6 | 走查截图 + 文档同步 | ✅ 完成 | `docs/pet-dot.png` 已换新；`DESIGN.md`/`CONTEXT.md`/`README.md` 已同步；`TASKS.md` 是历史日志故不动 |
| 7 | 独立复核（`trellis-check`）的 8 WARNING 处置 | ✅ 完成 | 见下节 |

## 自检结果（2026-09-27 实跑，最终态）

```bash
npm run typecheck        # 干净
npm test                 # 9 个套件，462 项，0 失败
node scripts/test-structure.mjs   # 13 项，0 失败（B4 闭集仍钉住 5 个 qa 文件）
BD_USER_DATA=<临时目录> npx electron . --uitest
                         # 97 键 / 85 ok / 0 fail，consoleErrors=none、execErrors=none
npx electron . --ballshot        # diag: win=[56,56]、canvas=null、dump=[]（球形态无 WebGL）
BD_PET=1 npx electron . --ballshot  # 见下「人物形态零回归」的逐位对照
```

**人物形态零回归的证据不是像素比对，是逐位对照。** 先证伪了像素路线：同一轮 ballshot 的
三张图互差 13–15%（每张捕到不同动画帧），所以跨轮像素比对在这里没有意义。改比对确定性字段，
改动前后**逐位相同**：`win [213,293]`、`canvas [426,586,213,293]`、
`rect {x:26.880806326334206, y:39.53742447368828, w:159.23838734733158, h:212.83465409088166}`、
`center {x:106.5, y:145.9547515191291}`、`stride 26.8`、`overlay [["petball-caption",68,245,145,289]]`、
`petReady true`。唯一变的是动画相位（逐帧采样）与随机会作池（每会话从 11 条里抽 6 条）。

**步 5 的「先弄坏一次」**：把 `{showRing && pct != null && …}` 改成 `{false && …}` 重跑 --uitest，
`petRingToggle` 如期变红：
`fail:on={"fill":false,…},off={"fill":false,…},back={"fill":false,…}`。
⚠ **第一次弄坏时它没有变红** —— 原写法只查「关掉后没有弧」，弧**永远不画**时照样绿，
是典型的假护栏。已补上「读到百分比时开着必须有弧」这一句才真正验住（R7）。

## `trellis-check` 复核的处置

0 CRITICAL、8 WARNING、11 NIT。处置如下（**每条都实跑验证过，没有一条靠读代码下结论**）：

| 编号 | 问题 | 处置 |
|---|---|---|
| W1 | `.petball-fallback:active` **永远触发不了** —— `.petball` 是 `pointer-events:none`，事件全被盖在上面的 `.petball-hit`（`auto`）吃掉。球形态其实**完全没有按压反馈**，而注释却宣称有 | 改用 `:has()`：`.petball.no3d:has(.petball-hit:active) .petball-fallback`。实测（`sendInputEvent` 发**真实**输入，合成事件点不亮 `:active`）：`idle=matrix(1,0,0,1,-28,-28)` → `down=matrix(0.94,0,0,0.94,-28,-28)` |
| W2 | `failed` 只在 `catch` 里置 `true`、**永不复位** —— 「人物→球→人物」再来一次时，即便这次 WebGL 正常，也被上一次的 `failed` 钉在 2D 兜底上 | 成功分支补 `setFailed(false)` |
| W3 | 球形态**没有任何数据来源提示**。`ballLevel()` 只看 `status`、不看 `dataQuality`，所以缓存/本机估算的数字在环上是和权威数据**一模一样的绿/琥珀色** | 可信度角标从「仅人物形态」放开到两种形态。球形态缩到 10px、圆心沿 45° 对角线放到 29.5+… 见下「角标几何」 |
| W4 | 复核断言 `petBallNoBubble` 是**假护栏**，`implement.md` 里的解释也是错的 | 见下「W4 的三轮取证」，已重写并挪位 |
| W5 | `petRingToggle` 不验偏好是否落盘 —— 「改了内存里的 React state、忘了写 extras」也能一路绿 | 新增 `petRingSaved`，对齐 `intervalSaved` 的做法 |
| W6 | `petBallCenterValue` 只查 track 的 `stroke ≠ none`。轨道是 16% 透明度的灰、几乎看不见，「弧根本没画」时照样成立 | 改为同时查 fill 的 `stroke` 与 `strokeDasharray > 0`（dasharray 承载弧长）。实测 `dash: "22.1168px, 138.23px"` |
| W7 | 球形态命中区无任何断言守着 —— 一旦退回整窗（213×293）就是隐形可点击区 | 新增 `petBallHitRect`，允许 2px 抖动（浮点取整） |
| W8 | `README.md` 只改了一半，球形态那节仍在描述玻璃球 | 整节重写，并新增 `docs/pet-dot.png`（112×112 = 2× DPR） |
| N1/N6/N8/N9 | 过期注释：`200×210`、无解释的 `pad = 3`、`BD_ONLY` 门控、`hasScene` 语义 | N1 改 `uitest.ts:46`；N6 给 `pad` 补上「为什么是 3px」；N8/N9 复核时子代理已用 `needScene()` 守住，无需再动 |
| N11 | `implement.md` 里的数字与实跑不符（95 项 vs 85 ok） | 以实跑为准改掉 |

另清掉 7 处活跃代码/文档里的过期说法（`preload/index.ts:77`、`App.tsx:214`、`uitest.ts:359`、
`DESIGN.md:58/292/299`、`README.md:136/159`）。**保留**两处历史注记（`pet-view.ts:12`、
`scene.ts:44`）—— 它们记录的是「为什么从 200×210 退回 56×56」，属于变更说明而非现状描述。
`TASKS.md` 里带日期的过往条目同样不动：改它等于篡改历史。

### W4 的三轮取证：一条「绿」的断言怎么变成可信的

复核报告说 `petBallNoBubble` 靠 `setExtras` 触发，但 `App.tsx:211` 只在挂载时读一次 extras，
推不进 React —— 而我上一次的探针读到 `data-pet` 已经变成 `ray`。两边矛盾，只能实测。

1. **第一轮**：守卫保持破坏，只把 `setExtras` 那行删掉 → 读 `ok`。看着像「`setExtras` 是必需的」。
2. **第二轮**：在 `setExtras` **之前**插探针 → `pet=ray bubble=你好，我是Ray～`。
   **泡泡早就在了**，`setExtras` 什么也没触发。第一轮的结论是巧合。
3. **第三轮**：`data-pet` 为什么早就是 `ray`？`uitest.ts:379` 点非选中角色卡片
   （`[...document.querySelectorAll('.pet-chip')].find(c=>!c.classList.contains('on')).click()`）
   才是换角色的那一步。而 `defaultPetState()` 默认是 `'aria'`、不是随机 —— 复核报告这条说对了。

**真正的触发**是形态翻转：`petSwitch('0')` 让 `figure` 翻到 false，`[pet.id, figure]` 依赖的
effect 重跑，守卫一失效就在球形态里冒泡泡。**它原来之所以能抓到，纯属侥幸** ——
断言点恰好落在泡泡 4.2s 存活期的尾部，删掉一行 IPC 的耗时就从「抓得到」翻成「抓不到」。
**处置**：挪到 `petBallOff` 紧后面（那行正好读 `data-figure` 翻成 0 的那一刻，泡泡是**新生**的），
不再和 4.2s 赛跑；原位置留一行注记说明「别挪回来」。
**验证**：守卫弄坏 → `fail:bubble=你好，我是Ray～`（仅此 1 项失败）；守卫修好 → `ok`。

### 角标几何（W3 的坑）

56×56 窗口里，环的 `stroke`（`strokeWidth=5`）外缘在 **r=24.5**（圆心 28,28），空角沿 45° 对角线
到盒角（距圆心 39.6）只有 **15.1px** —— 而角标本来就是 15px。**塞不进去。**

第一版按 15px 放到 (37,5)-(52,20)，实测最近角距圆心仅 **12.0**，盖在环上。
算错了两次才对：① 以为最近点是**边中点**（半宽 5），实际正方形的最近点是**角**（半对角线 5√2≈7.07）；
② 切点圆心距应是 `24.5 + 7.07 = 31.57`，不是 `24.5 + 5 = 29.5`。
最终 10px + 圆心 (50.34, 5.66) → 占位 `89.9%` / `10.1%`，实拍落在 **(45,1)-(55,11)**：
完整在框内、最近角距圆心 24.52（≈24.5 内切）、远角 38.66（< 39.6 不裁）。
实拍确认不压环也不压中心读数。

## 步 1：球形态走 2D 环

- [x] `src/shared/pet-view.ts`：`BALL_VIEW` 改 `{ width: 56, height: 56 }`，
      注释写清「首版设计（`d5a028e`）；球形态不再有 3D 球」
- [x] `src/renderer/src/PetBall.tsx`：
  - 3D 场景 effect（`:100-123`）加守卫 `if (!figure) return` —— 球形态不建场景。
    注释写明「不是「建一个空场景」：省显存是硬要求，`createPet3dScene` 会
    无条件 `new THREE.WebGLRenderer`（`scene.ts:151`）」
  - 2D 环的渲染条件从 `failed` 改为 `!figure || failed`（三态见 `design.md` 状态表）。
    **保留 `failed` 分支**：它服务的是人物形态的 WebGL 失败兜底，不是球形态
  - `no3d` 类名：现状 `${failed ? ' no3d' : ''}` 要改成覆盖两种情况
- [x] `src/renderer/src/skins.css`：
  - **补回环规则**（R3，这是修 bug）：`.petball.no3d .dot-ring-track { stroke: var(--track) }`
    与 `.dot-ring-fill { stroke: var(--ok) }` + `lvl-warn` / `lvl-danger` 两档变体
  - `.petball.no3d` 圆盘 60×60 → **56×56**（与 SVG `viewBox` 及新窗口一致）
  - 删 `.dot-btn.stale .dot-ring-fill` / `.dot-value`（`skins.css:2081-2086`，
    `.dot-btn` 既无规则也无引用）
  - 加 `stroke` 之外还需确认：`PetBall.tsx:445,448` 两个 `<circle>` 都没有
    `stroke` 属性，规则补上后才生效（**这一步是 R3 的实质**）

**门**：`BD_USER_DATA=<临时目录> npx electron . --ballshot`（不带 `BD_PET`）
拍出 56×56 的小环，环**可见**（当前是隐形的），中心有数字。

## 步 2：命中区

- [x] `src/renderer/src/PetBall.tsx:200-202`：无场景分支的兜底值从
      `FIGURE_VIEW` 改为 `BALL_VIEW`。现状用 `FIGURE_VIEW`（213×293）是个
      **错的默认值**，只因 60×60 在任何窗口里都偏上居中才没暴露
- [x] 球形态下命中区用「整块窗口」还是「内切圆」？56×56 窗口 + 内切圆（r=28）、
      外加主进程 `pad = 3` → 可点范围 62px。**建议整块窗口**（更宽容，且圆盘本
      就占满 56×56）

**门**：`--uitest` 的 `petPierce`（`hb.width > 20`）与 `dotDom` 仍过。

## 步 3：死码清理

每删一块都要确认没有人物形态的引用。

- [x] `src/renderer/src/pet3d/scene.ts`：
  - 球几何 `266-391`（126 行：`shell` `rimShell` `edgeShell` `spec` `specSm`
    `band` `ringGroup` `trackRing` `fillMat` `fillMesh` `fillGeo` `capMat`
    `buildFill` `halo`）
  - `applyTokens` 里的球材质 505-517、`levelRgb` + `refreshColors` 525-536
  - `updateHitRect` 球分支 561-567、`step` 的高光漂移 750-754、`ringOn`
  - `dispose` 材质表（`:926`）里 9 个球材质，**只留 `blobMat`**
  - **保留** `shadowFloor` / `blob`（`scene.ts:226-227` 注释：人物形态也用）
- [x] `src/renderer/src/pet3d/rig.ts`：删 9 个球专属常量
      （`CAM_DISTANCE` `CAM_PITCH` `CAM_Y` `SHELL_EDGE_R` `BAND_R` `BAND_TUBE`
      `RING_R` `RING_TUBE` `RING_HALO_TUBE`）。
      **保留** `BALL_RADIUS` / `BALL_CENTER_Y`（`GROUND_Y` 的输入，人物间接用）
- [x] `src/renderer/src/pet3d/projection.ts`：**整个删除**
      （`sphereNdcHalf` 唯一运行时消费者是球分支的 `updateHitRect`）
- [x] `src/renderer/src/skins.css`：删
  - `.petball-center-value` 4 条（1489-1510，球形态专属）
  - `.petball.hover .petball-stage` 缩放（1581-1589，注释自承「球体本身由 WebGL 画」）
  - `@keyframes petball-pop`（1604-1615，**全项目零 `animation` 引用，已经是死码**）
- [x] `FORMS.ball` 保留但只留 `ball: true`，**注释写明「语义已死，故意保留」**
      （删它要连锁改 `PetForm` 联合 + `Record` 穷尽 + 三个文件的类型签名，不划算）

**门**：`npm run typecheck` 干净；`--uitest` 的**人物形态**断言（`petModel`
`pet3dCanvas` `petFigureBig` `petGesturePool` `petStride` `petFigureOnly`）
与步 4 之前一致。

## 步 4：QA 同步（本任务最大的工作量面）

- [x] `src/main/qa/uitest.ts`：
  - `:106` `ball3d` **删**（断言球形态有 WebGL canvas，与新设计相反）
  - `:171` `refreshThenCollapse` 的**硬编码 `200`** 改为读 `BALL_VIEW.width`
  - `:533` `petBall3d` **反转**：球形态应当 `!canvas` 且 `.petball-fallback` 存在
  - `:539` `petBallCenterValue` 改为断言 2D 环
  - `:429` `petFigureOnly` **重写**（R7）：正则在球几何删完后**永不可能匹配**，
    留着就是假护栏。改为断言 figure 形态下 `__bd_ball().dump` 里出现
    `f014_...bones_opacity` 这类人物网格（`BallBallshot` 的 diag 已证明它在 dump 里）
  - `:420` `petCenterValue` **重新验证**（不是假设）：它断言 figure 下
    `.petball-center-value` 不存在，新结构下该类只被人物分支引用，结论应仍成立
  - 逐条复核其余 30 条断言
- [x] `src/main/qa/ballshot.ts`：`BD_ONLY` / `BD_ISOLATE` / `BD_DEBUG_RING`
      依赖 `__bd_ball().dump`，球形态无场景 → **明确标为「仅人物形态有效」**，
      并在球形态下**打印一行说明**而不是静默无效（静默失效的 env 是最坏的形态）。
      `BD_SETTINGS` 的 `petInfo:` 打印同理
- [x] `scripts/test-projection.mjs` **整个删除**（§1/§2/§3 全依赖球几何或
      `projection.ts`）+ `package.json` 去掉 `test:projection` 及其在 `test` 链里的位置
- [x] `scripts/test-structure.mjs`：`ballshot.ts` 被 B4 闭集钉住，文件不能删。
      步 3 删掉的 CSS/文件若被任何静态断言引用需同步

**门**：`npm test` 9 个套件 0 失败（少一个，因为删了 `test:projection`）；
`BD_USER_DATA=<临时目录> npx electron . --uitest` 全绿。

## 步 5：「显示用量环」不再是死开关

现状：`src/main/ipc.ts:251` 右键菜单有「显示用量环」，`App.tsx:193-196` 切换
`ui:petRing`，传给 `PetBall` 的 `showRing`（`App.tsx:381`）。
球形态变 2D 后这个开关若不接上就是**点了没反应的死开关**。

**决策：让 `showRing` 控制 2D 环的填充弧**（关掉 → 只剩素圆盘 + 数字）。
不隐藏菜单项、不删设置。理由：它是既有用户配置，保留语义比删掉更尊重；
且对 2D 环同样有意义（有人就想要一个干净的数字）。

- [x] `PetBall.tsx` 的 2D 环 JSX：`{showRing && pct != null && (<circle className="dot-ring-fill" …/>)}`
- [x] `--uitest` 加一条断言：切 `ui:petRing=0` 后球形态下 `.dot-ring-fill` 消失、
      `.dot-ring-track` 仍在
- [x] 按纪律**先弄坏它一次**确认新断言会红

## 步 6：走查与文档

- [x] `BD_USER_DATA=<临时目录> npx electron . --ballshot` 拍球形态（不带 `BD_PET`）
- [x] `BD_PET=1 BD_PET_ID=aria|ray` 拍人物形态，确认**零回归**（dump 实证人物网格
      `f014_hipoly_81_bones_opacity` 可见、canvas 426×586、命中区 159×213）
- [x] 逐皮肤 `BD_SKINS=1` —— 2D 环靠 `--dot-rim` / `--dot-bottom` / `--track` /
      `--ok` 等令牌上色，逐皮肤必须都对
- [ ] `DESIGN.md` 收起态章节改写（原描述是「3D 悬浮球」）
- [ ] `TASKS.md` 记一轮；`CONTEXT.md` 若「形态」词条提到球体则同步
- [ ] 走查基线/结果图存 `docs/baseline/`（沿用 human-realism 步 1 的做法）

## 与计划的偏差（实施时取证，改动前都复核过）

| 计划 | 实际 | 原因 |
|---|---|---|
| 保留 `FORMS.ball` 但只留 `ball: true` | **删掉** `FORMS.ball`，`PetForm` 收成 `'figure'`，`FormRig.ball` 字段与 `createPet3dScene` 的 `form` 参数一并删除 | R4 正文本来就写「清 `FORMS.ball`」；且步 3 删掉球几何后 `rig.ball` 的 4 处分支全部不可达。留一个只剩 `ball: true` 的条目就必须编一套机位数字（`camZ: 0` 会让相机落在原点，是个地雷）。连锁面比预估小：`PetBall` 一处调用 + 两个类型名 |
| 死码清单未列 `BallFrame` | **一并删掉** `BallFrame` / `setFrame` / `frame` | 它每个字段（`percent`/`level`/`pager`/`showRing`）都是 3D 用量环的输入；删掉 `buildFill`/`refreshColors` 后场景里**没有任何一处读它**，留着就是只写字段 + 一个什么都不做的句柄方法。步 5 让 `showRing` 改由 DOM 消费后更是零引用。人物形态的**行为**不受影响（已实证） |
| 步 1 只说改 `no3d` 类名 | 同时**删掉** `.petball-center-value` 那块 TSX，并让 `.petball-caption` 只在人物形态渲染 | 球形态的 56×56 窗口里，环心数字（`.dot-value`）与旧球心数字会**重叠成两层**；胶囊最宽 140px 会被 `overflow:hidden` 切掉。这两处的 CSS 本来就在步 3 的删除清单里，TSX 侧必须同步 |
| 步 4 未提 `shots.ts` | `settle()` 里的「等 WebGL 首帧」加了 `hasScene` 守卫 | 球形态没有场景，`__bd_ball().measure` 恒 null → 每次收起白等 8 秒并打一条**假的**「画布迟迟没有像素」 |
| — | `PetSection.tsx` 的说明文案与开关 `title` 改为「小圆环」 | 原文案写着「3D 悬浮球（玻璃球 + 用量环）」，会把用户引向已经不存在的形态 |
| — | 恢复首版的 `.petball-fallback:active { scale(0.94) }` | 步 3 删掉 `.petball.hover .petball-stage` 后球形态就没有按压反馈了；prd 说「首版 CSS 直接复用，不重新设计」，而 `:active` 就在那份里（`d5a028e:skins.css:1394-1395`） |

**未处理（留给后续）**：`uitest.ts:561` 的 `petBallNoBubble` 用 `setExtras` 改 `ui:petState`，
但 App 只在挂载时读一次 extras、不订阅 petState 变化 —— 那条断言很可能一直是**恒过**的。
不在本任务范围内（R7 针对的是本任务新增/重写的断言），但值得单独立项。

> ⚠️ 上面这条**已被后续复核推翻并处置**，见「`trellis-check` 复核的处置 → W4」。
> 结论确实如这里所怀疑的（那条断言的触发机制是假的），但结论下的处置不是「单独立项」，
> 而是**在本任务内挪位重写**了 —— 因为它守的正是本任务删掉的那段分支。

## 自检命令

```bash
npm run typecheck
npm test                                    # 9 个套件（删了 test:projection）
npm run build
rm -rf /tmp/bd-ud && BD_USER_DATA=/tmp/bd-ud npx electron . --uitest
npx electron . --ballshot                   # 球形态（默认），应为 56×56
BD_PET=1 BD_PET_ID=aria npx electron . --ballshot    # 人物形态 213×293
```

> ⚠️ **`--uitest` 必须带 `BD_USER_DATA=<临时目录>`。** 它只把 autostart 目录
> 重定向到临时目录（`uitest.ts:25`），**不隔离 userData**，会继承本机真实的
> `ui:*` 偏好与供应商状态，产生假失败。修隔离本身单独立项（不在本任务范围）。

## 上下文清单

按需 `Read` 的大文件（**故意不进 jsonl**：超 `context_injection.max_file_bytes` = 32KB
会被截断却仍吃满注入预算 —— 2026-09-19 派发连续失败就是这个原因）：

- `src/renderer/src/pet3d/scene.ts`（948 行）—— 步 3 的手术台
- `src/main/qa/uitest.ts`（776 行）—— 步 4 的手术台
- `src/renderer/src/skins.css`（2366 行）—— 步 1/3 的手术台，用 `grep -n` 定位而非通读
- `TASKS.md` / `DESIGN.md` —— 步 6 只需收起态那几节
