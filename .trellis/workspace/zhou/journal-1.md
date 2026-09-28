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
