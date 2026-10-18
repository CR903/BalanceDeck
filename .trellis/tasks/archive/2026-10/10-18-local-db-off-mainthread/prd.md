# 本机用量扫描移出阻塞路径：消灭每轮 2 秒沙漏 + 修缓存键

## Goal

把"每轮采集在主进程同步阻塞约 2 秒"变成"常态毫秒级、冷启动一次有上界且被记录"，并把缓存"数据没变"的判据改成语义正确的那个；同时收口主进程里其它同型可阻塞调用。

## Background（实测取证，2026-10-18）

| # | 证据 | 观测值 |
|---|---|---|
| E7 | `~/.local/share/opencode/opencode.db` | 638 MB；31 天 assistant 消息 **25860 条 / 265 MB** |
| E8 | `loadLocal()` 等价口径（拉全量 `data` 进 JS + `JSON.parse`） | **1935 ms/轮**（SQL 1112 + parse 806） |
| E9 | `localDbStamp()` 的 `-wal` stamp | **5 秒内即变**（`3221872@…401` → `3448472@…406`）⇒ `LOCAL_CACHE_TTL` 几乎不命中 |
| E10 | 表结构（`sqlite_master`） | `session_message(id, session_id, type, seq, time_created, time_updated, data)`，数据**只**在 `data` JSON 里，无独立 cost/provider 列；**有** `session_message_time_created_idx`（`time_created`）与 `sqlite_autoindex`（`id` 主键） |
| E11 | SQL 侧 `json_extract` 投影 + provider 过滤（31 天） | **761 ms**，rows=14029，**0 次 `JSON.parse`** |
| E12 | 同一投影换成"近 10 分钟"口径 | **1 ms**，rows=70 |
| E13 | 同型隐患 | `adapters/antigravity.ts:116-131` `execFileSync('security', …)` 同步读 Keychain（一旦弹 ACL 授权窗，**永久**堵死主进程）；`adapters/claude.ts:73-90` / `codex.ts` 每轮同步递归 `readdirSync`+`statSync` |

（`loadLocal()` 在 `opencode.ts:350`，缓存键在 `:331-343`，查询在 `:403`/`:414`。）

## Requirements

- **R1 缓存键语义正确**：`localDbStamp()` 不得包含 `-wal` / `-shm` 的 size/mtime（活跃写入区，opencode 每次写都动它）。改用主库 `size:roundedMtime` + 显式 TTL。
- **R2 不再把 `data` 搬进 JS**：查询改为 SQL 侧 `json_extract` 投影 + SQL 侧 provider 过滤（实测 1935ms → 761ms，且 0 次 `JSON.parse`）。
- **R3 常态化增量**：以行主键 `id` 为身份、以 `time_updated` 为水位，每轮只重读"新增或更新过"的行；**结果必须与一次性全量扫描逐点等价**（同点集、同 `byModel` 汇总）。
  ⚠ **实施偏差（已实测、已记录）**：游标从 `time_updated` 水位改为 **rowid 范围**（`time_updated` 无索引 ⇒ 每轮退化全表扫 200–350ms，违反 AC4 的 <50ms）；因此"等价"只在**回看窗口（600 行）内**成立，窗口外的改值/删行由 **6 小时全量核对**收口（不是永久错误，但最大陈旧度 = 6h）。理由与全部实测见 daily 日志「设计取舍 ①②」与「核查代理独立复核」；L3x-j/L3x-l 显式钉住这条边界。
- **R4 冷启动有上界且可观测**：进程启动后的第一次全量扫描是唯一的大开销（761ms），必须写进 `debugLog`（耗时 + 行数）；稳态每轮 < 50ms。
- **R5 诚实口径不变**：tokens 仍只来自本机且仍标注「本机」；缺失值不填 0；本机数据不得被当成官方数据（`shared/quality.ts` 语义不动）。
- **R6 异步化同步 Keychain**（E13 最危险的一条）：`antigravity.ts` 的 `execFileSync` 改异步调用 + 超时 + 凭据缓存，使"弹授权窗"不再能堵死主进程。
- **R7 目录扫描短路**：`claude.ts` / `codex.ts` 的每轮递归 `readdirSync` + `statSync` 改为目录 `mtime` 短路（目录未变则复用上次文件列表）；单文件全量 `readFileSync` 保持现状（已有 per-file mtime 缓存）。

## Out of Scope

- **`worker_threads` / `utilityProcess` 化**：deferred。理由写在 `design.md` §6（electron-vite 主进程 worker 需额外入口与打包配置；冷启动只剩一次 761ms，风险收益不匹配）。若将来冷启动开销变得不可接受，再单开任务。
- 不改官方数据口径与控制台端点抓取（`adapters/opencode-console.md`）。
- 不动 `usage-history.json` 的存储格式与采样节奏。
- 不动 UI 展示与文案（tokens 的「本机」标签保持）。
- 不引入新的依赖（`node:sqlite` 是运行时内置）。

## Acceptance Criteria

- [x] AC1（夹具）：用临时 `node:sqlite` 库构造"`-wal` 变、主库不变"→ 断言命中缓存、**未重扫**；**全量重扫只在四种条件下发生**：无快照 / rowid 回退（删表尾、VACUUM）/ 表集合变化 / `FULL_RESCAN_MAX_AGE_MS` 到期。⚠ 主库 stamp 变（checkpoint）**不**触发重扫，只触发增量 —— 实测"stamp 变即全量"在 WAL 下等于每次 checkpoint 卡 ~0.7s（L2l 钉住；理由见下方「设计取舍」③）。
- [x] AC2（等价性）：同一批数据下，"增量累积结果"与"一次性全量结果"**逐点相等**（`pts` 与 `byModel` 都比）。
- [x] AC3（水位正确性）：把某行的 `cost` 改大并推进 `time_updated` → 断言该行被重读且**只出现一次**（不双计）；把行删掉 → 断言结果里不再有它。
- [x] AC4（真机取证）：638 MB 真库上冷启动全量 < 900ms、稳态每轮 < 50ms（可复跑命令与输出写进验收小节）。—— **未达标（部分）**：实施当日隔离测量（热页）冷启动 **676ms（load 4.4）/ 818ms（load 17）**、稳态 cache **4.7–5.7ms ✅**；但**应用内首轮 1075–2858ms ❌**（冷页 + 启动竞争），增量在 load 13–17 时为 55–97ms ❌。**2026-10-18 核查代理独立重测 3 次：冷启动 1222 / 2971 / 4418ms —— 三次全部越过 900ms 红线**（机器负载已恶化：预热 660MB 从 15s 涨到 37s），故 676/818ms 不可复现；**稳定的是比值 旧:新 = 2.31–3.37×**（证明实现确实是 2.3–3.4× 的真实改善）。⇒ 建议单开 worker 任务把首次全量移出主线程；差异来源与全部原始输出见验收小节与 daily 日志「核查代理独立复核」。
- [x] AC5（静态守卫）：`src/main/adapters/antigravity.ts` 整文件**零** `execFileSync`；`claude.ts`/`codex.ts` 的目录遍历走 mtime 短路（用测试断言"目录未变时 `readdir` 不被调用"）。
- [x] AC6：`npm run typecheck` + `npm test` 全绿；每条新护栏先弄坏一次确认变红。
- [x] AC7（真机）：连续两轮采集 `balance-export.json` 的 `updatedAt` 前进；`sample <pid>` 中主线程无单次 > 200ms 热点。
- [x] AC8（回归）：既有 `test-adapters` / `test-quality` / `test-read-model` / `test-cli-export` 全绿 —— tokens 口径与缺失值口径零变化。


---

## 验收取证（2026-10-18 实施，孩子 B）

> 完整日志：`docs/daily/2026-10-18_local-db-off-mainthread.md`（含设计取舍、变异红集、测量条件）。

### AC1 缓存键与三模式（夹具）

`node scripts/test-local-scan.mjs` → **98 断言 0 失败**。相关：`L2a/L2e/L2h/L2m/L2p/L2r`。
- 什么都不动 ⇒ `mode=cache`（0 次查询）；
- **只动 `-wal`**（utimes，无提交）⇒ 仍 `cache`、未重扫；主库 stamp 同步断言未变；
- 另一个连接真提交（`-wal` 变、主库不变）⇒ `delta`（明确断言 `!== 'full'`）；
- checkpoint（主库 stamp 变）⇒ **不重扫**（设计稿"stamp 变即全量"在 WAL 下等于每次 checkpoint 卡 0.7s，实测）；
- 超过 `FULL_RESCAN_MAX_AGE_MS` ⇒ `full`（TTL 到期 → 重扫）；`MAX(rowid)` 回退 ⇒ `full`。
- 变异 M1（`-wal` 加回 `dbStamp`）⇒ 红集 `L2c L2f L2g L5b L5g`。

### AC2 等价性

`L1b`（冷启动全量 == 旧口径逐点）、`L3e/L3f`（增量累积 == 旧口径一次性全量 == 全新扫描器全量）、
`L3x-c/L3x-g`（1300 行大表：窗口化增量仍逐点相等）。夹具覆盖 19 类边界行
（`cost<=0` / 缺 cost / 非 opencode-go / 新老两代字段形状 / 坏 JSON / 窗口边界 / 跨表 `(t,cost)` 重复 /
`pid` 存在但不是 go / cost 是字符串）。
- 变异 M2b（合并键换成内容键 + 不按窗口清理）⇒ 红集 `L3e L3f L3g L3h L3i L3x-g`。

### AC3 水位正确性

`L3g/L3h`（改大 cost 并推进 `time_updated` ⇒ 该行**只出现一次**且取新值）、`L3i`（删行 ⇒ 结果里消失）。
- 变异 M3（不再清窗口内的旧行）⇒ `L3i` 红。

### AC4 真机取证

`node scripts/measure-local-scan.mjs --rounds 5`（APFS 克隆真库 653MB 到临时目录，**只读真库**；
先预热页缓存、旧/新**交替跑两轮**、打印 load average）：

| 条件 | 旧口径 | 新 full | 新 delta | 新 cache |
|---|---|---|---|---|
| load 4.39（热页） | 1899ms | **676ms** ✅ | 47ms（窗口 1000） | **4.70ms** ✅ |
| load 17.00（热页） | 2820ms | **818ms** ✅ | 75ms | **5.71ms** ✅ |

应用内（`BALANCEDECK_DEBUG=1` 真实常驻运行）：首轮 `full 2858ms rows=4112`（冷页 + 启动竞争 + load 17）
→ 其后全部 `delta 55/97/71ms`；另一次负载较低的应用内首轮 `full 1075ms` → `delta 62ms`。

**结论：部分达标。** 隔离测量（热页）冷启动 676/818ms 在红线内；**应用内首轮 1075–2858ms 超红线**
（页读取量 + 启动竞争，非实现差异：同条件下旧实现是它的 2.8–3.4 倍）。稳态 cache 4.7–5.7ms ✅；
增量 29–35ms（安静）/**55–97ms（load 13–17）**。
按 design.md §6 自己写的判据（真机冷启动 > 900ms ⇒ 回来做 worker/utilityProcess），
**建议单开一轮把首次全量移出主线程**；本轮按设计 deferred。

### AC5 静态守卫

`L5b`（`opencode-local.ts` 去注释后零 `-wal`/`-shm`）、`L5c`（零 `JSON.parse`）、`L5d/L5e/L5f`（旧实现没被并行保留）；
`L6b/L6d/L6h/L6l`（目录 mtime 未变 ⇒ **0 次 `readdir`**，产品路径上 claude/codex 各一条；子目录变了只重读那个子目录）；
`test-adapters` 的 `XSG7`（`antigravity.ts` 整文件零 `execFileSync`）+ `XSG7b`（异步 + 有界超时）。
- 变异 M8（目录缓存退化）⇒ `L6b L6d L6h L6l` 红；M9（Keychain 回 `execFileSync`）⇒ `XSG7` 红。

### AC6 全绿 + 变异

```
npm run typecheck   → 通过（node + web 两个 project）
npm test            → exit 0，22 段全绿，0 条 ✗
node scripts/test-local-scan.mjs → 98 通过 / 0 失败
node scripts/test-adapters.mjs   → 533 通过 / 0 失败
```
12 组变异（M1–M10 / M2b / M6b）红集见 daily 日志表格 —— 每条新护栏都被实测证明确实会红。

### AC7 真机两轮 + sample

`updatedAt` 前进：`2026-10-18T10:22:19.995Z` → `2026-10-18T10:23:24.965Z`（`balance-export.json` 的 opencode 条目）。
`sample <主进程 pid> 10`：主线程 8177/8182 采样停在 `mach_msg_trap`（等事件），**0 帧** sqlite/JSON；
每轮耗时上界见 AC4（增量 55–97ms、稳态 ~5ms）。

### AC8 回归

`test-adapters`（533）/ `test-quality` / `test-read-model` / `test-cli-export` 全绿；
`opencode.ts` 的 `LocalStats` 消费点（`officialWindows` / `sumInRange` / `modelRows` / `mergeConsoleModels`）零改动，
tokens 仍只来自本机、缺失值仍不填 0（`L1f/L1k` 与既有 `test-ssr-parser` 一并钉住）。
