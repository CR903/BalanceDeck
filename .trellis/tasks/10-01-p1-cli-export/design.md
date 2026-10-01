# Design: P1-6 轻量 CLI / JSON 快照导出

## 调研结论（已核实，含本机实测）

| 问题 | 结论 |
|---|---|
| `scheduler.currentState()` 读得到吗 | **读不到**。它是模块级内存（`scheduler.ts:33-38`），且**全仓无 `requestSingleInstanceLock`** —— 两个进程完全隔离、无任何 IPC 通道。独立 CLI 进程只能自己再采一轮 |
| argv 怎么分 | 开发态 argv = `[electronBin, ".", "export", "--json"]` → **必须 `slice(app.isPackaged ? 1 : 2)`**（本机实测） |
| `app.getPath('userData')` 时机 | ready 前**可用**（实测）。仓库注释说的真正理由是「静态导入先于模块体求值」，不是 ready 时机 |
| `usage-history.json` 本机可用吗 | **不存在** —— 全部采集失败时 `scheduler.ts:138` 不写文件 → 路 C 不可作主数据源 |

## 架构：路 D（常驻进程周期性写导出文件）+ 路 E（CLI 纯读它）

```
┌── 常驻进程（正常启动的应用）──────────────────────────────────────────┐
│                                                                          │
│  src/main/cli/export-snapshot.ts  ← 【新增·纯逻辑】                     │
│    buildSnapshot(state, now) → Snapshot    不碰 electron，可单测          │
│                                                                          │
│  写盘点：src/main/index.ts:71 的 pushState                             │
│    ⚠ 不碰 scheduler.ts（守住本任务「不改 scheduler」的约束）              │
│    写 userData/balance-export.json —— **不是 extras**                    │
│      （store.ts:92-97 全量覆写；test-usage-store.mjs:250-251 有断言钉着）│
└──────────────────────────────────────────────────────────────────────┘
                                    ↓ 读文件（零出网）
┌── CLI 进程 ────────────────────────────────────────────────────────────┐
│  balancedeck export --json                                              │
│    src/main/cli/export-command.ts  ← 【新增·纯逻辑】参数解析 + 输出       │
│    实测：Electron 冷启 520–760ms vs 纯 node <50ms                       │
└──────────────────────────────────────────────────────────────────────┘
```

竞品 opencode-quota 正是这个形态（`~/.cache/opencode/quota-export.json`）。

## Technical Decisions

### D1 · 路 D + 路 E：常驻写、CLI 纯读

三条数据来源的取舍：

| 路径 | 做法 | 否决理由 |
|---|---|---|
| A | CLI 自己跑一轮采集 | 每次出网；且 **`usageStore.ts:99` 每进程一份内存 cache + `:121` 整文件覆写** → CLI 采集会**抹掉常驻进程的历史采样**（趋势图直接出现空档） |
| B | 走主进程 IPC | **无 `requestSingleInstanceLock`**，两进程完全隔离 |
| C | 读 `usage-history.json` | 该文件**只存历史采样、不存当前余额**，且本机实测不存在；余额金额从未落盘（`UsagePoint` 只有 `pct`） |
| **D+E** | **常驻进程周期性写一份只读导出，CLI 纯读** | ✅ 零出网、零副作用、快（<50ms） |

代价：CLI 必须**先启动过一次应用**才有数据。这是接受的 —— 一个「查当前额度」的命令，
答案本来就是最近一次采集的结果；`--refresh` 会打破「零副作用」这个性质（见 D3）。

### D2 · 写盘点挂 `index.ts:71` 的 `pushState`，**不碰 `scheduler.ts`**

`pushState` 是每次状态推送都会走的路径（`index.ts:71` 定义、`scheduler` 的 `onPush` 传进来），
**挂在那里既不改 scheduler.ts，又天然与采集同步**。

写入频率控制：按内容哈希去重 —— 快照没变就不写盘。
（常驻应用每 60s 推一次状态，不去重就是每天 1440 次写盘。）

### D3 · v1 **不做** `--refresh`

理由是调研发现的两个风险：

1. CLI 自己的采集会通过 `scheduler.ts:74` 注入的 `setKey` **重写 `secrets.bin`**
   （用旧快照重算凭据）。这是 CLI 命令**不该**有的副作用。
2. `safeStorage.decryptString` 对真实 `secrets.bin` 在本机**失败**
   （同进程 encrypt→decrypt 往返成功，疑似钥匙串 ACL）—— `--refresh` 档需在真实桌面会话下验证。

CLI 读不到文件时的行为：打印一行提示 + 退出码 2（告诉脚本「没数据，去启动应用」）。

### D4 · 隐私：v1 **不导** `source` / `detail` / `failureReason`

调研发现的**已存在泄漏点**：`opencode.ts:198-202` 的 `keyTag` 把 **API key 尾 4 位**
拼进 `source`，经 `:780` → `:788` 进入 `ProviderSnapshot.source`。

这三个字段都是**自由文案**：
- `source` 含 key 尾 4 位
- `detail` / `failureReason` 可能含响应体预览、GitHub 用户名

**决策**：v1 只导结构化字段，不导这三个。这不是「暂时没做」，是**契约层面不导** ——
将来加字段时要重新过一次隐私评估，而不是「顺手把整个 snapshot 序列化出去」。

### D5 · 导出契约放 `src/main/cli/`，**不放 `src/shared/`**

- `src/shared/` 是**主进程 ↔ 渲染层**的契约层。CLI 契约的双方是「常驻进程 ↔ 外部脚本」，
  渲染层永远看不到它 → 放 shared 是错配。
- ⚠ 兄弟任务 `tray-color` 确实因「不许新增 shared 文件」这条历史约束踩过冲突，
  但那条约束是**当时那个任务**的边界，不是仓库法律（本任务同样不新增 shared 文件）。

### D6 · JSON 带 `schemaVersion`，导出字段固定

外部脚本会长期依赖这个格式。加版本号让它们能判「我认识这个版本吗」，
而不是解析到一半发现字段变了。

```ts
// src/main/cli/export-snapshot.ts
export const EXPORT_SCHEMA_VERSION = 1
export interface ExportSnapshot {
  schemaVersion: number
  generatedAt: string        // ISO
  offline: boolean
  providers: ExportProvider[]
}
export interface ExportProvider {
  id: string
  name: string
  kind: string
  status: string
  /** 数据质量：'official' | 'cached' | 'local'（**结构化枚举，不是自由文案**） */
  dataQuality: string
  updatedAt: string
  windows: ExportWindow[]
}
export interface ExportWindow {
  name: string
  used: number
  limit: number | null
  unit: string
  percent: number | null
  resetAt: string | null
}
// ⚠ 刻意**不含**：source / detail / failureReason / models / modelsByWindow
```

### D7 · 默认输出表格，`--json` 输出 JSON

`--json` 是给脚本的；不给参数时给人看。两者共用同一份
`buildSnapshot`（数据源唯一），只是渲染方式不同。

## Contracts

### CLI 契约

```
balancedeck export [--json] [--out <path>]

  --json       输出 JSON 到 stdout（供脚本消费）
  --out PATH   写到文件而不是 stdout
  （无参数）    人类可读的表格

退出码：
  0  成功
  1  参数非法
  2  没有导出文件（应用从未运行过 / 数据太旧）
```

### src/main/cli/export-command.ts（纯逻辑，不碰 electron）

```ts
export interface ExportArgs {
  json: boolean
  out: string | null
  /** 第一个非选项参数；非 null 时是未知命令 → 退出码 1 */
  unknown: string | null
}
/** ⚠ argv 必须已 slice 掉可执行文件与 app 路径（开发态 slice(2)，打包态 slice(1)） */
export function parseExportArgs(argv: string[]): ExportArgs
export function renderTable(snap: ExportSnapshot): string
```

## Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| argv 里有未知命令 | 退出码 1 + 用法（**不猜**用户想干什么） |
| 导出文件不存在 | 退出码 2 + 「请先启动一次 BalanceDeck」 |
| 导出文件损坏 / schemaVersion 不认识 | 退出码 2 + 明确说「导出文件格式不认识」（不是解析崩溃） |
| 快照全空（应用刚启动还没采集完） | 退出码 0 + 空数组 + `generatedAt`（**空数据是有效状态**） |
| `--out` 指向不可写路径 | 退出码 1 + 说明；**不静默改写 stdout** |
| 无 `--json` 时终端不支持 UTF-8 | 中文可能变问号；不做降级（表格是给人看的，终端编码问题超出范围） |
| 快照内容未变化（哈希相同） | 常驻进程**不写盘**（D2） |

## Good / Base / Bad Cases

- **Good**：`balancedeck export --json` → tmux 状态栏显示 `Claude 公司 M 68.5% (cached)`。
  `cached` 明确在场，脚本不会把它当实时数据。
- **Base**：应用跑着但一行数据都没采到 → `providers: []`，退出码 0。空数组是有效答案，不该报错。
- **Bad**：导出里带上了 `source: "official (sk-…a3f9)"` → 用户的 tmux 配置、日志、截图里开始出现 key 片段。
  这就是 D4 那三个字段**在契约层面不导**的理由。

## Tests Required

新建 `scripts/test-cli-export.mjs`（`loadTs` 加载 `src/main/cli/` 的真源码，
**不碰 electron**）：

1. `parseExportArgs`：`[]` / `['--json']` / `['--out','/tmp/x.json']` / `['--json','--out','p']` /
   未知命令 / 参数缺值（`--out` 后面没东西）
2. `buildSnapshot`：
   - **不含** `source` / `detail` / `failureReason` / `models`（D4 的守卫，逐个 key 断言）
   - 含 `schemaVersion` / `generatedAt` / `offline` / `providers`
   - `dataQuality` 透传 `'cached'` / `'local'` / `'official`
   - `limit` / `percent` / `resetAt` 的 `null` **保持 null**（不填 0）
3. 空快照 → `providers: []`，不抛
4. `renderTable` 含每个供应商名与百分比；cached 带标注
5. 纯度：`buildSnapshot` 不修改入参 snapshot
6. 静态守卫：
   - `src/main/cli/**` 内**不得** `import 'electron'`（能被 loadTs 在纯 node 里加载）
   - **不得** `import` keystore / setKey（CLI 绝不能碰凭据 —— D3 的风险 1）
   - `src/main/index.ts` 的写盘点**不得**写进 extras（走独立文件）
7. `--out` 写文件失败 → 返回失败状态，**不抛**

## Wrong vs Correct

#### Wrong
让 CLI 自己跑一轮 `collectAll` 再输出：

- 每次调用都出网；
- `usageStore.ts:99` 每进程一份内存 cache + `:121` 整文件覆写 → **CLI 的这次采集会抹掉
  常驻进程累积的历史采样**，P1-1 的趋势图会突然出现空档；
- 还会顺带通过 `scheduler.ts:74` 注入的 `setKey` 重写 `secrets.bin`。

#### Correct
常驻进程在 `pushState` 路径上按内容哈希去重地写一份只读导出；CLI 纯读它：
零出网、零副作用、不碰凭据、不碰历史存储。竞品 opencode-quota 就是这个形态。