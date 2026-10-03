# 执行计划：悬浮球贴边自动隐藏

顺序按“先纯函数可测，再主进程状态机，再开关与测试”。

## 进度快照

| 步 | 内容 | 状态 | 门 |
|---|---|---|---|
| 1 | `shared/dock-hide.ts` 纯函数 + 单测 | ✅ | 边沿判定/隐藏偏移/痕迹命中区/角落平局全覆盖 |
| 2 | 主进程 `dockHide.ts` 状态机 + `overlay.ts` 三处接入 | ✅ | 四边隐藏/唤出/取消路径手测通过 |
| 3 | 开关（extras + 设置页 + 右键菜单）+ reduced-motion | ✅ | 关开关即回现行行为 |
| 4 | uitest/shots 断言 + 文档 | ✅ | 新增断言先弄坏验证；走查截图 |
| 5 | 球体 3D 化 + 水满进度（R8/R9，常态可见） | ✅ | 液位==percent 单测；5 皮肤走查 |
| 6 | goo 吸入/汇聚 + 接入 dockHide 状态机 | ✅ | 四边 E2E；reduced-motion 走 slide |
| 7 | 测试与文档（流体） | ✅ | uitest 状态序列 + shots 三帧 + DESIGN/TASKS/CONTEXT |

> 注：步 2 的 slide 位移已实现，转为 reduced-motion 回退路径保留；流体只走全动效路径。

## 步 5：球体 3D 化 + 水满进度

- [ ] 渐变球体（令牌同源）+ 双层波浪 + 液位映射 `src/shared/fluid.ts` 纯函数 + 单测（边界/钳制/整数无抖）。
- [ ] 余额类无波浪；隐藏态暂停波浪；5 皮肤走查截图。
- [ ] 先弄坏验证：液位公式取反能红。

## 步 1：纯函数与单测

- [ ] `src/shared/dock-hide.ts`（新增）：`EDGE_THRESHOLD=8`、`PEEK=4`、`HIDE_DWELL_MS=1000`、
  `REVEAL_DWELL_MS=300`、`REHIDE_MS=1500`；`detectEdge(bounds, workArea)`（角落平局按左/右/上/下）、
  `hiddenBounds(docked, edge)`、`peekHitbox(edge)`（窗口局部坐标）。
- [ ] 单测文件（随仓库既有 `scripts/test-*.mjs` 风格命名，如 `test-dock-hide`）+ `package.json` 挂进 `npm test`。
- [ ] 边界：窗口比工作区大（小屏负区间）→ 不贴边；`Number.isFinite` 全守卫（沿 overlay 既有模式）。

**门**：单测全绿；故意改错阈值/平局顺序能红。

## 步 2：主进程状态机

- [ ] `src/main/dockHide.ts`（新增）：三计时器 + 16ms `easeOutCubic` 动画步进 + 与 `dragTimer` 互斥。
- [ ] `overlay.ts` 接入三处：`dragStop` 尾（收回后判边）、`dragStart` 头（取消一切）、
  显示器重定位处（取消并回正）。隐藏态覆盖 `hitbox` 为痕迹条；恢复后重新采信渲染层上报。
- [ ] `state.json` 读写 `dock` 字段；启动时按当前 `workArea` 重算偏移。

**门**：四边手测 + `BD_DOCK_FAST=1` 下计时器可压缩。

## 步 3：开关与无障碍

- [ ] `extras` `ui:dockHide`（缺省开）+ 设置页“系统”分区开关 + 球右键菜单项（`ipc.ts` 同模型）。
- [ ] `prefers-reduced-motion` 下跳动画、留计时；无 hover 设备点击痕迹唤出。
- [ ] 关闭开关 → 取消计时/动画、滑回全可见、持久化 `hidden=false`。

**门**：关开关后行为与当前主线一致（`git stash` 对比手测）。

## 步 4：测试与文档（slide 基线，已部分完成）

- [ ] uitest 新增：`dockHide`（贴边→隐藏）、`dockReveal`（停留→滑出）、`dockCancel`（拖拽/展开取消隐藏）、
  `dockPassby`（路过不停留不唤出）；每条先弄坏验证。`--shots` 新增贴边/痕迹/唤出三张走查图。
- [ ] `DESIGN.md` 贴边隐藏一节 + `TASKS.md` 一轮 + `CONTEXT.md` 若引入新词（贴边隐藏/痕迹 peek）补词汇。

## 步 6：goo 吸入/汇聚 + 接入状态机

- [ ] `.petball-goo` 容器 + 三元素 + `dock:fluid` 相位通道；morph 与窗口位移串行；morph 期命中并集。
- [ ] `debug:fluid-freeze` 冻结时序供 shots 取帧（复用 `debug:dock-freeze` 模式）；shots 新增拉伸中/桥接中/水渍三帧。
- [ ] uitest 断 `dock:fluid` 状态序列 + 最终 bounds；reduced-motion 下走 slide 旧断言仍绿。

## 步 7：测试与文档（流体）

- [ ] `DESIGN.md` 流体一节 + `TASKS.md` 补一轮 + `CONTEXT.md` 补词（水渍/液位，可选）。
- [ ] 走查：macOS + Windows 透明窗口合成确认；125%/150% 缩放复核 4px 探出。

## 自检命令

```bash
npm run typecheck
npm test
npm run build
BD_DOCK_FAST=1 npx electron . --uitest   # 压缩计时版回归
npx electron . --shots                    # 走查截图
```

## 风险文件 / 回滚点

- `src/main/overlay.ts`（调用点三处，改前记 `git diff`）、`state.json` 结构（只增 `dock` 键）。
- 回滚：删 `dockHide.ts` + 恢复三处调用 + 忽略 `dock` 字段即回现行。
