# Research: P1-3 托盘颜色阈值 + 状态点角标

- **Query**: 给托盘标题的百分比加颜色阈值（>80% 红 / >50% 橙 / 正常绿）+ 图标状态点角标；查清
  macOS/Windows 上 `Tray.setTitle` 能否着色、现有分级逻辑能否复用、测试与 uitest 落点
- **Scope**: internal（代码 / spec / 测试脚本）+ external（Electron API 文档与源码、macOS template image 规则）
- **Date**: 2026-10-01
- **Task**: `.trellis/tasks/10-01-p1-tray-color`（status `planning`，PRD 只有 Goal，Requirements / AC 全 TBD）

---

## 0. 一句话结论（先看这个）

> **前提修正：macOS 上 `tray.setTitle()` 是可以着色的** —— Electron 官方文档明确写
> 「Support ANSI colors」，本仓锁定的 Electron 37.10.3 里 `NSString+ANSI.mm` 仍在
> （`containsANSICodes` / `attributedStringParsingANSICodes` 符号已在二进制里核到）。
> 因此 PRD 里「macOS 不支持颜色」这条假设**不成立**，标题阈值着色是最小改动路径。
> 但有两条硬限制：**① ANSI 只有 8 种终端色，没有「橙」**（33 是纯黄）；
> **② Windows 上 `setTitle` 根本不存在**，标题只在 macOS 出现，托盘颜色在 Windows
> 只能靠图标表达。

---

## 1. 托盘标题现状

### 1.1 职责切分

| 文件 | 职责 | 是否纯函数 |
|---|---|---|
| `src/shared/tray-text.ts`（87 行） | **所有托盘文案**：`shortWindowLabel` / `compactAmount` / `providerSummary` / `primarySnapshot` / `trayTitle` / `qualitySuffix` | 是（不依赖 electron） |
| `src/main/tray.ts`（146 行） | Electron 侧装配：`Tray` 生命周期、默认图标、图标切换、菜单、`setTitle` / `setToolTip` 调用、测试观测点 | 否（`import { Tray, Menu, nativeImage, app } from 'electron'`，`tray.ts:1`） |

模块头注释把这个分工写死了（`tray.ts:10-13`）：

```ts
// 标题文案与主供应商选择逻辑在 `src/shared/tray-text.ts`（纯函数、可测试）：
//   · 多窗口 → `5H 2.7% W 51.9% M 67.9%`（logo 由渲染层栅格化后送来）
//   · 单窗口余额 → `$12.34`
//   · 离线 / 缓存数据 → 前缀 ⚠
```

⚠ **spec 与现实已有一处偏差**（不影响本任务，但改 spec 时该知道）：
`.trellis/spec/frontend/directory-structure.md:18` 写
`tray-text.ts  # every tray string lives here (main-only consumer, unit-tested)`，
实际渲染层也 import 了它：

```
src/renderer/src/App.tsx:20      import { providerSummary, qualitySuffix } from '../../shared/tray-text'
src/renderer/src/CardView.tsx:4  import { shortWindowLabel } from '../../shared/tray-text'
src/renderer/src/PetBall.tsx:6   import { shortWindowLabel } from '../../shared/tray-text'
```

**对本任务的意义**：`tray-text.ts` 已经事实上是跨进程模块，所以把「等级判定」放进去在架构上
**不新增边界**（它已经在两个 tsconfig project 里，`tsconfig.node.json:15` / `tsconfig.web.json:15`）。

### 1.2 `trayTitle()` 的输出格式与前缀拼接

`src/shared/tray-text.ts:70-80`：

```ts
export function trayTitle(snapshots: ProviderSnapshot[], offline: boolean): string {
  const s = primarySnapshot(snapshots)              // :72 卡片顺序第一位
  const body = s ? providerSummary(s) : ''         // :73
  if (!body) {
    if (snapshots.length === 0) return ''           // :75
    return snapshots.some((x) => x.status === 'ok') ? '✓' : ''   // :76
  }
  const stale = s?.dataQuality === 'cached' || s?.dataQuality === 'local'   // :78
  return `${offline || stale ? '⚠ ' : ''}${body}`  // :79
}
```

- **主供应商**：`primarySnapshot` = `snapshots.find(s => s.status === 'ok' && s.windows.length > 0) ?? snapshots[0]`（`:66-68`）
- **body**：`providerSummary`（`:51-63`）
  - ≥2 个带百分比的窗口 → 全部平铺 `5H 2.7% W 51.9% M 67.9%`（`:56`）
  - 单窗口百分比 → `W 50%`（`:61`）
  - 无百分比 → `compactAmount`（`:62`，`¥500.67` / `$12.3k`）
- **前缀**：只有 `⚠ ` 一个，两种来源合并判断 —— `offline`（网络不可达）**或** `dataQuality ∈ {cached, local}`（`:78-79`）
- **空态三态**：`''`（无供应商）/ `'✓'`（有 ok 但无窗口数据）/ `''`（全出错，见 test `:98`）

### 1.3 消费端：只有 macOS 才有标题

`src/main/tray.ts:101-131` `updateTray()`：

```ts
101: export function updateTray(snapshots: ProviderSnapshot[], meta?: { offline?: boolean }): void {
102:   if (!tray) return
103:   const offline = !!meta?.offline
104:   if (process.platform === 'darwin') {          // ⚠ 整段只在 macOS 跑
105:     lastTitle = trayTitle(snapshots, offline)
106:     tray.setTitle(lastTitle, { fontType: 'monospacedDigit' })
107:   }
108:   const lines: string[] = []
...  // :108-128 tooltip 明细（跨平台都设）
130:   tray.setToolTip(`BalanceDeck\n${lines.join('\n')}`)
```

调用链：`scheduler.ts:104 / 209 / 224` → `updateTray?.(snapshots, { offline })`，
其中 `debugPush`（`scheduler.ts:220-225`）是 `--uitest` 推夹具的入口，会**同时**更新托盘。

---

## 2. 托盘文字能否上色（关键约束）

### 2.1 macOS：**能**，官方支持 ANSI 颜色

- 官方文档 `docs/api/tray.md`（Electron main 分支，v37 同源）：

  > #### `tray.setTitle(title[, options])` _macOS_
  > Sets the title displayed next to the tray icon in the status bar **(Support ANSI colors)**.

  本仓 `node_modules/electron/electron.d.ts:14664-14672` 是同一句话，且带
  `@platform darwin` 标注。

- 着色实现：`shell/browser/ui/cocoa/NSString+ANSI.mm`（已 fetch v37.10.3 tag 核对，
  内容与 main 分支一致）。`attributedStringParsingANSICodes` 把 `\033[...m` 解析成
  `NSAttributedString` 的 `NSForegroundColorAttributeName`。符号
  `containsANSICodes` / `attributedStringParsingANSICodes` / `modifyAttributesForANSICodes:`
  已在本机 `node_modules/electron/dist/.../Electron Framework` 二进制里 `strings` 核到。

- **历史坑已修**：`fontType` 与 ANSI 曾经互斥 —— issue
  [electron#29287](https://github.com/electron/electron/issues/29287)「Tray title ANSI colors
  don't work when using fontType option」，由 PR
  [#30146](https://github.com/electron/electron/pull/30146) 修复并 backport 到 12/13/14-x-y。
  本仓用 `fontType: 'monospacedDigit'`（`tray.ts:106`）在 Electron 37 上**不受此坑影响**。
  ⚠ 但这条**必须实机验证一次**再落 PRD（见 §8 Q1）。

- **可用色板只有 8 个终端色**（`NSString+ANSI.mm` 的 `switch`）：

  | code | 非 bold | bold（`;1`） |
  |---|---|---|
  | 30 / 39 | `#000000` / 重置 | `#7f7f7f` |
  | 31 | `#ff0000` 红 | `#cd0000` 暗红 |
  | 32 | `#00ff00` 绿 | `#00cd00` 暗绿 |
  | 33 | `#ffff00` **黄** | `#cdcd00` 暗黄 |
  | 34 | `#5c5cff` 蓝 | `#0000ee` |
  | 35 / 36 / 37 | 洋红 / 青 / 白 | 各自暗色 |
  | 40–47 / 49 | 背景色（**菜单栏上会出方块，不建议**） | |

  → **没有「橙」**。`33` 是纯黄，`1;33` 是暗黄（#cdcd00，偏橄榄）。
  PRD 的「>50% 橙」在 ANSI 层面只能映射成黄（33）或暗黄（`1;33`）。
  → **没有自定义 hex**。想要品牌橙只能靠图标（见 §2.3）。

- **已知的 macOS 渲染副作用**（外部资料，来自 NSStatusItem 社区问答）：
  用 `setAttributedTitle` 之后，菜单栏项**被按下/高亮时不再自动反色** ——
  StackOverflow「Highlighting NSStatusItem with attributed string」记录了
  「colors don't get inverted as I want them to… it just keeps the color I set it to」。
  Electron 的实现正是走 `attributedTitle_`（见 issue #12343 的崩溃栈
  `TrayIconCocoa::SetTitle` → `attributedTitle_.reset(...)`），所以这条**大概率适用**。
  ⚠ 本项目托盘左键点击是核心交互（`tray.ts:39`），高亮态视觉是否可接受**需实机确认**。

### 2.2 Windows：**没有标题**，`setTitle` 整条路径不存在

- `electron.d.ts:14666-14671` 明确 `@platform darwin`。
- Electron issue [#13148](https://github.com/electron/electron/issues/13148)：
  > 「Windows does not support tray icon titles. You can specify the tooltip.」（Electron 维护者）
- 本仓代码本来就这么写：`tray.ts:104` 的 `if (process.platform === 'darwin')` 把 `setTitle`
  整段圈住，Windows 只走 `setToolTip`（`:130`）。

**结论**：Windows 上「托盘文字颜色」**不存在这个surface**。任何颜色方案在 Windows
只能落在 **图标**（`setImage`）上。这不是实现取舍，是平台事实。

### 2.3 图标现状：template PNG，渲染层 canvas 栅格化

链路（渲染层 → IPC → 主进程）：

```
src/renderer/src/App.tsx:980-993
  980: // 托盘图标随「优先级第一位」的供应商变化（卡片顺序 = 用户定义的优先级）
  981: const primaryMark = (state.snapshots.find(s => s.status==='ok' && s.windows.length>0)
                             ?? state.snapshots[0])?.mark
  982: useEffect(() => {
  985:   void renderTrayIcon(primaryMark)
  986:     .then(({ png1x, png2x }) => {
  987:       if (!cancelled) window.api.setTrayIcon(primaryMark, png1x, png2x)
  ...
  993: }, [primaryMark])
        ↓ preload
src/preload/index.ts:42-43
  setTrayIcon: (key, png1x, png2x) => ipcRenderer.send('tray:icon', key, png1x, png2x)
        ↓
src/main/ipc.ts:395-397
  ipcMain.on('tray:icon', (_e, key, png1x, png2x) => {
    if (typeof key === 'string') setTrayIcon(key, String(png1x ?? ''), String(png2x ?? ''))
  })
        ↓
src/main/tray.ts:77-99  setTrayIcon(key, png1x, png2x)
  80: if (key === currentIconKey) return          // 去重，避免状态栏闪烁
  88-90: nativeImage.createEmpty() + addRepresentation({scaleFactor:1, w:22,h:22,dataURL:png1x})
                                              + addRepresentation({scaleFactor:2, w:44,h:44,dataURL:png2x})
  95: if (process.platform === 'darwin') img.setTemplateImage(true)
  96-98: iconCache.set(key, img); currentImage = img; tray.setImage(img)
```

栅格化实现 `src/renderer/src/ProviderMark.tsx:59-85`：

```ts
59: export async function renderMarkPng(mark: string | undefined, size: number): Promise<string> {
60:   const url = markDataUrl(mark)          // SVG data URL（fill=currentColor）
63:   await img.decode()
64-77: canvas drawImage（pad = size*0.12，保持宽高比居中）
78:   return canvas.toDataURL('image/png')
82: export async function renderTrayIcon(mark) {   // 1x=22, 2x=44
83:   const [png1x, png2x] = await Promise.all([renderMarkPng(mark, 22), renderMarkPng(mark, 44)])
```

**是 template 吗？是。** 两条证据：
1. `tray.ts:95` 显式 `img.setTemplateImage(true)`（macOS 分支）。
2. `provider-icons.ts:5-7` 的生成器注释：
   `作为 <img>/canvas 用时解析为黑色（托盘 template image 用）` —— 所有 body 的
   `fill/stroke` 已归一为 `currentColor`（`gen-provider-icons.mjs` 产出），
   在 canvas 里解析成**纯黑 + alpha**。

**macOS template 规则**（外部权威来源）：
- Electron `docs/api/native-image.md`「Template Image _macOS_」：
  > On macOS, template images consist of **black and an alpha channel**.
- benjgo《Designing macOS menu bar extras》：
  > Template images can be full colour, or monochrome template images. A template image is a
  > standard image, but **macOS will ignore the colour, and only use the alpha channel
  > information** … If needed, it's possible to **use different levels of opacity to provide
  > shading. This is often used to indicate state**, like volume or Wi-Fi strength.
  > Apple typically uses **35% opacity to indicate disabled elements**.

**推论（对状态点方案至关重要）**：
在 macOS 上**图标里画红点/橙点是没用的** —— RGB 被丢弃，只有 alpha 生效。
多色状态点必须改成**灰度分层**（不同 alpha / 不同尺寸 / 不同形状），
否则用户看到的三个图标一模一样。这正好也是 Apple 自己区分状态的做法。

Windows 侧相反：`tray.ts:33-35` 与 `:95` 的 `setTemplateImage` 只在 darwin 调，
所以 Windows 的 `tray.ico`（`build/tray.ico`，24×24）**可以是多色** ——
但 Windows 也没有标题文字，所以「颜色」在 Windows 的落点**只能是图标本体**，
而 macOS 的图标只能是灰度。**两平台的「颜色」语义天然不同。**

---

## 3. 已有的分级逻辑：能不能复用？

### 3.1 现状：阈值只有一处，在**渲染层**

`src/renderer/src/format.ts:55-64`：

```ts
55: export type Level = 'ok' | 'warn' | 'danger' | 'muted'
57: /** 阈值分级：≥85% 危险，≥60% 警告 */
58: export function levelOfPercent(pct: number | null, status: string): Level {
59:   if (status !== 'ok') return 'muted'
60:   if (pct == null) return 'muted'
61:   if (pct >= 85) return 'danger'
62:   if (pct >= 60) return 'warn'
63:   return 'ok'
64: }
```

`src/renderer/src/read-model.ts` 是「唯一回答哪个窗口重要、多严重」的地方
（`read-model.ts:4-13` 头注释明说这是为了收口此前分散在 4 处的实现）：

| 函数 | 位置 | 口径 |
|---|---|---|
| `maxPercent(s)` | `read-model.ts:42-45` | 快照里最大百分比，没有可比的则 `null` |
| `snapshotLevel(s)` | `read-model.ts:48-53` | error→danger；非 ok→muted；否则 `levelOfPercent(maxPercent(s))` |
| `windowLevel(w)` | `read-model.ts:56-58` | `levelOfPercent(windowPercent(w))` |
| `severityRank(s)` | `read-model.ts:64-75` | **阈值不在这里重写，直接由 `snapshotLevel` 推导**（注释 `:62` 明写「避免第二份 85/60」） |
| `ballLevel(s, w)` | `read-model.ts:96-101` | 收起态球专用；与 `snapshotLevel` 的差别只在「没有百分比时判 muted」 |

`read-model.ts:12` 的分工注释：

> 分工：阈值判定仍在 format.levelOfPercent（百分比计算在 shared/percent，主进程托盘与
> 渲染层共用）；**这里只决定「拿哪个数去比」「按什么排序」**。

消费方（全部渲染层）：`CardView.tsx:1,49,129`、`DetailView.tsx:1,266`、`PetBall.tsx`、`components.tsx:2`
（`StatusDot` / `Ring` / `Bar` 都吃 `lvl-${Level}`），CSS 色板在 `skins.css:23-25, 509-519, 586-602`。

### 3.2 跨进程可达性：**主进程拿不到 `levelOfPercent`**

- `format.ts` 在 `src/renderer/src/`，**不在** `tsconfig.node.json` 的 include 里
  （`tsconfig.node.json:15`：`["src/main/**/*", "src/preload/**/*", "src/shared/**/*", ...]`）。
- 现有纪律：**没有任何 `src/main/*.ts` import 渲染层模块**
  （`grep "renderer/src" src/main/` 只命中一条注释：`ipc.ts:84`）。
- 三处注释把「不许新增 shared 文件」写成了硬纪律（源各自任务的 implement.md 文件所有权）：
  - `src/main/ipc.ts:85`：「两边没有共享模块（**文件所有权不许新增 shared 文件**），
    所以由 `scripts/test-system-notify.mjs` 静态比对两侧字面量」
  - `src/renderer/src/systemNotify.ts:30`、`src/renderer/src/speechOut.ts:409`：同款
  - `ipc.ts:261`：「文件所有权（implement.md）不许新增 shared 文件，故不抽共享常量」

  → **「新增 shared 文件」在本仓是被显式记录的既往约束**（虽然它来自具体任务的
  implement.md，不是 Trellis 全局规则）。托盘若要复用阈值，有三条路：
  (a) 阈值函数搬进 `src/shared/`（改 `format.ts` 的 import，需评估 spec 影响）；
  (b) 在 `tray-text.ts` 里写第二份阈值；
  (c) 渲染层算好等级、经 IPC 传给主进程。
  **这是本任务最需要产品/架构拍板的一点**（见 §8 Q2）。

### 3.3 阈值冲突：85/60 vs 80/50 —— 确实存在，且不止一处

现在仓库里**已经有三套**百分比阈值：

| 阈值 | 位置 | 用途 | 语义 |
|---|---|---|---|
| **85 / 60** | `format.ts:61-62` | UI 分级（卡片 / 详情 / 球 / win-chip / StatusDot） | 视觉严重度 |
| **80 / 95** | `systemNotify.ts:61` `DEFAULT_NOTIFY_CONFIG` | 系统通知（P0-1 落地） | 弹一次提醒 / 强提醒 |
| **90** | `smartBroadcast.ts:74` `exhaustionPct: 90` | TTS 播报「用量耗尽」 | 播报阈值 |
| （+ 用户可配） | `smartBroadcast.ts` `fluctuation` / `abnormalMul` / `idleHours` | 波动 / 异常 / 闲置 | 播报 |

设计文档对这些并不回避 —— `systemNotify.ts:11-14` 明确写：

> 语音播报与系统通知是**两条互相独立的输出通道**，用户可能只想开其中一条；
> **阈值也必须能分开配**（默认 >80% 弹通知、>90% 才播报）。…而把两套阈值塞进同一张表
> 则迟早互相覆盖。

所以**两套阈值并存是这个仓已确立的架构立场**，不是缺陷。
但托盘颜色是**第三套**，且它是「常驻可见」的（用户眼睛一直盯着菜单栏），
与卡片/详情/球的**同屏**视觉 —— 这才是真问题：

> 用户场景：用量 62%。卡片上 win-chip 是**橙色 `lvl-warn`**（≥60），
> 但托盘按 PRD 的 >80/>50 会判**绿色**。**同一个数，两个颜色，同屏。**
> 这不是「阈值不同」，是**视觉上自相矛盾**，而且用户没法解释（他不知道有 85 和 80 两套）。

结论：**托盘配色应复用 85/60 的 `levelOfPercent` 口径，不引入 80/50。**
PRD 里的 80/50 来自竞品报告的**观察描述**（CodexBar / Claude-God 的做法），
不是对本仓阈值系统的设计要求。若坚持 80/50，至少要接受上面那条矛盾。

---

## 4. 状态点的三种候选形态

前置事实（决定成本）：macOS 图标是 template，**RGB 被丢弃，只有 alpha 生效**
（§2.3）。所以「用不同颜色的小圆点」在 macOS 上**三种方案都做不出彩色** ——
必须改成灰度分层（alpha / 尺寸 / 形状）。

| 方案 | 描述 | 实现成本 | template 兼容 | 评价 |
|---|---|---|---|---|
| **(a) 图标 + 灰度状态点** | 同一张 canvas 上，logo 左下角画一个圆点；等级 → 不同 alpha（如 danger=1.0 / warn=0.6 / ok 不画）+ 不同直径 | **低**。全在 `ProviderMark.tsx:59-85` 的 `renderMarkPng` 里加几行 `ctx.arc()` + `ctx.fill()`；`renderTrayIcon` 的签名 `(mark) → {png1x,png2x}` 要变成 `(mark, level) → {...}`；`App.tsx:985-987` 传第二个参数；`tray.ts:77` 的 `key` 要把 level 并进去（否则 `tray.ts:80` 的 `key === currentIconKey` 去重会把换级图标吞掉） | ✅ 完全兼容（只动 alpha） | **推荐**。macOS/Windows 同一份代码；Windows 上是灰度点（因为 renderer 画的就是灰度），但 Windows 本来就没标题文字，图标是唯一 surface |
| **(b) 三套独立图标整套切换** | ok / warn / danger 各一张完整 PNG，渲染层按等级选 | **中**。要三份 canvas 绘制分支；但 `tray.ts:96` 的 `iconCache` 天然按 key 缓存，只要 key 带上 level 就行 | ✅（都是 template） | 视觉冲击更强（整个 logo 变灰/淡），但 macOS template 下只能改 alpha，改了就是「logo 变淡」——Apple 语义上更像「禁用态」，容易被误读成「不可用」而不是「有风险」 |
| **(c) 图标不变，只改 tooltip** | `tray.setToolTip` 里加一行等级 | **最低**（`tray.ts:130` 一行） | ✅ | **不可用**：tooltip 要 hover 才看得见，PRD 诉求是「一眼可见」。可作为 (a) 的**补充**（tooltip 里写明等级文案） |

补充事实：
- 图标尺寸是 22×22 @1x / 44×44 @2x（`tray.ts:89-90`，`ProviderMark.tsx:83`），
  logo 本体只占 `size - 2*size*0.12 = size*0.76`（`ProviderMark.tsx:72-73`），
  **四周有 ~12% 的留白**可放状态点，不必缩 logo。
- macOS 菜单栏推荐尺寸是 16×16 / 32×32@2x（Electron tray.md），本仓用 22/44 是**偏大**的
  （现状，非本任务引入）。状态点若按 22px 画，实际视觉尺寸会比预期小。

---

## 5. 测试落点

### 5.1 `scripts/test-tray.mjs` 现状（29 项，`npm run test:tray` 全绿，已实跑确认）

`test-tray.mjs:9-18` 用 `loadTs('src/shared/tray-text.ts')` 加载真实源码（非 inline copy），
`eq()` 做 `JSON.stringify` 全等比较，`:118-119` 打印通过数并 `process.exit(fail ? 1 : 0)`。

现有分组：

| 组 | 行 | 覆盖 |
|---|---|---|
| 窗口短标签 | `:63-69` | `shortWindowLabel` 6 项（含「未知窗口取前两字」） |
| 状态栏标题形态 | `:71-91` | `providerSummary` / `trayTitle` 的多窗口、单窗口 %、美元金额、k/M 缩写 |
| 离线 / 缓存前缀 | `:93-99` | `⚠` 三来源 + 空态三态 + 「跳过出错项取下一个」 |
| 主供应商选取 | `:101-109` | 顺序即优先级、顺延、空列表 |
| 其他 | `:111-116` | `qualitySuffix` ×3 + `compactAmount` ×2 |

`loadTs` 机制（`scripts/lib/load-ts.mjs:23-37`）：esbuild bundle 成内存 ESM 再 `import`，
**不需要改源码写法**。这是新增纯函数测试的零成本路径。

**能加什么**：
- 若等级判定写进 `tray-text.ts`（或搬进 shared）→ **直接在 `test-tray.mjs` 加组**，
  逐条断言 `85 → danger` / `84.9 → warn` / `59.9 → ok` 这类边界
  （与 `test-read-model.mjs:66-73` 的 D3/D4/D5 同款写法）。
- 若新增一个「图标 key 生成」纯函数（如 `trayIconKey(mark, level)`）→ **也可纯测**，
  因为它只是字符串拼接。

### 5.2 图标生成（含图像）能不能不依赖真实 Electron 测？

**能，而且成本比想象低 —— 但只能测「决策」，不能测「像素」。**

| 层 | 可测性 | 手段 |
|---|---|---|
| 等级判定 / key 拼接 | ✅ 纯 node | 抽成 `tray-text.ts`（或 shared）里的纯函数，`loadTs` + `eq()` |
| canvas 绘制（`ProviderMark.tsx:59-79`） | ❌ 现状不可测 | 依赖 `document.createElement('canvas')` + `Image.decode()`（`:61-63`），纯 node 没有 DOM。**仓里没有任何 canvas 测试先例**（`loadTs` 清单里无 `.tsx`） |
| macOS 模板化结果 | ❌ 不可测 | `nativeImage.setTemplateImage` / `addRepresentation` 是 Electron API。仓里已有 electron stub 先例（`scripts/lib/electron-stub.mjs`），但它**只实现 `net.isOnline`**（`:13`），且注释写明「只实现被用到的成员，不要顺手补全」（`:8-10`） |

已有的近似手段：`scripts/lib/png-probe.mjs`（≈90 行，只用 `zlib` 解 PNG 成 RGBA），
`quality-guidelines.md:93-113` 有一条硬纪律：
> **Don't: eyeball a screenshot — decode it**（`capturePage` 比对必须逐像素）

→ 若要给状态点做像素级验证，路子是：把 canvas 输出落到文件后用 `png-probe` 解。
但 canvas 只在渲染层存在 ⇒ **像素验证只能在 `--uitest` 里做**（见 §6）。

### 5.3 现有静态门（改文件时会连带触发）

`scripts/test-structure.mjs`（45 条，纯静态）：
- `C1`（`:65`）：`src/renderer/src/*.ts(x)` 与 `src/shared/*.ts` 不得 `import` `qa/`
- `C2`（`:73`）：`src/main/*.ts`（除 `index.ts`）不得 `import './qa/'`
- `A3/B1`（`:44-49`）：`src/main/qa/` 目录清单**逐字比对**
  `'ballshot.ts,fixtures.ts,modes.ts,shots.ts,uitest.ts'` —— **加第 6 个文件会红**

---

## 6. uitest 可观察性

### 6.1 现有的两个托盘观测点

| 观测点 | preload | ipc.ts | 主进程实现 | uitest 断言 |
|---|---|---|---|---|
| `debug:tray-title` | `index.ts:114` | `ipc.ts:495` | **不走 `lastTitle`**，而是现场重算 `trayTitle(currentState().snapshots, ...)` | `uitest.ts:687-692` `r.trayTitle` |
| `debug:tray-mode` | `index.ts:116` | `ipc.ts:497` | `trayInteractionMode()`（`tray.ts:69-71`） | `uitest.ts:694-701` `r.trayMode` |

```ts
// uitest.ts:687-692
687:  // 状态栏（托盘）标题：多时限窗口应平铺展示（如 `5H 4% W 52% M 68%`）
688:  const trayTitle = String(await exec('window.api.debugTrayTitle()'))
689:  r.trayTitle =
690:    !trayTitle || (!/undefined|NaN/.test(trayTitle) && /[0-9]/.test(trayTitle))
691:      ? `ok(${trayTitle})` : `fail:${trayTitle}`
```

⚠ **`r.trayTitle` 的现有判据极弱**：只要「非空 + 不含 undefined/NaN + 含数字」就算 ok，
不做任何格式比对。所以**加颜色不会让它变红，也不会让它变绿有区别** ——
它对「标题长什么样」几乎没有约束力。

### 6.2 图标侧：**uitest 里没有观测点**

`trayImageInfo()`（`tray.ts:138-146`，返回 `{ empty, size, iconKey }`）**只被 `--smoke` 用**：

```ts
// src/main/qa/modes.ts:65（runSmoke 的 JSON 输出）
65:  tray: { title: currentTrayTitle(), ...trayImageInfo() },
```

`--uitest` 走的是 `runUiTestAndReport`（`modes.ts:79-82`），**不调 `trayImageInfo`**。
preload 也没有 `debugTrayImage` 之类的通道（`index.ts:111-116` 只有 `debugPush` /
`debugTrayTitle` / `debugTrayMode`）。

**含义**：图标状态目前**在 `--uitest` 里完全不可观测**。要给图标加等级，
必须**新增一个 `debug:` 通道**（改 `preload/index.ts` + `ipc.ts` + `uitest.ts` 三处），
否则只能靠 `--smoke` 的人工看 JSON。

### 6.3 已有的「推夹具 → 断言」范式（可直接复用）

`uitest.ts:121-126`：

```ts
121: const pushFix = async (snaps: unknown[]): Promise<void> => {
122:   await exec('window.api.debugPush([], false)')      // 先推空：窗口索引归零 / 轮播节拍重置
123:   await sleep(150)
124:   await exec(`window.api.debugPush(${JSON.stringify(snaps)}, false)`)
125:   await sleep(500)
126: }
```

夹具工厂 `uitest.ts:69-113`：`fw(name, percent)` / `planFix(id, name, windows)` /
`FIX_PLAN3` / `FIX_PLAN1` / `FIX_BAL` / `FIX_AB` / `FIX_NOLIMIT`。
**`fw()` 直接接受 percent，做托盘等级夹具不需要新造轮子** ——
加一个 `FIX_TRAY_WARN`（percent 70）/ `FIX_TRAY_DANGER`（percent 90）即可。

⚠ **两个已知的 uitest 陷阱**（`quality-guidelines.md:489-556`）：
1. `npx electron . --uitest` 跑的是 `out/`，**改完源码必须先 `npm run build`**，
   否则测的是上一次产物（此坑「静默作废过一整轮验证」）。
2. `executeJavaScript` **不是模块，顶层 `await` 直接抛**，且只体现在 `execErrors` 里，
   其他断言照样 ok —— 看起来像 flake。用 `.then()`。

---

## 7. 各平台能力差异（一览表）

| 能力 | macOS | Windows | 依据 |
|---|---|---|---|
| 托盘标题文字 | ✅ `setTitle` | ❌ **不存在** | `electron.d.ts:14666` `@platform darwin`；issue #13148 |
| 标题着色 | ✅ **ANSI 颜色**（含 `fontType`） | ❌ 无标题 | Electron tray.md「Support ANSI colors」+ v37 `NSString+ANSI.mm` |
| 可选颜色数 | 8 终端色 + 暗色变体，**无橙、无自定义 hex** | — | `NSString+ANSI.mm` switch |
| 图标 template 化 | ✅（`tray.ts:95`）→ **RGB 丢弃，只剩 alpha** | ❌（`:33-35`/`:95` 只在 darwin 调）→ 图标可以是多色 | native-image.md「black and an alpha channel」；benjgo「ignore the colour, only use the alpha channel」 |
| 表达多等级的图标手段 | **灰度分层**（alpha / 直径 / 形状） | 真彩色 | 同上 |
| 按下高亮反色 | ⚠ 用 attributedTitle 后**可能不再反色**（社区记录，需实测） | N/A | StackExchange「Highlighting NSStatusItem with attributed string」 |
| tooltip | ✅ 全平台 | ✅ 全平台 | `tray.ts:130` |

---

## 8. 需要澄清的问题（给 PRD / 拍板）

**Q1（阻塞）· ANSI 着色在 Electron 37 + `fontType:'monospacedDigit'` 下是否真的生效？**
文档说支持，2021 年的 bug 已修并 backport 到 14-x-y，本仓是 37.10.3，**理论上没问题**；
但 `quality-guidelines.md` 对「文档说 vs 实测」有明确立场（§85-91「Don't: trust a label —
verify the mechanism」）。**建议在写 PRD 之前花 10 分钟实机验一次**（一行
`tray.setTitle('\x1b[31m52.9%\x1b[39m', {fontType:'monospacedDigit'})`），
顺带看一眼**按下时的高亮反色**是否可接受。

**Q2（阻塞）· 阈值用哪一套？**
- 选项 A（**推荐**）：复用 85/60 的 `levelOfPercent`，与卡片/详情/球完全一致。
  代价：等级判定要从 `renderer/src/format.ts` 搬到跨进程可达的位置
  （`src/shared/` 或 `tray-text.ts`）。这与 ipc.ts:85 / systemNotify.ts:30 记录的
  「文件所有权不许新增 shared 文件」既往约束**直接冲突** —— 需要明确豁免，
  或者接受 (b) 写第二份 + 静态比对门（`test-system-notify.mjs:241-260` 的现成范式）。
- 选项 B：坚持 PRD 的 80/50。**代价已明确**：用量 62% 时卡片是橙色、托盘是绿色，
  同屏自相矛盾且用户无法解释。
- 选项 C：托盘用 80/50 但同时把 UI 的 85/60 也改成 80/50（口径统一）。影响面超出本任务。

**Q3 · 「橙」怎么办？** ANSI 没有橙。可选：(i) 用 33（纯黄）；(ii) 用 `1;33`（#cdcd00 暗黄，
最接近橙）；(iii) 放弃标题着色，只做图标状态点。需要产品拍板视觉稿。

**Q4 · 状态点用灰度分层（alpha/直径）还是整套图标切换？**
macOS template 下「彩色圆点」不存在，只能灰度。灰度三档在小尺寸（22px）下是否可辨，
**必须实机看**（`--shots` 截不到托盘，只能肉眼或 `screencapture`）。

**Q5 · 图标等级的观测点要不要加？** 现在 `--uitest` 完全看不到托盘图标
（`trayImageInfo` 只有 `--smoke` 用，`modes.ts:65`）。要么新增 `debug:tray-image` 通道
（改 3 个文件），要么接受「图标层只有 smoke 人工观测」。

**Q6 · 现有断言太弱要不要顺手加严？** `r.trayTitle`（`uitest.ts:689-692`）只判
「非空 + 有数字」，加颜色后它依然不会区分对错。加严还是保留？

---

## 9. 附：文件清单（本次调研读到 / 引用的）

### 核心改动面（预估）

| 文件 | 行数 | 与本任务的关系 |
|---|---|---|
| `src/main/tray.ts` | 146 | `setTitle`（:106）、`setTrayIcon`（:77-99，key 去重 :80、template :95）、`updateTray`（:101-131）、观测点（:134-146） |
| `src/shared/tray-text.ts` | 87 | `trayTitle`（:70-80）、`providerSummary`（:51-63）、`primarySnapshot`（:66-68） |
| `src/renderer/src/ProviderMark.tsx` | 87 | `renderMarkPng`（:59-79，canvas 绘制）、`renderTrayIcon`（:82-85） |
| `src/renderer/src/App.tsx` | ~1100 | `primaryMark` + 托盘图标 effect（:980-993）；已 import `shared/tray-text`（:20） |
| `src/preload/index.ts` | 169 | `setTrayIcon`（:42-43）、`debugTrayTitle`（:114）、`debugTrayMode`（:116） |
| `src/main/ipc.ts` | ~500 | `tray:icon`（:395-397）、`debug:tray-title`（:495）、`debug:tray-mode`（:497） |
| `src/renderer/src/format.ts` | 90 | `Level`（:55）、`levelOfPercent` 85/60（:57-64）—— 若复用需搬位置 |
| `src/renderer/src/read-model.ts` | 101 | `snapshotLevel`（:48-53）、`windowLevel`（:56-58）、`severityRank`（:64-75）、`ballLevel`（:96-101） |
| `src/main/qa/uitest.ts` | 954+ | `r.trayTitle`（:687-692）、`r.trayMode`（:694-701）、夹具工厂（:69-126） |
| `src/main/qa/modes.ts` | 145 | smoke 的 `trayImageInfo()`（:65） |

### 测试 / 脚本

| 文件 | 覆盖 |
|---|---|
| `scripts/test-tray.mjs` | 29 项（已实跑全绿），`loadTs('src/shared/tray-text.ts')` |
| `scripts/test-read-model.mjs` | D3/D4/D5 = 85/60 边界（:70-72），D6 = 无百分比→ok |
| `scripts/test-structure.mjs` | 45 条静态门（C1/C2/A3/B1 与本任务相关） |
| `scripts/test-system-notify.mjs:241-260` | 「无共享模块时靠静态比对钉住两份字面量」的现成范式（H 段） |
| `scripts/lib/load-ts.mjs` | esbuild 内存打包，纯函数测试的零成本入口 |
| `scripts/lib/png-probe.mjs` | 纯 zlib 解 PNG → RGBA，像素级断言的唯一现成工具 |
| `scripts/lib/electron-stub.mjs` | electron 替身，**当前只有 `net.isOnline`** |

### 文档 / 资产

| 文件 | 关键内容 |
|---|---|
| `.trellis/spec/frontend/directory-structure.md:18` | `tray-text.ts` 的 spec 描述（**与实际不符**：说 main-only，实际渲染层也 import） |
| `.trellis/spec/frontend/directory-structure.md:162-164` | `src/shared/` 同时在两个 tsconfig project —— 跨进程代码的唯一落点 |
| `.trellis/spec/frontend/directory-structure.md:205-208` | 「一个实现，多个消费者」的样板（percent.ts / read-model.ts） |
| `.trellis/spec/frontend/quality-guidelines.md:489-556` | QA harness 契约 + 三个已踩过的坑（build / executeJavaScript / select） |
| `.trellis/spec/frontend/quality-guidelines.md:85-113` | 「别信标签，去验机制」「别肉眼看截图，去解像素」 |
| `.trellis/spec/frontend/component-guidelines.md:255-259` | 「别在 TSX 里写 severity switch，用 read-model」 |
| `build/trayTemplate.png` / `@2x.png` | 16×16 / 32×32，`gen-icons.js:172-173` 生成（`genTrayIcon`，纯黑+alpha） |
| `build/tray.ico` | 24×24 Windows（`gen-icons.js:174`） |
| `.trellis/tasks/archive/2026-09/09-30-similar-projects-research/research/report.md` §6 P1-3 | 竞品报告原文：「>80% 红、>50% 橙」+ 「增加一个小的状态点或角标」 |

### 外部参考

- [Electron Tray 文档](https://github.com/electron/electron/blob/main/docs/api/tray.md) —
  `setTitle` 「Support ANSI colors」；macOS 图标须为 template image，16×16 / 32×32@2x 推荐
- [Electron nativeImage 文档](https://github.com/electron/electron/blob/main/docs/api/native-image.md) —
  「Template Image _macOS_：consist of black and an alpha channel」
- [`NSString+ANSI.mm`（v37.10.3 tag）](https://raw.githubusercontent.com/electron/electron/v37.10.3/shell/browser/ui/cocoa/NSString%2BANSI.mm) —
  8 色表与 dark 变体的权威来源
- [electron#29287 + PR#30146](https://github.com/electron/electron/issues/29287) —
  `fontType` 曾使 ANSI 失效，已 backport 至 14-x-y
- [electron#13148](https://github.com/electron/electron/issues/13148) —
  维护者：「Windows does not support tray icon titles」
- [Designing macOS menu bar extras（benjgo）](https://benjgo.com/articles/designingmenubarextras/) —
  template image 忽略颜色、只用 alpha；「different levels of opacity to provide shading …
  often used to indicate state」
- [Highlighting NSStatusItem with attributed string](https://exchangetuts.com/index.php/highlighting-nsstatusitem-with-attributed-string-1640754663775038) —
  attributedTitle 后高亮不再反色（**社区记录，需实测**）

---

## 10. 未解 / 未验证（明确标出）

1. **未实机验证** ANSI 着色 + `fontType:'monospacedDigit'` 在 Electron 37.10.3 的表现（Q1）
2. **未实机验证** macOS 菜单栏项按下时 attributedTitle 是否反色（§2.1 末）
3. **未验证** 22px 图标上灰度状态点三档是否肉眼可辨（Q4）
4. **未确认** `tray.getTitle()` 在有 ANSI 时返回什么（带码还是纯文本）—— 若 uitest 要断言
   标题里的颜色，得先知道它返回什么。当前 `debug:tray-title`（`ipc.ts:495`）绕开了它，
   现场重算 `trayTitle(...)`，所以**它天然测不到 ANSI**（除非颜色逻辑写进 `tray-text.ts`）
5. **未评估** 把 `levelOfPercent` 搬进 `src/shared/` 对 `test-read-model.mjs`、
   `type-safety.md:140-144`、`quality-guidelines.md` 里已引用的行号的影响（spec 更新面）