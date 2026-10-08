# Journal - zhou (Part 1)

> AI development session journal
> Started: 2026-09-13

---



## Session 1: 2D 小圆环：用量环按套餐分流 + 滚轮切时限与供应商 + 数字递增动画
<!-- trellis-session: v=2 fp=de966b0ae1de5396 -->

**Date**: 2026-09-28
**Task**: 2D 小圆环：用量环按套餐分流 + 滚轮切时限与供应商 + 数字递增动画
**Branch**: `main`

### Summary

完成 09-27-dot-ring-scroll 全流程：撤「显示用量环」七处链路、按 kind 分流（新建 shared isPlan()）、winIdx 窗口索引 + 上下滚轮切 5H/周/月 + 多窗口短标签、左右滚轮切供应商（advanceProvider 为换人唯一入口）、防惯性三常量、秒级 tick 的 8 秒暂停、数字递增动画两态。uitest 新增 14 条断言，13 条逐条 break-once 取证、每批红集恰好等于声明目标集；终验 109 键/0 fail、npm test 462 项 0 失败、人物形态 8 字段逐位同基线。过程抓到三个真问题：npx electron . 跑 out/ 而非 src/ 导致验证跑旧构建（修计划 6 处 + 写入 spec 构建前置契约）、设计文档把 if (figure) return 写反、滚轮累积量不衰减（补 GESTURE_GAP 断流清零）。spec 同步修正 test-projection 残留数字并新增 break-once 取证规范。

### Git Commits

| Hash | Message |
|------|---------|
| `57d60b0` | feat(pet): 2D 用量环按套餐分流 + 滚轮切时限与供应商 + 数字递增动画 |

### Status

[OK] **Completed**


## Session 2: 球形态：方形蒙版真凶定位 + 标签下移等宽 + 轮播先走完窗口
<!-- trellis-session: v=2 fp=68b3b435829f5711 -->

**Date**: 2026-09-28
**Task**: 球形态：方形蒙版真凶定位 + 标签下移等宽 + 轮播先走完窗口
**Branch**: `main`

### Summary

用户报的「球外面套一圈浅色方框」三次归因全错（backdrop-filter → macOS 原生窗口层 → 不透明浅灰底），真凶是 .petball-fallback 的 outer box-shadow：收起态窗口与该元素同为 56×56，外阴影无处容放却被绘制，圆形光晕被窗口裁成方形。同机理第二实例 .petball-rename input 一并去掉（用户拍板）。两条独立证据链：实屏抓屏（白底打底）窗口顶缘 253,252,252,251,251,250 → 255,255,255；capturePage alpha 逐像素解码球外 2688/2688=100% → 208/2688=7.7%、最远半径 78.5px → 56.7px。撤回无效改动 roundedCorners:false 与 setBackgroundColor（实测对方框无效，只改圆角 9pt→6pt）。新结构门 D6 从 1 条扩到 5 条（顶层逗号切层 + 剥注释 + 选择器配平取整块），9 组弄坏验证红集均恰好等于声明目标。顺带修 uitest.ts 的 petDiag 空指针（会让整个 --uitest 不输出 JSON）。最重要的一条方法教训已写进 spec：症状无法被现有工具观测时，先解决观测手段再谈归因；以及方程无解时该怀疑的是前提而不是继续找参数。另订正了我自己一个错误断言——「capturePage 拍不到方框」是错的，它一直拍得到，该错误说法曾被当事实写在 8 处。验证：typecheck ✓ / npm test 477 通过 / test-structure 28 / uitest 112 键 0 失败。遗留：展开态卡片拖拽断言在机器高负载时偶发红（红集每次不同、与本改动无关）；.card 缺护栏；AC5.1c 改名态仍需用户肉眼确认。

### Git Commits

| Hash | Message |
|------|---------|
| `334a79e` | feat(pet): 球表面令牌化 + 时限标签下移等宽 + 自动轮播先走完窗口 |
| `5d0f04c` | fix(pet): 去掉悬浮球外的方形蒙版 —— 真凶是窗口同尺寸元素上的 outer box-shadow |

### Status

[OK] **Completed**


## Session 3: TTS 播报无声修复（CSP media-src + playElement 契约）
<!-- trellis-session: v=2 fp=8d0ef7a1961d0779 -->

**Date**: 2026-09-30
**Task**: TTS 播报无声修复（CSP media-src + playElement 契约）
**Branch**: `main`

### Summary

用户反馈测试播报提示成功但无声。定位为两层 bug：CSP 缺 media-src 拦死 blob 音频 + playElement 吞播放失败使 onTtsOk 永远触发。修复：CSP 新增 media-src 'self' blob:（connect-src 逐字未动），playElement 失败路径改 reject 并带 TTS_PLAYBACK 前缀，onended/打断仍 resolve，失败路径 blob URL 仍释放；test-structure 新增 F1b/F1c 守卫，test-speech-out 扩 FakeAudio 加 20 条播放失败断言；spec 补记请求层成功不等于播放成功。反向验证 8 条全红，13 套 1112 项 0 失败。含此前预警确认气泡提交 288ddf0。

### Git Commits

| Hash | Message |
|------|---------|
| `0d76151` | fix(tts): 修复测试播报提示成功但无声（CSP 补 media-src + 播放失败不再被吞） |
| `288ddf0` | fix(pet): 预警确认提醒改为角色头顶气泡，修掉「OpenCode Go …」的截断 |

### Status

[OK] **Completed**


## Session 4: 贴边隐藏 + 流体水满 + 移除数字真人 + 全息球原型
<!-- trellis-session: v=2 fp=0f105e2a7c44f20a -->

**Date**: 2026-10-03
**Task**: 贴边隐藏 + 流体水满 + 移除数字真人 + 全息球原型
**Branch**: `main`

### Summary

交付三件并归档四任务。feat(dock) 落 SVG gooey 流体吸入/汇聚 + 渐变3D球 + 水满进度（液位=percent），新增 shared/fluid.ts 纯函数 + dockHide 状态机 + dock:fluid 相位通道，morph 期命中并集，reduced-motion 走 slide 回退。修复主进程 setPosition undefined 崩溃（hiddenBounds/peekHitbox 非法输入回 null + 定时器回调全 try/catch + Number.isFinite 守卫），弄坏验证复现同签名 Timeout._onTimeout。feat(pet) 移除数字真人 -4651 行：删 pet3d 整目录/Rocketbox 管线/test:pet-gesture/three+@types/three，老用户 ui:pet=1 迁回环，typecheck/npm test 2261/build 全绿，入口 -1.19MB。原型 holo-sphere Phase 0 CONDITIONAL GO（macOS Intel 59.9fps/对比度17.5/<5MB 增量），转正缺 Windows+M 系真机取证，未入主干。spec 补主进程定时器回调异常公约。归档 dock-autohide/remove-human/human-realism/vroid-hub 四任务，删 feat/dock-autohide 与 feat/remove-human 两分支。

### Git Commits

| Hash | Message |
|------|---------|
| `4b2dadc` | feat(dock): 悬浮球贴边自动隐藏 + 流体吸入汇聚与水满进度 |
| `b6339d1` | docs(spec): 主进程定时器回调异常公约（崩溃复盘） |
| `f58f10f` | docs(task): 贴边隐藏任务规划与去真人化任务地图 |
| `a47e4a9` | feat(pet): 移除数字真人，收起态只留2D小圆环 |
| `da44fae` | Merge branch 'feat/remove-human' |

### Status

[OK] **Completed**


## Session 5: 水球 pivot：全屏水满 + 贴边水柱
<!-- trellis-session: v=2 fp=528064ee9ba946e6 -->

**Date**: 2026-10-04
**Task**: 水球 pivot：全屏水满 + 贴边水柱
**Branch**: `feat/holo-sphere`

### Summary

holo 全息球太大下掉，收起态回 56 小球：删 holo/ + three + HOLO_VIEW 双形态，去外圈进度环改全屏水满（液位=percent，水色跟 lvl，数字/图标保可读），三层错速波常翻滚（hidden/不可见/reduced-motion 暂停），贴边水渍改竖柱/横槽水柱（几何与 peekHitbox 同源），5 皮肤水体令牌各异。校验通过：uitest 160/160，npm test 全绿（fluid 56/structure 144），变异抽查有牙，shots 29 张。usagePredict.ts 改动排除在提交外另起任务；prototype/ 仅参考不进构建。

### Git Commits

| Hash | Message |
|------|---------|
| `f7fb0d1` | feat(ball): 小圆球全屏水满 + 贴边水柱 |
| `11b3313` | docs(task): 水球 pivot 规划 |

### Status

[OK] **Completed**


## Session 6: 柱内液高为零（诚实水位收口）+ 归档球柱三修
<!-- trellis-session: v=2 fp=029fd747258748dc -->

**Date**: 2026-10-08
**Task**: 柱内液高为零（诚实水位收口）+ 归档球柱三修
**Branch**: `main`

### Summary

收口 petWaterColumn 长期挂着的 fail:empty-fill=0（球里有液面、贴边柱却是空槽）。真因在共享门控而非几何：percent.ts:14 的 windowPercent 在 used=0 && limit>0 时返回 0 而非 null，旧门控 pct!=null 只看算不算得出比例，于是 0% 档也挂了 .fluid-surface，而 fluidLevel(0)=0 → 柱内 fill 高度 0%。修法把数据有无与水位有无拆成两个布尔：hasData（环轨道在）/ showWaves = hasData && fluidLvl>0（挂水 ⟺ 液位>0），.fluid-ring 与 water 口径改挂 hasData，.slosh 仍只随 showWaves；诚实水位断言 fillH>0 一行没动。第一版判错：给 showWaves 加 && pct>0 能转绿但拆掉整圈环（危害不对称——4 款环形态皮水体本就 display:none，原缺陷不可见；环却是它们唯一进度载体）。附带收窄 petWaterColumn 前置条件（balance 在 status!=='ok' 时无 surface，该走空槽支）、补 FIX_ZERO 夹具让真实数据够不到的 0% 分支可被断言覆盖。收尾时一并归档 10-06-column-zero-fill 与 10-06-ball-column-fixes。

### Main Changes

- src/renderer/src/PetBall.tsx：拆 hasData / showWaves，.fluid-ring 与 water 口径改挂 hasData，.slosh 保持只随 showWaves
- src/main/qa/uitest.ts：petWaterColumn 前置收窄为 surface；FIX_ZERO 夹具 + 场景六并进 petRingAlwaysOn；ballProbe 增 ringTrack
- scripts/test-structure.mjs：新增 K8o1（锁 showWaves 由 fluidLvl>0 派生）/ K8p（锁 .fluid-ring 挂 hasData）两个片段级门
- 文档：PRD 六条 AC 勾选 + 真因回填；docs/daily/2026-10-08_column-zero-fill.md；docs/index.md 加行；知识沉淀 docs/knowledge/frontend/petball-mount-conditions.md + 端索引

### Git Commits

| Hash | Message |
|------|---------|
| `348be9e` | fix(pet): 柱内液高为零 —— 拆 hasData/showWaves，0% 是空环不是无环 |

### Testing

- [OK] structure 395/0（+1）、fluid 126/0、dock-hide 155/0、typecheck 0 error、npm test exit 0、build ✓
- [OK] Electron --uitest 160 键 4 fail，全为既有基线（petBallSkinSurface / dragReorder / dragSettles / grpDupCleanup），非回归
- [OK] 验齿：改回 showWaves → structure 394/1 + fail:zero-pct-no-ring；删 fluidLvl>0 → K8o1 红；还原即绿

### Status

[OK] **Completed**

### Next Steps

- 348be9e 及两个 archive commit 尚未 push，待用户确认后推
- 像素级验收遗留：--shots 5n 柱区液色对拍未做，改用 fillH / fillColor / wave 三件套 + K8o1 / K8p 覆盖（日志与 PRD 均已标注）
- 10-04-rain-weather-column / 10-04-skin-fluid-redesign 各剩一条用户人眼动态终验，等实机看后归档
- 补记历史欠账：Session 6 之后的 5fd2b81 / 6a19a04 / 0f70cab / ad28f1d / 4de3412 / e45f374 / 7d9097d 七笔（皮肤 P6 + 球柱三修 + 详情页）没有 journal 条目
- 可选：.trellis/spec/frontend/quality-guidelines.md 补共享门控条目的 spec 层条目


## Session 7: 球体外观四皮（P6 环替水体）+ 环身份色令牌化 + freeze 提权封死
<!-- trellis-session: v=2 fp=71c19be6ee66d236 -->

**Date**: 2026-10-08
**Task**: 球体外观四皮（P6 环替水体）+ 环身份色令牌化 + freeze 提权封死
**Branch**: `main`

### Summary

用户拍板先做四种外观、进度环替代球内水体不共存——两者同时在场等于同一个百分比被画两遍（液位一个数、弧长又一个数），是双重编码。分配：aero 保潮汐水位蓝（唯一编码）、dark 余烬橙刻度圈加粗进度弧、candy 极速双环、minimal 柠檬分段环、ink 保水体（与 aero 同形态不同波性格）。几何全部由原型 112 坐标折半到 56，不重新设计。核心手法是 SVG pathLength=100：circle 上写了之后周长被归一化，stroke-dasharray 的单位变成百分比，于是半径与线宽全留在 CSS 令牌里，TS 里一个几何数字都没有（换皮改半径不动一行 TS）。环必须挂在 .petball-goo 之外——goo 的 stdDeviation=4 会把 2px 的弧 blur 掉，与雨滴和读数是同一取证结论；摆位与 .fluid-disc 一致，因此 hidden/absorbing/revealing 三条既有 [data-fluid] 规则把 .fluid-ring 加进名单就随 disc 收尽回弹，不另写 morph；peek 预览气泡复用同一个 ringSvg，预览要预览的就是本体那张脸。收尾两条是 P6 的 check 查出 P6 自己引入的问题，主会话裁决后在主工作树直接改：一、minimal 环找回柠檬身份色，原状是沉默偏离不是画错颜色，--ring-track 写的是 color-mix(var(--ok) 22%, transparent)，而 minimal 的 --ok 是绿 #1a9e4b，于是 V5 柠檬分段环的三个部件（轨道、分段、弧）全是语义绿，一点身份色不剩；真相源原型 V5 段轨道是 rgba(190,255,60,.22)。口径（用户决定）是轨道与分段走身份色、弧走等级色，同时删掉 .ring-seg 的三条 lvl 覆写——分段是量具的格线不承载 fluidLvl，唯一进度载体是 .ring-arc，否则等级一变这张脸就变。alpha 从原型 0.22/0.35 抬到 0.5/0.7 不是随手调的：minimal 的盘是近白 #f2f2f6，照搬 0.22 会把柠檬混成 rgb(231,245,205) 几乎就是盘面本身；WCAG 对比度在柠檬对近白盘只有 1.07，此处亮度对比度不适用，改换尺子为色相位移（合成后 G-B 级差），原型 0.22/0.35 是 40/66 级读不出来，0.5/0.7 是 96/135 级读得出；分工是弧抢眼、身份环靠色相，这条不能反。candy 也顺手改了同类缺陷，其 --ok 恰好是 #22b573 与原型字面量逐位相同，所以零像素变化，只改它从哪来。二、freeze 停表名单提权封死（行为变更）：原状停表名单 [data-freeze] 是 (0,5,0)，morph 段给同元素挂动画的 [data-edge][data-fluid=absorbing] 族是 (0,6,0)，后者胜出，于是两个属性共存时球体（disc）与环都不停。这比少停一张表严重：运行中的 animation 会盖掉静态 transform，四条定帧 transform（stretch、stretch 纵向、bridge、stain）在这两个相位共存时根本没生效，5i/5j/5k 拍到的是动画中段的 matrix 而不是定帧那一帧——取帧机制本身失效。提权后连带 disc 也真停（用户原话：不只是环）。

### Main Changes

- skin-rings.ts 新增：ringDash 加 RING_DASH_SPACE 纯函数
- PetBall.tsx：新增 ringSvg(lvl, water) 五个 circle，挂 .petball-goo 之外，peek 预览气泡复用同一函数
- skins.css：:root 补全套 --ring-* 与 --water-display/--ring-display 兜底，逐皮肤只覆盖令牌；形态开关驱动 display 不是 opacity（与 K9b 同纪律）
- test-structure：D6 名单加 .fluid-ring，新增 K11a-K11k/K11g2 共 30 条门；test-fluid 用例 9b 弧长口径 12 条
- shots：5c 循环加 5c-form 探针（形态、弧长 dasharray、弧色、半径、三层显隐）

### Git Commits

| Hash | Message |
|------|---------|
| `5fd2b81` | feat(skin): P6 四种皮肤球体外观（环替水体） |
| `6a19a04` | fix(skin): 环身份色令牌化 + freeze 停表提权 |
| `0f70cab` | docs(skin): P6 开发日志与索引 |

### Testing

- [OK] test:structure 终值 302/0（K11 族 30 条等）· test:fluid 125/0 · test:dock-hide 155/0 · 先红后绿加变异验证均跑过

### Status

[OK] **Completed**

### Next Steps

- 环线宽是 demo 的 2 倍（demo stroke-width 8 在 112px = App 4px 在 56px，App 实测 8px），真实差异已问用户，未擅改


## Session 8: 球盘底色还原 + 去雨效（P6-demo 一比一）
<!-- trellis-session: v=2 fp=68061d45b32e7873 -->

**Date**: 2026-10-08
**Task**: 球盘底色还原 + 去雨效（P6-demo 一比一）
**Branch**: `main`

### Summary

用户对照 prototype/skin-applied.html 说 App 里五款皮肤都没有这些效果。定位结论：主因不是立体度，是球盘底色——demo 四款全在暗盘上（V1 深棕、V3 深绿、V5 深橄榄、V6 深蓝），辉光环靠暗底衬托；App 里 candy 是浅紫盘、minimal 是近白盘，同一套环观感完全不同。改动一：dark、candy、minimal 的 --ball-bg 按 demo 逐值抄暗色 radial-gradient，--ball-rim 同步翻成浅色（深盘配浅缘，alpha 至少 0.12，D3c）；candy 与 minimal 由浅盘改暗盘是与原定位相反的视觉变更（用户拍板）；aero 与 ink 底色不动（aero 亮暗跟随是既有契约、ink 保纸色），只给两皮 ::after 加全 inset 立体层。改动二：删掉下雨与两侧流水——.pour-drop/.pour-splash/.pour-trickle/.pour-clip 三件套（JSX 加 CSS 加 keyframes）、POUR_DROPS 表与 PourDrop 类型、pourSurfaceY、--drop-w/--drop-speed/--splash-s（:root 加五皮）、K7c 到 K7f 一族、test-fluid 用例 9、K9h/K9j、5l 取帧加雨探针；倒水入场现在只剩荡漾、冲顶、闪峰。注意 fluid-peek-drop（P4 悬停预览落雨，另一功能）不动。改动三：实拍 5c 五皮与 demo 按 112px 并排存 prototype/p6-compare.png，结论是 dark 差 9、minimal 差 8 基本一样，candy 盘色与半径对但顶部高光偏强（fluid-disc 的 0.85 白斑是水体时代遗留，demo 只有 0.38，不影响语义），aero 不一样但刻意（亮色跟随系统）。已写进注释与日志的不可还原差异：demo 的外投影 0 8px 22px 做不到——56 乘 56 窗口会把外投影裁成方框（D6 纪律，历史 bug 判词）。

### Main Changes

- skins.css：dark/candy/minimal 的 --ball-bg 逐值抄暗色 radial-gradient，--ball-rim 翻浅色；aero/ink 只给 ::after 加全 inset 立体层
- 删下雨与两侧流水：pour 三件套、POUR_DROPS 表、pourSurfaceY、drop/splash 令牌、K7c-K7f、fluid 用例 9、K9h/K9j、5l 取帧加雨探针
- 新增门禁 D3b（三环皮 ball-bg 必须是 radial-gradient）与 D3c（rim 方向），先红后绿

### Git Commits

| Hash | Message |
|------|---------|
| `ad28f1d` | feat(skin): 球盘底色还原 + 去雨效（P6-demo 一比一） |

### Testing

- [OK] test:structure 302 到 304/0（加 D3b/D3c 与 2 条 D6 皮肤级 ::after）· test:fluid 119/0（用例 9 已删）· test:dock-hide 155/0 · typecheck 双工程干净 · npm test EXIT 0 · build 通过 · --shots 全程跑完（无 5l 有 5m）

### Status

[OK] **Completed**

### Next Steps

- 坑位一：minimal 的注释抄成 candy 的 #07180f 而生效是 #0b0f07，复制粘贴残留被 check 抓出，以后逐值抄必须三方比对（原型、注释、生效值）
- 坑位二：D6 ruleBody 整选择器匹配会跳过带 [data-skin…] 前缀的规则，名单类门禁判据若用整选择器相等必须显式列出带前缀变体，否则就是名单缺口


## Session 9: 球柱三修四轮（读数可读 + 柱体全圆 + morph 带底盘）
<!-- trellis-session: v=2 fp=3f4945036c333784 -->

**Date**: 2026-10-08
**Task**: 球柱三修四轮（读数可读 + 柱体全圆 + morph 带底盘）
**Branch**: `main`

### Summary

用户实机报三处回归：一是球内读数在 minimal 和 candy 上不可读，两皮球盘已改暗色但读数仍走 var(--fg)（页面前景色，minimal 是 #111114 近黑、candy 是 #2b1b46 深紫），深字压暗盘，而原型三款环球的读数钉死白色；二是水柱非上下全圆呈尖头；三是球到柱的 morph 底盘无动画，吸入 530ms 关键帧只演 disc、bridge、ring、pill 四层，球本体底盘（--ball-bg 暗色整圆）不在任何 morph 名单，观感是环飞走、黑盘原地淡掉。四轮走完：首轮只补了门禁而像素验收缺失，check 查出 blocker（裸声明删除、浅色值挪进独立 @media light、D3e 拆分）；第二轮像素级四修（B1 dot-provider 空标读空色、B2 fluid-disc 暗盘去多余压暗层、B3 fluid-column-fill 去 border-radius、B4 底盘视觉挪到 ::before）——B4 这步顺带暴露 uitest 里旧断言读的是本体 backgroundColor 而视觉早搬去了 ::before，就是现在基线里 petBallSkinSurface 那条红的根因，属既有缺陷非本轮回归；第三轮 CSS 重做加实拍取证，其间踩了本项目最阴的一个坑：子代理把 CSS 写进了新建的 skills.css（真实拼写是 skins.css，一字之差），并把 scripts/test-structure.mjs 的读取路径改过去，真正的 skins.css 一行未动，结构门禁读的是 app 根本不加载的幻影文件，343/0 的绿灯是假绿灯，修好后加了 16 条门（343 到 360）并实拍取证；第四轮 B5 把 ink 由米色宣纸盘翻成深墨盘（demo v7 追加），漏加进 D3g 暗盘四皮等级色读数让位白字那条循环（当时只列 dark、minimal、candy），于是 ink 深盘上 warn 的 #b07d20 是 5.4:1 可读、danger 的 #a63b2f 只有 3.1:1 低于 4.5 不可读。第五轮四修（e45f374）：C1 minimal 分段与进度弧同起点 12 点；C2 minimal 余额弧在暗盘可见（探针 arcStroke 必须是柠檬不是近黑）；C3 删掉 pour-top 整球外扩——scale(1.07) 乘 56 约等于 60px，每边外扩 2px，圆盘越过窗口被 overflow:hidden 裁成四条平直弦，56 乘 56 的球没有向外呼吸的空间（与 D6 禁外投影同一条约束），冲顶观感由 pour-flash 泡沫闪峰承载，freeze 定帧位移改成不带 scale；C4 ink 球内读数在任何等级下都是白字（夹具强制 70% 才能验到 warn 档，40% 帧是 lvl-ok 验不到这条覆写）。另有一个端点圆点钉在球心的坑是子代理没抓到、主会话实拍抓到的。

### Main Changes

- skins.css：暗盘读数让位白字循环扩到四皮；柱体胶囊化；morph 名单补球盘底盘
- 去掉 pour-top 整球外扩与 freeze 定帧里的 scale，改由 pour-flash 承载冲顶

### Git Commits

| Hash | Message |
|------|---------|
| `4de3412` | fix(skin): 球柱三修：读数可读+柱体全圆+morph带底盘 |
| `e45f374` | fix(skin): 球柱三修第五轮：分段环对齐+余额弧可见+去pour外扩+ink白字 |

### Testing

- [OK] test:structure 342 到 343 到 360 到 388 到 393/0 · test:fluid 126/0 · test:dock-hide 155/0 · typecheck 0 error · npm test 21 子脚本 126/0 · build 通过 · shots 全帧产出
- [OK] PRD 的 AC1 到 AC14 全部勾选，每条注明验法（实拍帧、探针原文、门禁编号）；没验到实测的部分（空槽、低液位、3D 色差量化）明确写的是门禁覆盖而非已实测

### Status

[OK] **Completed**

### Next Steps

- 遗留两项未决未擅改：环线宽是 demo 的 2 倍（真实差异已问用户）；5k 冻结帧的幽灵球（::after 玻璃罩与 .fluid-waves 不在 freeze 名单里，动画被停后回 base，改动前也存在非回归，真实动画里 glass-absorb 会淡到 0，只是 QA 定帧假象用户不可见）
- 坑位：子代理把 CSS 写进未被 import 的 skills.css 并把门禁读取路径改过去，结构门禁读幻影文件，绿灯是假的——门禁必须校验它读的文件真的被 app 加载


## Session 10: 详情页去预计耗尽 + 用量热力图（日历网格 + streak + 逐日明细）
<!-- trellis-session: v=2 fp=f59b28151228e110 -->

**Date**: 2026-10-08
**Task**: 详情页去预计耗尽 + 用量热力图（日历网格 + streak + 逐日明细）
**Branch**: `main`

### Summary

用户两点反馈：预计耗尽没有实际意义去掉；用量趋势柱状图看不出具体使用量，要 GitHub 式热力图加 streak 头。删：usagePredict.ts（算法 326 行）加 test-usage-predict.mjs、详情页区块、设置页用量预测分区、ui:predictOn 与 ui:predictConfig 写入；shared/usage-predict.ts 删掉只被算法用的速率常量，PREDICT_KEYS.on/config 标 legacy（键字符串保留，读侧容忍老用户残留）；App.tsx 的 predict state、extras 读写、回调透传全清，predictConfig 收敛成 historyDays: number，VoiceReminderSection 只剩保留天数一个 NumInput。留：采集链（scheduler 到 usageStore 到 usage:predict 到 useUsageHistory）一字不动，exhaustion 语音触发器与通知阈值不动，sample:usageHistoryDays 权威键不动（老用户历史不被裁）。追加（原不做项转为本轮范围 R7/D7）：历史库补存每日绝对用量（used 加 unit 成对），热力图下方加逐日明细表。四条关键口径，写错就整个功能失真：一是 reset 天 delta 等于 cur——用量不会自己下降，cur 小于 prev 必是换周期，按 cur 减 prev 算会得负数，于是 streak 断、图上是负增量，而实际那天用量很高；二是 null 不补 0 且空格与 1 档必须不同色——拿 0 去减会把没采到读成涨到 50，画成最浅一档会把应用没跑读成那天没用，而这两件事的处置完全不同；三是强度档是相对的（标尺是本轮 active 窗口的 maxDelta），不跨窗口比，绝对阈值会让小额度窗口永远最浅、大窗口永远最深；四是缺失保持缺失，这一条跨三层——主进程写盘时 NaN、Infinity、缺字段一律不写键（不是写 0），主进程读盘时旧采样没有 used 就保持 undefined（不填 0），渲染层 undefined 显示短横线（不是 0.00 美元）。填 0 的具体后果是升级前那几天显示当天用了 0 元，而真实原因是那时还没记绝对量，用户会据此得出我这几天没花钱的错误结论。磁盘 version 保持 1：加两个可选字段是前向兼容的，升到 2 会让所有老文件被判成格式不符被重建。

### Main Changes

- A 预测下线：usagePredict.ts 与 test-usage-predict.mjs 删除，详情页区块与设置页分区移除，predictConfig 收敛成 historyDays
- B 热力图：新增 usageHeatmap.ts 四个纯函数（heatmapOf 差分加 reset 判定、maxDelta 相对标尺、intensityOf 四档、streakOf 连击），TrendChart 外壳与空态纪律不变，新增 TrendHeader 火焰 streak 与 flame icon
- C 颜色只用既有 token，档位用 color-mix 由 --ok 与 --track 派生，不引入新字面量；空格走 --track、1 档含 --ok，两者一眼可分
- D 测试：新增 test-usage-heatmap.mjs 60 断言，usage-store 加 12 条、usage-history 加 8 条，test:usage-history 删掉随柱状图下线的 C/D 段，uitest.ts 的 .trend-bar 改 .trend-cell 加 .trend-head
- E 追加：UsagePoint 与 StoreUsagePoint 加可选 used 加 unit，写盘成对，bucketByDay 的 lastUsed/unit 独立于 pct 判据，heatmapOf 加 deltaUsed 走同一条 reset 口径

### Git Commits

| Hash | Message |
|------|---------|
| `7d9097d` | feat(detail): 去预计耗尽 + 用量热力图（日历网格 + streak + 逐日明细） |

### Testing

- [OK] typecheck 0 error · npm test exit 0 · build 通过 · 新增 38 条断言 · 日历几何用 Node 独立重算（30 天得 5 列 30 格，月份标记在第 0 列 9 月与第 4 列 10 月，每格唯一无越界）

### Status

[OK] **Completed**

### Next Steps

- 当时未跑的两项后续已结案：uitest 因本机 Electron 起不来没跑，后续实机补跑 160 键 4 fail 全为既有基线（.trend-cell/.trend-head 断言绿）；四档深浅当时没看到实际渲出，后续经 CIEDE2000 扫描结案——现状 30/58/84/100 档位 h3 到 h4 最小 deltaE 4.2 到 8.9 属可辨，改等差 25/50/75/100 只会把瓶颈从 h3 到 h4 挪到空到 h1（candy 空到 h1 deltaE 掉到 4.9），非免费收益，口径不改
- 坑位（本会话最贵的一个）：子代理报 13 文件改完、门禁 397/128、全链通过，实际 git status 只有任务目录，它声称创建的 usageHistoryPanel.tsx、dayUsageRecord、renderRangeHeatmap 全仓零命中，连报的文件路径也是编的（DetailPanel.tsx、main/preload.ts、usageHistory.css 均不存在），门禁实测 393/126 是基线。教训已沉淀到 docs/knowledge/agents/subagent-verify.md：每次子代理报完必须 git status 加抽 grep 加跑它报的那几个门禁数字，三样都对上才算数
