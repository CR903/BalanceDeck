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
