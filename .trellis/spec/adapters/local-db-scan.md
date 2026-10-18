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
  lastRun(): { mode: 'cache' | 'full' | 'delta'; ms: number; rows: number } | null
}

export function createLocalScanner(opts: { detectDbPath: () => string | null }): LocalScanner
export function dbStamp(dbPath: string): string            // 主库 size:roundedMtimeMs —— 不含 -wal/-shm
```

Consumers (`officialWindows` / `sumInRange` / `modelRows`) are unchanged; `loadLocal(nowMs)` in
`opencode.ts` keeps its name and signature so every call site is untouched.

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
  The 600-row look-back window and the 6-hour full reconciliation bound the blind spot for rows
  updated outside that window (asserted by `L3x-j` / `L3x-l`).
- **Merge identity is the row** (`id`), never `t|cost`: a re-written `cost` changes that content
  key and the same message would be counted twice.
- **Honesty**: `tokens` still comes only from the local DB and is still labelled 本机; missing
  values are never filled with `0`; `shared/quality.ts` semantics are untouched.

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
  6-hour reconciliation. Bounded and asserted, not eliminated.

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
| `L6b/d/h/l` | `claude`/`codex` second `collect()` performs **0** `readdir` calls |
| `XSG7` | `antigravity.ts` contains **zero** `execFileSync` (async + bounded timeout instead) |

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
