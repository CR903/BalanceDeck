# 执行计划：小圆球全屏水满

顺序按“先删 holo 回干净，再做水满，最后水柱与测试”。

## 进度快照

| 步 | 内容 | 状态 | 门 |
|---|---|---|---|
| 0 | holo 删除（目录/依赖/双形态/测试/令牌） | ✅ | grep 零残留；双工程绿 |
| 1 | 去外圈环 + 全屏水体 + `lvl` 水色 | ✅ | 液位==percent；非颜色唯一通道 |
| 2 | 三层波浪真实化 + 常翻滚 | ✅（check 修了 B 层无缝：drift-b 28→36px，见下） | 藏起/不可见/reduced-motion 暂停 |
| 3 | 贴边水柱（竖柱/横槽 + 柱顶波浪） | ✅ | 命中区与 `peekHitbox` 同源 |
| 4 | 5 皮肤水体令牌 | ✅ | 5 皮肤走查各异 |
| 5 | 测试与文档 | ✅（check 后补：K2d + uitest 归位守卫） | 新增断言先弄坏验证 |

## check 复核记录（2026-10-04 trellis-check）

- `npm run typecheck` ✅；`npm test` 全绿 ✅（test-fluid 56、structure 144 即 K 门 27）。
- 变异抽查（均还原重绿）：`waterColumn` 改坏→2 红；K4 CSS 改 5px→1 红；
  K2d 值改坏/整块删除→各 1 红（无跨界空洞通过）。
- 修 bug：`fluid-drift-b` 位移 28px ≠ 波长 36（2s 一跳），改 -36px；
  新增 K2d（位移=波长整数倍，按块切片）；DESIGN/TASKS 数字按实现更正。
- 修 uitest 幂等：routine 段加"先归位"守卫（复用 vrsPowerOn 模式；旧土 `/tmp/bd-uitest-check`
  残留 `ui:ttsRoutine='1'` 曾让 Routine* 3 红，与水无关）。
- uitest（`BD_DOCK_FAST=1`）：水键全绿（见 TASKS 验证节）；160 键首轮 157/160，
  3 红全在 Routine*（旧 userData 残留所致，与水无关），加归位守卫后**新目录重跑 160/160 全绿**。
- `--shots` 已补跑：5-ball×3 帧 + 5 皮肤（5c-ball-*）+ 隐藏/唤出/流体帧齐全，
  解码确认逐皮肤各异（dark 深盘 / candy 粉 / ink 米 / minimal 浅灰 / aero 默认）。
- `src/renderer/src/usagePredict.ts` 非本任务改动（预测重置判定，无单测覆盖但经
  DetailView 已上线）：**排除在本次提交之外**，另起任务补 PRD+测试，或 revert。
- implement 遗留 `--shots` 待补跑（5 皮肤 × 常态/水柱出图）。

## 步 0：holo 删除

- [ ] 删 `src/renderer/src/holo/`、`scripts/test-holo.mjs`；`package.json` 去 three 系；
  chunk 配置还原；`pet-view.ts`/`overlay.ts`/`PetBall.tsx` 回单形态。
- [ ] uitest/shots/ballshot 去 holo 键帧；`skins.css` 去 `--holo-*`。
- [ ] `grep -ri "holo\|three" src/ scripts/` 逐条消灭或书面说明。

**门**：残留 grep 干净；`npm run typecheck`、`npm test` 绿。

## 步 1：水满主体

- [ ] 删 `dot-ring` SVG + 环色规则；球盘内全屏水体（clip 圆 + 液位矩形 + 波浪层位）。
- [ ] 水色按 `lvl-*` 类走渐变；读数/角标保留；`!isPlan`/`pct==null` 画静水素盘。
- [ ] 液位映射沿用 `fluidLevel`，先弄坏验证（公式取反能红）。

**门**：液位与百分比逐位一致；余额类无假水位。

## 步 2：波浪

- [ ] 三层错速波 + 液面高光线；CSS 位移循环（不逐帧重算 `d`）。
- [ ] 暂停三条件：`hidden` / `document.hidden` / reduced-motion。

**门**：常态肉眼可见翻滚；三条件逐个验证暂停。

## 步 3：水柱

- [ ] 隐藏态渲染改为水柱（竖柱/横槽 + 柱顶波浪 + `lvl` 水色），几何与计时沿用 dock-hide。
- [ ] `debug` 取帧钩子沿用 `__bd_fluid_freeze`（如需新增帧先确认旧钩子不够用）。

**门**：四边水柱走查；痕迹点击唤出可用。

## 步 4：皮肤

- [ ] 新增水体令牌 + 5 皮肤调色 + `:root` 兜底。

**门**：5 皮肤走查截图各异。

## 步 5：测试与文档

- [ ] 单测：液位/水柱几何（沿用 `test-fluid`/`test-dock-hide`，新增用例先弄坏验证）。
- [ ] uitest：水满液位/水色/`lvl`同步/水柱唤出/reduced-motion 静态；shots 5 皮肤 × 常态/水柱。
- [ ] `DESIGN.md`/`TASKS.md`/`CONTEXT.md`（水满/水柱词条）补一轮。

## 自检命令

```bash
npm run typecheck
npm test
npm run build
npx electron . --ballshot
BD_DOCK_FAST=1 npx electron . --uitest
npx electron . --shots
```

## 风险文件 / 回滚点

- `PetBall.tsx`（主渲染）、`skins.css`（水体样式）、`shared/pet-view.ts`、`overlay.ts`。
- holo 删除与水满分两个 commit，可分别 revert。
