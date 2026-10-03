# 技术设计：废除真人相关功能

## 边界

纯删除任务，不新增行为。唯一保留逻辑是老用户迁移（`ui:pet=1` → 环）与 holo 条件分支（three 去留）。

## 删除清单（按层）

1. 渲染层：`src/renderer/src/pet3d/` 整目录；`PetBall.tsx` figure 分支（动态 import 块 `:196-246`、
   人物泡泡/命中投影上报）；`PetSection.tsx` 人物开关与换人 UI。
2. 主进程：`overlay.ts` `petFigure`/`setPetFigure`/`resizeCollapsed` 双尺寸分支 → 恒 `BALL_VIEW`；
   `ipc.ts` 人物菜单项与 `pet:figure` 类通道；`human-assets.ts`（若存在）及 `bd-asset://` 人物目录服务。
3. 共享层：`pet-view.ts` `FIGURE_VIEW`；`shared/types.ts` 人物相关类型（PetId aria/ray 等，核对后删）。
4. 脚本与依赖：`scripts/fetch-human-pets.mjs`；`package.json` `predist` 人物钩子、`three`/`@types/three`；
   `electron.vite.config.ts` three chunk；`resources/human-pets`（gitignored，不删用户本地，只断管线）。
5. 测试：`test:pet`/`test:gesture` 人物动作部分（与 dock/fluid 无关的删；`package.json` 测试链同步）；
   uitest/shots/ballshot 人物键与人物帧。
6. 文档：README/CONTEXT/DESIGN/TASKS 人物章节（CONTEXT 数字助理/动作/静息/就位词条改写）。

## 数据流与兼容

- 启动迁移：读 `ui:pet`，`'1'` → 写回环形态（`'0'`/删除均可，以现有 extras 写模式为准），其余偏好不动。
- `state.json` 无人物字段（尺寸由形态常量推导），无需迁移。
- three 去留开关：先按删除实现；holo Q1 若保留 three，回退 `package.json` + chunk 两处即可（删人物代码不动）。

## 回滚

整任务是删除：回滚 = `git revert` 对应提交。提交时与 dock/fluid 改动分开（独立 commit），
避免不會混入功能代码。
