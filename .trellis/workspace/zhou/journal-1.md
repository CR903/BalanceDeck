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
