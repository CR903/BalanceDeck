# 设计：本机用量扫描移出阻塞路径（孩子 B）

## 1. 边界与文件清单

| 文件 | 改动性质 |
|---|---|
| `src/main/adapters/opencode-local.ts` | **新增**。本机用量扫描的解析/投影/缓存/增量（唯一 import 运行时 `node:sqlite`，不 import electron ⇒ 可在纯 node 里被 `loadTs` 加载并用真 sqlite 夹具测试） |
| `src/main/adapters/opencode.ts` | `loadLocal`/`localCache`/`fileStamp`/`localDbStamp` 瘦身为装配（只保留 `detectDbPath()` 与对 `opencode-local` 的调用） |
| `src/main/adapters/antigravity.ts` | `execFileSync` → 异步 + 超时 + 凭据缓存（R6） |
| `src/main/adapters/claude.ts` / `codex.ts` | 目录遍历 mtime 短路（R7） |
| `scripts/test-local-scan.mjs` | **新增**测试套件（夹具 sqlite） |
| `scripts/test-adapters.mjs` 等 | 只在需要时补回归断言，**不改既有断言的期望值** |
| `package.json` | 注册 `test:local-scan` |

## 2. 为什么慢，以及为什么这样修

慢的本质：需要的数据（cost / providerID / model / tokens / 时间）**只存在于 `data` 这一列 JSON 文本里**（E10）。SQLite 必须把每一行的 `data` 页读出来 —— 25.9k 行 × 约 10KB ≈ 265MB。所以：

- **能在 SQL 侧做的事**：抽取 + provider 过滤（`json_extract`），省掉"265MB 进 JS 堆 + 25.9k 次 `JSON.parse`"（E11：1935ms → 761ms）。
- **不能在 SQL 侧省的事**：页读取量。要真正降到毫秒，只有两条路：**别扫 31 天**（增量）或**别在主线程扫**（worker，见 §6）。
  → 选增量（E12：1ms）。这正是"用户 3 小时前用了什么"以外唯一真正需要的信息：**新增行**。

## 3. 契约：`opencode-local.ts`

```ts
export interface LocalPoint { t: number; cost: number; tokens: number; model: string }
export interface LocalStats {
  pts: LocalPoint[]                                        // 按 t 升序，与既有口径一致
  byModel: Map<string, { cost: number; tokens: number }>    // 与既有 modelRows() 的消费形状一致
}

export interface LocalScanner {
  /** 扫描（自动走全量或增量）。stamp/TTL 命中时直接返回上次结果 */
  scan(nowMs: number): Promise<LocalStats | null>
  /** 诊断用：上次是命中缓存还是重扫，以及重扫耗时/行数 */
  lastRun(): { mode: 'cache' | 'full' | 'delta'; ms: number; rows: number } | null
}

export function createLocalScanner(opts: { detectDbPath: () => string | null }): LocalScanner
```

### 3.1 单条 SQL 投影（取代 `SELECT data`）

```sql
SELECT
  id,
  json_extract(data,'$.cost')                 AS cost,
  json_extract(data,'$.providerID')           AS pid,
  json_extract(data,'$.model.providerID')     AS mpid,
  json_extract(data,'$.modelID')              AS mid,
  json_extract(data,'$.model.id')             AS modelid,
  json_extract(data,'$.time.created')         AS t,
  json_extract(data,'$.tokens.input')         AS i,
  json_extract(data,'$.tokens.output')        AS o,
  json_extract(data,'$.tokens.reasoning')     AS r,
  json_extract(data,'$.tokens.cache.read')    AS cr,
  json_extract(data,'$.tokens.cache.write')   AS cw
FROM session_message
WHERE type = 'assistant'
  AND time_created > :since                        -- 全量：31 天窗口（与旧实现逐字同参）
  AND (pid = 'opencode-go' OR mpid = 'opencode-go') -- 旧实现是在 JS 里判的，这里前移到 SQL
```

旧 `message` 表路径保留（同投影、同判据），两表按既有口径去重取并集 —— **口径逐字不变**，只是把过滤前移、把 `JSON.parse` 干掉。

### 3.2 增量：`id` 作身份，`time_updated` 作水位

- 内存中保留 `Map<rowId, LocalPoint>` 作为"行快照"，另有 `watermark = max(time_updated)`。
- 每轮增量查询：`time_created > :since AND time_updated > :watermark - 600_000`（回退 10 分钟，覆盖"先插行、后回写 cost"的时序）。
- 合并规则：**以 `rowId` 覆盖**（同一行只留最新一次解析），再把 `t <= since` 的点裁掉。→ 这保证 AC2 的**逐点等价**。
- ⚠ 不能用 `t|cost` 去重来合并增量：cost 被改写时该键会变，同一条消息会被算两遍。`id` 是主键（E10 有 `sqlite_autoindex`），用它才正确。

### 3.3 缓存与 TTL（修 R1/E9）

```ts
function dbStamp(dbPath: string): string {          // ← 不再包含 -wal / -shm
  const s = statSync(dbPath)
  return `${s.size}:${Math.round(s.mtimeMs)}`
}
```

- 命中规则：`stamp 未变 && 未超 TTL && 已有行快照` → **直接返回**（0 次 SQL）。
- TTL 从 120s 提到 **10 分钟**：stamp 只是"要不要全量重扫"的粗判据，新鲜度交给增量水位。**取舍**：主库 mtime 在 WAL 模式下长时间不变（写入落在 `-wal`），所以 stamp 命中 ≠ 数据没变 —— 这正是必须靠增量而非 stamp 来保新鲜度的原因。
- `-wal` 变化**不再作废缓存**；显式在注释里写明这条因果，防止将来有人"顺手加回去"。

## 4. 数据流

```
每轮 collect
  └─ loadLocal(now)
       └─ scanner.scan(now)
            ├─ stamp 命中 + TTL 未过 + 有快照 → 返回（~0ms）          ← 常态
            ├─ 有快照（冷启动已建）：增量 SQL（time_updated > wm-10min）→ 按 id 覆盖 → 裁窗口（~1ms）
            └─ 无快照 / stamp 变 / TTL 过：全量投影 SQL（~761ms）→ 建快照 + 记 debugLog
```

`LocalStats` 的形状与语义与旧实现完全一致 ⇒ `officialWindows()`、`sumInRange()`、`modelRows()` 的消费点**零改动**。

## 5. 相同隐患的收口

### 5.1 `antigravity.ts`（R6，风险最高）

- `readKeychainRaw()`：`execFileSync('security', [...])` → `execFile`（promisify）＋ `timeout: 5000`。
- 加成 5 分钟凭据缓存 `{ at, token, source }`：现在**每轮**都会 spawn 一个进程读 Keychain，改成每 5 分钟一次。
- 失败语义不变（读不到 → 继续走文件/手动粘贴级联）。
- 理由写进代码注释：**同步 Keychain 调用一旦触发 ACL 授权弹窗，主进程会永久阻塞** —— 这正是"鼠标转圈"的经典成因；E13 里它没爆只是因为这台机器上没配 Antigravity。

### 5.2 `claude.ts` / `codex.ts`（R7）

- 目录遍历改 `fs.promises` + **目录 mtime 短路**：`Map<dir, { mtimeMs, files[] }>`，目录 mtime 未变则复用文件列表（消除每轮递归 `statSync`）。
- 单文件仍走既有 mtime 缓存（`parseFile` 里已有），不重复解析。
- 范围控制：只做"短路"，不改解析逻辑、不改 4/5 层深度上限、不改口径。**若回归面超出预期，允许在本任务内标记 deferred 并写进 knowledge**（R7 是收益最小的一条）。

## 6. 取舍：为什么**不**上 `worker_threads`（deferred）

- 诉求已由增量满足：常态 1ms 级，冷启动一次 761ms（发生在进程启动首轮，用户对一次 0.8s 无感）。
- 代价不小：electron-vite 主进程侧 worker 需要独立的构建入口与打包路径处理（`out/main` 的资源解析、asar 内路径），出错面是"打包后运行时找不到 worker"，而这类问题**只在打包态复现**，本仓没有 CI 兜底。
- 判据（什么时候回来做）：若真机冷启动 > 900ms（AC4 红线），或增量路径被证明无法覆盖（例如 opencode 换 schema 让 `time_updated` 失去语义），再单开任务引入 worker/utilityProcess。

## 7. 测试策略

- `scripts/test-local-scan.mjs`（`loadTs` 加载真源码 + 临时 sqlite 夹具）：
  1. 建表（照抄 E10 的 DDL）+ 插若干行（含 `cost<=0`、非 `opencode-go`、两代 schema 字段形状）；
  2. **等价性**：`scan()` 全量结果 vs "逐行写入后走增量" 的结果逐点相等（AC2）；
  3. **stamp/TTL**：只动 `-wal` → 断言 `lastRun().mode === 'cache'`（AC1）；动主库 → `'full'`；改 TTL 参数 → `'full'`；
  4. **水位**：更新一行的 `cost` 且推进 `time_updated` → 只出现一次且取新值（AC3）；删行 → 结果里消失；
  5. **投影正确性**：断言 `pts`/`byModel` 与"用旧实现口径（`JSON.parse` 整条 `data`）算出的结果"相同 —— 这条是本任务最重要的回归护栏。
- `scripts/test-adapters.mjs` 补一条：`antigravity` 静态守卫（整文件零 `execFileSync`，沿用 `test-seam.mjs` 的整文件计数风格）。
- `claude/codex` 短路：断言"目录 mtime 未变时 `readdir` 调用次数不增长"（用计数桩）。
- 每条护栏先弄坏一次确认变红。

## 8. 回滚形态

- 新增 `opencode-local.ts` + 测试可独立存在；`opencode.ts` 的 `loadLocal` 换成调用它是一处**单点替换**，回滚只需 revert 该文件到旧实现（旧实现留在 git 历史，不并行保留双实现）。
- `antigravity.ts` / `claude.ts` / `codex.ts` 三处互相独立，可分别 revert。
- 无数据格式变更（不新增磁盘文件）⇒ **没有迁移/回滚的数据面风险**。
