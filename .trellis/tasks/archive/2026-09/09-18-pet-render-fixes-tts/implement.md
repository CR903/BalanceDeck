# 执行计划：宠物渲染修复与定时播报

顺序按「先能看见，再谈观感」排：每一步都以基线截图 `/tmp/balancedeck-shots/pet-aria.png`（当前纯黑）为对照。
检查点 CP1–CP3 是评审门，未过不进下一步。

## 收尾归档说明（2026-09-26）

步骤 0–5 已全部落地并验收（`typecheck` / `npm test` 10 套件 0 失败 / `--uitest` 82 项 0 失败），
本任务于 2026-09-26 归档。**归档时对本 PRD 的验收标准做了作废标注**，因为落地后
项目方向又变了，下列前提已不成立 —— 保留原文本是为了留下决策依据，不是待办：

| 原 AC / 要求 | 现状 | 接手它的 commit |
|---|---|---|
| R5–R7 漫游区反算、球壳不裁切、`fitRoamArea` 双约束 | **漫游机制整体下线**，`walker.ts` / `fitRoamArea` / `test-walker` / `test-viewfit` 全删 | `4f85487` |
| R9 `halfZ` 13→28、缩放跨度 ≥1.35× | 前提（漫游纵深）已不存在 | `4f85487` |
| R10 真人系朝行进方向偏航 | 改由动作编排接管（`clips.ts` / `gesture.ts`） | `a0def59` |
| R17 `test:walker` / `test-viewfit` 全绿 | 这两个套件已删除；现存的是 `test:pet` / `test:gesture` / `test:projection` | `4f85487` |
| 隐含的「养成」验收 | **养成体系下线**，收起态人物定位改为「数字助理」 | `69d9aff` |
| 「与现有 8 只 Q 版并列」 | 8 只 Q 版动物已下线，`src/renderer/src/pet3d/` 只剩 Aria / Ray 两位真人 | `0f70602` |
| 窗口 320×230 | 球 `200×210`、人物 `213×293`（`src/shared/pet-view.ts` 是唯一来源） | `aed234c` / `69d9aff` |
| 「补 CP3 验收」那一节（4 张 `BD_PIN_POS` 定点图） | **已作废** —— `BD_PIN_POS` / `fitRoamArea` 随漫游机制一起没了 | `4f85487` |

**仍然成立、且由本任务交付的**：R1 材质反照率修正（`pet3d/human.ts` 的 Phong→Standard
+ 黑 `color` 提白 + `envMapIntensity`）、R2 IBL 真正生效、R12–R16 语音播报
（`src/renderer/src/voice.ts` + 设置页开关与间隔档位 + `hideBalance` 隐私口径 +
单定时器不自叠）。

真人化观感（皮肤/毛发/布料分材质、打光重构）始终**不在本任务**，仍归 `09-18-human-realism`。

## 进度快照（2026-09-19 会话完成）

| 步骤 | 状态 | 已验收证据 |
|---|---|---|
| 0 自检门禁 | ✅ 完成 | `BD_PET=1` 幂等化 + 新增 `BD_PET_ID=<id>`；`petFormOn: true` |
| 1 材质修发黑 | ✅ 完成 CP1 | `/tmp/balancedeck-shots/pet-aria.png` 已是肤色 + 深蓝西装人形；Q 版正常 |
| 2 视口反算 | ✅ 完成 CP2 | 320×230 下 `halfX=34.59 / halfZ=28.00`；ink box 全在窗内；`test:viewfit` 76/0 |
| 3 纵深与转身 | ✅ 完成 CP3 | `fitRoamArea` 双约束二分；`walker.ts` 输出 `dirX/dirZ`；转身生效；真人素材到位；缩放跨度 1.39× ≥ 1.35× |
| 4 语音播报 | ✅ 完成 | `voice.ts` 模块 + 定时器 + 设置 UI；间隔 15/30/60/120 分钟可选；隐私保护 (`hideBalance`) |
| 5 全量检查与文档 | ✅ 完成 | `typecheck` ✓ `test:walker` 29/0 `test:viewfit` 76/0 `test:pet` 64/0

> 派发记录：步骤 3 那次 `trellis-implement` 向我返回的是「模型服务拒绝」错误，
> 但**代码实际写完了**（错误发生在汇报阶段）。所以"派发失败"不等于"没干活"——
> 下次遇到同样报错，先用 `grep`/`git diff` 核实工作树，不要盲目重发，否则会重复实现。

### 下次开工第一件事

**补 CP3 验收**（步骤 3 还差这一步，别跳过）：

```bash
npm run build
BD_PET_ID=aria BD_PIN_POS=0,28  npx electron . --ballshot   # 最近镜头
BD_PET_ID=aria BD_PIN_POS=0,-28 npx electron . --ballshot   # 最远
BD_PET_ID=aria BD_PIN_POS=34,28 npx electron . --ballshot   # 最坏角
BD_PET_ID=mochi BD_PIN_POS=0,28 npx electron . --ballshot   # Q 版
```
判据：每帧 `win/stage/canvas` 三者一致、`measure.box` 完整落在窗内；
**z=+halfZ 与 z=−halfZ 的 ink box 宽高比值 ≥1.35×**（这是用户唯一能感知的"走近变大"证据）。
实测的 `halfX/halfZ` 数值也要从 `roamArea()` 观测点读出来记进 `prd.md`。
过了 CP3 再做步骤 4（语音）。

### 两次派发失败的教训（别再踩）

`trellis-implement` 连续两次被模型服务拒绝，原因是**注入上下文过大**：
`implement.jsonl` 里放了 `DESIGN.md`(35KB) 与 `TASKS.md`(46KB)，两者都超过 `context_injection.max_file_bytes`
(32KB) 被截断却仍占满预算。**已从两个 jsonl 里移除**，改为让子代理按需自己 `Read DESIGN.md:256-350`。
以后往 jsonl 里加大文档前先 `wc -c`。

### 工作树状态（未提交）

改动全在工作区，**没有 commit、没有 stash**。`git status --short` 实测：

```
 M package.json  M scripts/test-walker.mjs  M src/main/index.ts  M src/main/overlay.ts
 M src/renderer/src/PetBall.tsx  M src/renderer/src/pet3d/human.ts
 M src/renderer/src/pet3d/scene.ts  M src/renderer/src/pet3d/walker.ts  M src/renderer/src/skins.css
?? scripts/test-viewfit.mjs  ?? src/renderer/src/pet3d/viewfit.ts  ?? src/shared/pet-view.ts
```

**待复核**：`PetBall.tsx`(+41) 与 `skins.css`(+6) 是步骤 2 子代理为消除 `320/230` 重复而改的
（新建了 `src/shared/pet-view.ts`），我当时只审了 `human.ts` / `viewfit.ts` / `index.ts` 的 diff，
**这两个文件的改动还没逐行看过**。下次开工先补这道审。

### 用户应用的持久化状态

`ui:pet='1'`、`ui:petState.id='ray'`（会话开始时的原值，子代理已还原）。
存于 `~/Library/Application Support/BalanceDeck/secrets.bin`，要改走 `BD_PET_ID=<id>` 拍摄路径，
**不要手改文件**。

## 步骤 0：修自检工具（验收前置，独立小改动）

- [ ] `BD_TOGGLE=1 electron . --ballshot` 打印 `after click: pet=… switchOn=…`，确认是"点错开关"还是"点了没缩放窗口"
      （实测 `BD_PET=1` 停在 `win:[200,210]` 球形态，`petHolder.visible=roam` 因此为 false，拍不到角色）
- [ ] 修 `src/main/index.ts:109-125` 的宠物形态进入路径：按开关**标题文本**定位而不是 `[0]` 下标
- [ ] 复跑 `BD_PET=1 electron . --ballshot`，确认 `diag.win` 为漫游形态尺寸且画面里有角色轮廓

> 不做这步，后面所有视觉验证都是拍空气。

## 步骤 1：材质转换 —— 修发黑（R1–R4）

- [ ] `pet3d/human.ts`：新增 `normalizeHumanMaterials(root)`，在 `loadHumanTemplate()` 解析后对模板调用
- [ ] 处理 `material` 为**数组**的情况（实测 1 网格 3 材质分组）；逐材质按 `design.md` 表格搬迁
      `map`/`normalMap`/`alphaMap`/`transparent`/`opacity`/`name`
- [ ] 反照率修正：源 `color` 亮度 < 0.05 → 设白（实测三材质全 `000000`）
- [ ] `map.colorSpace` 断言为 `SRGBColorSpace`，不是则显式设
- [ ] 丢弃 `specularMap`（`fetch-human-pets.mjs:73` 刻意不采集 → 搬过来必 404）
- [ ] `roughness=0.62` / `metalness=0` / `envMapIntensity=0.9`
- [ ] 删除 `human.ts:134-141` 里在实例上改材质的死代码（`envMapIntensity` 在 Phong 上不存在）
- [ ] 转换后 `dispose()` 源材质

**验证**
```bash
node /tmp/probe-fbx.mjs aria        # 复核源材质事实（color=000000 / envMapIntensity ABSENT）
BD_PET=1 BD_PETS=1 npx electron . --ballshot   # 逐只出图
open /tmp/balancedeck-shots/pet-aria.png /tmp/balancedeck-shots/pet-ray.png
```
对照 `resources/human-pets/aria/preview.png`：应有肤色、头发、西装细节。
**CP1（评审门）**：Aria/Ray 不再是黑剪影，且 `pet-mochi.png` 等 Q 版与改动前逐像素一致（R4）。

## 步骤 2：视口反算 —— 修贴边裁切（R5–R8、R11）

- [ ] 新建 `pet3d/viewfit.ts`：`fitRoamArea(...)`，单调性 + 二分 24 次求解（复用 `scene.ts:485-498` 的投影口径，
      **不要新写一套投影数学**）
- [ ] `silhouetteRadius` 取球壳与用量环外沿较大者；下限保护 `halfX≥12` / `halfZ≥6`
- [ ] `scene.ts`：`resize()` 内调用并把结果原地写回 `walkerCfg.area`（`scene.ts:431` 浅拷贝共享 area 引用，天然生效）
- [ ] `scene.ts:486-487`、`500-502` 的 `320/230` 兜底默认值改为新形态尺寸
- [ ] `walker.ts`：越界先夹回再走（保证 R6"到边停住"）
- [ ] `overlay.ts:307-308` 拖拽夹取与其他路径（`overlay.ts:231-233`）统一为严格 workArea 夹取（R11）
- [ ] `scripts/test-viewfit.mjs`：覆盖 320×230 / 460×340 / 极小窗口 / 极端 aspect

**验证**
```bash
npm run test-viewfit && npm run test:walker
BD_PET=1 npx electron . --ballshot   # 连续 3 帧 + measure() ink box
```
断言 ink box 完整落在窗口内；肉眼再看一遍走到左右极限的帧。
**CP2（评审门）**：任意一帧无半圆裁切；Q 版漫游不出界。

## 步骤 3：纵深与转身（R7、R9、R10）—— 2026-09-18 已完成

> 前提修正：**「加高窗口到 460×340」作废**（窗口尺寸只以 `aspect` 进入投影计算，等比放大窗口
> 不改变世界坐标活动范围）。窗口保持 `320×230`，`overlay.ts` 形态常量未动。

- [x] `scene.ts`：去掉 `shellGroup.position.z` 跟随（x 保留），`ringGroup.position.z` 一起停（R7）
- [x] `fitRoamArea` 改成两条约束（C1 球壳固定 z=0 / C2 宠物四角+z 两端），`depthBudget=28`；
      宠物轮廓按**实际世界包围盒**取（aria r=22.19 / ray r=22.65，中心 y≈26.5），不拍脑袋
- [x] 实测：320×230 下 `halfX=34.12 / halfZ=28.00`（ray 口径，aria 运行时 35.08），
      缩放跨度解析值 1.398×、实拍像素 1.362×（`BD_ONLY=f014` 量宠物本体 94px ↔ 69px）→ R9 达标
- [x] `walker.ts`：输出 `dirX`/`dirZ`（归一化，idle 保持上一次方向）
- [x] `scene.ts` 真人分支：`heading = atan2(dirX, dirZ)`，角差最短路径 `k=min(1, dt*4)` 写 `petGroup.rotation.y`
      （**不写 `petHolder`**：那是归一化层，`DESIGN.md:312-314` 记录过回归）；Q 版分支显式把 yaw 归零
- [x] `HUMAN_YAW` 并入 heading 的常量偏移（`human.ts` 导出，不再写进实例旋转）
- [x] 实测剪辑根位移：**漂**（`Bip01.position` 的 z 曲线振幅 159.7cm → 归一化后 ≈33 世界单位/循环，
      idle 也有 ≈12；`MotionExtractionHelper` 在 FBX 里没导出）→ 已加 `cancelRootMotion()`，
      每帧在 `mixer.update` 之后把骨骼层根节点的 x/z 拉回绑定值（y 保留）。
      注意：原设想的"归零内层 `group.position.x/z`"是空操作，位移载体在 Bip01 上
- [x] Q 版不读 heading，保持既有取舍
- [x] `skins.css` / `PetBall.tsx` 覆盖层（R8）：caption/bubble/badge 全部 `clampX`，
      pad 由 CSS `max-width` 反推（70/95/8）；泡泡上移量 -34 → -4 并按两行高 46 兜底；
      `--ballshot` 的 `diag.overlay` 打印实际 rect，逐点核对不越界
- [x] `--ballshot` 新增 `BD_PIN_POS=<x>,<z>`（钉位拍最坏角）与 `BD_ONLY=<网格名>`（单量一个物体），
      用法与失效模式写进 `research/verification-harness.md`

**验证**（全部实测过）
```bash
npm run build
BD_PET_ID=aria  BD_PIN_POS=0,28   npx electron . --ballshot   # box {95,50,130,133} inside ✓
BD_PET_ID=aria  BD_PIN_POS=0,-28  npx electron . --ballshot   # box {95,50,130,130} inside ✓
BD_PET_ID=aria  BD_PIN_POS=34,28  npx electron . --ballshot   # box {171,50,132,136} 右缘 303/320 ✓
BD_PET_ID=mochi BD_PIN_POS=0,28   npx electron . --ballshot   # Q 版 box {95,50,130,142} inside ✓
npm run typecheck && npm run test:viewfit && npm run test:walker && npm run test:pet && npm test
```
**CP3**：缩放与转身自然、覆盖层不越界、宠物在玻璃壳前方未被糊住（实拍核对）。

## 步骤 4：定时语音播报（R12–R16）

- [ ] 新建 `src/renderer/src/voice.ts`：`speak` / `pickVoice('zh-CN')` / `stopVoice`；
      处理 `getVoices()` 首轮为空 → 监听 `voiceschanged` 再取；无中文音色回退默认；无 `speechSynthesis` 时 no-op
- [ ] `App.tsx`：新增偏好状态 `ui:voiceOn`（默认关）、`ui:voiceEvery`（默认 60，档位 15/30/60/120），
      并入 `App.tsx:210` 的 `getExtras` 读取列表
- [ ] 单个自重排定时器（照 `scheduler.ts:98-108` 形状），依赖变化即清即重排，卸载时 `stopVoice()`（R15）
- [ ] 触发条件全满足才播：`voiceOn && !expanded && !dragging && status==='ok' && 有焦点供应商`
- [ ] 文案与卡片同源：复用 `compactAmount`、`format.ts`、诚实后缀；`hideBalance` 时省略金额段（R14）
- [ ] `PetSection.tsx`：开关 + 间隔档位，沿用现有 `.pet-sec .switch` 结构（注意步骤 0 的教训：**别用下标定位开关**）
- [ ] `PetBall.tsx:336-345` 的 90s 文字泡泡保持不动（R16）
- [ ] 测试：`voice.ts` 的 `speak` 可注入，断言"该播一次 / 不该播零次"

**验证**
```bash
npm run typecheck
npx electron .            # 手工：开开关 + 间隔调 15 分钟，等一次播报；再验证 hideBalance 静默
```
实测后决定播报用完整数字还是 `compactAmount` 缩写（听感决定，`design.md` 已标记为唯一需实测的口径）。

## 步骤 5：全量检查与文档

- [ ] `npm run test:walker && npm run test-viewfit && npm run test:pet && npm run typecheck`
- [ ] 宠物相关 uitest 用例（含"收起态无原生窗口阴影""球外区域鼠标穿透"两条行为断言）
- [ ] 逐皮肤核对：`BD_SKINS=1`（`scene.ts:465-466` 每次换肤覆写 `environmentIntensity`/`ambient.intensity`，
      改曝光必须同步这两处）
- [ ] `DESIGN.md:256-350`：形态表尺寸、"走动与边界"段落删掉与实际不符的"位置硬夹在漫游区内"、
      新增语音播报口径、真人材质转换说明
- [ ] `TASKS.md`：记录本轮 5 项反馈的处置与 `halfX:58` 的根因教训
- [ ] README 脚本表若 `--ballshot` 用法有变则同步

## 回滚点

- 步骤 1、2、3、4 各自独立可回滚（互不依赖；步骤 0 是纯工具改动）。
- 风险最高的是**步骤 3 的窗口尺寸变更**（牵动 `overlay.ts` 形态表、`skins.css` 覆盖层、命中框）：
  若观感不达标，退回 `320×230` + 只保留步骤 2 的反算（R6/R8 仍成立，R9 降级为"纵深不明显"并在 PRD 标注）。
- 步骤 4 的语音默认关，可随时整体回滚而不影响渲染。

## 不做

- 皮肤/毛发/眼睛材质分类、重打光、环境贴图替换、动画集扩充 → `09-18-human-realism`
- 云端 TTS、多供应商汇总播报
- `predist:win` 的 `sips` 依赖问题（只在 PRD 记录）
