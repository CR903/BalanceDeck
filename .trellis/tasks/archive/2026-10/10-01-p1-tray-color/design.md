# Design: P1-3 托盘颜色阈值 + 状态点角标

## Architecture

```
                 ┌──────────────────────────────────────────┐
                 │  src/shared/levels.ts  ← 【新增】          │
                 │  唯一的百分比分级来源                      │
                 │  Level / levelOfPercent / TRAY_ESCAPE     │
                 │  （从 renderer/format.ts 搬来，re-export）  │
                 └───────┬──────────────────────┬───────────┘
                         │ re-export            │ import
                         ▼                      ▼
        ┌─────────────────────────┐   ┌────────────────────────────┐
        │ renderer/format.ts      │   │ shared/tray-text.ts        │
        │ （原样 re-export，零改动）│   │ trayTitle() → 加 ANSI 转义  │
        └─────────────────────────┘   └─────────────┬──────────────┘
                                                    │
                                    ┌───────────────┴──────────────┐
                                    ▼                              ▼
                     macOS: Tray.setTitle(ANSI)      macOS/Windows: 图标灰度分层
                     Windows: setTitle 不存在 →        （template 只用 alpha：
                     颜色只能落在图标上                 绿=实心 / 橙=半透明 /
                                                      红=大点）
```

## Technical Decisions

### D1 · 复用 85/60，不引入第二套阈值（用户已拍板）

竞品报告建议的 80/50 **降级为观察描述**，不作需求。理由是可验证的：

- `format.ts:61-62` 的 `≥85 danger / ≥60 warn` 是仓库**唯一**的 UI 分级阈值；
  `read-model.ts:11-13` 的注释明写「阈值判定仍在 format.levelOfPercent…
  避免第二份 85/60」。
- 若托盘另立 80/50，**同一屏幕会出两套判断**：用量 62% 时卡片橙色、托盘判绿色。
  这不是审美分歧，是用户无法解释的矛盾，且没有任何一层代码能同时看到两处。

搬运方式：`levelOfPercent` 与 `Level` 从 `renderer/format.ts` 移到**新增的** `src/shared/levels.ts`，
`format.ts` 原样 `export { … } from '../../shared/levels'`。
**调用点零改动**（`CardView.tsx:11`、`DetailView.tsx:18`、`read-model.ts:2` 都不动），
单一出处落在跨进程的位置 —— 与 `shared/percent.ts`、`shared/tray-text.ts` 同一理由。

> **⚠ 这条推翻了「文件所有权不许新增 shared 文件」的历史约束。**
> 那条约束出自 `ipc.ts:85` / `systemNotify.ts:30` 记录的是**当时那两个任务**的边界
> （P0-1 明确不许新增 shared 文件，所以 NOTIFY_LEVELS 在两侧各写一份靠静态比对钉住）。
> 它不是仓库的长期法律，现在它挡住的正是「消除第二份 85/60」这件事。
> 引用它当理由会永久保留一处已知的用户可见矛盾。

### D2 · macOS 用 ANSI 上色，但只有 8 色、没有橙

Electron 的 `Tray.setTitle` 支持 ANSI 转义（官方文档「Support ANSI colors」，
本仓锁定的 Electron 37.10.3 里 `NSString+ANSI.mm` 仍在：二进制 `strings` 核到
`containsANSICodes` / `attributedStringParsingANSICodes`）。

**但 ANSI 终端调色板只有 8 色，没有橙色**：`33` 是纯黄，`1;33` 是 #cdcd00 暗黄。
所以「橙」这个中间档在标题里只能退化成黄。可接受 —— 因为颜色是**冗余信号**，
真正的信息载体是「图标分层 + 文案里的数字」，去掉橙不丢信息。

| Level | ANSI | 视觉 |
|---|---|---|
| `danger` | `\x1b[31m` | 红 |
| `warn` | `\x1b[33m` | 黄（**不是橙**，ANSI 调色板没有橙） |
| `ok` | 不加转义 | 跟随系统（正常色） |
| `muted` | `\x1b[90m` | 灰（无数据 / 出错） |

> **⚠ 必须实机验证两件事，文档不算数**（quality-guidelines 的「别信标签，去验机制」）：
> 1. ANSI 在本机 Electron 37 上真的渲染成彩色（而不是被当成字面量显示）。
> 2. **按下托盘时是否反色**。社区记录 `setAttributedTitle` 之后不再反色 ——
>    而本项目的**左键点击托盘是核心交互**（`tray.ts:39`），反色失效会让用户看不出按下态。
>    若反色确实失效，方案退化为「只做图标分层，不做 ANSI 上色」（见 D3 的回滚点）。

### D3 · 图标用灰度分层而非彩色（三平台通用，承载真正的等级信号）

macOS 图标是 **template image**（`tray.ts:95` 的 `setTemplateImage(true)`），
Apple 规则要求纯黑 + alpha，系统**丢弃 RGB**。所以「绿/橙/红三个图标」在 macOS
物理上不存在。

替代：用 **alpha + 直径** 做三个层级，template 规则下天然成立：

| Level | 状态点 | 判据 |
|---|---|---|
| `danger` | 实心大点（直径 4px） | 一眼可见的「注意」 |
| `warn` | 半透明中点（直径 3px，alpha ~60%） | 中等 |
| `ok` | 无点（回归现状） | 不给正常状态加噪点 |
| `muted` | 空心小点 | 无数据 |

Windows 侧 `setTitle` 整条 API 不存在（`@platform darwin`），颜色**只能**落在图标上 ——
于是这套灰度分层成了 Windows 的**唯一**信号载体，两平台在「图标分层」上完全一致，
差异只在「macOS 额外有 ANSI 文字色」。

回滚点：若 D2 的实机验证失败（ANSI 不渲染或反色失效），**保留 D3 的图标分层**，
去掉 ANSI —— 那是一个纯删除，不动数据结构。

### D4 · 现有 `trayTitle()` 保持单一出口，ANSI 在它内部拼

`shared/tray-text.ts` 已经是 main 与 renderer 共用的纯函数模块
（消费者：`tray.ts:5`、`ipc.ts:16`、`App.tsx:20`、`CardView.tsx:4`、`PetBall.tsx:6`）。
把转义拼装放在 `trayTitle()` 内部，两个调用点（`tray.ts` 与 `ipc.ts` 的
`debug:tray-title`）自动一致 —— 不新增第二份拼装。

⚠ **纯函数性**：`tray-text.ts` 是纯函数模块（无 electron），`test-tray.mjs` 经 loadTs 测它。
ANSI 转义是纯字符串操作，可以直接测。

### D5 · 等级判定放 `shared/levels.ts`，不放 `tray-text.ts`

`directory-structure.md:18` 说 `tray-text.ts` 是 "main-only consumer" —— **这是错的**，
渲染层四处都在 import（已核实）。所以把等级判定放进 `tray-text.ts` 不算新增架构边界，
但仍然**不放**：等级判定是**全 UI 共用的**语义（卡片、详情页、托盘），它的家应该是
`levels.ts`；`tray-text.ts` 只是**消费者**。放进去会让「托盘的分级」看起来是托盘专属的，
下一个消费者又要再搬一次。

> 顺手修掉 `directory-structure.md:18` 的错误描述（spec 陈述与现实不符）。

### D6 · 新增 `debug:tray-image` 观测点（否则图标分级无人能验）

`--uitest` **目前完全看不到托盘图标**：`trayImageInfo()` 只被 `--smoke` 用
（`modes.ts:65`），preload 无对应通道。而图标的等级分层恰恰是本任务的核心交付物，
没有观测点就只剩「逻辑测了、界面没人验证」。

三处改动：`preload/index.ts` 暴露 `debugTrayImage()` → `ipc.ts` 注册
`debug:tray-image`（**仅在 `--uitest`/`--shots` 下**，与既有 debug 通道同一纪律）
→ `uitest.ts` 加断言。

⚠ 现有 `r.trayTitle` 断言（`uitest.ts:689-692`）只判「非空 + 有数字」，
加了 ANSI 之后它**既不会变红也没有区分力**，必须换成按 level 的判据。

## Contracts

### shared/levels.ts（新增）

```ts
export type Level = 'ok' | 'warn' | 'danger' | 'muted'
/** 阈值判定：≥85 danger、≥60 warn。**唯一**的 UI 分级来源 */
export function levelOfPercent(pct: number | null, status: string): Level
/** ANSI 转义：按 level 返回包裹码（ok 返回空串 = 跟随系统色） */
export function ansiColor(level: Level): string
export const ANSI_RESET = '\x1b[0m'
```

### shared/tray-text.ts（扩展，签名不变）

```ts
export function trayTitle(snapshots: ProviderSnapshot[], offline: boolean): string
// 行为变化：百分比片段按 level 包 ANSI；文案结构与措辞逐字不变
// ⚠ 结构不变是硬要求 —— uitest 与用户都按现有格式读它
```

### 图标分层契约（新增 `src/main/tray-badge.ts`）

```ts
/** 生成 template 图标用的状态点描述（纯函数，可测） */
export type BadgeShape = 'none' | 'solid-large' | 'translucent' | 'hollow-small'
export function badgeOf(level: Level): BadgeShape
```

## Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| `pct == null` | `muted` → 灰色文字 + 空心小点（**不填 0**） |
| `status !== 'ok'` | `muted`，同上 |
| 无快照 / 全部 `nodata` | 托盘标题走现有文案，图标回到**无点**（回归现状） |
| 离线 | 文案保留现有 `⚠` 前缀；颜色叠加在百分比上，二者互不覆盖 |
| `cached` / `local` | 保留现有 `qualitySuffix` 前缀；颜色由**百分比**决定，不由数据源决定（数据源问题由前缀表达，混在一起会让人以为「缓存的颜色就是另一种颜色」） |
| Windows（无 `setTitle`） | 跳过 ANSI，只走图标分层 |
| 实机验证 ANSI 失败 | 保留图标分层，去掉 ANSI（D3 的回滚点） |

## Good / Base / Bad Cases

- **Good**：Coding plan `M 68.5%` → `levelOfPercent(68.5) = 'warn'` → 标题 `…\x1b[33mM 68.5%\x1b[0m…`，图标半透明中点。
- **Base**：用量 12% → `'ok'` → 标题**无转义**（与今天逐字相同）、图标无点。**这一档必须与改动前完全一致**，否则每个正常用户都看到「界面变了」。
- **Bad**：给 `muted` 用灰色 ANSI 却**不加**图标变化 —— 用户看到灰字以为是「低用量」，而真实原因是「没数据」。灰字 + 空心点两处信号必须同时改变。

## Tests Required

扩展 `scripts/test-tray.mjs`（经 `loadTs` 加载真源码）：
1. `levelOfPercent` 四档边界：84.9/85、59.9/60、`null`、`status !== 'ok'`
2. `ansiColor`：四档各自返回正确的转义；`ok` 返回**空串**（不是某个转义）
3. `trayTitle` 结构不变：加转义后，`>`、`⚠`、数字序列与改动前逐字相同（剥掉转义再比对）
4. `badgeOf`：四档各自形状；`ok` → `'none'`
5. **P1-1 式的静态守卫**：全仓 `levelOfPercent` 只允许**声明一次**（数 `const`/`function` 声明点）——
   这条是 D1 的守门人，把阈值搬回第二处即红
6. `src/main/ipc.ts` / `tray.ts` 的 `trayTitle` 调用点仍只有两处（没新开一条拼装路径）

`scripts/test-structure.mjs`：
7. `shared/levels.ts` **不含**任何 electron / DOM 引用（能被 loadTs 在纯 node 里加载）

`--uitest`（`uitest.ts`）：
8. 新增 `debug:tray-image` 通道可读出当前等级对应的 `BadgeShape`
9. `r.trayTitle` 的断言从「非空+有数字」换成按 level 判（不同用量 → 不同 level）

## Wrong vs Correct

#### Wrong
在 `tray.ts` 里给标题拼 ANSI，`format.ts` 的 85/60 不动，图标另画一套彩色：

- 阈值变成两份（85/60 与 80/50 或另一套），卡片与托盘同屏打架；
- ANSI 拼装散在主进程，`debug:tray-title`（`ipc.ts:16`）那条路径拿不到同样的转义，两处输出不一致；
- 彩色图标在 macOS template 下**不显示颜色** —— 一个花了 200 行、只在 Windows 上生效的方案。

#### Correct
等级判定提到跨进程的 `shared/levels.ts`（renderer 侧 re-export，调用点零改动），
ANSI 在 `trayTitle()` 内部拼（两个调用点自动一致），图标用 alpha 分层（三平台通用）：
- 阈值单一来源，同屏不再打架
- 实机验证不通过时，删 ANSI 即可，图标分层独立成立