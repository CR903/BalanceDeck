# Implement: P1-3 托盘颜色阈值 + 状态点角标

## Ordered Checklist

### Phase 1: 共享分级模块 shared/levels.ts

- [x] **1.1** 新建 `src/shared/levels.ts`：`Level` 类型 + `levelOfPercent`（**从 `renderer/format.ts:58` 原样搬**，不改任何阈值）
- [x] **1.2** 加 `ansiColor(level)`：`danger`→`\x1b[31m`、`warn`→`\x1b[33m`、`muted`→`\x1b[1;30m`（⚠ **不是 design.md 的 `90m`**：`NSString+ANSI.mm` 的 switch 里没有 `case 90`，落到 default 什么都不发生，muted 会与 ok 同色）、`ok`→**空串**
- [x] **1.3** `renderer/format.ts` 改为 `export { levelOfPercent, type Level } from '../../shared/levels'`
  - ⚠ **调用点零改动**：`CardView.tsx:11`、`DetailView.tsx:18`、`read-model.ts:2` 一行都不动
  - ⚠ 确认 `format.ts` 自己内部没有继续引用本地定义（它导出给三方，也要自己用）
- [x] **1.4** 确认 `src/shared/levels.ts` 不含 electron / DOM 引用（能被 `loadTs` 在纯 node 加载）

### Phase 2: 托盘标题 ANSI

- [x] **2.1** `src/shared/tray-text.ts`：`trayTitle()` 内部对百分比片段包 `ansiColor(level)`
  - ⚠ **文案结构与措辞逐字不变**（`>` 分隔、`⚠` 前缀、数字格式），只在片段两端加转义
  - ⚠ Windows（无 `setTitle`）路径不走 ANSI —— 由 `tray.ts` 决定要不要 strip，见 3.2
- [x] **2.2** 加 `stripAnsi(s)` 导出（供测试与 `--uitest` 剥转义后比对文案）

### Phase 3: 图标灰度分层

- [x] **3.1** 新建 `src/main/tray-badge.ts`：`BadgeShape` + `badgeOf(level)` 纯函数
  - `danger`→`solid-large` / `warn`→`translucent` / `muted`→`hollow-small` / `ok`→`none`
- [x] **3.2** `src/main/tray.ts`：把 `badgeOf` 的形状叠加到现有图标栅格化结果上
  - ⚠ macOS 仍 `setTemplateImage(true)` —— 分层靠 alpha / 直径，**不引入 RGB**
  - ⚠ `ok` 必须与改动前**逐字节相同**（每个正常用户都不该看到任何变化）
- [x] **3.3** 平台差异：Windows 走图标分层（唯一信号载体）；macOS 图标分层 + ANSI 文字色并存

### Phase 4: 实机验证（阻塞项，不验不算完）

- [x] **4.1** 跑一次 `--smoke` 或手工启动，确认 ANSI **真的**渲染成彩色而非字面量
- [x] **4.2** 按下托盘时确认**高亮/反色**是否仍生效（本项目左键点击是核心交互，`tray.ts:39`）
  - 失效 → 走 D3 回滚点：**保留图标分层、删掉 ANSI**，并在本任务 Notes 记录实测结论

### Phase 5: 测试

- [x] **5.1** 扩展 `scripts/test-tray.mjs`（loadTs 加载真源码）
  - [x] `levelOfPercent` 四档边界（84.9/85、59.9/60、`null`、`status !== 'ok'`）
  - [x] `ansiColor` 四档；`ok` 返回**空串**（不是某个转义）
  - [x] `trayTitle` 加转义后**剥掉转义**与改动前的文案逐字相同
  - [x] `badgeOf` 四档；`ok` → `'none'`
  - [x] **静态守卫**：`levelOfPercent` 全仓只声明一次（数声明点），把阈值搬回第二处即红
  - [x] `trayTitle` 的调用点仍只有 `tray.ts` / `ipc.ts` 两处（没新开拼装路径）
- [x] **5.2** `scripts/test-structure.mjs` 加一条：`shared/levels.ts` 无 electron / DOM 引用
- [x] **5.3** `src/main/qa/uitest.ts`
  - [x] 新增 `debug:tray-image` 通道（`ipc.ts` 仅在 `--uitest`/`--shots` 注册 + preload 暴露）
  - [x] `r.trayTitle` 的断言从「非空 + 有数字」换成**按 level 判**（不同用量 → 不同 level）
  - [x] 新增 2 个键：等级 → `BadgeShape` 的对应；`ok` → 无点

### Phase 6: package.json 与 spec

- [x] **6.1** 若 5.1 新增了脚本则接入 `test` 链（本任务预计**不新增**脚本，只扩展 `test-tray.mjs`）
- [x] **6.2** 修正 `spec/frontend/directory-structure.md:18` 关于 `tray-text.ts` 是 "main-only consumer" 的错误描述（渲染层四处都在 import）
- [x] **6.3** 在 spec 里记录：**「不许新增 shared 文件」不是仓库长期法律**，
  它出自 P0-1 当时的任务边界；引用它当理由会永久保留「卡片与托盘两套阈值」这个用户可见矛盾

## Review Gates

- [x] `npm test` 通过（含扩展后的 `test-tray.mjs`，98 项 / 0 失败；全链 17 个套件 exit 0）
- [x] `npm run typecheck` 通过
- [x] **反验**：把 `trayTitle` 里的 ANSI 拼装删掉 → 5.1 的「剥转义后逐字相同」与 level 判据必须报红
      （实测 7 条红）
- [x] **反验**：把 `levelOfPercent` 的阈值在 `levels.ts` 里改成 80/50 → 5.1 的四档边界必须报红
      （实测 3 条红）
- [x] **反验（check 补做）**：`ansiColor('muted')` 改回 design.md 写的 `\x1b[90m` → 实测 2 条红。
      期望值写在测试里、没跟着实现走，所以这一条是真的钉住 `1;30`
- [x] **实机验证 4.1 / 4.2 已完成并记录结论**（含反色是否生效）
- [x] `trellis-check` 对照 prd.md 验收标准逐条复核（2026-10-01，见下节）

## trellis-check 复核记录（2026-10-01）

**VERDICT：PASS（修了 4 处静默失效 + 2 处假守卫）**

### 修复的静默失效

1. **去重键丢掉形状 → 全仓零测试会红**（本任务最容易发生的一条）。
   `tray.ts` 的 `` `${key}#${shape}` `` 当时是就地拼的：`tray.ts` import electron，
   `loadTs` 加载不了，所以没有任何单测能覆盖它；而 uitest 读的是 `currentBadge`
   （**意图**，`updateTray` 在 `applyTrayIcon` 之前就写了），所以连 uitest 也照样绿。
   → 把键抽成纯函数 `trayIconKey(mark, shape)`（`src/main/tray-badge.ts`），
   补 4 条纯函数断言 + 2 条静态守卫（`tray.ts` 必须调它、不得手拼 `#${…}`）。
   反验：键去掉形状 → 3 条红；`tray.ts` 手拼 → 2 条红。
2. **`--uitest` 看不到「实际落盘的那份图标」**。`debug:tray-image` 返回了 `iconKey`
   却没人读（`readTray` 只取 `level` / `shape`），而那正是唯一能暴露去重吞掉图标的字段。
   → `uitest.ts` 改读 `iconKey`：判「键以 `#期望形状` 结尾」，并判换级后
   `iconKey` **与上一档不同**。
3. **`currentLevel` 只在形状变化时更新**。`badgeOf` 当前是单射所以没错，但一旦有人让两个
   等级共用形状，观测点就会报过期值。→ 改为无条件更新（`applyTrayIcon` 自己按
   `appliedIconKey` 去重，行为不变）。
4. **`stripAnsiTitle` 的注释说「tooltip 读它」—— 不实**。tooltip 走
   `providerSummary`（纯文本，永远不带转义）。已改正。

### 修掉的假守卫

5. **「标题与状态点同源」是恒真式**：原文把 `trayLevel(...)` 与 `stripAnsiTitle(...)`
   各算一遍再与自己比 —— 同一函数调两次，实现怎么改都绿。
   → 改成跨实现的真判据：解析标题里最重的 ANSI 码得等级，与 `trayLevel` 的返回值比，
   6 档全测。反验：`trayLevel` 固定返回 `'ok'` → 8 条红。
6. **`paintBadge` 的越界测试是永绿的**：原写法传 `size=1`，而 1px 画布上圆心落在
   画布外（`cover` 恒为 0），守卫根本没被触发。
   → 试过两种改法（传短缓冲、传 subarray + 金丝雀）都**测不出来**：
   TypedArray 的越界写是静默丢弃的，删掉守卫后仍是 97/0 全绿。已如实记录，
   改为守真正生效的那道防线（`tray.ts` 画点前的长度校验，静态守卫 6b）。
   反验：删掉长度校验 → 1 条红。
7. **`test-structure.mjs` §H 的匹配串写错**（`handle('x')` 多了一个 `)`，源码里引号后跟的是逗号），
   于是「门内没有」恒真、「门内都有」恒假。已改正并加 H1 对照物。
   反验：把注册搬到门外 → 2 条红。

### AC 条数更正

prd.md 的 AC 是 **15 条**（不是 17 条 —— 实现报告里的数字含 2 条不在文件里的项）。

## Rollback

- **纯增量、无数据迁移**：删除 `levels.ts` 的 ANSI 部分 + `tray-text.ts` 的转义拼接即可回到改动前；
  图标分层独立成立（若 ANSI 实机验证失败，删 ANSI 仍留图标分层）。
- 唯一不可逆的是 `levels.ts` 的搬迁 —— 但那是纯移动，`format.ts` 的 re-export 保留兼容，
  回滚只需把函数搬回 `format.ts` 并删 `levels.ts`。