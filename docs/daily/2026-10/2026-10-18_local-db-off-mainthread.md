# 本机用量扫描移出阻塞路径：消灭每轮 2 秒沙漏 + 修缓存键

任务：`.trellis/tasks/10-18-local-db-off-mainthread`（孩子 B；孩子 A = `10-18-sync-collect-watchdog`）

## 起因

用户症状：程序经常卡住、鼠标转沙漏。父任务已取证（本次直接采信，不重复调查）：

| # | 证据 | 观测值 |
|---|---|---|
| E7 | `~/.local/share/opencode/opencode.db` | 638 MB；31 天 assistant 消息 25860 条 / 265 MB |
| E8 | `loadLocal()` 等价口径（拉全量 `data` 进 JS + `JSON.parse`） | **1935 ms/轮**（SQL 1112 + parse 806） |
| E9 | `localDbStamp()` 的 `-wal` stamp | **5 秒内即变** ⇒ `LOCAL_CACHE_TTL` 几乎不命中 |
| E10 | 表结构 | `session_message(id, session_id, type, seq, time_created, time_updated, data)`，数据只在 `data` JSON 里 |
| E11 | SQL 侧 `json_extract` 投影 + provider 过滤 | 761 ms，0 次 `JSON.parse` |
| E12 | 「近 10 分钟」增量口径 | 1 ms |
| E13 | 同型隐患 | `antigravity.ts` 同步读 Keychain；`claude.ts`/`codex.ts` 每轮同步递归 `readdirSync`+`statSync` |

本轮实施中又测到两条**与设计稿冲突的事实**（见「设计取舍」），以及一条测量方法学问题
（见「测量条件」）—— 都写清楚了，没有粉饰。

## 改了什么

| 文件 | 改动 |
|---|---|
| `src/main/adapters/opencode-local.ts` | **新增**。本机用量扫描的全部实现：SQL 侧 `json_extract` 投影 + rowid 增量 + 变更探测（`dbStamp` / `PRAGMA data_version` / `MAX(rowid)`）+ `lastRun()` 诊断。不 import electron，可被真 sqlite 夹具直接测 |
| `src/main/adapters/opencode.ts` | `loadLocal`/`localCache`/`fileStamp`/`localDbStamp`/`parsePoint`/`MsgData` 全部删除，瘦身为装配（模块级单例扫描器 + `detectDbPath` 导出 + 耗时/行数写 `debugLog`）。`loadLocal(nowMs)` 同名同签名 ⇒ 调用点零改动 |
| `src/main/adapters/scan-dir.ts` | **新增**。目录递归遍历的 **mtime 短路**（缓存**条目**而非最终文件列表），claude/codex 共用一份实现 |
| `src/main/adapters/claude.ts` / `codex.ts` | 各自的 `listJsonl` / `listRollouts` 换成 `collectFiles(root, {maxDepth, match})`；深度上限 4/5 与过滤条件逐字不变 |
| `src/main/adapters/antigravity.ts` | `execFileSync('security', …)` → `promisify(execFile)` + `timeout: 5000` + 5 分钟凭据缓存（连"读不到"也缓存）；`readAntigravityToken()` 变 async |
| `scripts/test-local-scan.mjs` | **新增**测试套件（98 断言）：真 sqlite 夹具 + 旧口径基准 + 三模式 + 窗口化增量 + 目录短路 |
| `scripts/lib/fs-probe.mjs` | **新增**。`fs` 探针替身：只给 `readdirSync` 计数，其余透传真 fs（给 AC5 的"目录未变时 readdir 不被调用"用） |
| `scripts/measure-local-scan.mjs` | **新增**。真机三档测量（旧口径 / 新全量 / 新增量 / 稳态），APFS 克隆真库到临时目录，**只读真库** |
| `scripts/test-adapters.mjs` | X0b 改 `await`；XSG7 从"必须 `execFileSync`"翻转为"**零** `execFileSync` + 异步带超时"（533 断言） |
| `package.json` | 注册 `test:local-scan`，并在 `test` 串**末尾**追加（既有项一字未动） |

## 设计取舍（三处与设计稿不同，都是被实测逼出来的）

### ① 增量游标：`time_updated` 水位 → **rowid 范围**

设计稿 §3.2 写的是 `WHERE time_created > :since AND time_updated > :watermark - 600_000`。
**冲突**：真库 `time_updated` 上**没有索引**（只有 `time_created` 与 `(session_id, seq)`），
该条件会把查询退化成全表扫描 —— 实测 200–350ms/轮，直接违反 AC4 的"稳态每轮 < 50ms"。

改成 rowid（b-tree 原生范围键）：`rowid > 上次表尾 - 回看窗口 AND rowid <= 本次表尾`，
EXPLAIN 实测走 `SEARCH ... USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)`。
窗口是**范围**不是"最后 N 行" ⇒ 期间新插入的行永远在窗口里（间隔多久都不漏）。

### ② 回看窗口 1000 → **600 行**

设计稿没给数；我先按"实测最迟回写离表尾 811 行"取了 1000。真机实测 1000 行 ≈ **50–78ms**
（已越过 50ms 红线），600 行 ≈ **29–35ms**。600 行 ≈ 峰值写入速率（86 条/10 分钟）下约 70 分钟，
覆盖"先插行、后回写"的 99.3%（< 10 分钟）。代价：实测那 30 行"lag ≥ 1h"的迟到回写里，
离表尾 > 600 行的部分要等全量核对（≤ 6 小时）才被看见 —— 写进代码注释的「诚实边界」，
并用 `L3x-j/L3x-l` 两条断言把这条边界**钉死**（盲区可见、且有界）。

### ③ 全量核对间隔 10 分钟 → **6 小时**

设计稿 §3.3 说"TTL 从 120s 提到 10 分钟"。**冲突**：全量核对是一次 ~0.7s 的同步阻塞；
每 10 分钟一次 = 把"每轮 2 秒沙漏"换成"每 10 分钟卡 0.7 秒"，症状只是变稀而不是消失。
取 6 小时：盲区最大陈旧度有界，冻结占比从原来的 ~6%（2s/30s）降到 ~0.006%（0.7s/6h）。
进程每次启动也天然是全量，所以真实会话里核对远比 6 小时频繁。

### 另外两处"设计稿没写、但代码事实要求"的补充

- **增量查询带 `time_created > :since`**：不加的话，旧 `message` 表（5663 行全在窗口外）
  每轮被白读 1000 行、白解析 ~790 行 JSON（实测 delta 890→1788 行、47→59ms）。
  加它不会把计划挤到索引上（EXPLAIN 已核）。
- **`rowid` 回退（删表尾 / VACUUM 重排）⇒ 全量重扫**：两者在数据上不可区分，
  宁可多扫一次（真库 16 次/整库生命期），也不让游标指向错行。

## 验收取证

### 1. 真机三档（`node scripts/measure-local-scan.mjs --rounds 5`）

命令：APFS 克隆真库（653MB）到临时目录 → 预热页缓存 → 旧/新**交替跑两轮**（避免顺序造假）。

```
真库：/Users/zhouri/.local/share/opencode/opencode.db      大小：653 MB
load average：17.00 / 30.52 / 26.30

── 同一份数据、同一次会话内的背靠背对比 ────────────────────────────
旧口径（整条 data + JSON.parse）  2820ms   pts=4094   （两轮：2439/2820ms）
新实现 冷启动 full                818ms   rows=4094 pts=4094 mode=full   （两轮：810/818ms）
新实现 增量 delta                 75ms   rows=559 mode=delta
新实现 稳态 cache ×5             avg 5.71ms  max 7.60ms
口径一致性：旧口径 pts=4094 / 新实现 pts=4094（应相等）
```

同一脚本在**较安静的机器**上（load 4.39 / 5.77 / 7.56）：

```
旧口径（整条 data + JSON.parse）  1899ms   pts=3935   （两轮：1932/1899ms）
新实现 冷启动 full                676ms   rows=3935 pts=3935 mode=full   （两轮：627/676ms）
新实现 增量 delta                 47ms   rows=890 mode=delta     ← 当时窗口还是 1000 行
新实现 稳态 cache ×5             avg 4.70ms  max 6.27ms
```

**测量条件（数字必须带条件）**：APFS 克隆出来的副本页缓存是冷的 ——
不预热就测，先跑的那条路会替对方把 651MB 从磁盘读进来（实测预热本身要 11–16s，
未预热时"冷页那次"多花 6–7s，足以把结论倒过来）。所以脚本里：先预热、再交替跑两轮、附 load。

### 2. 应用内两轮（`BALANCEDECK_DEBUG=1`，`--smoke` 之外的真实常驻运行）

```
2026-10-18T10:22:19.996Z collect start (epoch 1)
2026-10-18T10:22:23.294Z opencode: 本机扫描 full 2858ms rows=4112      ← 冷启动那一次（冷页 + 启动竞争 + load 17）
2026-10-18T10:22:27.384Z opencode: 本机扫描 delta 55ms rows=901        ← 第二轮起全是增量
2026-10-18T10:23:25.083Z opencode: 本机扫描 delta 97ms rows=566
2026-10-18T10:23:28.859Z opencode: 本机扫描 delta 71ms rows=894
```

`rows` 大于 600 是因为区间上界是"本次表尾"：**我自己的 opencode 会话正在往库里写**，
新插入的行都落在窗口里（这正是"新行永不漏"的体现）。

另一次负载较低的应用内首轮：`本机扫描 full 1075ms rows=4041` → `delta 62ms rows=895`。

### 3. `balance-export.json` 连续两轮前进（AC7 前半）

```
--- T1 ---  generatedAt 2026-10-18T10:22:24.948Z   opencode.updatedAt 2026-10-18T10:22:19.995Z
--- T2 ---  generatedAt 2026-10-18T10:23:26.732Z   opencode.updatedAt 2026-10-18T10:23:24.965Z
```

### 4. `sample <主进程 pid>`：稳态无热点（AC7 后半）

```
8083 Thread_572397  DispatchQueue_1: com.apple.main-thread (serial)
  + 8083 … __CFRunLoopRun / __CFRunLoopServiceMachPort / mach_msg_trap      ← 8177/8182 采样在等事件
  +  168 __CFRunLoopDoSources0 → … uv__run_timers                            ← 2% 在跑定时器
sqlite / JSON / json_extract 帧数：0
```

主线程 99.94% 采样停在事件循环里等消息；`sample` 里**零** sqlite/JSON 帧。
定量上界来自上一节的每轮耗时（增量 55–97ms / 稳态 ~5ms），远低于"单次 > 200ms 热点"。

## 护栏与红绿实测（每条新护栏都先弄坏一次）

`scripts/test-local-scan.mjs` 98 断言全绿；`npm test`（22 段）全绿；`npm run typecheck` 全绿。

| 变异 | 实测红集 |
|---|---|
| M1 `dbStamp` 加回 `-wal` | L2c L2f L2g **L5b** L5g |
| M2a 快照键换成内容键 `t+cost` | **L3x-g**（窗口外条目丢失 ⇒ 与旧口径不等） |
| M2b 内容键 + 不按窗口清理（= 设计稿警告的"同一消息算两遍"） | **L3e L3f L3g L3h** L3i L3x-g |
| M3 增量不再清窗口内的旧行 | **L3i** L3e L3f（删掉的行变幽灵） |
| M4 丢掉 `type='assistant'` 过滤 | L1b L2o L2q L3e L3g L4f（L0e 兜底） |
| M5 JS 判据从 `??` 改成 OR | **L1h**（SQL 侧与 JS 侧是冗余双保险，单层放宽只被纯函数那条钉住） |
| M6 去掉 `json_valid(data)` | **L1b** L2o L2q L3e L3g（一行坏 JSON 让整表消失） |
| M6b `cost > 0` 收紧成 `cost > 1` | **L1b** L2o L2q L3e |
| M7 增量窗口改成整表（`low = 0`） | **L3x-e L3x-f** L3x-j |
| M8 目录缓存退化成"每轮都 readdir" | **L6b L6d L6h L6l** |
| M9 Keychain 回到 `execFileSync` | **XSG7**（test-adapters） |
| M10 cache 轮无条件复用派生结果（去掉"有行掉出窗口"判据） | **L2r3 L2r4** |

`npm run build` + `BD_USER_DATA=/tmp/… npx electron . --uitest`：172 项，两次里一次全 ok、
一次 `grpUnknownBucket = fail:{"at":null}`（已知 harness 抖动：孩子 A 的 prd 记过
"HEAD 基线也红、每次红 key 不同"，与本改动无因果路径）。

## 未完成 / 存疑（明确写出，不粉饰）

1. **AC4 的 900ms 冷启动红线：隔离测量达标，应用内首轮不达标**。
   隔离（热页）：676ms（load 4.4）/ 818ms（load 17）✅；应用内首轮：1075ms（load 低）
   / 2858ms（load 17 + 冷页 + Electron 启动竞争）❌。差异来源是**页读取量与启动竞争**，
   不是实现 —— 同一条件下旧实现是它的 2.8–3.4 倍（1899→676 / 2820→818）。
   按设计稿 §6 自己写的判据（"若真机冷启动 > 900ms，再单开任务引入 worker/utilityProcess"），
   **建议单开一轮**把首次全量挪出主线程；本轮按设计 deferred。
2. **AC4 的"稳态每轮 < 50ms"：安静机器达标（29–35ms），load 13–17 时不达标（55–97ms）**。
   同一次测量里全量也从 676ms 涨到 818ms ⇒ 是机器负载的整体放慢，不是增量路径的退化。
   数字与 load 一起报在上一节。
3. **增量的两处盲区**（远离表尾的迟到回写、远离表尾的删除）**没有消除，只是有界**（≤ 6 小时，
   由全量核对收口），并用 L3x-j/L3x-l 显式钉住。要彻底消除需要 worker + 常驻核对，本轮不做。
4. `sample` 只能证明"采样窗口内没有热点"，冷启动那一次 0.7–2.9s 的阻塞**不在**采样窗口里
   （它在进程启动首轮）。真正的定量证据是 debugLog 的每轮耗时。
5. `fetchJson` 式的"异步化"没做：`node:sqlite` 在 Node 22 只有同步 API，
   所以"移出主线程"只能靠 worker/utilityProcess（见 1）。

## 核查代理独立复核（2026-10-18，trellis-check）

核查代理**没有复用**本日志的夹具与红集：自建 7 组边界场景（29 断言）、5 组真库只读实验，
并独立重做 3 组变异。**结论：实施自述全部成立**，另有 1 处口径边界 + 1 条机制事实需要记录。

### 独立复现成立的部分

| 项 | 我的独立做法 | 结果 |
|---|---|---|
| 逐点等价（总闸门） | 自建 7 组场景：同 `t` 不同 cost / 同 `(t,cost)` 不同 model / 同名 `id` 跨表 / 窗口边界 `tc == since` / `tc` 与 JSON `t` 解耦 / 空表 / 表尾删除 / 8+5 轮增量累积 | 29 断言全绿；`pts` + `byModel` 与"整条 `data` + `JSON.parse`"冻结基准**逐点相等** |
| 增量游标真的走主键 | 真库 `EXPLAIN QUERY PLAN`（自己跑） | 增量 `SEARCH session_message USING INTEGER PRIMARY KEY (rowid>? AND rowid<?)` ✅；全量 `SEARCH … USING INDEX session_message_time_created_idx (time_created>?)`；`message` 表 `SCAN`（5663 行、窗口内 0 行 ⇒ 增量里那句 `time_created > since` 确实必要） |
| `data_version` 是有效判据 | 外部**进程**（`spawn` 新 node）改一个真实字段，再读 `PRAGMA data_version` | `2 → 3` ✅ |
| 变异红集 | 独立重做 M1 / M2b / M10（脚本化改源码 → 跑套件 → 还原） | `L2c L2f L2g L5b L5g` / `L3e L3f L3g L3h L3i L3x-g` / `L2r3 L2r4` —— 与本日志表格**逐字相同** |
| R6 Keychain 有界 | PATH 前置一个 `sleep 600` 的假 `security`，直接调 `readAntigravityToken()` | 第 1 次 **5006ms** 返回（= `KEYCHAIN_TIMEOUT_MS`），第 2 次 **0ms**（命中缓存）；换回真 `security`（条目不存在）**0ms** 快速失败 ✅ |
| 测量脚本只读真库 | 审计 `realPath` 的全部用处 | 只有 `detectDbPath()` / `statSync` / `existsSync` / `cp`（读源）；所有写落在副本上 ✅ |
| `antigravity.ts` 零 `execFileSync` | 全文 grep + 确认 `agCode` 已去注释 | 唯一命中在**注释**里（`XSG7` 不空洞）✅ |
| `scan-dir.ts` 真被两家共用 | 读 diff | `claude.ts` / `codex.ts` 各自 `collectFiles(root, {maxDepth, match})`，无第二份实现；深度上限 4/5、`.jsonl` / `rollout-*.jsonl` 过滤、符号链接跟随**逐字未变** ✅ |
| 既有套件不碰真库 | 查 `test-adapters` 的 N3b | 那次 `.collect()` 调的是手写基座 `multiKeyBase`，**不是** `opencodeAdapter` ⇒ 测试不会读真机 660MB 库 ✅ |
| 全绿 | `npm run typecheck` + `npm test`（自己重跑） | typecheck 通过；`npm test` **exit 0 / 22 段 / 0 条 ✗**（`test:local-scan` 是末段，既有串一字未改、只追加）✅ |

### 核查新增：两条要记录的事实

1. **`PRAGMA data_version` 对"无内容变化的写入"不动。**
   `UPDATE … SET time_updated = time_updated` 实测 `changes() = 1` 但 `data_version` 2→2；
   改成真实改动（`+1`）才 2→3。这是 SQLite 的 no-change 优化。**对产品是安全的**
   （内容没变 ⇒ 投影也没变 ⇒ 没有东西要重读），但它解释了**为什么判据不能是
   `changes()` 或"写过几次"** —— 只有 `data_version` 才代表"有别的连接提交了会改变读结果的东西"。
   （核查第一轮曾据此误报"`data_version` 无效"，根因就是我自己用了 no-op UPDATE；已自纠。）
2. **去重顺序的唯一分歧边界**（已写进 `opencode-local.ts` 的 `derive` 契约注释）。
   旧实现两张表拿到**不同的查询计划**：`session_message` 按 `time_created` 索引序、
   `message` 按 rowid 表扫序 —— 所以"旧顺序"**没有单一答案**，对齐其中一张必然与另一张错开。
   分歧只在一种输入下可见：**同表内两行共享 `(t, cost)` 且 `time_created` 次序与 rowid 次序相反**
   （此时保留的 `model` / `tokens` 不同）。真库实测 **4248 个去重键里重复 0 个** ⇒ 当前不可观测。
   **决定：不修**（两种顺序都是任意的，旧的那一种还是计划副产品），只把事实钉在代码注释里。

### AC4 复核：绝对数字在核查期间**不可复现**（同代码差 3.6 倍）

同一台机器、同一份代码、660MB 真库，核查代理跑了 **3 次** `measure-local-scan.mjs`
（预热 + 旧/新交替，脚本自带）：核查期间机器负载持续恶化（预热 660MB 的耗时就是负载计：

| 次数 | 预热耗时（负载计） | 旧口径 | 新 full | 旧:新 | 新 delta | 新 cache |
|---|---|---|---|---|---|---|
| A | 15.4s（load 11.4） | 3871ms | **1222ms** | 3.17× | 51ms | 0.26ms |
| B | 36.9s（load 17.4） | 10222ms | **4418ms** | 2.31× | 139ms | 0.86ms |
| C | 35.2s | 10000ms | **2971ms** | 3.37× | 229ms | 1.50ms |
| 自建归因：预热后连跑 5 次 full | — | — | **1786 / 3331 / 3433 / 3746 / 3083ms** | — | 109ms | 1 / 31 / 0 / 0 / 0ms |
| 自建归因：**冷页**（不预热） | — | — | **11116ms** | — | — | — |

⇒ 三点结论：

1. **绝对耗时被机器负载主导**（同代码 1222 → 4418ms；冷页一次 11s；预热一次 15–37s），
   **不能**用它判定实现优劣。实施代理测到 676/818ms 的那次，预热只要 11–16s ⇒ 机器比现在安静得多；
   那不是它测错，是**这个数字必须连负载一起读**。
2. **稳定的是比值**：旧 : 新 = **2.31× / 3.17× / 3.37×**（实施代理 2.8× / 3.45×）——
   实现确实是 2.3–3.4× 的真实改善，且口径一致性每次都成立（`pts` 两侧相等）。
3. **AC4 的 900ms 红线在核查期间的三次隔离测量里全部未达标**（1222 / 2971 / 4418ms，
   连"预热后隔离测"也是 1222ms）。结论与实施代理相同、但证据更强 ⇒ **应单开 worker 任务**。
   要复现"达标"需要在安静机器上重测；`docs/knowledge/main/local-db-scan.md` 已把
   "数字必须带测量条件"写成纪律（本次又验证了一遍：负载计就是预热耗时）。

## 沉淀

- `docs/knowledge/main/local-db-scan.md`（**新增**）：① WAL 活跃区不能当缓存键 + `data_version`
  才是正确判据；② JSON 列只能靠投影省 CPU、省不掉页读取量（进毫秒级靠增量或 worker）；
  ③ 增量游标必须选**有索引**的列；④ 增量的合并键必须是行身份；⑤ 数字必须带测量条件
  （含"克隆副本页缓存是冷的 ⇒ 谁先跑谁吃亏"这条测量方法学）。
- `docs/knowledge/main/index.md` 追加一行。
