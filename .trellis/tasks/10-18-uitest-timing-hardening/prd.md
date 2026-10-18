# uitest 时序脆弱断言收口：瞬时判据改轮询 + flaky 基线可复跑

## Goal

把 `--uitest` 从"跑一次看运气"变成**可复跑的验收工具**：

1. 断言不再依赖"某一瞬间的 DOM 恰好长成那样"（瞬时判据 → 有界轮询）；
2. 有一份**可复跑的 flaky 基线**（N 轮逐键对比），修复前后能给出同口径数字；
3. 对每个观测到的 flaky 键，**判定它是"测试时序 bug"还是"产品竞态"**，不许一律归到测试头上。

## Background（确认事实，源码取证）

**为什么必须做**：`--uitest` 是本仓所有任务的验收手段（`frontend/quality-guidelines.md` 承认"没有 linter、没有 CI"），它自己 flaky 等于每次验收都打折。两个已完成任务的核查代理都撞上过它，并且都**额外花时间证明"这不是我引入的"**（用 `git archive` 另建 HEAD 基线对比）。

| # | 证据 | 位置/观测 |
|---|---|---|
| E1 | **瞬时判据 39 处**：`r.X = (await exec(...)) ? 'ok' : 'fail'` 形式，单点取值、无轮询 | `src/main/qa/uitest.ts` 全文件计数 39 |
| E2 | **正确做法已存在但没铺开**：`waitFor(cond, tries)` 轮询助手在文件里，却只被 dock/岛段落使用；注释明确写着纪律 | `uitest.ts:1794`（定义）、`:1888/:1889/:1974/:1996/:2029`（使用）、`:2080`「所以一律用 waitFor 轮询而不是固定 sleep（固定值在两种模式下必坏其一）」、`:2083` `dockWait` |
| E3 | **最典型的坏例**：先睡 900ms，再查一个"闪一下就消失"的元素 | `uitest.ts:767-772`：`setRefreshInterval('10')` → `sleep(900)` → `intervalSaved` → `intervalFlash = !!document.querySelector('.saved-flash')` |
| E4 | 实测 flaky 键（跨两个任务的核查代理，独立观测） | `intervalFlash`（**HEAD 基线也红，约 1/2 失败**）、`dockSettings`、`grpUnknownBucket`、岛上夹具簇（`grpUnknownBucket` 与 `dockSettings` 3 次里 1 次）、以及一次**整轮挂死**（主线程空转在 `kevent`） |
| E5 | 相关但独立的缺口：10-07 遗留要求"跑 uitest 确认 `.trend-cell`/`.trend-head` 断言绿"，而这两个选择器**全仓零命中**（真实类名是 `.trend-chart` / `.trend-records-*` / `.trend-bar`） | `grep -rn "trend-cell\|trend-head" src/ scripts/ prototype/` → 无输出；`TrendChart.tsx:58-143` |
| E6 | flaky 让**别的任务无法收尾**：`10-07-detail-predict-trim-heatmap` 的「遗留」第①条正依赖 uitest 断言 | `docs/daily/2026-10-07_detail-predict-trim-heatmap.md:98-104` |

**基线（3 轮，`BD_USER_DATA=/tmp/bd-uitest-base`，同一构建、同一机器）**：

### 修复前基线（本任务实测，2026-10-18）

命令：`node scripts/uitest-baseline.mjs --runs 3 --all`（每轮独立临时 `BD_USER_DATA=/tmp/bd-uitest-r<i>`，
同一构建、同一机器；`out/` 为 22:22 的构建，`find src -newer out/main/index.js` 无输出 = 构建是最新的）。

| 轮 | 墙钟 | 键数 |
|---|---|---|
| run 1 | **4m15s** | 171 |
| run 2 | 2m26s | 171 |
| run 3 | 2m25s | 171 |

- **键总数 171**（各轮一致，键集合稳定）。
- **跨轮翻转键 1 个**：`grpUnknownBucket`（值序列 `fail:{"at":null}, ok, ok`）。
- **恒定红键 0 个**。
- 关键键逐键通过率（本任务 E4 列出的 flaky 键）：`intervalFlash` **3/3**、`dockSettings` **3/3**、
  `islandDisable` / `islandNoPct` / `petBallCenterValue` / `petBallHitRect` / `petRingRemoved` /
  `cachedCard` / `detailRefreshSpin` / `grpDupCardName` / `settingsDeleteConfirm` 全 **3/3**。
  ⚠ `intervalFlash` 这 3 轮**没红**：前一个任务的核查代理实测约 1/2 失败（HEAD 基线也红），
  3 轮采样的命中概率不足以稳定复现 —— 这也说明「3 轮无翻转」不等于「不 flaky」，
  所以本任务的判据改造是**按机制**（判据形状）做，而不是「这 3 轮没红就不改」。
- `grpUnknownBucket` 的翻转机制已定位：`setExtras({refreshInterval:'300'})` 会触发一轮真实采集，
  旧代码 `sleep(2500)` 等它落定 —— 一轮出网慢时超过 2.5s，那一轮就落在 `debugPush(ghost)`
  **之后**把注入的夹具冲掉，断言读到 `{"at":null}`。修法见「改了什么」。

（修复后 5 轮见日志 `docs/daily/2026-10-18_uitest-timing-hardening.md`。）


## Requirements

- **R1 有界轮询判据**：新增/统一一个轮询助手（沿用既有 `waitFor` 的形状，提升到全文件可用），把"需要等渲染/等动效"的断言改为**在预算内轮询**，而不是单点取值或固定 `sleep`。
- **R2 瞬时判据分类**：39 处逐条过一遍，按判据分三类处理 —— ①**必须轮询**（等异步渲染/等动效出现）；②**可以保持瞬时**（同一谓词已在前面被 `waitFor` 等过，或断言的是"移除后不存在"）；③**需要改写成"先等消失再断言"**（负向断言不能在移除动作后立刻判）。分类结果必须落成清单（键名 + 类别 + 理由）。
- **R3 可复跑的 flaky 基线**：提供一个脚本，跑 N 轮（默认 3–5）同一套 uitest，输出**逐键通过率**与**跨轮翻转键**；同一命令在修复前后都能跑，给出同口径数字。
- **R4 区分测试 bug 与产品竞态**：对每个 flaky 键，把预算放大（例如轮询 3s）后判断"最终是否出现"：
  - 最终出现 → 测试时序 bug（本任务修测试）；
  - 始终不出现 → **产品竞态**，单独记录并**不在本任务里猜着修**（要另开任务或明确写进存疑）。
- **R5 不拖慢套件**：轮询要有预算上界与早退；整轮 `--uitest` 墙钟不得比现状恶化超过 ~1.5×（现状实测每轮约 1.5–2 分钟）。
- **R6 棘轮守卫**：新增静态守卫，禁止"瞬时判据"的数量**增加**（把 39 这个数字钉住并随修复下降），避免后来者又把坏写法加回来。守卫必须**先弄坏一次**确认变红。
- **R7 不掩盖真问题**：不许用"加大 sleep"或"重试到过为止"的方式让键变绿 —— 必须把判据换成"等条件成立"，且失败时输出**可诊断信息**（当时 DOM 的实际情况，而不是只写 `fail`）。

## Out of Scope

- **不修产品**：本任务的产物是"可信的验收工具"。若 R4 判定出产品竞态，只记录 + 建议另开任务，不在本任务里改产品代码。
- 不重写 uitest 的用例覆盖面（不加新功能断言）。
- 不为 10-07 补 `.trend-*` 断言（那是 10-07 的遗留，属它的收尾；本任务只需保证"跑 uitest 能得到可信结论"）。
- 不引入新的测试框架/依赖（保持现有 `--uitest` 形态与 `exec` 注入方式）。
- 不动 `qa/` 之外的运行时代码。

## Acceptance Criteria

- [x] AC1：R2 的分类清单已产出（**52 处**逐条：键名 + 改造前行号 + 类别 + 理由），且**每一条**都能在 `uitest.ts` 里找到对应行号。
      ⚠ 口径修正：prd 取证写的「39 处」是**同行写法**的数量；按归一化文本另数出**换行写法 13 处**
      （`r.x =\n (await exec(…)) ? 'ok' : …`），同一个缺陷，合计 52 处，全部收口。
      清单见日志 `docs/daily/2026-10-18_uitest-timing-hardening.md` 的「R2 分类清单」。
      另有第 53 处（`islandPosSaved`，复合判据形状，按形状数不到）由 R4 探针实测抓到并修掉。
- [x] AC2：① 类 40 处全部改为 `pollAssert`/`pollCheck` 有界轮询；③ 类 7 处全部改成谓词正向写 + `mode: 'absent'`
      （「出现过又消失 = 成立」/「一直没出现 = 等满预算才成立」）。
- [x] AC3：`scripts/uitest-baseline.mjs` 可用，输出逐键通过率（判据键 / 诊断键分开）+ 跨轮翻转键 + 每轮耗时 +
      失败诊断；`--selftest` 15 项自检；修复前 3 轮与修复后 5 轮各跑过一次（同一条命令）。
- [x] AC4：修复后 **5 轮翻转键 = 0**（`171/171/171/171/171` 键，无恒定红）；`intervalFlash` **5/5 ok**。
      另有一批（不含 `islandPosSaved` 修复的中间构建）同样 5 轮 0 翻转，互为对照。
- [x] AC5：E4 列出的全部 flaky 键（`intervalFlash` / `dockSettings` / `grpUnknownBucket` / 岛上夹具簇 6 键）
      + 探针新抓到的 `islandPosSaved` 都有判定（**全部「测试时序 bug」**）；
      「整轮挂死」判定为**产品收尾问题**（断言跑完但 `app.quit()` 不退，A/B 排除本任务改动），
      已写进「存疑 1」并给出复现命令。判定表见日志 §6。
- [x] AC6：修复后 5 轮 `2m17s / 2m16s / 2m18s / 2m16s / 2m37s`，中位数 2m17s vs 修复前 2m26s = **0.94×**；
      最保守口径（修复后最大 3m19s / 修复前最小 2m25s）= 1.38×，仍在 1.5× 内。
- [x] AC7：`scripts/test-structure.mjs` 新增 N1–N7（瞬时判据必须 0 处、助手清单闭集、`waitFor` 不许自带 for、
      负向必须走 `absent`）；**弄坏一次**实测：同行写法 → N1 红（476/1）；**换行写法 → N1 也红**（476/1）。
- [x] AC8：`npm run typecheck` 无输出（通过）；`npm test` exit=0、24 个套件全 0 失败；`test-structure` 477 通过 / 0 失败。
- [x] AC9：键集合修复前后都是 **171**（各轮一致），既有键一个都没丢；值只从 fail/flaky 变成稳定 ok
      （`intervalFlash` 的值额外带了 `waited=` 诊断，仍是 `ok*`）。

## 核查代理复测（2026-10-19，trellis-check）—— 独立跑过，不是采信自述

命令：`node scripts/uitest-baseline.mjs --runs 3 --all --user-data /tmp/bd-finalcheck`
（核查中途另跑过一批 `/tmp/bd-check`）；`npm run typecheck` / `npm test` / `node scripts/test-structure.mjs`。

| 项 | 实施代理自述 | 核查实测 | 结论 |
|---|---|---|---|
| 键集合（AC9） | 171 × 5 轮 | **171 × 3 轮，与修复前逐键 diff = 0** | ✅ 一致 |
| 「172 个 key」（更早任务记录） | 未解释 | = 171 + `"uitest": true` 标志（`modes.ts:81`） | ✅ **不是丢键**，是数法不同 |
| 翻转键（AC4） | 5 轮 0 | **3 轮 0**（最终源码）；关键键全 3/3 | ✅ 一致 |
| 墙钟（AC6） | 中位数 0.94× | 中位数 2m14s / 2m26s = **0.92×** | ✅ 一致 |
| 门禁（AC8） | 24 套件 0 失败、structure 477/0 | 24 套件 0 失败、structure **479/0**（核查加了 N8a/N8b） | ✅ 数字已同步 |
| `app.quit()` 不退 | A/B：HEAD 同样不退 | **独立复跑 A/B：HEAD 30s 仍存活**；`--smoke` 9s 自退；且**间歇**（3/3 与 1/3 都出现过） | ✅ 一致，建议另开任务 |
| `pollCheck` 的 `absent` | 未提 | **条件恒真时死循环**（探针 8s 不返回） | ❌ **已修** + 新增 N8a/N8b |
| `intervalFlash` 的轮询起点 | 「t=0 起」 | 实际在 `sleep(900)` **之后**（与 §5 结论矛盾） | ❌ **已修**（派发处起轮询 + 派发前清残留） |
| R2 清单行号（AC1） | 52 条「都能找到行号」 | 初版 **39/52** 命中 HEAD，13 条对不上任何版本 | ❌ **已按 HEAD 改正，现 52/52** |
| R7「不许 sleep 换绿」 | 无新增判据型 sleep | 逐条核过 diff：只新增轮询步长 + 1 处有界落定窗口 | ✅ 一致 |

核查改动集中在：`src/main/qa/uitest.ts`（两处）、`scripts/test-structure.mjs`（护栏）、
`docs/daily/2026-10-18_uitest-timing-hardening.md`、`docs/knowledge/agents/uitest-timing.md`。
细节与命令原文见日志「核查代理独立复测」节。**产品代码零改动**（`git status` 只有 `qa/uitest.ts` +
`scripts/**` + `docs/**` + `.trellis/**`）。
