# 执行计划：废除真人相关功能

顺序按“先断管线（不再拉取/加载），再删代码，最后清测试文档”。

## 进度快照

| 步 | 内容 | 状态 | 门 |
|---|---|---|---|
| 1 | 采集/加载断流（fetch 脚本、predist、动态 import） | ⬜ | 断网也能启动，无人物请求 |
| 2 | 渲染层 + 主进程 + 共享层删除 | ⬜ | `tsc` 绿；窗口恒 56×56 |
| 3 | 依赖与 chunk（three） | ⬜ | 入口体积下降可记录 |
| 4 | 测试链清理 + 文档 + 老用户迁移验证 | ⬜ | 全绿；`ui:pet=1` 进环 |

## 步 1：断流

- [ ] 删 `PetBall.tsx` `./pet3d/scene` 动态 import 块；删 `fetch-human-pets.mjs` 调用与 `predist` 人物钩子。
- [ ] 验证：`BD_PET=1` ballshot 不再有人物分支（应走环或报错收敛，行为记入 PR）。

## 步 2：删代码

- [ ] 删 `pet3d/` 整目录；`overlay.ts` 双尺寸分支恒 `BALL_VIEW`；删 `FIGURE_VIEW`、人物类型、人物菜单/通道。
- [ ] `tsc` 双工程绿。

## 步 3：依赖

- [ ] 删 `three`/`@types/three` + chunk；`npm install` 后 `npm run build` 入口体积记录。
- [ ] holo 条件：若同期 holo Q1 已定保留 three，则跳过本步并在 PRD Risks 落字。

## 步 4：测试文档迁移

- [ ] 测试链：删人物动作用例，保 dock/fluid；uitest/shots 去人物键（每条删除先确认无其他断言依赖）。
- [ ] 文档四件套去人物章节；`ui:pet=1` 老偏好实测进环。
- [ ] `DESIGN.md`/`TASKS.md` 补一轮“人物下线”。

## 自检命令

```bash
npm run typecheck
npm test
npm run build
npx electron . --ballshot
grep -ri "figure\|human\|aria\|ray" src/ scripts/ --include="*.ts" --include="*.tsx" --include="*.mjs" | grep -v test  # 逐条消灭或说明
```

## 风险文件 / 回滚点

- `src/main/overlay.ts`（窗口尺寸逻辑）、`package.json`（依赖/测试链）、测试套件（删用例）。
- 回滚：独立 commit，`git revert` 即可。

## 终检（trellis-check 2026-10-03，结论：通过，附缺口清单）

- 跨层口径：`PetMenuModel.pets` 删除后主进程（`ipc.ts` 现场归一化）/ 渲染层（`App.tsx`
  只给 title/status/开关）/ preload（`petMenu` 唯一通道）一致；`pet:mode` /
  `setPetFigure` / `FIGURE_VIEW` / `shared/pet.ts` 零悬空引用（grep 仅剩
  下线注释、断言名、`humanDur`/`aria-hidden`/`Array`/`tray` 类良性子串）。
- uitest ring-only 键：`petSectionGone`（JSX 无 `pet-sec`）/`petNoFigureDom`
  （4 类零 JSX 命中）/`petUiPetDead`（去注释后 `ui:pet` 零行为引用）机制成立；
  弄坏模拟：重加 `.pet-sec` → 红集恰好 `{petSectionGone, petRingRemoved}`（后者经
  `ringRowGone` 合报）；单加 `.petball-caption` → 红集恰好 `{petNoFigureDom}`。
- 措辞：DESIGN 管线两节已转 `>` 历史引用块（“已随 10-03 下线失效”）+ 现行条目，
  口径准确；`test-alert-orchestration.mjs` L62/L65/L66/L72/L76/L77b 及
  `skins.css` / `PetBall.tsx` / `tts-preset.ts` / `providers.ts` 的“真人形象 /
  角色投影 / 人物窗口 / petGender”残留已顺手清理（本轮 check 修复，断言数不变）。
- 主会话裁决①：**three 按删除合并**（`package.json` + chunk + 素材协议全删；
  本轮另把 `package-lock.json` 与 `package.json` 对齐，lock 内 three 清零）。
  holo-sphere 若转正，另起 planning 把 three 加回（人物管线不加回）。
- 主会话裁决②已知缺口：a) `node_modules/three` + `@types/three` 磁盘残留
  （`--package-lock-only` 不剪枝，下次 `npm install`/`npm ci` 即清掉）；
  b) `--shots` 本轮未跑（shots 人物流程已删，环-only 走查待下次跑）；
  c) `ui:pet=1` 老用户迁移（`primePrefs` 写回 `'0'`）未经真机实测，
  仅有 uitest `petUiPetDead`/`petToggleOff` 形态死键覆盖。
- 全链重验：`typecheck` ✓（双工程零报错）；`npm test` ✓（`&&` 链走完，
  末套件 `test:dock-hide 155/0`、`test:fluid 44/0`）；`npm run build` ✓
  （`out/renderer/assets/` 无 `three-*.js`，入口 477KB；`out/main/index.js` 新鲜）。
- 弄坏验证（红集恰好性）：`test-alert-orchestration.mjs` L62（按钮“好的”→“知道了”）
  红集恰好 1 项（239 通过 / 1 失败）；复位后 240/0 全绿。
