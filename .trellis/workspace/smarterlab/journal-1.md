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
