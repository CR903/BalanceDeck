# 视觉验证门禁与自检工具实测记录

`--ballshot` 是本项目唯一的 3D 视觉验证手段，但它自己有坑。**踩过的坑都记在这里，避免"我验证过了"其实是拍了空气。**

## 用户原始持久化状态（改动前后必须还原成这个）

| 键 | 原值 | 说明 |
|---|---|---|
| `ui:pet` | `'1'`（桌面宠物形态开） | 证据：会话前 12:20 的 `pet-aria.png`/`pet-ray.png` 是 320×230 漫游形态 |
| `ui:petState.id` | `ray` | 会话开始时当前角色 |

`ui:*` 存在 `~/Library/Application Support/BalanceDeck/secrets.bin`（`keystore.ts:17`，
extras 明文存放），**不要手改这个文件**；要还原就用 `BD_PET_ID=ray BD_PET=1 electron . --ballshot`
走应用自己的写入路径。

## 已修：`BD_PET=1` 非幂等

原实现 `[...document.querySelectorAll('.pet-sec .switch')][0].click()` 是**无条件 toggle**：
`ui:pet` 已经是 `'1'` 的机器上跑一次就把它翻成 `'0'` → 收起成 200×210 球形态 →
`scene.ts:392` 的 `petHolder.visible = roam` 为 false → **拍不到任何角色**。
现在按 `.pet-sec .enable-row` 文本「桌面宠物」定位、仅在未 on 时点一次，并打印 `petFormOn:`。

教训：**自检脚本里凡是 toggle，必须先读状态再决定点不点。** 下标定位同理（该分区还要加开关，必然漂移）。

## 未修（已知限制）：`BD_PETS=1` 逐只拍摄会拍到空画布

实测 `BD_PET=1 BD_PETS=1`：`pet-aria.png` 正常，但 `pet-mochi/shiba/penguin/panda/bunny/koala/tiger.png`
全是 2071 字节的空帧（只有底部翻页点），`pet-fox.png` 甚至是 384×600（展开态尺寸）。
控制台**没有任何报错**（无「宠物模型加载失败」、无 context lost）。

结论：这是**循环内反复 expand→设置页→换角色→收起**造成的时序/上下文问题，不是产品缺陷。
证据：`BD_PET_ID=mochi` 单只拍摄一切正常（`dump` 里 `body`/`tail`/`leg-*` 全 `visible:true`，
画面里灰猫清晰）。

**所以：逐只验证请多次调用 `BD_PET_ID=<id>`，不要用 `BD_PETS=1`。**
`BD_PETS=1` 目前只能当作"最后两只（aria/ray）能出图"的粗筛。

## 新增：`BD_PET_ID=<id>`

`src/main/index.ts` 支持 `BD_PET_ID`，单次换一只角色并打印 `petChipOn: <idx> (want <idx>=<id>)`，
不匹配时打 `⚠ 未切换成功`。宠物形态下拍摄前会等 `petReady`（换角色会重建场景，固定等待会拍到空画布）。

```bash
npm run build && BD_PET_ID=fox npx electron . --ballshot
```

`PET_IDS` 顺序 = `src/shared/pet.ts` 的 `PETS` 顺序：
`mochi shiba penguin fox panda bunny koala tiger aria ray`（下标 0–9）。

## 新增：`BD_PIN_POS=<x>,<z>`（定点拍最坏位置）

`--ballshot` 支持把宠物**钉到指定世界坐标**再拍：走渲染层的 `setPin` 观测点，值会被夹进
当前反算出的可行区，`diag.ball.walker` 可核对是否真钉到位（钉住后 gait 强制 idle、`waitFor` 极大）。

```bash
BD_PET_ID=aria BD_PIN_POS=0,28  npx electron . --ballshot   # 纵深最近的一端（最大）
BD_PET_ID=aria BD_PIN_POS=0,-28 npx electron . --ballshot   # 最远的一端（最小）
BD_PET_ID=aria BD_PIN_POS=34,28 npx electron . --ballshot   # 最坏角：又近又贴右边缘
```

用途：R6/R9 的判据都是"任意可行位置不裁切"，靠随机走撞出来不可靠，定点拍才可复现。

## 新增：`BD_ONLY=<网格名子串>`（只留一个物体）

把场景里名字不匹配的网格全隐藏，`measure.box` 就只剩那个物体的 ink box。
配 `BD_PIN_POS` 才能量出**宠物本体**的透视缩放。

```bash
BD_PET_ID=aria BD_PIN_POS=0,28  BD_ONLY=f014 npx electron . --ballshot   # → 高 94px
BD_PET_ID=aria BD_PIN_POS=0,-28 BD_ONLY=f014 npx electron . --ballshot   # → 高 69px  ⇒ 1.362×
```

`diag.overlay` 会列出每个覆盖层（caption/bubble/badge/toast/center-value）的实际 rect 与窗口尺寸，
R8 的"不越界、不被 `overflow:hidden` 切"直接看这个数组就够，不用肉眼量截图。

## 踩过的坑：这些观测点会**静默**给出错答案

1. **`dump()` 量不到骨骼动画。** three 的 `SkinnedMesh.boundingBox` 是懒算后**缓存**的
   （`Box3.expandByObject` 只在它为 null 时算一次），所以 `dump()` 对蒙皮网格永远报**绑定姿态**的
   盒子。我据此得出过"走路时模型相对 petGroup 不漂（Δz=0.54）"的结论，是错的 ——
   实测剪辑里 `Bip01.position` 的 z 振幅 159.7cm（归一化后 ≈33 世界单位/循环）。
   要量骨骼位移得显式 `computeBoundingBox()` 或用 `Box3.setFromObject(obj, true)`（precise）。
2. **`measure.box` 在宠物形态下被玻璃球壳主导。** 球壳固定 z=0（R7）→ 它的投影尺寸恒定，
   宠物再怎么放大也顶多把 box 下沿推下去几像素。所以"整景 ink box 高 133 vs 130"**不能**当缩放跨度，
   必须 `BD_ONLY` 单独量宠物。
3. **`BD_PIN_POS` 钉住后是 idle 步态**，walk 剪辑根本没播 → `rootMotion` 峰值会偏小；
   要量 walk 的位移得先让它走几秒（不钉或晚点钉）。
4. **zsh 不做无引号变量分词**：`set -- "aria 0,28"` 在 zsh 里只得到 `$1="aria 0,28"`、`$2=""`，
   于是 `BD_PIN_POS` 是空的 —— 表现为"钉位没生效"，其实是命令没拼对。用 `${spec%%:*}` / `${spec#*:}` 拆。
5. **拍到旧 `out/`**：上一次 `npm run build` 被中断过，之后所有截图都是旧代码，
   数字自洽但与实际代码矛盾（`roamArea` 一直是步骤 2 的 34.13×13）。
   怀疑观测点时先 `grep -c <新符号> out/renderer/assets/*.js` 确认产物是新的。
6. 逐只验证仍要用 `BD_PET_ID=<id>` 多次调用，`BD_PETS=1` 会拍空帧（见上一节）。
7. **`npm run uitest` 的宠物段落假设 `ui:pet` 起始是关的**，而 `petSwitch()` 至今还是
   `[...querySelectorAll('.pet-sec .switch')][0].click()` 这种无条件 toggle —— 在 `ui:pet='1'`
   的机器上（就是本任务用户的常态）它第一次点就把形态**关掉**，于是
   `petToggleSaved / petBallOn / petRoamWindow / petStillCollapsed / petBallCenterValue …`
   整片红，看着像步骤 3 改坏了，其实是起始状态不对。
   判据：`BD_USER_DATA=$(mktemp -d) npm run uitest` 全绿（实测 exit 0，含
   `petRoamWindow: ok`、`petNoWindowShadow: ok`、`petPierce: ok`）→ 有这些红就先看起始状态。
   修法与步骤 0 同源（先读状态再决定点不点），属步骤 5 的收尾项。

## 判读 `diag` 的要点

- `win` / `stage` / `canvas` 三者应相等且等于形态尺寸（球 200×210、漫游 320×230、展开 384×600）。
  **尺寸不对就说明形态没切对，这张图不能当证据。**
- `ball.measure.box` = 像素 ink box，`{x,y,width,height}`。**判"有没有被窗口裁切"就看它是否完整落在
  `win` 之内**（步骤 2 的 CP2 判据）。
- `ball.dump[]` 里 `visible` 是**有效可见性**（含祖先链），`self` 是自身 `visible`；
  `visible:false, self:true` = 被祖先隐藏，不是自己关的。
- `petReady` 只表示 `petHolder !== null`——**换角色时它会保留上一只的真值**，所以等待要放在场景重建之后。
