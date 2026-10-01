# Implement: P1-3 托盘颜色阈值 + 状态点角标

## Ordered Checklist

### Phase 1: 共享分级模块 shared/levels.ts

- [ ] **1.1** 新建 `src/shared/levels.ts`：`Level` 类型 + `levelOfPercent`（**从 `renderer/format.ts:58` 原样搬**，不改任何阈值）
- [ ] **1.2** 加 `ansiColor(level)`：`danger`→`\x1b[31m`、`warn`→`\x1b[33m`、`muted`→`\x1b[90m`、`ok`→**空串**
- [ ] **1.3** `renderer/format.ts` 改为 `export { levelOfPercent, type Level } from '../../shared/levels'`
  - ⚠ **调用点零改动**：`CardView.tsx:11`、`DetailView.tsx:18`、`read-model.ts:2` 一行都不动
  - ⚠ 确认 `format.ts` 自己内部没有继续引用本地定义（它导出给三方，也要自己用）
- [ ] **1.4** 确认 `src/shared/levels.ts` 不含 electron / DOM 引用（能被 `loadTs` 在纯 node 加载）

### Phase 2: 托盘标题 ANSI

- [ ] **2.1** `src/shared/tray-text.ts`：`trayTitle()` 内部对百分比片段包 `ansiColor(level)`
  - ⚠ **文案结构与措辞逐字不变**（`>` 分隔、`⚠` 前缀、数字格式），只在片段两端加转义
  - ⚠ Windows（无 `setTitle`）路径不走 ANSI —— 由 `tray.ts` 决定要不要 strip，见 3.2
- [ ] **2.2** 加 `stripAnsi(s)` 导出（供测试与 `--uitest` 剥转义后比对文案）

### Phase 3: 图标灰度分层

- [ ] **3.1** 新建 `src/main/tray-badge.ts`：`BadgeShape` + `badgeOf(level)` 纯函数
  - `danger`→`solid-large` / `warn`→`translucent` / `muted`→`hollow-small` / `ok`→`none`
- [ ] **3.2** `src/main/tray.ts`：把 `badgeOf` 的形状叠加到现有图标栅格化结果上
  - ⚠ macOS 仍 `setTemplateImage(true)` —— 分层靠 alpha / 直径，**不引入 RGB**
  - ⚠ `ok` 必须与改动前**逐字节相同**（每个正常用户都不该看到任何变化）
- [ ] **3.3** 平台差异：Windows 走图标分层（唯一信号载体）；macOS 图标分层 + ANSI 文字色并存

### Phase 4: 实机验证（阻塞项，不验不算完）

- [ ] **4.1** 跑一次 `--smoke` 或手工启动，确认 ANSI **真的**渲染成彩色而非字面量
- [ ] **4.2** 按下托盘时确认**高亮/反色**是否仍生效（本项目左键点击是核心交互，`tray.ts:39`）
  - 失效 → 走 D3 回滚点：**保留图标分层、删掉 ANSI**，并在本任务 Notes 记录实测结论

### Phase 5: 测试

- [ ] **5.1** 扩展 `scripts/test-tray.mjs`（loadTs 加载真源码）
  - [ ] `levelOfPercent` 四档边界（84.9/85、59.9/60、`null`、`status !== 'ok'`）
  - [ ] `ansiColor` 四档；`ok` 返回**空串**（不是某个转义）
  - [ ] `trayTitle` 加转义后**剥掉转义**与改动前的文案逐字相同
  - [ ] `badgeOf` 四档；`ok` → `'none'`
  - [ ] **静态守卫**：`levelOfPercent` 全仓只声明一次（数声明点），把阈值搬回第二处即红
  - [ ] `trayTitle` 的调用点仍只有 `tray.ts` / `ipc.ts` 两处（没新开拼装路径）
- [ ] **5.2** `scripts/test-structure.mjs` 加一条：`shared/levels.ts` 无 electron / DOM 引用
- [ ] **5.3** `src/main/qa/uitest.ts`
  - [ ] 新增 `debug:tray-image` 通道（`ipc.ts` 仅在 `--uitest`/`--shots` 注册 + preload 暴露）
  - [ ] `r.trayTitle` 的断言从「非空 + 有数字」换成**按 level 判**（不同用量 → 不同 level）
  - [ ] 新增 2 个键：等级 → `BadgeShape` 的对应；`ok` → 无点

### Phase 6: package.json 与 spec

- [ ] **6.1** 若 5.1 新增了脚本则接入 `test` 链（本任务预计**不新增**脚本，只扩展 `test-tray.mjs`）
- [ ] **6.2** 修正 `spec/frontend/directory-structure.md:18` 关于 `tray-text.ts` 是 "main-only consumer" 的错误描述（渲染层四处都在 import）
- [ ] **6.3** 在 spec 里记录：**「不许新增 shared 文件」不是仓库长期法律**，
  它出自 P0-1 当时的任务边界；引用它当理由会永久保留「卡片与托盘两套阈值」这个用户可见矛盾

## Review Gates

- [ ] `npm test` 通过（含扩展后的 `test-tray.mjs`）
- [ ] `npm run typecheck` 通过
- [ ] **反验**：把 `trayTitle` 里的 ANSI 拼装删掉 → 5.1 的「剥转义后逐字相同」与 level 判据必须报红
- [ ] **反验**：把 `levelOfPercent` 的阈值在 `levels.ts` 里改成 80/50 → 5.1 的四档边界必须报红
- [ ] **实机验证 4.1 / 4.2 已完成并记录结论**（含反色是否生效）
- [ ] `trellis-check` 对照 prd.md 验收标准逐条复核

## Rollback

- **纯增量、无数据迁移**：删除 `levels.ts` 的 ANSI 部分 + `tray-text.ts` 的转义拼接即可回到改动前；
  图标分层独立成立（若 ANSI 实机验证失败，删 ANSI 仍留图标分层）。
- 唯一不可逆的是 `levels.ts` 的搬迁 —— 但那是纯移动，`format.ts` 的 re-export 保留兼容，
  回滚只需把函数搬回 `format.ts` 并删 `levels.ts`。