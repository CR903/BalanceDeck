# Research: P1-6 轻量 CLI / JSON 快照导出

- **Query**: `balancedeck export --json` 的实现前调研 —— 启动形态分派、数据来源取舍、argv 坑、JSON 形状、
  数据诚实标注、隐私红线、测试落点、`--out` / 人类可读
- **Scope**: internal（`src/main` / `src/shared` / `scripts` / spec / 测试）+ external（Electron argv 与
  `app.getPath` 时机、竞品 opencode-quota 的 external-integration 文档）+ 本机实测（Electron 37.10.3）
- **Date**: 2026-10-01
- **Task**: `.trellis/tasks/10-01-p1-cli-export`（status `planning`，PRD 只有 Goal，Requirements / AC 全 TBD）
- **约束遵守**: 未改任何代码。临时探针目录（`/tmp/bd-argv` 等）已删除。

---

## 0. 一句话结论（先看这个）

> **推荐「路 D + 路 E」双档**：让**常驻的应用进程**在每轮采集后把一份只读快照写到独立文件
> （不是 `extras`），`balancedeck export --json` **纯读那个文件**（零出网、亚秒级）；
> `--refresh` 才让 CLI 进程自己跑一轮采集。
>
> 理由三条：
> 1. `scheduler.currentState()` 是**进程私有内存**（`scheduler.ts:33-38` 的模块级 `let`），且本仓
>    **没有单实例锁**（全仓 grep 无 `requestSingleInstanceLock`）—— 独立 CLI 进程**读不到**常驻进程的状态，
>    除非自己再采一轮。
> 2. 「自己采一轮」意味着 tmux 每 30s 轮询就并发打 N 家 API（`request.ts:19` 每家 12s 超时），
>    与竞品明确写的 "reads from the disk cache only — **no network calls**" 相反，也和本批次
>    「无新增网络请求」的 AC 冲突。
> 3. 竞品的落地形态就是**导出文件**（`~/.cache/opencode/quota-export.json`，TUI 每分钟刷新一次），
>    CLI 与状态栏读的是同一个文件 —— 一份数据两个消费者。
>
> ⚠ **但路 D 有两个必须先解决的问题**（写在 §2.5 / §10）：
> **① 双进程写 `usage-history.json` 会互相覆盖丢数据**（`usageStore.ts:99` 每进程一份内存 cache +
> `:121` 整文件覆写）；**② 采集路径会把 `setKey` 注入 `CollectContext`**（`scheduler.ts:74`，
> 供 cookie 自愈回写），CLI 若走这条路可能重写 `secrets.bin`。

---

## 1. 应用启动形态：argv 怎么分、分派在 ready 前还是后（Q1）

### 1.1 五个 QA 模式的分派点

全部在 `src/main/index.ts`。argv 读取在**模块体**（top-level），分派在 **`app.whenReady()` 回调内**：

```ts
// src/main/index.ts:15-22 —— 认参数（模块体求值，app ready 之前）
const smoke       = process.argv.includes('--smoke')
const uitest      = process.argv.includes('--uitest')
const shots       = process.argv.includes('--shots')
const detailsTest = process.argv.includes('--details-test')
```

```ts
// src/main/index.ts:91-115 —— 分派（whenReady 回调内，ready 之后）
if (detailsTest) { await runDetailsTest(); app.quit(); return }      // :91-95
if (process.argv.includes('--ballshot')) { await runBallshot(); return }  // :98-101
if (shots)       { await runShotsMode(pushState); app.quit(); return }    // :103-107
if (smoke || uitest) {                                                  // :109-115
  const t = setupTestApp(pushState)
  if (smoke) await runSmoke(t); else await runUiTestAndReport(t)
  app.quit(); return
}
```

**答案：全部在 app ready 之后分派。** `--ballshot` 是唯一例外意义上的例外 —— 它 `return` 而不 `app.quit()`
（退出交给 `ballshot.ts:17` 的兜底 `setTimeout` 与 `:263`），但分派点同样在 ready 之后。

### 1.2 ready 之前发生了什么（对 CLI 很重要：这些是**无条件**执行的）

```ts
// src/main/index.ts:29    BD_USER_DATA → app.setPath('userData', …)   ← 必须在 ready 前
// index.ts:31-35          BD_SANDBOX_OFF=1 → 三个 commandLine switch
// index.ts:58             appendSwitch('autoplay-policy', …)          ← 必须在 ready 前（注释 :54-55 说明）
// index.ts:60             app.dock?.hide?.()
// index.ts:63             registerHumanAssetScheme()                  ← bd-asset:// 特权 scheme
// index.ts:65             loadPersisted()                             ← 读 userData/state.json
// index.ts:68             configureProviders(keystoreStore)           ← 组合根注入，registerIpc 的前置
// index.ts:69             registerIpc()                               ← 注册全部 ipcMain handler
```

⚠ 对 CLI 的三个含义：

1. **`registerIpc()` 已经跑了**（`index.ts:69`，模块体）。它内部会读 argv 决定要不要挂调试通道：
   ```ts
   // src/main/ipc.ts:485-489
   if (process.argv.includes('--uitest') || process.argv.includes('--shots') ||
       process.argv.includes('--ballshot')) { /* 注册 debug:* 一族 */ }
   ```
   `export` 不会命中 → **不会**暴露任何调试 handler。这一点是天然的安全默认值，不要改。
2. **`configureProviders(keystoreStore)` 已经跑了**（`index.ts:68`），所以 CLI 分支里可以直接用
   `listInstances()` / `listProviders()`，不需要重新装配。
3. **`loadPersisted()` / `registerHumanAssetScheme()` / `app.dock.hide()` 对 CLI 是无意义的开销**
   （读一个 json、注册一个 scheme）。它们在模块体，无法按 argv 跳过 —— 除非把 CLI 分派提到模块体
   （**不建议**，见 §3.4）。

### 1.3 QA 模式与 `export` 的定位差异

`src/main/qa/modes.ts:8-16` 把定位写死了：

```ts
// 各 QA 运行模式的一次性入口（--shots / --smoke / --uitest / --details-test）
// 入口模块只做「认参数 → 交给这里 → 退出」，因为它的接口是「启动应用」。
// 这些模式都要一个窗口、托盘与调度器，但输出与退出方式各不同，所以在这里收口。
//
// 结果契约：UI 断言以 JSON 打到 stdout，**不设置退出码** —— 失败与否由调用方解析；
// 谁要把它接进 CI，得先补退出码（见 scripts/test-structure.mjs 的说明）。
```

关键差异：

| | QA 模式 | `export`（产品功能） |
|---|---|---|
| 是否建窗口 | 大多要（`setupTestApp` → `createOverlay`，`modes.ts:29`） | **不要** |
| 是否建托盘 | 要（`modes.ts:42` `createTray`） | **不要** |
| 是否起调度器 | 要（`modes.ts:44` `startScheduler`） | 不要（一次性） |
| 退出码 | 不设（`modes.ts:14-15` 明说） | **必须设**（脚本消费） |
| 归属 | `src/main/qa/`（**封闭 5 文件**，见 §7.3） | 必须另开目录 |

**结论：`export` 不能放进 `src/main/qa/`** —— `scripts/test-structure.mjs:47-51` 逐字断言该目录恰好
5 个文件，多一个就红：

```js
// scripts/test-structure.mjs:48-51
ok(qaFiles.join(',') === 'ballshot.ts,fixtures.ts,modes.ts,shots.ts,uitest.ts',
   `B4 src/main/qa/ 只放这五样（当前 ${qaFiles.join(', ')}）`)
```

而且 `qa/` 是**测试工具**（`modes.ts:2` 「这里的代码不参与产品运行」），`export` 是产品功能。

**推荐落点：新目录 `src/main/cli/`**（`export.ts` = 纯函数 + 装配，`index.ts` 只加分派那 4 行）。
`test-structure.mjs:69-73` 的 C2 只扫 `src/main` 顶层的 `.ts` 文件（`readdirSync(...).filter(f => f.endsWith('.ts'))`），
子目录名不以 `.ts` 结尾 → **自动豁免**，不需要改守卫。

---

## 2. 数据来源：三条路的取舍（Q2）★核心

### 2.0 先纠正一个前提

`scheduler.currentState()` 返回的是**模块级变量**，不是任何跨进程可见的东西：

```ts
// src/main/scheduler.ts:33-38
let push: PushFn | null = null
let updateTray: TrayFn | null = null
let lastSnapshots: ProviderSnapshot[] = []      // ← 进程私有
let lastSync: string | null = null             // ← 进程私有
let timer: NodeJS.Timeout | null = null
let running = false

// src/main/scheduler.ts:212-214
export function currentState(): AppState {
  return { snapshots: lastSnapshots, lastSync, scanning: running, offline: isOffline() }
}
```

**独立 CLI 进程读不到它。** 佐证：

- 全仓 `grep -rn "requestSingleInstanceLock|second-instance|makeSingleInstance" src/` → **零命中**。
  没有单实例锁 = 没有 `second-instance` 事件 = **两个进程完全并行、互不可见**。
- 没有 unix socket / named pipe / 共享内存 / `MessagePort`（全仓无相关代码）。
- 因此「读常驻进程的内存」这条路**不存在**。`currentState()` 只能反映**CLI 进程自己**跑的那一轮。

### 2.1 三条路的取舍表

| | **路 A：读常驻进程内存** | **路 B：CLI 自己采一轮** | **路 C：读 `usage-history.json`** |
|---|---|---|---|
| 可行性 | ❌ **不可行**（无单实例锁，无 IPC 通道） | ✅ 可行（复用 `startScheduler`） | ⚠️ 可读但**字段不够** |
| 字段完备性 | — | ✅ 全字段（就是 `ProviderSnapshot`） | ❌ 只有 `{providerId, window, t, pct}` |
| 数据新鲜度 | — | 官方实时（≤12s） | **15 分钟**粒度（`usageStore.ts:39`） |
| 网络开销 | — | ❌ N 家并发，每家 12s 超时 | 零 |
| 启动开销 | — | Electron 冷启 **实测 520–760ms**（§3.3） | 纯 node，<50ms |
| tmux 30s 轮询是否可接受 | — | ❌ 持续打爆各家 API | ✅ |
| 副作用 | — | ⚠️ 写 `usage-history.json` + 可能 `setKey`（§2.5） | 零 |
| 文件可能不存在 | — | — | ⚠️ **会**（§2.3） |

### 2.2 路 B 的隐藏代价：会**丢掉**「数据诚实」的核心逻辑

`scheduler.ts:60-106` 的 `collect()` 里有两段不能重写的东西：

```ts
// src/main/scheduler.ts:85-91
for (const id of activeIds) {
  const next = freshById.get(id)
  if (next) merged.push(applyCachePolicy(prevById.get(id), next))   // ← 最后有效值策略
}
lastSnapshots = merged
```

`applyCachePolicy`（`src/shared/quality.ts:37-59`）是「本轮失败时沿用上次官方数据并标 `cached`」的唯一实现，
带 24h 上限（`quality.ts:19` `MAX_CACHE_AGE`）。它依赖 `prevById` —— **上一个进程内轮次的快照**。

一个全新 CLI 进程里 `prevById` 恒为空 → `applyCachePolicy(undefined, next)` 直接 `return next`
（`quality.ts:42`）。**所以路 B 产出的 `dataQuality` 永远不会是 `cached`。**

这不是缺陷，而是必须写进 PRD 的事实：**CLI 自己采的那一轮，「缓存」这个状态在结构上不存在。**
数据诚实在 CLI 场景下要靠别的东西兜（见 §5.3）。

### 2.3 路 C 的字段缺口（逐字段核对）

磁盘格式（`src/main/usageStore.ts:44-53`）：

```ts
interface DayPoint { window: string; t: number; pct: number | null }
interface UsageFile { version: 1; days: Record<string, Record<string, DayPoint[]>> }
```

| PRD 要求的导出字段 | `usage-history.json` 有吗 |
|---|---|
| 供应商 id | ✅ 作为 `days[日期][providerId]` 的键 |
| 供应商 name | ❌ |
| 供应商 kind | ❌ |
| 各窗口 name | ✅ `window` |
| 各窗口 used / limit / unit | ❌ |
| 各窗口 percent | ✅ `pct`（**已归一化过**，`percent.ts:14-20`） |
| resetAt | ❌ |
| dataQuality | ❌ |
| updatedAt | ⚠️ 只有 `t`（采样时刻，非采集时刻） |

**缺 6 个必需字段 → 路 C 不能作主数据源。**

还有两个更硬的问题：

1. **文件可能根本不存在。** `sampleUsageHistory` 有三重提前返回：
   ```ts
   // src/main/scheduler.ts:127-138
   if (lastSnapshotAt !== null && now - lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return  // 间隔
   if (lastSnapshots.length === 0) return                                            // 没供应商
   for (const s of lastSnapshots) { if (s.status !== 'ok') continue }                // 只记 ok
   if (points.length === 0) return                                                    // 没有可记的窗口
   ```
   **全部采集失败 / 无供应商 / 全是 error 时就不写文件。** 本机实测：
   `~/Library/Application Support/balancedeck/` 下**只有 `secrets.bin` 与 `state.json`，没有
   `usage-history.json`** —— 与上面第 3 条吻合。CLI 若以它为数据源，用户会看到「文件不存在」。
2. 它是**历史**（30 天分桶），不是**当前快照**。用它导出等于给用户一份 15 分钟前的百分比，
   且丢掉「余额」类供应商（余额窗口没有 limit → `pct` 恒 `null`，`percent.ts:17` 要求 `limit > 0`）。

**路 C 的正确定位**：趋势 / 历史补充（P1-1 趋势图已在用，`ipc.ts:374-380`），**不是导出源**。

### 2.4 路 D（推荐）：常驻进程周期性写「导出快照」文件

形态对齐竞品。opencode-quota 的 `docs/readme/external-integration.md` 明确给了两条独立通道：

| What you need | Use |
|---|---|
| Run a command and get JSON | `opencode-quota show --json` |
| **Read the same JSON often** | **Export file** |

导出文件路径 `~/.cache/opencode/quota-export.json`（`XDG_CACHE_HOME` 可覆盖），
「The TUI refreshes the file about once a minute. A write error is logged, but it does not break the TUI.」
—— 即：**写失败不许影响主流程**。tmux 示例直接 `jq` 读那个文件（`status-interval 30`）。

本仓对应设计：

| 维度 | 决定 | 依据 |
|---|---|---|
| 落在哪 | `app.getPath('userData')` 下的独立文件，**不是 extras** | `usageStore.ts:19-23` 已把「不得走 extras」钉成断言（`test-usage-store.mjs:250-251`）；`store.ts:92-97` 的 `setExtra` 每次全量重写整个文件 |
| 谁写 | `scheduler.collect()` 的 `finally`（`scheduler.ts:97-105`）或 `index.ts:71-75` 的 `pushState` | 后者**不改 scheduler.ts**，与本任务「不要碰 scheduler.ts」的约束相容 |
| 写失败 | `try/catch` 吞掉，只 `debugLog` | 与竞品同纪律；「写文件坏了不该让采集跟着坏」已是本仓既有原则（`scheduler.ts:121-123`） |
| 节流 | 复用 `SNAPSHOT_INTERVAL_MS`（15min）太慢 —— 建议跟采集周期走但**至少 10s**（`MIN_INTERVAL`，`scheduler.ts:30`） | tmux 默认 30s 轮询 |
| 体积 | 全量 `ProviderSnapshot`（含 `models` / `modelsByWindow`）约几 KB～几十 KB | `fixtures.ts:10-52` 的 demoSnapshot 就是这个量级 |
| 隐私 | 落盘前**过一遍脱敏**（§6） | |

### 2.5 ⚠ 路 B / 路 D 各自的双进程风险（**必须先解决**）

**风险 ①：`usage-history.json` 会被互相覆盖**

```ts
// src/main/usageStore.ts:97-99
export function createUsageStore(opts: { filePath: () => string }): UsageStore {
  const { filePath } = opts
  let cache: UsageFile | null = null          // ← 每进程一份

// src/main/usageStore.ts:119-122
function persist(): void {
  if (!cache) return
  writeFileSync(filePath(), JSON.stringify(cache), 'utf-8')   // ← 整文件覆写
}
```

时序：CLI 进程在 T0 读全文件 → T1 写回。**常驻进程在 T0..T1 之间追加的采样会被 T1 的整文件覆写抹掉。**
两个进程都这么干，历史序列会出现随机缺口，而预测（`usagePredict.ts` 的速率回归）会把缺口读成
「用量停了」—— 正是 `scheduler.ts:120-122` 明令要避免的。

> **规避**：CLI 的导出路径**不要调用 `sampleUsageHistory`**。它由 `collect()` 的 `finally` 无条件触发
> （`scheduler.ts:102` `void sampleUsageHistory().catch(() => {})`），所以**路 B 天生带这个副作用**。
> 路 D（纯读文件）天然没有这个问题 —— 这是路 D 优于路 B 的又一个理由。

**风险 ②：`secrets.bin` 可能被 CLI 重写**

```ts
// src/main/scheduler.ts:70-77
const fresh = await collectAll(adapters, {
  now,
  getKey: async (id) => (await getKey(id)) ?? envValueFor(id),
  getExtra: async (k) => (await getExtra(k)) ?? envExtraFor(k),
  setKey: async (id, v) => setKey(id, v),      // ← 回写通道（cookie 自愈）
  request
})
```

`setKey` 的用途见 `opencode.ts` 的 cookie 轮换自愈。`store.ts:60-79` 的 `persist()` 同样是整文件覆写
（`store.ts:12` 磁盘格式 `{ version: 1, items, extras }`）。若 CLI 进程里的适配器触发一次自愈回写，
就会用它那份**启动时读的旧快照**覆盖常驻进程刚写的凭据。

> **规避**（若最终选路 B）：CLI 的 `CollectContext` 注入一个**只读** `setKey`（no-op 或写临时文件），
> 不复用 `scheduler.ts:74` 那一行。这也是把采集逻辑抽成可注入上下文的价值所在
> （`adapters/types.ts:24-36` 的 `CollectContext` 就是为此存在的接缝）。

### 2.6 建议的双档设计

```
balancedeck export              → 人类可读表格（默认）
balancedeck export --json       → JSON 到 stdout
balancedeck export --json --out <path>   → JSON 写文件
balancedeck export --json --refresh      → ⚠️ 触发一轮真实采集（出网，见 §2.1 路 B 的代价）
```

- **默认档（路 D）**：零出网、亚秒、可被 tmux 每 30s 轮询。
- **`--refresh` 档（路 B）**：用户明确要新鲜数据时的兜底，代价是出网 + §2.5 的两个风险
  （必须在文档里写明「会与常驻实例争写 usage-history.json」）。

---

## 3. CLI 调用形态与 argv 坑（Q3）

### 3.1 开发态 vs 打包态的命令名

| 场景 | 命令 | argv 实测 |
|---|---|---|
| 开发（未打包） | `npx electron . export --json` | `["<electronBin>", ".", "export", "--json"]` |
| 开发（npm script） | `npm run export -- --json` | 同上 |
| macOS 打包后 | `/Applications/BalanceDeck.app/Contents/MacOS/BalanceDeck export --json` | `["<exe>", "export", "--json"]` |
| macOS `open -a` | `open -a BalanceDeck --args export --json` | 同上 |
| Windows 打包后 | `…\Programs\BalanceDeck\BalanceDeck.exe export --json` | 同上 |

- 可执行文件名来自 `electron-builder.yml:2` `productName: BalanceDeck`
  （electron-builder 用 `appInfo.productFilename` 命名，`node_modules/app-builder-lib/out/platformPackager.js:317`）。
- 本仓**没有 `bin` 字段**（`package.json` 全文无 `bin`），所以**装完不会自动有 `balancedeck` 这个命令**。
  用户必须写全路径或自己 `alias`。这是要在 README 里明说的一件事。
- ⚠ macOS 从 **Finder** 启动的进程拿不到终端参数；要传参必须走 `open -a … --args` 或全路径。

### 3.2 ⚠ 最核心的坑：argv 偏移量在开发态和打包态**不同**

**本机实测（Electron 37.10.3）**：

```
# 开发态 electron .
isPackaged=false sliced=["export","--json","--out","/tmp/a.json"]
# 完整 argv: [".../Electron.app/Contents/MacOS/Electron", ".", "export", "--json", "--out", "/tmp/a.json"]

# 打包态（依据 Electron 官方 issue #4690 与 app.isPackaged 语义）
# argv[0]=exe, argv[1]=第一个用户参数
```

**结论：`process.argv.slice(app.isPackaged ? 1 : 2)`**。
`app.isPackaged` 已在别处使用（`tray.ts:26`、`autostart.ts:118`），是本仓既有的判定惯例。

> **现有的 `process.argv.includes('--smoke')` 之所以没踩到这个坑，是因为它做的是「包含」判断，
> 不依赖偏移量。`export` 是位置敏感的子命令，必须显式切片。**
> 参考：Electron 官方 issue #4690 记录了「开发态 argv 多一个 app 路径」的经典问题；
> `process.defaultApp` 亦可判定（实测开发态为 `true`），但 `app.isPackaged` 是官方推荐且本仓已在用。

### 3.3 启动开销实测

```
Electron 冷启 → app ready → 退出：wall_ms = 521 / 718 / 759（三次实测）
```

对比纯 node 读一个 json：**< 50ms**。这是路 D（纯读）vs 路 B（自己采）的量级差距，
也是 tmux 每 30s 轮询时选路 D 的直接理由。

### 3.4 三个具体的 argv 陷阱

**陷阱 ① `ELECTRON_RUN_AS_NODE`**

实测：设了 `ELECTRON_RUN_AS_NODE=1` 之后 `require('electron')` 直接
`Error: Cannot find module 'electron'`。若用户的 shell / CI 里有这个变量，
`balancedeck export` 会以一条毫无线索的栈崩掉。
→ 建议在 CLI 分支里 `try { require('electron') } catch` 并给一句人话提示（或至少在 PRD 里记一笔）。

**陷阱 ② Chromium 会吞掉不认识的 switch**

`--json` 不是 Chromium 开关，但**任何以 `-` 开头的 token 都可能被 Chromium 的命令行解析改写**
（Electron issue #20322 / #61554004 记录的 `second-instance` argv 损坏就是这条）。
本仓没有单实例锁，所以 CLI 进程读的是自己干净的 `process.argv`（实测正常）。
→ 但**不要用 `--` 开头的自定义 flag 承载位置语义**（子命令名 `export` 是裸词，安全）。

**陷阱 ③ 分派点不能提到模块体**

看起来「提前分派能省掉 `loadPersisted()` / `registerIpc()`」，但：
- `app.getPath('userData')` 在 ready 前**确实可用**（本机实测：`app.getPath('userData')` 在模块体
  返回 `/Users/zhouri/Library/Application Support/bdprobe`，不抛）——
  **但仓库注释说的真正理由不是「ready」**。`keystore.ts:12-14` / `usage-history.ts:9-12` 写的是
  「BD_USER_DATA 在 app ready 前才 setPath，而**静态导入先于模块体求值**」。
  也就是说约束是**导入顺序**，不是 ready 时机。把 CLI 分派提到模块体不会踩 `getPath`，
  但会踩「`index.ts:29` 的 `setPath` 还没跑」——如果 CLI 模块在 import 期就求值路径的话。
- `safeStorage` 本机实测 ready 前后都可用（`isEncryptionAvailable()` 两处均 `true`，加密→解密往返成功）。
- 但 `app.dock?.hide?.()`（`index.ts:60`）在 ready 前调用、Chromium 开关必须 ready 前（`index.ts:54-55`）
  这些都说明**模块体有它自己的顺序纪律**，插队风险高。

→ **建议：与 `--details-test` 同位置分派**（`index.ts:91` 那个位置），复用已跑好的
`configureProviders` / `registerIpc` / `setAppUserModelId` / `primePrefs`，只跳过后面的
`createOverlay` / `createTray` / `startScheduler`。改动最小、风险最低。

### 3.5 退出方式

- QA 模式用 `app.quit()`（`index.ts:93/105/113`），会触发 `before-quit` → `stopScheduler()`（`index.ts:130-132`）。
- CLI 需要**退出码**（竞品：`0` = 正常 / `1` = 低于阈值 / `2` = 无可比数据），
  `app.quit()` 不保证退出码。→ 用 `app.exit(code)`（实测立即退出，`wall_ms=521`）。
- ⚠ `app.on('window-all-closed')`（`index.ts:125-128`）只在 `smoke` 时 quit；
  CLI 没建窗口，这个事件**不保证触发** → 必须自己 `app.exit()`。

---

## 4. JSON 形状与 schema version（Q4）

### 4.1 可直接复用的 shared 类型

`src/shared/types.ts` 里现成的：

| 类型 | 位置 | 说明 |
|---|---|---|
| `Unit` | `types.ts:3` | `'usd' \| 'cny' \| 'token' \| 'request' \| 'percent'` |
| `ProviderKind` | `types.ts:11` | `'balance' \| 'coding' \| 'token'` |
| `ProviderWindow` | `types.ts:13-30` | `name / used / limit? / unit / resetAt? / note? / tokens? / percent?` |
| `ProviderStatus` | `types.ts:46` | `'ok' \| 'nodata' \| 'error' \| 'skipped'` |
| `DataQuality` | `types.ts:54` | `'official' \| 'local' \| 'cached'` |
| `ProviderSnapshot` | `types.ts:56-86` | 含 `windows / dataQuality / dataAt / updatedAt / degradedReason / failureReason / source / plan / mark` |
| `AppState` | `types.ts:146-152` | `{ snapshots, lastSync, scanning, offline? }` |

**建议：导出层不要重新定义窗口/供应商类型，直接复用 `ProviderWindow` / `ProviderSnapshot` 的字段名**，
只做**塑形 + 脱敏 + 补一个版本号**。理由：本仓已因「各写一份」吃过亏 ——
`api.d.ts:1-10` 记录了 `BalanceDeckApi` 与 preload 双向漂移的事故；
`shared/usage-predict.ts:9-13` 也写明「各写一份的后果不是重复劳动而是**无声漂移**」。

`percent` 字段必须用 `windowPercent()` 算，**不要直接透传 `w.percent`**：

```ts
// src/shared/percent.ts:14-20
export function windowPercent(w: ProviderWindow): number | null {
  let raw: number | null = null
  if (w.percent != null && Number.isFinite(w.percent)) raw = w.percent
  else if (w.limit != null && w.limit > 0) raw = (w.used / w.limit) * 100
  if (raw == null) return null
  return roundPercent(Math.max(0, Math.min(100, raw)))
}
```

理由：`w.percent` 可能 `undefined`（官方不给），此时必须回退到 `used/limit`；
且 `null`（不可知）**绝不能变成 0** —— 这是本仓反复强调的纪律
（`usage-predict.ts:30-35`、`quality-guidelines.md` 「Don't pass a plausible zero」、
`test-usage-store.mjs:145-149` 写盘侧也守同一条）。

### 4.2 schema version：**要加**

本仓已有两处 `version: 1` 的先例，且都被测试钉住：

```ts
// src/main/store.ts:24-28
interface SecretFile { version: 1; items: Record<string,string>; extras?: Record<string,string> }
// src/main/usageStore.ts:50-53
interface UsageFile { version: 1; days: Record<string, Record<string, DayPoint[]>> }
```

```js
// scripts/test-usage-store.mjs:81
eq(raw.version, 1, 'A5 磁盘格式带 version')
```

竞品用的是 `"version": 2`（顶层）—— 与本仓惯例一致。
→ **建议：顶层 `version: 1`**，与 `store.ts` / `usageStore.ts` 同一形状，
并且**第一条测试就断言它**（照抄 `test-usage-store.mjs:81` 的写法）。

### 4.3 建议的 JSON 形状（草案）

```jsonc
{
  "version": 1,
  "exportedAt": "2026-10-01T09:20:00.000Z",   // 本文件生成时刻
  "lastSync": "2026-10-01T09:19:41.000Z",    // ← AppState.lastSync，null 必须保留为 null
  "scanning": false,
  "offline": false,                          // ← AppState.offline，缺失即 false
  "stale": false,                            // 整体是否有任何非官方数据
  "providers": [
    {
      "id": "opencode",
      "name": "OpenCode Go",
      "kind": "coding",
      "plan": "Go 套餐",
      "mark": "opencode",
      "status": "ok",
      "dataQuality": "official",             // ← 直接来自快照（铸造时盖的章，ADR-0002）
      "stale": false,                        // ← isStale(snapshot)
      "staleLabel": "",                      // ← staleLabel(snapshot)，人类可读
      "dataAt": "2026-10-01T09:19:41.000Z",  // ← dataTime(snapshot)：cached 时 = 上次成功时刻
      "updatedAt": "2026-10-01T09:19:41.000Z",
      "source": "控制台（精确）",             // ⚠ 见 §6.1，此字段必须脱敏
      "degradedReason": null,
      "windows": [
        {
          "name": "5 小时",
          "used": 0.62,
          "limit": 12,
          "unit": "usd",
          "percent": 5.2,                    // ← windowPercent(w)，可为 null
          "resetAt": "2026-10-01T12:40:00.000Z"  // 缺失就不给这个键，不要给 ""
        }
      ]
    }
  ]
}
```

**形状选择说明**：

- `providers` 用**数组**而非对象。理由：`ProviderSnapshot[]` 的顺序 = 用户拖拽排序 = 优先级
  （`scheduler.ts:80-88` 按注册表顺序过滤；`tray-text.ts:66-68` `primarySnapshot` 取第一个有数据的）。
  竞品用对象（`providers: { copilot: {...} }`）是为了 jq 按 key 取；**数组保序**对本仓更有价值，
  且 `jq '.providers[] | select(.status=="ok")'` 一样好用。若要两者兼得，可加 `byId: { id: index }` 辅助字段。
- `percent` **可为 `null`**，且 `null` 与「键缺失」要区分：
  `limit` 未知（余额类，`percent.ts:17` 要求 `limit > 0`）→ `percent: null`。
- `resetAt` 缺失就**不给这个键**，不要给空串（`types.ts:21` 是 `resetAt?: string`）。
- `lastSync: null` 是合法值（`types.ts:148` 是 `string | null`，首轮未完成时为 null）—— 不能替换成 `new Date()`。

---

## 5. 数据诚实：cached / local 的标注（Q5）

### 5.1 `staleLabel` 的现状

```ts
// src/shared/quality.ts:67-76
export function isStale(s: { dataQuality?: string }): boolean {
  return s.dataQuality === 'cached' || s.dataQuality === 'local'
}
export function staleLabel(s: { dataQuality?: string }): string {
  if (s.dataQuality === 'cached') return '缓存'
  if (s.dataQuality === 'local') return '本机'
  return ''
}
```

- `staleLabel` 返回**中文短标签**、官方数据返回**空串**。已测（`test-quality.mjs:113-115`）。
- ⚠ **空串在 JSON 里是 ambiguous**：它同时可能表示「官方」或「字段没写」。
  脚本里 `if (label == null)` 与 `if (label == "")` 会走出不同分支，而 `label == ""` 恰好是官方 ——
  逻辑没错，但极易被误读。

### 5.2 推荐：机器字段用**字符串枚举**，人读字段用 `staleLabel`，两者都给

| 字段 | 类型 | 来源 | 为什么 |
|---|---|---|---|
| `dataQuality` | `'official' \| 'local' \| 'cached'` | **直接来自 `ProviderSnapshot.dataQuality`** | 这是 ADR-0002 在**铸造时**盖的章（`engine.ts:49-63`，`dataQuality` 是必填输入，缺失即编译错误）。**不需要重新判断**，只是搬运 |
| `stale` | `boolean` | `isStale(s)`（`quality.ts:67`） | 脚本最方便的判断形式：`if (.stale)` |
| `staleLabel` | `string` | `staleLabel(s)`（`quality.ts:72`） | 人类可读；批次 PRD 明确要求「取自 `shared/quality` 的 `staleLabel`」 |

**三条纪律**（与批次 PRD「不在新模块里写第二份判断」相容）：

1. `dataQuality` 是**搬运**不是**判断** —— 它由 `engine.ts:60` 在铸造时写入，导出层不许推导。
2. `stale` / `staleLabel` **必须调 `shared/quality` 的函数**，不许在新文件里写
   `s.dataQuality === 'cached' || s.dataQuality === 'local'`。
   （`tray-text.ts:78` 与 `format.ts:10` 都是 re-export 而非重写，遵循同一纪律。）
3. 顶层再给一个汇总 `stale`：`.providers | map(.stale) | any`，
   供 tmux 一句话判断「这个面板现在能不能信」。

### 5.3 CLI 场景下「诚实」的特殊形态（§2.2 的直接后果）

路 B（自己采一轮）产出的快照**永远不是 `cached`**（`applyCachePolicy` 在新进程里 `prev` 为空，
`quality.ts:42` 直接 return）。所以 CLI 必须额外表达**采集本身的状态**，否则脚本无从判断：

| 情况 | `status` | `dataQuality` | 需要额外表达 |
|---|---|---|---|
| 采集成功 | `ok` | `official` / `local` | — |
| 该家没凭据 | `nodata` | `undefined` | `detail`（`types.ts:66`，各适配器自己写，如 `opencode.ts:801`） |
| 该家出错 | `error` | `undefined` | `failureReason`（`types.ts:84`） |
| 全程离线 | 混合 | 混合 | 顶层 `offline: true`（`AppState.offline`，`types.ts:151`） |
| 路 D 读旧文件 | 快照里原样 | 可能是 `cached` | 顶层 `lastSync` + `exportedAt` 让脚本自己算 age |

竞品对应的字段是 `fromCache: true` + `cacheAgeSeconds: 42`（其 `QuotaExport` 文档）。
本仓的对等物是 `exportedAt` + `lastSync`（都是 ISO 字符串，**不加 `cacheAgeSeconds`** ——
那是派生值，脚本自己 `Date.now() - Date.parse()` 就行，多一个字段就多一处可能不一致）。

⚠ 顶层 `offline` 必须来自 `AppState.offline` 而不是自己重算 —— `isOffline()`
（`net.ts:59-68`）有「连续 2 次网络错误 + 期间无成功响应」的阈值语义，
在 CLI 的短生命周期里重算必然得到不同答案。

---

## 6. 隐私：密钥绝对不能进导出（Q6）

### 6.1 ⚠ 已发现的实际泄漏点：`snapshot.source` 里有一把 API key 的尾 4 位

```ts
// src/main/adapters/opencode.ts:198-202
function keyTag(entry: KeyEntry, multiAccount: boolean): string {
  const tail = `…${entry.key.slice(-4)}`                       // ← 密钥尾 4 位
  if (entry.label.startsWith('账号')) return multiAccount ? `${entry.label}(${tail})` : '官方 API'
  return `${entry.label}(${tail})`
}

// src/main/adapters/opencode.ts:780  →  :788
if (apiUsage) parts.push(`API · ${apiTag}`)
...
source: parts.join(' + '),                                       // ← 进了快照的 source 字段
```

多账号配置时，用户看到的卡片来源文案会是 `控制台（精确） + API · 账号1(…9dFe)`。
`source` 是 `ProviderSnapshot` 的字段（`types.ts:76`），**会被 JSON 导出**。

→ **必须在导出前处理 `source`。** 两条路：
（a）导出层做正则脱敏 `/(…|\()\.\.\.[0-9A-Za-z]{4}\)?$/` → 替换成 `(…)`；
（b）更干净：**导出层根本不导 `source`**，只在人类可读表格里用它。
建议 (b)，因为 `source` 是自由文案（各适配器自己拼），正则一定会漏。

### 6.2 其他需要审查的字段

| 字段 | 风险 | 处置 |
|---|---|---|
| `detail`（`types.ts:66`） | 嵌**响应体预览**：`engine.ts:108` `text.slice(0, 200)`、`protocol-adapter.ts:84-85` / `qwen.ts:103-104` / `volc.ts:101-102` / `copilot.ts:125-126` 各截 160 字符。响应体可能含账号标识 | 建议**默认不导**，或只导长度 |
| `detail`（copilot） | `copilot.ts:159` `detail: 账号 ${cred.user}` —— **GitHub 用户名** | 同上 |
| `degradedReason` / `failureReason` | 由适配器自撰，多数是错误文案；但 `opencode.ts:807-808` 会把 `apiError`（HTTP 状态 / 网络错误）拼进去 | 可导，但过一遍脱敏 |
| `source`（`opencode.ts:788`） | 见 §6.1，**含密钥尾 4 位** | **不导** |
| `plan` / `mark` / `name` / `kind` | 纯展示元数据 | 可导 |

### 6.3 存储侧的明文清单（回答「items/extras 里哪些是明文」）

两个命名空间，**互不相通**，用错会永远拿到 `null`（`qa/modes.ts:88-92` 记录过这个坑）：

```ts
// src/main/store.ts:11-13
// 磁盘格式与旧实现逐字兼容（version 1）：
//   { version: 1, items: { <id>: base64 密文 | 'plain:<base64>' }, extras: { <key>: 明文 } }
// 安全约束：源码、示例、测试禁止出现可用凭据字面量。
```

| 命名空间 | 加密 | 本机实测内容（`~/Library/Application Support/balancedeck/secrets.bin`，**只列键名，未读值**） |
|---|---|---|
| `items` | ✅ `safeStorage`（`keystore.ts:16-18`）；`safeStorage` 不可用时回落 `plain:` 前缀明文（`store.ts:75-76`） | `deepseek`、`opencodeCookie`、`inst:mukyp7ml-ndtec` |
| `extras` | ❌ **全明文** | `providerInstances`、`opencodeWorkspaceId`、`customProviders`、`refreshInterval`、`skin`、`enabled:minimax/kimi/zhipu`、`sample:usageHistoryDays`(未出现在本机)、`ui:*` 共 24 键 |

**逐项判断「算不算隐私泄漏」**：

| extras 键 | 内容 | 算不算密钥 | 处置 |
|---|---|---|---|
| `opencodeWorkspaceId` | org/workspace 标识（如 `org_xxx` / `wrk_xxx`，`opencode-auth.ts:36`） | **不是密钥本身**（认证靠 cookie，`ipc.ts:136-140`），但**与 cookie 组合即可访问该 workspace 的用量页**。且 `qa/modes.ts:123` 已经在打印时截断成 `wid.slice(0,8)+'…'` —— **仓库自己就把它当敏感处理** | **不进导出**。理由与 §6.1 同：导出没有它也能工作，暴露它零收益 |
| `providerInstances` | `ProviderInstance[]`（`types.ts:116-128`）：id/name/presetId/protocol/kind/baseUrl/enabled | 不含凭据，但 `baseUrl` 是用户配置的中转站地址（可能内网域名） | 不进导出 |
| `ui:*`（22 个） | 界面偏好 + TTS 配置（`ui:ttsConfig` 含**自定义 TTS 服务 URL**，`ipc.ts:236-238`） | 不是密钥，但 `ui:ttsConfig` 的 URL 是用户私有部署地址 | 不进导出 |
| `ui:hideBalance` | `'1' \| ''` | 不是隐私，是**用户意愿**：用户主动打码余额 | ⚠ 见 §6.4 |
| `skin` / `refreshInterval` / `enabled:*` | 偏好 | 无 | 不进导出 |

### 6.4 ⚠ 一个容易被漏掉的需求冲突：`ui:hideBalance`

```ts
// src/shared/types.ts:225-226（PetMenuModel）
/** 是否打码余额 */
hideBalance: boolean
```

用户可以在悬浮球右键菜单里勾「隐藏余额」（`ipc.ts:449`），此时**界面上余额是打码的**
（`qa/uitest.ts:703-726` 有对应断言）。如果 `balancedeck export --json` 绕过这个开关直接吐
`used: 1288.5`，那么「隐藏余额」这个偏好在 CLI 通道上**失效了**。

这不是密钥泄漏，但它是**用户明确表达的意愿**，与「数据诚实」同族。
→ **需要产品决策**（见 §10 问题 5）：CLI 导出是否要遵守 `ui:hideBalance`？
我的看法是**遵守**（余额类窗口的 `used` 打码 / 置 `null`），因为打码的目的是「不被人看到」，
而 stdout 会进 tmux 状态栏、shell history、日志 —— 传播面比屏幕大得多。

### 6.5 结论：导出的白名单

```
✅ 白名单（结构化、无自由文案）：
   顶层: version, exportedAt, lastSync, scanning, offline, stale
   每家: id, name, kind, plan, mark, status, dataQuality, stale, staleLabel, dataAt, updatedAt
   每窗: name, used, limit, unit, percent, resetAt
❌ 黑名单（自由文案 / 标识符 / 偏好）：
   source, detail, degradedReason, failureReason, models, modelsByWindow,
   以及任何 extras / items 的东西
```

`models` / `modelsByWindow`（`types.ts:69/74`）不含密钥，但体积大且是「每模型明细」——
建议 `--verbose` 才带，或干脆不进 v1。

---

## 7. 测试落点（Q7）

### 7.1 能不能不进 Electron 就测：**能，而且这是本仓的既有最优路径**

`scripts/lib/load-ts.mjs` 的机制：

```js
// scripts/lib/load-ts.mjs:26-39
export async function loadTs(relPath, { alias } = {}) {
  const result = await build({
    entryPoints: [resolve(ROOT, relPath)],
    bundle: true, format: 'esm', platform: 'node', target: 'node22', write: false,
    logLevel: 'silent', ...(alias ? { alias } : {})
  })
  const url = 'data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text, 'utf8').toString('base64')
  return import(url)
}
```

`scripts/lib/load-ts.mjs:11-15` 说明了 electron 替身的用途与原因：

> electron 替身是给 src/main 下那些「经 net.ts 间接依赖 electron」的模块用的：
> electron 的入口会 require('fs')，esbuild 打包成 ESM 后报
> `Dynamic require of "fs" is not supported`，导致这些模块在纯 node 里根本加载不了。

**关键设计决策**：把导出实现拆成
- **`src/main/cli/export.ts` —— 纯函数**（`parseArgs(argv)` / `buildExportDoc(appState)` / `renderTable(doc)`），
  **零 electron import** → `loadTs` 直接加载，**连 `ELECTRON_STUB` 都不需要**
- **`src/main/cli/index.ts`（或 `run.ts`）—— 装配**（读 userData、写文件、`app.exit`）

这正是 `store.ts` + `keystore.ts` 的形状，`directory-structure.md:202-204` 称之为
「the cleanest seam in the repo」。

**已有同款先例**：`scripts/test-usage-store.mjs:16-17` 直接
`await loadTs('src/main/usageStore.ts')`，且 `:253` 断言该文件 `!from 'electron'` —— 就是这个形状。

### 7.2 必须写的断言（照抄既有纪律）

`quality-guidelines.md` 的「Forbidden Patterns」逐条对应：

| 纪律 | 落法 | 依据 |
|---|---|---|
| **不许内联实现副本** | 全部经 `loadTs('src/main/cli/export.ts')` | `test-percent.mjs:19-23` 是**唯一**还在内联的（已漂移过），`quality-guidelines.md` 点名要求改 |
| **桩不许让测试静默走别的分支** | 若测装配层，`ELECTRON_STUB` 需**显式补齐**用到成员；`electron-stub.mjs:8-10` 明说「只实现被用到的成员，不要顺手补全」 | `electron-stub.mjs:5-10` |
| **负向断言要有前置** | `ok(storeCode.trim().length > 0, 'H0 前置…')` 模式 | `test-usage-store.mjs:249` |
| **剥注释再判** | 负向 grep 前先 `.replace(/\/\*[\*\/]*?\*\//g,'')` | `test-structure.mjs:336` 的 `stripComments`，理由写在 `:77-90`（三个真实踩过的坑） |
| **机制守卫** | 断言 `export.ts` 不 import `keystore` / 不含 `safeStorage` / 不含 `secrets.bin` | `test-usage-store.mjs:250-254` 的 H1–H5 同款 |

**特别值得加的一条机制守卫**（本任务特有）：

```js
// 断言：导出模块里不出现任何凭据读取通道
ok(!/from '\.\.\/keystore'/.test(code), 'export 不 import keystore（不碰凭据）')
ok(!/safeStorage|secrets\.bin|getKey\(/.test(code), 'export 不读任何密钥')
// 断言：脱敏规则真的挡住了 opencode 的尾 4 位
ok(!/…[0-9A-Za-z]{4}/.test(JSON.stringify(doc)), '导出的 source 不含密钥尾号')
```

最后一条的样本来自 `qa/fixtures.ts`（纯函数、不依赖 electron，`:10-52`）——
**造一个带 `source: 'API · 账号1(…9dFe)'` 的夹具，断言导出后不出现它**。
这条断言如果写不出来，说明 §6.1 的脱敏没做，是真正的守门人。

### 7.3 会被碰到的现有结构守卫

| 守卫 | 位置 | 对本任务的影响 |
|---|---|---|
| A1 `index.ts ≤ 500 行` | `test-structure.mjs:37`（当前 **134 行**） | 加 ~6 行分派，安全 |
| A4 必须仍认 `--uitest` / `--shots` | `test-structure.mjs:40` | 只要不动那两行就绿 |
| **B4 `qa/` 恰好 5 文件** | `test-structure.mjs:48-51` | **导出代码不许进 `qa/`** |
| C2 `src/main` 顶层非 index 的 `.ts` 不得 import `qa/` | `test-structure.mjs:69-73` | 新目录 `src/main/cli/` 以目录名被 `filter(f => f.endsWith('.ts'))` 排除 → **自动豁免** |
| E8 `App.tsx` 写的 extras 键必须 `ui:` 前缀 | `test-structure.mjs:445-450` | CLI 不写 extras → 不受影响 |

### 7.4 `npm test` 链

`package.json:33` 的 `test` 链是 17 个脚本串联。批次 PRD 明确：

> | `package.json` 的 `test:` 链 | 四项各自加脚本 | **合并时统一接一次**，子任务提交里先不动 `test` 链，改为在各自 `implement.md` 注明待接 |

→ 本任务照办：新增 `scripts/test-cli-export.mjs` + `package.json` 里加 `"test:cli-export": "node scripts/test-cli-export.mjs"`，
但**不动 `test` 链**，在 `implement.md` 注明「待父任务合并时接入」。

---

## 8. `--json` 之外：`--out` 与人类可读表格（Q8）

### 8.1 `--out <path>`：**要支持**

竞品两条通道都有文件形态（`show --json` 走 stdout，export file 走磁盘）。
本仓的额外理由：`usage-history.json` 已经确立了「独立文件 + 独立键空间」的先例
（`usageStore.ts:19-23` 的理由 B2），用户对「BalanceDeck 会在 userData 写 json」已有预期。

实现注意：

1. **相对路径基准**。macOS 从 Finder / `open -a` 启动的进程 `process.cwd()` 是 `/`。
   → 相对路径按 `process.cwd()` 解析并在 README 里写明，或**要求绝对路径**。
2. **不要自动创建父目录**（`mkdir -p`）—— 静默创建目录树是意外行为。写失败就报错退出。
3. **写失败必须报错并给非零退出码**。这与 §6.1 的「写导出文件失败不许影响 TUI」不矛盾：
   那条说的是**常驻进程**的周期性写；**用户显式要求写文件**时失败必须让用户知道。
4. 走 `fs.writeFileSync`（同步），与 `ballshot.ts:91` / `store.ts:121` 的既有写法一致。

### 8.2 人类可读表格（默认）：**要做**

竞品 `opencode-quota show`（无 `--json`）就是终端速览；本仓也已有现成的纯函数：

```ts
// src/shared/tray-text.ts
export function shortWindowLabel(name: string): string   // :16-25  5 小时 → 5H
export function compactAmount(w: ProviderWindow): string // :32-49  $12.34 / ¥500.67 / 2.3M
export function providerSummary(s: ProviderSnapshot): string  // :52-63  5H 2.7% W 51.9% M 67.9%
export function primarySnapshot(snapshots): ProviderSnapshot | undefined  // :66-68
export function trayTitle(snapshots, offline): string    // :71-80  带 ⚠ 前缀
export function qualitySuffix(s: ProviderSnapshot): string  // :83-87  （缓存）/（本机估算）
```

外加 `src/shared/percent.ts:28-32` 的 `formatPercent`。
→ 表格输出**一行一家**，形如：

```
OpenCode Go    5H 5.2%  W 33%  M 41%          重置 12:40
DeepSeek       ¥1288.50
Claude Code    5H 13.7%  ⚠ 本机              限额为社区预设
Codex          HTTP 401
```

复用 `tray-text.ts` 的收益不只是省代码：`tray-text.ts:4-13` 的模块头写明
「展示 = **卡片顺序第一位**的供应商（用户拖拽排序即优先级）」——
CLI 与托盘用**同一套**选择逻辑，才不会出现「托盘显示 A、CLI 显示 B」。
这正是 `shared/percent.ts:3-5` 说的事：「保证各端显示一致」。

⚠ 注意 `tray-text.ts` 已经是**跨进程模块**（`App.tsx:20`、`CardView.tsx:4`、`PetBall.tsx:6` 都 import 它，
尽管 `directory-structure.md:18` 写的是 "main-only consumer"）——
所以复用它**不新增边界**。

### 8.3 顺带值得考虑的两个 flag（竞品有、成本极低）

| flag | 语义 | 竞品对应 | 本仓实现成本 |
|---|---|---|---|
| `--provider <id>` | 只导一家 | `show --json --provider copilot` | 1 行 filter（`ProviderSnapshot.id`） |
| `--threshold <pct>` | 低于阈值退出码 1；无可比数据退出码 2 | 同名 | 需定义「可比」= `percent != null`（`percent.ts:18`）—— 复用 `windowPercent` 即可 |

`--threshold` 让 CLI 能直接进 CI / shell 条件判断，是「数据可编程访问」这个产品主张的兑现。
但**建议 v1 只做 `--json` / `--out` / `--refresh`**，把这两个留到 v2 —— 先把形状与诚实性做对。

---

## 9. 推荐方案（落地清单）

### 9.1 文件改动（全部新增，只动 `index.ts` 6 行）

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/main/cli/export.ts` | **新增** | 纯函数：`parseArgs(argv: string[]): CliArgs` / `buildExportDoc(state: AppState): ExportDoc` / `renderTable(doc: ExportDoc): string`。**零 electron import** |
| `src/main/cli/run.ts` | **新增** | 装配：读 userData 下的导出文件（或 `--refresh` 时跑一轮采集）、写 `--out`、`app.exit(code)` |
| `src/main/cli/snapshot.ts` | **新增**（若走路 D） | 常驻侧的周期性写盘 + 脱敏 |
| `src/shared/export-doc.ts` | **新增（可选）** | `ExportDoc` / `ExportProvider` / `ExportWindow` 类型 + `EXPORT_DOC_VERSION = 1`。<br>⚠ 若只想放 main，可放 `src/main/cli/types.ts` 避免动 shared 目录（见 §10 问题 3） |
| `src/main/index.ts` | **改 ~6 行** | 在 `index.ts:91`（`--details-test` 之前或之后）加 `if (exportMode) { await runExport(); return }` |
| `scripts/test-cli-export.mjs` | **新增** | 经 `loadTs` 测 `export.ts` + 机制守卫 |
| `package.json` | **改 1 行** | 加 `test:cli-export`；**不动 `test` 链** |
| `README.md` | **改 1 行** | 脚本表加一行 |

### 9.2 `index.ts` 的分派长什么样

```ts
// src/main/index.ts，紧邻现有 QA 分派（第 91 行附近）
import { runExport } from './cli/run'

// 模块体（与现有四个 flag 并列，第 22 行后）
const exportArgs = parseArgs(process.argv.slice(app.isPackaged ? 1 : 2))  // ⚠ 偏移量见 §3.2
const exportMode = exportArgs !== null

// whenReady 回调内（与 --details-test 同位置，第 91 行附近）
if (exportMode) {
  await runExport(exportArgs)
  app.exit(exportArgs.exitCode)   // ⚠ app.exit 而非 app.quit（§3.5）
  return
}
```

**约束核对**：
- ✅ 不建窗口 / 不建托盘 / 不起调度器
- ✅ `registerIpc()` 已在 `index.ts:69` 跑过，`export` 不命中 `ipc.ts:485-489` 的调试通道
- ✅ `configureProviders()` 已在 `index.ts:68` 跑过
- ✅ `index.ts` 仍 < 500 行（A1），仍认 `--uitest` / `--shots`（A4）
- ✅ 不碰 `scheduler.ts` / `ipc.ts`

### 9.3 JSON 契约（v1 白名单）

见 §4.3 的草案 + §6.5 的白名单。要点：
`version: 1` / `dataQuality` 搬运不判断 / `stale`+`staleLabel` 调 shared / `percent` 用 `windowPercent` /
缺失值保持 `null` 或缺键，绝不填 0 / `source`·`detail`·`models` 不导。

### 9.4 验收要点（供 PRD 的 AC 起草）

1. `npm run typecheck` 通过（`package.json:15`，两个 tsconfig project）。
2. `scripts/test-cli-export.mjs` 覆盖：argv 解析（开发/打包两种偏移）、`percent` 的 null 纪律、
   `dataQuality` 三态的 `stale`/`staleLabel`、`version: 1`、**脱敏负向断言**（§7.2 那条）。
3. **机制守卫**：导出模块不含 `keystore` / `safeStorage` / `getKey` / `secrets.bin`。
4. 一条 `--uitest` 等价可观察断言：批次 AC 要求「每一项都有 `--uitest` 键或等价的可观察断言」。
   建议在 `--uitest` 里加一条「`buildExportDoc(currentState())` 的输出含 `version: 1` 且
   `providers` 长度等于 `snapshots` 长度」的断言（走 `modes.ts` 已有机制，不新增通道）。
5. `--refresh` 档必须验证**不破坏** `usage-history.json`（§2.5 风险 ①）。

---

## 10. 需要澄清的问题

> 按「阻塞实现 / 影响形状 / 影响范围」排序。前 3 个不答会写错代码。

### 🔴 Q1（阻塞）路 D 的写盘点放在哪？——决定要不要碰 `scheduler.ts`

- **选项 A**：`scheduler.ts:97-105` 的 `finally` 里加一次写。
  位置最准（拿到完整 `lastSnapshots`），但**违反本任务「不要碰 scheduler.ts」的约束**，
  且与其它三个并行子任务有冲突面。
- **选项 B**：`index.ts:71-75` 的 `pushState` 里加。
  `pushState` 本来就是 `startScheduler(onPush, …)` 的回调（`index.ts:120`），拿到的 `AppState`
  与 `scheduler.ts:103` push 的是同一个对象。**不动 scheduler.ts**，与约束相容。
  代价：`pushState` 在 `announce` 时也会被调（`scheduler.ts:66`，`scanning: true` + 旧快照），
  需要自己去重（按 `lastSync`）。
- **选项 C**：不做路 D，只做路 B（CLI 自己采）。最简单，但 §2.1/§2.5 的代价全都要接受。

**倾向 B**，但需要主 agent 拍板（因为它决定了「碰不碰 scheduler.ts」这条约束的边界）。

### 🔴 Q2（阻塞）`--refresh` 到底做不做？——决定要不要处理 §2.5 的两个风险

- 做：必须解决「CLI 的 `CollectContext.setKey` 写成只读」+「不触发 `sampleUsageHistory`」。
  这两件事都需要在 `run.ts` 里自己组装采集流程（**等于把 `scheduler.ts:60-106` 的 collect 抄一遍**）
  —— 或者给 `scheduler.ts` 加一个「不写历史 / 不回写凭据」的开关（又碰 scheduler.ts）。
- 不做（v1 只有路 D）：CLI 是纯读，零副作用、零风险，但**用户必须先跑着应用**才有数据可导。
  竞品的 `show --json` 也是纯读缓存，行为一致。

**倾向 v1 不做**，v2 再加 —— 但要在 PRD 里写明「首次使用需先启动一次应用」。

### 🔴 Q3（阻塞）导出契约放 `src/shared/` 还是 `src/main/cli/`？

- `src/shared/` 在两个 tsconfig project 里（`directory-structure.md:14`），是「一处定义三处引用」的位置。
- 但本仓有多处注释把「**文件所有权不许新增 shared 文件**」写成硬纪律
  （`ipc.ts:85`、`ipc.ts:261`）—— 那些是**各自任务 implement.md 的约束**，不是全局规则，
  但兄弟子任务（tray-color）的研究已明确指出这个冲突（见
  `.trellis/tasks/10-01-p1-tray-color/research/tray-color-thresholds.md:278-282, 489`）。
- `ExportDoc` 只有 CLI + 落盘文件消费，渲染层用不到 → 放 `src/shared/` 是**过度共享**。

**倾向 `src/main/cli/types.ts`**（或直接放 `export.ts` 里），并在 `implement.md` 里显式声明
「本任务不新增 shared 文件」，避免与兄弟任务的约束打架。

### 🟡 Q4 `providers` 用数组还是对象？

竞品用对象（`providers: { copilot: {...} }`）。我倾向**数组**（保序 = 用户拖拽优先级，
`scheduler.ts:80-88`），jq 用 `.providers[]` 同样好写。
但如果主要目标是「让用户复制竞品的 jq 片段」，对象更兼容。
→ 需要确认目标用户是否已有 jq 片段依赖。

### 🟡 Q5 CLI 导出要不要遵守 `ui:hideBalance`？（§6.4）

用户在悬浮球菜单勾了「隐藏余额」，界面上金额打码。导出要不要一起打码？
我的看法是**要**（stdout 会进 tmux / shell history / 日志，传播面比屏幕大）。
但这是产品语义决策，不是技术问题。若选「要」，需要一个不打码的逃生开关（如 `--show-hidden`）。

### 🟡 Q6 落盘文件名与位置？

`userData` 下的名字没定。候选：`export.json` / `last-export.json` / `snapshot.json`。
注意 `userData` 下已有 Chromium 自己的 `Cache/` `GPUCache/` `Local Storage/` 等目录
（Electron 文档明确建议 app 自己的文件不要放 userData 根以免与 Chromium 命名冲突）。
`store.ts` 的 `secrets.bin` / `overlay.ts` 的 `state.json` / `usage-history.ts` 的 `usage-history.json`
都直接放根目录 → 跟随既有惯例即可，但要在 PRD 里记一笔。

### 🟢 Q7 退出码语义？

竞品：`0` 正常 / `1` 低于阈值 / `2` 无可比数据。
本仓 v1 若不做 `--threshold`，建议只定义：`0` 成功 / `1` 用法错误（未知 flag、缺 `--out` 的值）/
`2` 无数据可导（导出文件不存在且未加 `--refresh`）。需要确认。

### 🟢 Q8 `--provider` 过滤要不要进 v1？

成本 1 行，但会让 `parseArgs` 的测试面变大。建议 v1 只做 `--json` / `--out` / `--refresh`，
`--provider` / `--threshold` 留 v2（与 §8.3 一致）。

---

## 11. Caveats / Not Found

1. **打包态 argv 未实测**。开发态 `electron .` 的偏移量是本机实测；打包态依据 Electron 官方
   issue #4690 与 `app.isPackaged` 语义推导（`["<exe>", ...用户参数]`）。
   **验证方式**：`npm run dist:mac` 后跑
   `/Applications/BalanceDeck.app/Contents/MacOS/BalanceDeck export --json`，或临时加一行
   `process.stdout.write(JSON.stringify(process.argv))` 到 CLI 分支。
2. **本机 `safeStorage.decryptString` 对真实 `secrets.bin` 解密失败**。实测：
   `Error while decrypting the ciphertext provided to safeStorage.decryptString`，
   而同一进程内 `encryptString` → `decryptString` 往返**成功**。
   在开发态 appName（`balancedeck` / `BalanceDeck`）下都复现。
   最可能是**钥匙串 ACL**（本环境无 GUI 会话，既有 keychain item 的访问被拒）。
   → **必须在真实桌面会话下验证 CLI 能否读到凭据**；若路 D（纯读导出文件）成立，这条不影响本任务，
   但 `--refresh` 档（路 B）**强依赖它**。这是 §10-Q2 建议 v1 不做 `--refresh` 的另一个理由。
   （诊断脚本 `scripts/keystore-debug.js` 正是为此存在的，打印的是掩码值 `:24`。）
3. **Windows 未实测**。`request.ts` / `net.ts` 的出网、`safeStorage` 的 DPAPI 路径、
   `autostart.ts` 的 LaunchAgent-vs-LoginItem 分支都只在 macOS 上跑过。
   CLI 的 argv 切片逻辑与平台无关，但 `--out` 的路径语义（盘符、反斜杠）需要单独确认。
4. **`src/shared/tray-text.ts` 的 spec 与现实有偏差**：`directory-structure.md:18` 写
   "main-only consumer"，实际 `App.tsx:20` / `CardView.tsx:4` / `PetBall.tsx:6` 都在用。
   不影响本任务（复用它是好事），但改 spec 时该一并修正。
5. **竞品调研基于二手文档**。opencode-quota 的字段形状取自其
   `docs/readme/external-integration.md`（已 fetch 原文核对），未读源码。
   `fromCache` / `cacheAgeSeconds` / `renderType` / `percentRemaining` 这些字段名**不要照抄**——
   本仓的 `windowPercent` 是「已用百分比」，竞品是「剩余百分比」，**语义相反**，
   照抄会让用户读到错的数字。
6. **未确认 `usage-history.json` 在打包态的路径**。`usage-history.ts:16` 用
   `app.getPath('userData')`，打包态目录名是 `BalanceDeck`（`electron-builder.yml:2` `productName`），
   开发态是 `balancedeck`（`package.json:2` `name`）。**两个目录名不同** →
   同一个用户从开发切到打包，userData 里的数据**不互通**。这影响所有「读 userData」的方案
   （包括路 D），需要在 README 里提一句。

---

## 附：相关文件索引

### 产品代码

| 文件 | 与本任务的关系 |
|---|---|
| `src/main/index.ts` | 唯一要改的既有文件（加 ~6 行分派）；argv 读取 `:15-22`、分派 `:77-123` |
| `src/main/scheduler.ts` | `currentState()` `:212-214`；模块级状态 `:33-38`；`collect()` `:60-106`；`applyCachePolicy` 调用 `:87`；`sampleUsageHistory` `:125-146`；`CollectContext` 装配 `:70-77` |
| `src/shared/types.ts` | `ProviderWindow` `:13-30` / `ProviderStatus` `:46` / `DataQuality` `:54` / `ProviderSnapshot` `:56-86` / `AppState` `:146-152` |
| `src/shared/quality.ts` | `isStale` `:67-69` / `staleLabel` `:72-76` / `applyCachePolicy` `:37-59` / `MAX_CACHE_AGE` `:19` |
| `src/shared/percent.ts` | `windowPercent` `:14-20`（**null 纪律**）/ `formatPercent` `:28-32` |
| `src/shared/tray-text.ts` | 人类可读表格的全部素材（`:16-87`） |
| `src/main/store.ts` | `items`（密文）vs `extras`（明文）`:11-13`；`persist()` 整文件覆写 `:60-63` |
| `src/main/keystore.ts` | `safeStorage` 装配 `:11-20`；惰性 `filePath` `:12-14` |
| `src/main/usageStore.ts` | 磁盘格式 `version: 1` `:50-53`；每进程 cache `:99`；整文件覆写 `:121`；「不走 extras」理由 `:19-23` |
| `src/main/usage-history.ts` | 惰性 `app.getPath('userData')` `:15-17` |
| `src/main/ipc.ts` | 调试通道的 argv 门 `:485-489`；`ui:hideBalance` 的写入路径（`extras:set` `:222-232`） |
| `src/main/adapters/opencode.ts` | ⚠ **密钥尾 4 位泄漏点** `:198-202` → `:780` → `:788` |
| `src/main/adapters/engine.ts` | 响应体预览 `:96-111`（`:108` 截 200 字符）；`snap()` 铸造 `:49-63`（ADR-0002） |
| `src/main/adapters/copilot.ts` | GitHub 用户名进 `detail` `:159`；响应预览 `:125-126` |
| `src/main/qa/fixtures.ts` | `demoSnapshot()` `:10-52` —— **纯函数夹具，测试直接用** |
| `src/main/qa/modes.ts` | QA 模式的定位与退出码约定 `:8-16`；`resolveDiagnosticCred` 的 items/extras 陷阱注释 `:84-92` |

### 测试与脚本

| 文件 | 用途 |
|---|---|
| `scripts/lib/load-ts.mjs` | `loadTs()` `:26-39`；`ELECTRON_STUB` `:24`；为何需要替身 `:11-15` |
| `scripts/lib/electron-stub.mjs` | 只实现 `net.isOnline` `:12-15`；纪律 `:8-10` |
| `scripts/test-usage-store.mjs` | **最接近的模板**：`loadTs` 加载 main 纯模块 `:16-17`；`version` 断言 `:81`；机制守卫 H1–H7 `:241-265` |
| `scripts/test-quality.mjs` | `staleLabel` / `isStale` 断言 `:106-115` |
| `scripts/test-tray.mjs` | `tray-text.ts` 的断言（表格输出的口径参照）`:1-119` |
| `scripts/test-structure.mjs` | A1 行数 `:37` / A4 参数 `:40` / **B4 qa 封闭集 `:48-51`** / C2 `:69-73` / E8 `:445-450` |
| `scripts/test-percent.mjs` | ⚠ **唯一还在内联副本的测试**（`:19-23`），反面教材 |
| `scripts/keystore-debug.js` | 凭据排障（打印掩码 `:24`），§11-2 的验证工具 |
| `package.json` | `test` 链 `:33` / `main` `:5` / `name: balancedeck` `:2` / 无 `bin` |
| `electron-builder.yml` | `productName: BalanceDeck` `:2`（决定可执行文件名与打包态 userData 目录名） |

### 文档与 spec

| 文件 | 用途 |
|---|---|
| `docs/adr/0002-provenance-is-required.md` | `dataQuality` 是铸造必填输入 —— 导出层只能搬运，不能推导 |
| `docs/adr/0003-one-shot-protocol-cutover.md` | 「测试必须加载真实源码」的历史背景 |
| `.trellis/spec/frontend/directory-structure.md` | `store.ts + keystore.ts` 是最干净的接缝 `:202-204`；`qa/` 封闭集 `:117-143`；已知偏差 `:185-196` |
| `.trellis/spec/frontend/quality-guidelines.md` | Forbidden Patterns（内联副本 / 桩静默分支 / plausible zero / 凭据字面量） |
| `.trellis/spec/frontend/state-management.md` | extras 的键前缀副作用 `:180-208` |
| `.trellis/tasks/10-01-p1-batch/prd.md` | 父任务的跨子任务 AC（无新增网络请求 / 统一走 `staleLabel` / test 链合并规则） |
| `.trellis/tasks/archive/2026-09/09-30-similar-projects-research/research/report.md` | 竞品 P1-6 原始描述 `:237-240`；opencode-quota 深度 `:156-160` |