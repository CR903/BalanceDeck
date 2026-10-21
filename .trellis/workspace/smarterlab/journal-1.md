# Journal - smarterlab (Part 1)

> AI development session journal
> Started: 2026-09-18

---

## 2026-09-18 · 宠物渲染修复与定时播报（`09-18-pet-render-fixes-tts`，会话中断在 CP3 前）

用户反馈 5 项：人物 3D 发黑 / 想要真人化 / 没有定时播报 / 悬浮球走到边缘变半圆 / 走近没有变大。
拆成两个任务：本任务（1/3/4/5）+ `09-18-human-realism`（真人化，路线已定为"升级现有 3D 材质光照"）。

**根因全部实测确认，没有一条靠猜**：

- 发黑 = FBXLoader 把 Rocketbox 的 `DiffuseColor` factor（黑）写进 `material.color`，
  而漫反射是 `color × map.rgb` → 纯黑剪影。**与打光无关**，调灯调曝光全是白费。
  附带发现：`mesh.material` 是**长度 3 的数组**，原 `human.ts:139-140` 既没遍历数组、
  又在 Phong 材质上写它根本不存在的 `envMapIntensity` → 双重静默失效，`RoomEnvironment` IBL 从未生效。
  诊断脚本 `node /tmp/probe-fbx.mjs <aria|ray>`（10 秒、零 Electron）；
  排除掉的假设清单在 `research/fbx-material-probe.md`。
- 半圆 = `walker.ts` 的 `halfX:58` 是硬编码世界常量，与视口无函数关系。
- 不放大 = `halfZ:13` 太浅（仅 1.17×），且 `facing` 算了从没被 `scene.ts` 读（死值）。
- 没播报 = `src/` 里 `speechSynthesis` 0 命中，那个"90s 余额泡泡"是一次性 `setTimeout`。

**已完成**：步骤 0（自检门禁幂等化 + `BD_PET_ID` + `BD_PIN_POS`）、步骤 1（材质转 Standard + 反照率修正，
CP1 过：Aria 有肤色与西装配色）、步骤 2（`pet3d/viewfit.ts` 二分反算，CP2 过：`halfX` 58→34.13，ink box 全在窗内）、
步骤 3 代码（球壳停 z=0 + `shell/body` 双约束 + `dirX/dirZ` 偏航，测试全绿，实拍到 Ray 背面朝向）。

**两处方案被实测推翻，都记进了 PRD 决策表**：

1. 「加高窗口换纵深」无效——`viewfit` 里窗口尺寸只以 `aspect` 进入计算，NDC 与像素分辨率无关，
   等比放大不改变世界边界；460×340 的 aspect 更小反而让 `halfX` 缩到 32.2。
   改为「球壳只跟 x 不跟 z、人从球里朝镜头走出来」（D4'）。
2. 「丢弃 specularMap 消除 404」不成立——404 发生在 FBXLoader 解析期，且 `MeshStandardMaterial`
   没有 `specularMap` 属性。R3 已改写为非目标。

**教训（会复发，写死在这里）**：

- `trellis-implement` 返回「模型服务拒绝」**不等于没干活**——步骤 3 那次代码全写完了，错在汇报阶段。
  遇到该报错先 `git diff` / `grep` 核实工作树，盲目重发会重复实现。
- 拒绝的真因是**注入上下文过大**：`implement.jsonl` 放了 `DESIGN.md`(35KB) + `TASKS.md`(46KB)，
  两者都超 `context_injection.max_file_bytes`(32KB) 被截断却仍吃满预算。已移除，改为让子代理按需
  `Read DESIGN.md:256-350`。往 jsonl 加大文档前先 `wc -c`。
- 自检脚本里凡是 toggle 必须先读状态再决定点不点；下标定位（`.switch[0]`）在会加分区的页面上必然漂移。
- Bash 工作目录跨命令保留，`cd resources/...` 会让后续相对路径全错。

**下次接手的断点**：见 `implement.md` 顶部「进度快照」——先补 CP3（4 张 `BD_PIN_POS` 定点图 +
量 z=±halfZ 的 ink box 宽高比 ≥1.35×），再做步骤 4（语音）与步骤 5（文档）。
`PetBall.tsx`(+41) 与 `skins.css`(+6) 是子代理为消除 `320/230` 重复而改的，**还没逐行审过**。
所有改动仍在工作区未提交；用户应用状态已还原为 `ui:pet='1'` / `id='ray'`。


## Session 1: 展开面板滚动条归零 + 托盘左键展开定位
<!-- trellis-session: v=2 fp=c057fa1af3f8dbb4 -->

**Date**: 2026-10-13
**Task**: 展开面板滚动条归零 + 托盘左键展开定位
**Branch**: `main`

### Summary

用户报「2K 屏没滚动条」，实测定性为所有屏都在溢出：.isl-body.open 的 overflow-y:auto 让横轴的 visible 被算成 auto，氛围辉光伪元素 inset -8px -16px 向外扩的 16/8px 成了可滚动溢出（435/419、245/237）。根修收回 inset 0（blur 的绘制外溢不计入滚动量，辉光不丢），另加 overflow-x: hidden 裁长图例名的结构性溢出；收起态不动。托盘左键改走 expandIslandPanelFromTray()，落位屏幕顶部居中紧贴菜单栏下沿，再点隐藏，右键菜单不变；跨层推送用单调序号 + 常驻 App 订阅转发 prop，避免岛挂载卸载吞掉意图。验证：typecheck 通过、npm test 全绿、L10 守卫改坏过一次确认会红、浏览器实测 sw==cw 且 18 卡超高仅纵滚。spec 沉淀两条（辉光不许外扩出滚动容器、间歇挂载组件不得持有主进程推送订阅）。

### Git Commits

| Hash | Message |
|------|---------|
| `8f526ae` | fix(island): 展开面板溢出归零 + 托盘左键展开定位 |
| `7d35da9` | chore(task): add 10-13-island-open-overflow-and-tray-expand |
| `77e098f` | docs: 添加 10-13 开发日志与索引 |

### Status

[OK] **Completed**



## Session 3: 系统通知自验通路（测试按钮 + 发起≠已显示）
<!-- trellis-session: v=2 fp=274cc403f75906b6 -->

**Date**: 2026-10-21
**Task**: 系统通知自验通路（测试按钮 + 发起≠已显示）
**Branch**: `main`

### Summary

80% 未提醒排查实锤 macOS 权限层吞弹 + OpenCode Go 额度核查，实现测试通知自验通路

### Main Changes

### 摘要

用户报「昨天 80% 未提醒」，排查实锤：提醒逻辑正确（判定单测 73 全绿、ui:notifyOn=1、落盘配置全对、当天 15:58 本月窗口 80.5% 越线应有告警），根因在 macOS 权限层 —— ncprefs flags 缺 bit28（「允许通知」位，macOS 15.7.7 实测；旧解码 bit25 已过时；对比微信 276832270 vs 本应用 8396814）。Electron Notification 权限被关时静默成功、无应用内探测 API，锁存记「弹过」整天不重试。顺带核查 OpenCode Go 额度：按模型给月度额度，多数 $60；DeepSeek V4.1 Flash 近期 $60→$80（单模型调整，非整体提额）。

### 改动

- 测试通知按钮走真实链路（App.tsx:935 notifyShow + systemNotify.ts:247 testNotifyPayload 纯函数），不受 notifyOn 约束
- VoiceReminderSection E 区：按钮/反馈条/常驻引导置于 {notifyOn && …} 之外
- test-system-notify J 区 12 条 + uitest 两断言（notifyOn=off 状态下断言）；check 自修 2 处（全文正则断言被无关调用点喂绿→函数切片 J11 守卫；vrs-notify-test-note.ok 同族 CSS 缺失）

### 测试

typecheck 0 error；npm test 24 套件全绿（J 区 12 条）；--uitest 174 断言 0 失败；J 区变异验证有牙（内联→红→还原→绿）。

### 下一步

用户点系统设置 → 通知 → BalanceDeck 打开「允许通知」，再用新加的测试按钮自验。spec 沉淀 2 条（quality 切片守卫法；component 通知静默成功 gotcha），knowledge 沉淀 1 条（归因四步法 + bit28 取证），近期将按 knowlog 新规迁移复核。


### Git Commits

| Hash | Message |
|------|---------|
| `109cfdc` | feat(notify): 系统通知自验通路——测试按钮走真实链路 + 「发起≠已显示」引导 |

### Status

[OK] **Completed**
