# 球形态回到 2D 小圆环

## Goal

未开启「个性人物」时，收起态不再用 3D 球（玻璃球壳 + 装饰带 + 管状用量环 + 底座），
改回**首版设计的 2D 小圆环**：56×56 窗口、SVG 环、中心显示额度或百分比。
球形态**不创建 WebGL 上下文**。

用户价值：默认状态下桌面只有一个安静的 56px 小环，不占显存、不加载任何 3D 资源，
视觉上就是「一个数」，而不是一个需要读懂仪表的球。要看人时才开个性人物。

## 用户原话（2026-09-27）

> 「若未开启个性任务，圆球悬浮不要现在的圆形背景展示和底座，改成最初悬浮效果(小圆环)，
> 中间显示额度或百分比」

已确认口径：**彻底回到 2D**（不是「保留 3D 球只去装饰」）。

## 首版规格（从 `d5a028e` 取回，非凭记忆）

| 项 | 首版值 | 证据 |
|---|---|---|
| 窗口 | 56×56 | `d5a028e:src/main/overlay.ts:9` `const COLLAPSED = { width: 56, height: 56 }` |
| 组件 | `CollapsedDot.tsx`，纯 SVG | `d5a028e:src/renderer/src/CollapsedDot.tsx` |
| 环 | `viewBox="0 0 56 56"`，`r=22`，`strokeWidth=5` | 同上 `:129-160` |
| 中心 | `.dot-value`，`max-width:42px` + ellipsis | 同上 + `d5a028e:skins.css:1418-1430` |
| 轮播 | 5s，按 `severity()` 排序 | 同上 `:70-73` |
| 拖拽阈值 | 8px | 同上 `:82` |
| 圆形背景 | `border-radius:50%` + `var(--bg)` + `backdrop-filter` | `d5a028e:skins.css:1376-1390` |

**首版 CSS 完整可取回**（`d5a028e:src/renderer/src/skins.css:1376-1466`），
本任务直接复用，不重新设计。

## 现状（2026-09-27 实测）

| 项 | 现状 |
|---|---|
| 窗口 | `BALL_VIEW = {200, 210}`（`src/shared/pet-view.ts:11`） |
| 实现 | three.js：玻璃球壳 + 暗边 + 高光 + 装饰带 + 管状进度环 + 光晕 + 底座 |
| 代码占比 | `scene.ts` 球专属 **173/948 ≈ 18%**；`rig.ts` 9 个常量变死码 |
| 窗口/命中 | `overlay.ts:16` 直接用 `BALL_VIEW`；命中区由场景上报（`scene.ts:561-567`） |

## Requirements

- **R1**：球形态窗口 **56×56**，视觉为 2D 小圆环（圆形背景 + 环 + 中心读数），
  **不创建 WebGL 上下文**（`createPet3dScene` 在球形态下不调用）。
  人格形态 213×293 **完全不变**。
- **R2**：**复用现有 2D 兜底路径**（`PetBall.tsx:441-462` 的 `.petball-fallback`），
  把它从「仅 WebGL 失败时」提升为「球形态的正常呈现」。不复用 `d5a028e` 的
  `CollapsedDot.tsx` —— 那份逻辑已在 `PetBall.tsx` 里重新长了一遍。
- **R3**：**补回缺失的环 CSS**。`.dot-ring-track` / `.dot-ring-fill` 目前
  **全项目零规则**，且两个 `<circle>` 都没写 `stroke` 属性 →
  **现在 WebGL 失败时环是隐形的**（默认 `stroke: none`），只有 CSS 圆盘和文字可见。
  补 `d5a028e:skins.css:1401-1416` 的规则。
  顺带修掉几何不一致：`.petball-fallback` 是 60×60 而 SVG `viewBox` 是 56（`skins.css:1691`）。
- **R4**：**清理球形态的 3D 死码**：`scene.ts` 的球专属几何与逻辑、`rig.ts` 的
  9 个球专属常量、`FORMS.ball`。保留两个「地面」物体（`shadowFloor` / `blob`）——
  它们属于人物形态（`scene.ts:226-227` 的注释说明）。
- **R5**：命中区：球形态改为**窗口正中 56×56 整块**（现在 `.petball-fallback`
  硬编码 60×60，`PetBall.tsx:200-202`）。注意 `overlay.ts:384` 有 `pad = 3`
  的外扩，56px + 3px 仍在可点范围内。**保留穿透语义**：窗口其余区域不接收鼠标。
- **R6**：**QA 同步**（这是本任务最大工作量面）：
  - `uitest.ts`：`petBallWindow`（用常量，OK）、`petBall3d`（**必须反转**：
    球形态应当**没有** canvas）、`ball3d`（`uitest.ts:106` **必须删**）、
    `petBallCenterValue`（改为断言 2D 环）、`petCenterValue`（figure 下断言
    `.petball-center-value` 不存在 —— 新结构下要重新确认）、`petFigureOnly`
    （**会变成永真**，正则 `Sphere|Torus|Tube` 删干净后不可能匹配 → 必须重写
    或删除，否则是假护栏）、`petBallNoBubble`（保持）
  - `ballshot.ts`：`BD_ONLY` / `BD_ISOLATE` / `BD_DEBUG_RING` 三个 env 全部依赖
    `window.__bd_ball().dump`（场景），球形态无场景 → **要么删、要么降级为人物形态专用**。
    `BD_SETTINGS` 的 `petInfo:` 打印同理。
  - `test-projection.mjs`：§2、§3 是球专属（用 `rig.BALL_*` 与 200×210 窗口）→
    随球形态删除。§1 是 `sphereNdcHalf` 纯数学，与形态无关，保留。
  - `test-structure.mjs`：`ballshot.ts` 被 B4 闭集断言钉住 —— **文件不能删**，
    只能改内容。
- **R7**：**不留假护栏**。`petFigureOnly` 这类「正则再也匹配不到所以恒过」的断言，
  必须重写成能真正证明问题的那一条，而不是留着绿。
- **R8**：无回归 —— `typecheck` / `npm test`（10 套件）/ `--uitest` 全绿。
  **注意**：`--uitest` 当前**不隔离 userData**（只重定向了 autostart 目录），
  会继承开发者真实偏好导致假失败。验收时必须用 `BD_USER_DATA=<临时目录>`。
- **R9**：不引入新依赖；不新增设置项（不保留「切回 3D 球」的开关）。

## Acceptance criteria

- [ ] 关闭个性人物时窗口为 **56×56**，视觉是 2D 小圆环，中心显示额度或百分比
- [ ] 关闭个性人物时**页面里没有 `<canvas class="pet3d-canvas">`**（可断言）
- [ ] 环**可见**（补回 `stroke` 规则；这是修一个已存在的 bug，不是新功能）
- [ ] 悬停变色跟随严重度（`lvl-ok/warn/danger/muted` 四档）
- [ ] 单击展开、拖动移动（阈值 8px）、右键菜单三项交互不退化
- [ ] 点击穿透仍然生效：小环以外的窗口区域不接收鼠标
- [ ] 打开个性人物时窗口回到 **213×293**、3D 场景正常、动作编排不受影响
- [ ] 两形态之间来回切换不残留画布 / 不泄漏 WebGL 上下文
- [ ] `npm test` 全绿；`test-projection.mjs` 不再有球专属断言
- [ ] `--uitest` 在 `BD_USER_DATA=<临时目录>` 下全绿
- [ ] `scene.ts` / `rig.ts` / `skins.css` 里的球形态死码已清，且
      `test-structure.mjs` 的静态断言仍成立

## Out of scope

- 人物形态的任何改动（213×293、材质、动作编排、打光 —— 那是 `09-18-human-realism`）
- 保留 3D 球作为可选项（用户明确不要）
- 修 `--uitest` 的 userData 隔离（R8 只要求**验收时**绕开；隔离本身单独立项）
- 收拾 `skins.css` 里那 262 行指向已删除 SVG 精灵的死 CSS（与本任务无关，
  已在 `00-bootstrap-guidelines` 的 spec 里记录）

## 依赖与顺序

- **本任务先做**，`09-18-human-realism` 随后。两者共享 `PetBall.tsx`、
  `pet-view.ts`、`rig.ts` —— 并行会撞车。
- 本任务**不依赖** human-realism 的任何产物；反过来 human-realism 会依赖本任务
  定下来的形态契约（窗口尺寸、`.petball-*` CSS 的存留范围）。
- 因此 human-realism 的 R4（「实际像素尺寸」）在两者的尺寸契约确定前**不要**开始验证。
