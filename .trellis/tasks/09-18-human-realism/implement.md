# 执行计划：真人化人物材质与光照升级

顺序按「先能看见，再谈观感」：先让材质**有差异**（R1+R2，同一件事），再看打光（R3），
最后补护栏（R6）。R1/R2 绑定 —— 没有 specular 派生图就没有图集内差异。

## 进度快照

| 步 | 内容 | 状态 | 门 |
|---|---|---|---|
| 0 | 实测：拉下 specular 贴图看清楚 + 订正 PRD 过期前提 | ✅ 完成 | 见 `prd.md`「关键发现」与「开工前修订」 |
| 1 | 基线截图（改动前的实拍） | ⬜ | 有可对比的 `before` |
| 2 | `specular-to-roughness.mjs` 纯 JS 转换脚本 + 单测 | ⬜ | 纯函数测试过；生成图有实际方差 |
| 3 | 采集链路放行 specular + 批量生成派生图 | ⬜ | 两只角色各 2 张 `*_rough.png` |
| 4 | `human.ts` 接 `roughnessMap` + 材质级差异化（R1/R2） | ⬜ | 材质不再全等；缺图时退回常数不报错 |
| 5 | `rig.ts` 加 `LIGHT_RIG` + `applyLightRig` 单一入口（R3） | ⬜ | 换肤后打光不回弹 |
| 6 | `test-human-mat.mjs` 三条非主观断言（R6） | ⬜ | 纳入 `npm test` |
| 7 | 走查截图对比 + 逐皮肤一致性 | ⬜ | 主观项交用户确认 |
| 8 | 文档同步（`DESIGN.md` / `TASKS.md`） | ⬜ | 记录体积变化与新素材 |

## 步 1：基线截图

**先拍到"改动前"的实拍**，否则步骤 4 之后没有任何对照。

```bash
npm run build
BD_PET=1 BD_PET_ID=aria  npx electron . --ballshot   # 近景
BD_PET=1 BD_PET_ID=ray   npx electron . --ballshot
BD_SKINS=1              npx electron . --ballshot   # 逐皮肤打光基线
```

> ⚠️ 走查截图是**独立 Electron 进程**，与 uitest 同时跑会争 GPU —— 串行执行。
> ⚠️ 收起后第一帧常是空画布（`cdabc9f` 修过等"合成过一帧"），别把空图当基线。

产物在 `/tmp/balancedeck-shots/`。基线图**提交进仓库的 `docs/`**（现有先例：
`docs/pet-3d.png` / `docs/dot-pet.png`），否则下次没法复现对比。

## 步 2：specular → roughness 转换脚本

- [ ] `scripts/lib/png.mjs`（新增）：纯 JS PNG 读/写。解码走 `zlib.inflate` +
      五种 filter 反算；编码用 filter 0 + `deflate`。**零依赖**
      （先例：`scripts/gen-icons.js`，`TASKS.md` 记着"纯 JS PNG 编码，无外部依赖"）
- [ ] `scripts/specular-to-roughness.mjs`（新增）：
      - 核心导出**纯函数** `specToRoughness(pixel, {lo, hi})`
      - 灰度输出，尺寸默认 1024（粗糙度低频，2048 是浪费）
      - CLI：入参 `f014_body_specular.png` → 出参 `f014_body_rough.png`
- [ ] 拉直窗口 `LO` / `HI`：先跑一次直方图统计（脚本加 `--histogram`）看两张图的
      高光实际分布再定值，**不要拍脑袋定 0.2/0.8**
- [ ] 单测：`specToRoughness` 的边界（`specLum=LO` → 输出 1；`=HI` → 输出 0；
      越界钳制；`lo>=hi` 时退化）
- [ ] 纯 JS 路径与 `sips` 路径的输出尺寸一致性

**门**：`npm run test-human-mat` 的第二条断言（派生图亮度有实际方差）能跑通。

## 步 3：采集链路放行 specular

- [ ] `scripts/fetch-human-pets.mjs:110-112`：过滤条件从 `!/specular|wrinkle/i` 改为
      只排除 `wrinkle`（**实测上游无 wrinkle 文件**，留着是为表达意图）
- [ ] specular **只下 TGA，不走 `sips`**（转换是步 2 的纯 JS 脚本的活）
- [ ] 素材齐后调 `specular-to-roughness.mjs` 批量生成 `f014_{body,head}_rough.png`
- [ ] 记录体积变化（用户已确认接受，但要**记下来**以便日后评估）
- [ ] `meta.json` 随 `readdirSync` 自动更新，确认无需手改

**门**：`resources/human-pets/{aria,ray}/textures/` 各有 2 张 `*_rough.png`，
且能通过 `bd-asset://` 加载（跑一次 `--ballshot` 不报 404）。

## 步 4：`human.ts` 接派生图 + 材质级差异化

- [ ] `toStandard()`（`human.ts:79-111`）：搬迁 FBX 材质上已有的 `specularMap` → 改成
      **加载同名的 `*_rough.png` 作为 `roughnessMap`**
      （不是搬 `specularMap`：Standard 材质没这个属性，见 design）
- [ ] `roughnessMap` 的 `colorSpace` 必须是 **`NoColorSpace`**
      —— 粗糙度是数据不是颜色。这条错了会整体偏亮，是最容易踩的坑
- [ ] 材质级差异化：按分组给不同的 `roughness` 上限（head < body < opacity，
      具体值见 design 表，先用初值再按截图调）
- [ ] `envMapIntensity` 也差异化（现在三个都是 0.9）
- [ ] **缺失兜底**：派生图不存在时退回当前常数 `roughness 0.62`，不抛错
      （老素材 / 转换失败都不能让人物变黑）
- [ ] `metalness` 保持 0（这套素材没有金属，别为了"真实感"乱加）

**门**：`npm test` 全绿；`test-human-mat` 第一、三条断言通过。

## 步 5：打光统一入口

- [ ] `pet3d/rig.ts` 新增 `LIGHT_RIG`（照该文件既有的"唯一来源"风格）
- [ ] `scene.ts` 新增 `applyLightRig(mode)`，写 `key/fill/rim/ambient.intensity/
      environmentIntensity/toneMappingExposure`
- [ ] `applyTokens()`（`scene.ts:520-521`）**删掉**那两行硬写，改调 `applyLightRig`
- [ ] 建场景路径（`scene.ts:191-216`）也走 `applyLightRig`，不再各自赋值
- [ ] 注释里写明**为什么**要单一入口：不这么做的后果是"改的打光只在换肤那一刻生效"
      （`scene.ts:520-521` 就是活证据）

**门**：`BD_SKINS=1` 逐皮肤走查，切换皮肤前后打光**不回弹**（逐张对比截图）。

## 步 6：非主观护栏

- [ ] `scripts/test-human-mat.mjs`（新增）+ `package.json` 挂进 `npm test`
- [ ] 断言 1：三个材质分组的 `roughness` 不全等，且 `head < body`
- [ ] 断言 2：派生 roughness 图的亮度**标准差 > 阈值**（防平铺图）
- [ ] 断言 3：抽样区域粗糙度差（手部区 vs 衬衫区）> 阈值
      —— 抽样坐标在实现时从实际图上量，**必须在注释里写清那个点是手/衬衫/裤/翻领**，
      否则后人看不懂为什么取那里
- [ ] 断言 4：`roughnessMap` 的 `colorSpace` 是 `NoColorSpace`（防上面那个坑复发）

**门**：故意把 `roughness` 改回全等，测试必须失败 —— **自己先验一次测试的有效性**。

## 步 7：走查与逐皮肤一致性

- [ ] `BD_PET=1 BD_PET_ID=aria` / `ray` 出图，与步 1 的基线并排
- [ ] `BD_SKINS=1` 逐皮肤：不存在"只有换肤后才生效"的参数
- [ ] 与素材官方 `preview.png` 并排：脸型、发色、西装配色可辨认
- [ ] **主观项交用户**：实机演示，等用户说"比之前像人"。不接受只看截图代答
      （原 PRD 明确要求，`TASKS.md` 也记着"录屏验证"这轮惯例）

## 步 8：文档

- [ ] `DESIGN.md`：材质段落写三层分工（材质级 / 图集内 / 打光），记录派生图的做法
- [ ] `TASKS.md`：新增一轮；记录**素材体积变化**与 `predist:win` 仍不可用（Q3 决定）
- [ ] `CONTEXT.md`：若引入新词（如「派生粗糙度图」），按词汇表纪律补一条

## 自检命令

```bash
npm run typecheck
npm test                                   # 含新增的 test-human-mat
npm run build
BD_PET=1 BD_PET_ID=aria npx electron . --ballshot
BD_SKINS=1            npx electron . --ballshot
node scripts/specular-to-roughness.mjs --histogram resources/human-pets/aria/textures/f014_body_specular.png
```

## 上下文清单

按需 `Read` 的大文件（**故意不进 jsonl**：超 `context_injection.max_file_bytes` = 32KB
会被截断却仍吃满注入预算 —— 2026-09-19 派发连续失败就是这个原因）：

- `TASKS.md`（50KB）—— 真人助理那轮（2026-09-19）与本轮相关
- `DESIGN.md`（42KB）—— 只需收起态/材质/机位那几节
- `CONTEXT.md`（5.7KB）—— 可进 jsonl，已在 `check.jsonl`

## 已知限制（本轮明确不做）

- `predist:win` 产不出 PNG（`sips` 依赖，Q3 决定不修）。新增的纯 JS 转换脚本
  **无平台依赖**，是唯一能在 Windows 上跑通的那一段
- 面部表情/口型（`morphTargets: 0`）
- wrinkle 细节法线（上游无此文件）
