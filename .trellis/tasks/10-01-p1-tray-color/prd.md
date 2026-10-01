# P1-3 托盘颜色阈值 + 状态点角标

## Goal

托盘标题目前是 `5H 5% W 52.9% M 68.5%` 的纯文字平铺。让用户**一眼识别风险**：
按用量阈值着色，并给图标加状态点角标。

竞品依据：CodexBar（动态 bar icons）、ClaudeBar（动态图标）、
Claude-God（菜单栏图标按最差配额变绿/橙/红）。

## Requirements

1. **颜色阈值与卡片一致**：复用仓库**唯一**的 UI 分级阈值（≥85 danger / ≥60 warn），
   不引入第二套（竞品报告里的 80/50 降级为观察描述）。
2. **macOS 文字着色**：用 ANSI 转义 —— Electron 支持（官方文档「Support ANSI colors」，
   本仓锁定的 37.10.3 二进制已核到 `containsANSICodes`）。**ANSI 只有 8 色、没有橙**，
   中间档用黄（`33`）。
3. **图标状态点**：三平台通用。用 **alpha + 直径** 做层级 ——
   macOS 图标是 template（`setTemplateImage(true)`），系统丢弃 RGB 只用 alpha，
   所以**彩色状态点在 macOS 上物理上不存在**。
4. **Windows 平台差异**：Windows 侧 `setTitle` 整条 API 不存在，颜色**只能**落在图标上 ——
   于是图标分层是 Windows 的唯一信号载体。
5. **正常态零变化**：`ok` 档必须与改动前**逐字节相同** —— 每个正常用户都不该看到任何变化。
6. **数据源标注不与颜色混淆**：颜色由**百分比**决定，数据源问题由既有的
   `qualitySuffix` 前缀表达。混在一起会让人以为「缓存的颜色就是另一种颜色」。

## Constraints

- **单一出处**：`levelOfPercent` + `Level` 从 `renderer/format.ts` 搬到**新增的** `src/shared/levels.ts`，
  `format.ts` 改为 re-export。**调用点零改动**（CardView / DetailView / read-model 一行都不动）。
- **⚠ 本任务明确跨过「不许新增 shared 文件」的历史约束**：那条出自 P0-1 当时的任务边界
  （因此 NOTIFY_LEVELS 只能在两侧各写一份、靠静态比对钉住），**不是仓库法律**。
  现在它挡住的正是「消除第二份 85/60」这件事。
- ANSI 拼装放在 `shared/tray-text.ts` 的 `trayTitle()` **内部** ——
  它已是 main 与 renderer 共用的纯函数模块（消费者：tray.ts / ipc.ts / App.tsx / CardView / PetBall），
  两个调用点自动一致，不新增第二份拼装。
- `trayTitle()` 的**文案结构与措辞逐字不变**（`>` 分隔、`⚠` 前缀、数字格式），只在片段两端加转义。
- **必须实机验证**（阻塞项，文档不算数）：
  ① ANSI 真的渲染成彩色而非字面量；
  ② **按下托盘时是否还反色** —— 本项目左键点击托盘是核心交互（`tray.ts:39`）。
  若反色失效 → 走回滚点：**保留图标分层、删掉 ANSI**（纯删除，不动数据结构）。
- **新增 `debug:tray-image` 观测点**：`--uitest` 目前**完全看不到托盘图标**
  （`trayImageInfo()` 只被 `--smoke` 用），没有观测点则图标分级无人能验。

## Acceptance Criteria

- [ ] `levelOfPercent` 搬进 `src/shared/levels.ts`，`format.ts` 改为 re-export，
      且**调用点零改动**（CardView / DetailView / read-model 无需修改）
- [ ] 全仓 `levelOfPercent` **只声明一次**（静态守卫：把阈值搬回第二处即红）
- [ ] 阈值仍是 85/60（四档边界 84.9/85、59.9/60 有断言）
- [ ] `ansiColor` 四档各自正确；`ok` 返回**空串**（不是某个转义）
- [ ] `trayTitle()` **剥掉 ANSI 后**与改动前的文案逐字相同
- [ ] 图标按等级分三层（`badgeOf` 纯函数可测）；`ok` → **无点**
- [ ] `ok` 档的图标与改动前**逐字节相同**
- [ ] Windows 路径跳过 ANSI（无 `setTitle`），只走图标分层
- [ ] `shared/levels.ts` **不含** electron / DOM 引用（能被 loadTs 在纯 node 加载）
- [ ] 新增 `debug:tray-image` 通道（**仅** `--uitest`/`--shots` 注册）+ preload 暴露
- [ ] `--uitest` 的 `r.trayTitle` 断言从「非空 + 有数字」换成**按 level 判**（现断言无区分力）
- [ ] **实机验证**：ANSI 真的上色；**按下托盘的反色是否仍生效**（结论要写进任务 Notes）
- [ ] `npm test` 与 `npm run typecheck` 通过
- [ ] 两个反验实测有效：删掉 ANSI 拼装 → 红；阈值改 80/50 → 四档边界红
- [ ] spec 修正 `directory-structure.md` 关于 `tray-text.ts` 是 "main-only consumer" 的错误描述
      （渲染层四处都在 import）

## Notes

- **调研推翻了本任务的原始需求前提**：初始 prd 按竞品描述写「>80% 红 / >50% 橙」，
  调研发现① macOS 模板图标无法用彩色（物理限制）② ANSI 调色板没有橙
  ③ 80/50 会与仓库现有的 85/60 同屏打架（用量 62% 时卡片橙、托盘绿，用户无法解释）。
  用户已拍板「统一用 85/60，ANSI + 图标分层」。
- **产品决策（用户已确认）**：余额类供应商（无百分比）在托盘上**变灰 + 空心点**。
  这对纯余额用户是可见变化，接受 —— 与 `read-model.ts:186` 的既有先例一致
  （`ballLevel`「无百分比 → muted」），且避免「卡片绿 / 托盘灰」又一套同屏矛盾。
- **实现纠正了设计里的两处错误**（子代理读源码 / 实测发现）：
  1. `ansiColor('muted')` 用 `\x1b[1;30m` 而非 design 写的 `\x1b[90m` ——
     读 Electron v37.10.3 的 `NSString+ANSI.mm`，**switch 里没有 `case 90`**，
     会落到 `default` 什么都不发生 → muted 与 ok 长得一模一样，恰与意图相反。
  2. 托盘**去重键必须含 shape**（`${key}#${shape}`）—— 否则等级变化会被去重吃掉。
- **ANSI 实机验证（像素级 A/B 差分）**：
  - 确认真的上色：danger ≈ `RGB(242,97,106)` 红、warn ≈ `RGB(246,234,107)` 黄
  - `tray.getTitle()` 返回**无转义**的串（AppKit 剥掉），所以走 `getTitle()` 的断言**看不到颜色** ——
    `debug:tray-title` 必须现场重算
  - **按下反色在本机不可测**（合成按键送不到第三方 status item，缺 Accessibility 权限），
    但源码结构回答了设计问题：`setTitle:font_type:` 两个分支都调 `setAttributedTitle:`，
    即改动前就已是 attributed title → ANSI **没有引入**这个退化条件，故按 D3 判据保留 ANSI。
- **未跑 `--uitest`**：本批次四个子任务都在改 `uitest.ts`，合并后由主会话统一跑一次。
- 设计推导见 `design.md` 的 D1–D6，执行清单见 `implement.md`。