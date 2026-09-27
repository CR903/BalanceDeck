# 执行计划：球形态回到 2D 小圆环

顺序原则：**先让视觉变成小圆环（可验收），再清理死码，最后同步 QA。**
步 1 结束就能交付 —— 步 3/4 只是把不再用的代码与断言收拾干净，
出问题时可以停在步 1+2（留死码比回滚视觉划算）。

## 进度快照

| 步 | 内容 | 状态 | 门 |
|---|---|---|---|
| 0 | 取证：首版规格、现状、QA 面、死码足迹 | ✅ 完成 | 见 `prd.md` / `design.md` |
| 1 | 球形态走 2D 环：尺寸 + 守卫 + 补回环 CSS | ⬜ | 视觉已是 56px 小环，环可见 |
| 2 | 命中区改用 `BALL_VIEW` | ⬜ | 穿透语义不退化 |
| 3 | 死码清理（`scene.ts` / `rig.ts` / `skins.css` / 删 `projection.ts`） | ⬜ | 人物路径零回归 |
| 4 | QA 同步（`uitest` / `ballshot` / `test-projection` / `package.json`） | ⬜ | 10 套件 0 失败；uitest 全绿 |
| 5 | 「显示用量环」在球形态下的行为 | ⬜ | 不是死开关 |
| 6 | 走查截图 + 文档同步 | ⬜ | 主观项交用户确认 |

## 步 1：球形态走 2D 环

- [ ] `src/shared/pet-view.ts`：`BALL_VIEW` 改 `{ width: 56, height: 56 }`，
      注释写清「首版设计（`d5a028e`）；球形态不再有 3D 球」
- [ ] `src/renderer/src/PetBall.tsx`：
  - 3D 场景 effect（`:100-123`）加守卫 `if (!figure) return` —— 球形态不建场景。
    注释写明「不是「建一个空场景」：省显存是硬要求，`createPet3dScene` 会
    无条件 `new THREE.WebGLRenderer`（`scene.ts:151`）」
  - 2D 环的渲染条件从 `failed` 改为 `!figure || failed`（三态见 `design.md` 状态表）。
    **保留 `failed` 分支**：它服务的是人物形态的 WebGL 失败兜底，不是球形态
  - `no3d` 类名：现状 `${failed ? ' no3d' : ''}` 要改成覆盖两种情况
- [ ] `src/renderer/src/skins.css`：
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

- [ ] `src/renderer/src/PetBall.tsx:200-202`：无场景分支的兜底值从
      `FIGURE_VIEW` 改为 `BALL_VIEW`。现状用 `FIGURE_VIEW`（213×293）是个
      **错的默认值**，只因 60×60 在任何窗口里都偏上居中才没暴露
- [ ] 球形态下命中区用「整块窗口」还是「内切圆」？56×56 窗口 + 内切圆（r=28）、
      外加主进程 `pad = 3` → 可点范围 62px。**建议整块窗口**（更宽容，且圆盘本
      就占满 56×56）

**门**：`--uitest` 的 `petPierce`（`hb.width > 20`）与 `dotDom` 仍过。

## 步 3：死码清理

每删一块都要确认没有人物形态的引用。

- [ ] `src/renderer/src/pet3d/scene.ts`：
  - 球几何 `266-391`（126 行：`shell` `rimShell` `edgeShell` `spec` `specSm`
    `band` `ringGroup` `trackRing` `fillMat` `fillMesh` `fillGeo` `capMat`
    `buildFill` `halo`）
  - `applyTokens` 里的球材质 505-517、`levelRgb` + `refreshColors` 525-536
  - `updateHitRect` 球分支 561-567、`step` 的高光漂移 750-754、`ringOn`
  - `dispose` 材质表（`:926`）里 9 个球材质，**只留 `blobMat`**
  - **保留** `shadowFloor` / `blob`（`scene.ts:226-227` 注释：人物形态也用）
- [ ] `src/renderer/src/pet3d/rig.ts`：删 9 个球专属常量
      （`CAM_DISTANCE` `CAM_PITCH` `CAM_Y` `SHELL_EDGE_R` `BAND_R` `BAND_TUBE`
      `RING_R` `RING_TUBE` `RING_HALO_TUBE`）。
      **保留** `BALL_RADIUS` / `BALL_CENTER_Y`（`GROUND_Y` 的输入，人物间接用）
- [ ] `src/renderer/src/pet3d/projection.ts`：**整个删除**
      （`sphereNdcHalf` 唯一运行时消费者是球分支的 `updateHitRect`）
- [ ] `src/renderer/src/skins.css`：删
  - `.petball-center-value` 4 条（1489-1510，球形态专属）
  - `.petball.hover .petball-stage` 缩放（1581-1589，注释自承「球体本身由 WebGL 画」）
  - `@keyframes petball-pop`（1604-1615，**全项目零 `animation` 引用，已经是死码**）
- [ ] `FORMS.ball` 保留但只留 `ball: true`，**注释写明「语义已死，故意保留」**
      （删它要连锁改 `PetForm` 联合 + `Record` 穷尽 + 三个文件的类型签名，不划算）

**门**：`npm run typecheck` 干净；`--uitest` 的**人物形态**断言（`petModel`
`pet3dCanvas` `petFigureBig` `petGesturePool` `petStride` `petFigureOnly`）
与步 4 之前一致。

## 步 4：QA 同步（本任务最大的工作量面）

- [ ] `src/main/qa/uitest.ts`：
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
- [ ] `src/main/qa/ballshot.ts`：`BD_ONLY` / `BD_ISOLATE` / `BD_DEBUG_RING`
      依赖 `__bd_ball().dump`，球形态无场景 → **明确标为「仅人物形态有效」**，
      并在球形态下**打印一行说明**而不是静默无效（静默失效的 env 是最坏的形态）。
      `BD_SETTINGS` 的 `petInfo:` 打印同理
- [ ] `scripts/test-projection.mjs` **整个删除**（§1/§2/§3 全依赖球几何或
      `projection.ts`）+ `package.json` 去掉 `test:projection` 及其在 `test` 链里的位置
- [ ] `scripts/test-structure.mjs`：`ballshot.ts` 被 B4 闭集钉住，文件不能删。
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

- [ ] `PetBall.tsx` 的 2D 环 JSX：`{showRing && pct != null && (<circle className="dot-ring-fill" …/>)}`
- [ ] `--uitest` 加一条断言：切 `ui:petRing=0` 后球形态下 `.dot-ring-fill` 消失、
      `.dot-ring-track` 仍在
- [ ] 按纪律**先弄坏它一次**确认新断言会红

## 步 6：走查与文档

- [ ] `BD_USER_DATA=<临时目录> npx electron . --ballshot` 拍球形态（不带 `BD_PET`）
- [ ] `BD_PET=1 BD_PET_ID=aria|ray` 拍人物形态，确认**零回归**
- [ ] 逐皮肤 `BD_SKINS=1` —— 2D 环靠 `--dot-rim` / `--dot-bottom` / `--track` /
      `--ok` 等令牌上色，逐皮肤必须都对
- [ ] `DESIGN.md` 收起态章节改写（原描述是「3D 悬浮球」）
- [ ] `TASKS.md` 记一轮；`CONTEXT.md` 若「形态」词条提到球体则同步
- [ ] 走查基线/结果图存 `docs/baseline/`（沿用 human-realism 步 1 的做法）

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
