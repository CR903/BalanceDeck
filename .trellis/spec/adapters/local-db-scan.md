# Local Usage Scan (本机用量扫描)

> Executable contract for reading the local `opencode.db` usage rows.
> Filled 2026-10-18 by task `10-18-local-db-off-mainthread`.
> Implementation: `src/main/adapters/opencode-local.ts` (pure: imports `node:sqlite`, never electron).

---

## 1. Scope / Trigger

**Trigger**: this is a cache + local-database integration, so it needs code-spec depth.

**Why it exists**: the main process must not block on the user's own data. Measured on a real
638 MB `~/.local/share/opencode/opencode.db` (25 860 assistant messages / 265 MB of JSON in the
`data` column) before the fix: **1935 ms per collection round** (SQL 1112 + `JSON.parse` 806)
*inside the main thread* — the user sees a spinning beachball. The freeze was aggravated by a
cache that could never hit: its key included `-wal` size/mtime, which opencode changes on every
write (measured: `3221872@…401` → `3448472@…406` within 5 seconds).

## 2. Signatures

```ts
export interface LocalPoint { t: number; cost: number; tokens: number; model: string }
export interface LocalStats {
  pts: LocalPoint[]                                       // ascending by t
  byModel: Map<string, { cost: number; tokens: number }>
}

export interface LocalScanner {
  scan(nowMs: number): Promise<LocalStats | null>
  lastRun(): LocalRun | null
  stop(): Promise<void>            // 停机：终止全量 worker + 关连接；幂等（app 退出 / stopScheduler）
}

export interface LocalRun {
  mode: 'cache' | 'full' | 'delta'
  ms: number
  rows: number
  /** full 轮走的哪条路：`worker` = 已移出主线程；`main` = 主线程同步（含降级）。cache/delta 无此字段 */
  via?: 'worker' | 'main'
  /** `via='main'` 且**是降级**时的原因；正常的主线程全量（没配 worker）不带这个字段 */
  degradedReason?: string
}

export function createLocalScanner(opts: {
  detectDbPath: () => string | null
  /** worker 入口（产品注入 `defaultWorkerPath`）。**缺省 = 不起 worker**，全部在主线程 */
  workerPath?: () => string
  /** 降级 / 丢弃迟到结果的留痕出口（产品注入 `debugLog`） */
  log?: (msg: string) => void
  workerTimeoutMs?: number
}): LocalScanner

export function dbStamp(dbPath: string): string            // 主库 size:roundedMtimeMs —— 不含 -wal/-shm

// 口径的唯一来源：worker 入口与主线程降级路径**调同一份**（不许复制第二份）
export function openLocalDb(dbPath: string): Promise<LocalDb>
export function detectTables(db: LocalDb): TableDef[]
export function projectFull(db: LocalDb, t: TableDef, sinceMs: number): ProjRow[]
export function projectDelta(db: LocalDb, t: TableDef, low: number, high: number, sinceMs: number): ProjRow[]
export function absorbRows(rows: ProjRow[]): Map<number, LocalRow>
export function deriveStats(tables: { rows: Map<number, LocalRow> }[], sinceMs: number): { stats: LocalStats; minTc: number }
export function scanFullSnapshot(db: LocalDb, sinceMs: number): { tables: LocalTable[]; rows: number }
```

Consumers (`officialWindows` / `sumInRange` / `modelRows`) are unchanged; `loadLocal(nowMs)` in
`opencode.ts` keeps its name and signature so every call site is untouched.

> 2026-10-18（任务 `10-18-local-db-worker-offload`）追加：`LocalRun` 多了 `via` / `degradedReason`
> （**纯新增**，既有消费方零改动），`LocalScanner` 多了 `stop()`，`createLocalScanner` 的 opts
> 多了三个可选字段。全部是加法 —— 这就是「改口径不行、加字段可以」的边界。

## 3. Contracts

- **Projection, not transfer**: the query extracts only the needed keys with `json_extract`
  (`cost`, `providerID`, `model.providerID`, `modelID`, `model.id`, `time.created`,
  `tokens.*`) and filters `providerID`/`model.providerID = 'opencode-go'` **in SQL**. The `data`
  column never crosses into JS and `JSON.parse` is never called. Measured: 1935 ms → 761 ms.
- **Cache modes** (`lastRun().mode`):

| Mode | When | Cost |
|---|---|---|
| `cache` | 主库 stamp 未变 **and** TTL 未过 **and** 已有快照 | ~0 ms (no SQL) |
| `delta` | 有快照：只读 rowid 回看窗口内的行 | ~1–30 ms |
| `full` | 无快照 / rowid 回退 / 表集合变化 / TTL 到期 | ~0.7–3 s (cold) |

- **Cursor**: rowid range, **not** `time_updated` — the real DB has **no index on
  `time_updated`** (measured degradation: 200–350 ms/round full scan), whereas
  `EXPLAIN QUERY PLAN` confirms `SEARCH session_message USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)`.
  The 600-row look-back window and the full reconciliation bound the blind spot for rows
  updated outside that window (asserted by `L3x-j` / `L3x-l`).
  The reconciliation interval is `FULL_RESCAN_MAX_AGE_MS` = **1 hour** (2026-10-18, tightened from
  6 h by task `10-18-local-db-worker-offload`: the full scan now runs on a worker thread, so the
  main-thread cost that justified the long interval is gone — measured main-thread event-loop gap
  16 ms vs ~1200 ms before; asserted by `test-local-scan.mjs` **L5j**). Cost of the tightening:
  ~24 full page-reads/day (~6.4 GB) on the **worker** thread; in the degraded case it means an
  hourly 0.7–3 s main-thread freeze instead of a 6-hourly one.
- **Merge identity is the row** (`id`), never `t|cost`: a re-written `cost` changes that content
  key and the same message would be counted twice.
- **Honesty**: `tokens` still comes only from the local DB and is still labelled 本机; missing
  values are never filled with `0`; `shared/quality.ts` semantics are untouched.

## 3b. The worker offload (`local-scan-host.ts` / `local-scan-worker.ts`)

Added 2026-10-18 by task `10-18-local-db-worker-offload`. `node:sqlite` has **only a synchronous
API**, so a full scan on the main thread is a 1.1–4.4 s freeze (measured). The `full` mode is
therefore delegated to a `worker_threads` worker; `cache`/`delta` stay on the main thread
(they are 1–30 ms — moving them out buys nothing and adds a failure mode).

- **Only `full` goes to the worker.** `LocalRun.via` records which path ran.
- **The payload is the row snapshot, not `LocalStats`.** `ScanResult.tables` is
  `{ name, rows: Map<rowid, {tc, p}> }[]`. `pts` cannot rebuild the delta cursor because it
  carries no `rowid` — returning only `{pts, byModel}` makes the **next** delta round lose its
  snapshot and the result goes *empty* (not slow: wrong). `L7u` pins this on a 900-row table,
  because a fixture smaller than the 600-row look-back window hides the defect entirely.
- **口径只有一份**: the worker entry and the main-thread fallback both call `openLocalDb` /
  `scanFullSnapshot`. Copying the projection SQL into the worker is a defect, not a shortcut.
- **Three disciplines, each with an assertion** (`scripts/test-local-scan-host.mjs`):
  1. **Degradation leaves a trace** — `via='main'` always carries `degradedReason`, and the host
     writes it through `log()`. Silent degradation is the failure this task exists to prevent.
  2. **The timeout covers the whole scan** (postMessage → reply), not one message round-trip:
     a worker stuck in a synchronous page read must still be able to fall back.
  3. **Late results are discarded** — requests carry a `seq`; a reply whose `seq` does not match
     the in-flight request is dropped and logged (same rule as `collect-loop.ts`'s epoch gate).
     A worker that timed out is marked unusable (`workerBad`) and replaced on the next call,
     because a synchronous read cannot be cancelled.
  4. **The payload's *content* is checked by the caller, not the transport** — the host only
     validates the *shape* (object, matching `seq`). `opencode-local.ts` additionally checks the
     returned table-name **set** against the tables its own connection sees, and degrades with a
     reason if any is missing. Criterion is the set, **never the row count**: 0 rows can be the
     truth (nothing used for 31 days), a missing table cannot. Measured in a packaged build with
     an injected `{ ok: true, tables: [] }` worker: `full 658ms rows=0 pts=0 via=worker` — the
     local numbers silently became zero and the next round is a `delta` (look-back window only),
     so recovery waited for the next full reconciliation. Asserted by `test-local-scan.mjs`
     `L7w/L7w2/L7w3` (+ `L7y*` data-intact) with the negative precondition `L7z` (right names,
     0 rows ⇒ still `via=worker`).
- **`new Worker()` needs a real file**: `electron.vite.config.ts` emits a second main input
  (`out/main/local-scan-worker.js`). Whether that file loads **from inside asar** can only be
  proven in a packaged build — `scripts/verify-worker-packaged.mjs` does a **positive** run
  (assert `via=worker` + `sample` shows no sqlite on the main thread) and a **negative** run
  (`BD_LOCAL_SCAN_WORKER=<missing>` → assert `via=main degraded=…` + same `rows`/`pts`).
  Measured on Electron 37: **asar works, `asarUnpack` is not needed**.
  ⚠ `defaultWorkerPath()` must tolerate `__dirname` being `out/main/chunks/` (rollup puts the
  shared chunk there) — a single `join(__dirname, …)` shipped a `Cannot find module` degradation
  on the first run.
- **Do not mistake "off the main thread" for "faster".** The worker path is **slower in wall
  clock** (thread boot + module load + structured clone ≈ +1–3 s); the win is a free main thread
  (measured event-loop gap 16 ms vs ~1200 ms).

## 4. Validation & Error Matrix

| Condition | Behaviour |
|---|---|
| DB file absent | `scan()` → `null` (unchanged from the old `detectDbPath()`) |
| `node:sqlite` import fails / open fails | `null`, no throw |
| Row is not `type='assistant'` | excluded in SQL |
| `cost <= 0` or missing | point skipped (same criterion as the old `parsePoint`) |
| `json_valid(data)` false | row skipped (SQL-side guard) |
| Both legacy `message` and new `session_message` present | union with the existing `t|cost` dedup, legacy order preserved |
| `time_created` exactly `since` | **excluded** (strict `>`), matching the old query |

## 5. Good / Base / Bad Cases

- **Good**: 31 days of usage, `delta` every round at ~1–30 ms; cold `full` once per launch.
- **Base**: no local DB (fresh machine) → `null` → adapters fall back to official-only windows.
- **Bad**: a row whose `cost` is rewritten after the look-back window has passed → stale until the
  full reconciliation (≤ 1 h). Bounded and asserted, not eliminated.
- **Bad (degraded)**: the worker cannot start (packaging change, missing artifact) → every full scan
  falls back to the main thread, i.e. back to a 0.7–3 s freeze **hourly**. The `degradedReason` log
  line is the only signal; `scripts/verify-worker-packaged.mjs` is what proves the worker still loads.

## 6. Tests Required

`scripts/test-local-scan.mjs` (real source via `loadTs`, real `node:sqlite` fixture built from the
real DDL):

| Assertion point | Pins |
|---|---|
| `L1b`, `L3e/f`, `L3x-c/g` | projection result == frozen old-criterion baseline, point by point (`pts` **and** `byModel`) |
| `L2c/f/g`, `L5b/g` | `-wal`-only change ⇒ `mode === 'cache'` (adding `-wal` back to `dbStamp` must go red) |
| `L2l` | main-DB stamp change (checkpoint) ⇒ `delta`, **not** `full` |
| `L2r3/r4` | a `cache` round must still trim the window (reusing derived results unconditionally must go red) |
| `L3g/h/i`, `L3x-j/l` | re-valued row appears once with the new value; deleted row disappears; window blind spot bounded |
| `L5j` | `FULL_RESCAN_MAX_AGE_MS ≤ 1 h` (the R6 tightening is a measured decision, not taste) |
| `L7b/d/e/q` | full scan via the worker == main thread == frozen baseline, point by point |
| `L7f/g` | `delta` stays on the main thread and carries no `via` |
| `L7u` | **the row snapshot really comes back** (900-row table: without it, out-of-window points vanish) |
| `L7j/l` | worker path broken ⇒ `via='main'` + `degradedReason` + result still point-equal |
| `L7w/w2/w3` + `L7y*` | a *successful-looking* payload missing a table (or the whole `tables` field) ⇒ degrade + data still point-equal |
| `L7z/z2` | **negative precondition**: right table names with 0 rows is a *trustworthy* empty ⇒ still `via='worker'` (the guard must not degenerate into "always degrade") |
| `L6b/d/h/l` | `claude`/`codex` second `collect()` performs **0** `readdir` calls |
| `XSG7` | `antigravity.ts` contains **zero** `execFileSync` (async + bounded timeout instead) |

`scripts/test-local-scan-host.mjs` (real source via `loadTs`; the "fake" workers are **real threads**
— temp-dir `.mjs` entries that append a line to `BD_FIXTURE_LOG` on boot, so "did the worker actually
start / did it get replaced" is a counted fact):

| Assertion point | Pins |
|---|---|
| `H1a–H1i` | happy path: `via='worker'`, payload passed through (Map survives structured clone), fallback never called, thread reused |
| `H2d/e`, `H3b` | entry missing / top-level throw ⇒ `via='main'` + non-empty `degradedReason` + logged (**remove it and it goes red**) |
| `H4b–H4h` | timeout returns within the budget; the late reply is **discarded and logged** and does not overwrite `lastRun()` |
| `H4i/j` | a timed-out thread is **replaced** on the next call (counted via the fixture boot log) |
| `H5a–H5g` | `stop()` is idempotent, no new thread afterwards, in-flight request settled, no leftover `Timeout` handles |
| `H6d/e` | an unrecognised reply shape has an exit (logged) and is never mistaken for success |
| `H6f–H6h` | `ok:false` degrades but the thread stays usable |
| `H7b/c` | the host imports neither electron nor `opencode-local` at runtime (swap-in-a-different-transport guard) |

Every guard above was broken once and watched go red (see the task's `prd.md` 变异红集).

## 7. Wrong vs Correct

#### Wrong

```ts
// The cache key includes the active write region, so it can never hit.
function localDbStamp(dbPath: string): string {
  return `${fileStamp(dbPath)}|${fileStamp(`${dbPath}-wal`)}|${fileStamp(`${dbPath}-shm`)}`
}

// And the whole `data` column is pulled into JS to be re-parsed every round.
const rows = db.prepare(`SELECT data FROM session_message WHERE type='assistant' AND time_created > ?`).all(since)
for (const row of rows) JSON.parse(row.data)
```

#### Correct

```ts
// The active write region is NOT a "nothing changed" signal: opencode writes -wal constantly.
function dbStamp(dbPath: string): string {
  const s = statSync(dbPath)
  return `${s.size}:${Math.round(s.mtimeMs)}`   // 主库只在 checkpoint 时变；新鲜度交给增量
}

// Project in SQL, filter in SQL, and only read the rows the cursor has not seen.
const rows = db.prepare(`
  SELECT id, json_extract(data,'$.cost') AS cost, json_extract(data,'$.time.created') AS t, …
  FROM session_message
  WHERE type = 'assistant' AND rowid > ? AND rowid <= ?
    AND (json_extract(data,'$.providerID') = 'opencode-go'
      OR json_extract(data,'$.model.providerID') = 'opencode-go')`).all(lo, hi)
```

## Related

- [`opencode-console.md`](./opencode-console.md) — the official side of the same provider; local
  numbers are a supplement and must never be presented as official.
- [`../frontend/state-management.md`](../frontend/state-management.md) — the collection loop that
  calls this scanner (budget, epoch gate, refresh semantics).
