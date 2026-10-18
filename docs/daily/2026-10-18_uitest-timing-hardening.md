# uitest 时序脆弱断言收口：52 处瞬时判据归零 + 翻转键从 1 → 0（5 轮实测）

任务：`.trellis/tasks/10-18-uitest-timing-hardening`（父任务 `10-18-sync-collect-watchdog` 的后续；
它的核查代理用 `git archive` 另建 HEAD 基线证明了「这些 flaky 不是它引入的」，本任务把那次自证变成工具）

## 起因

`--uitest` 是本仓唯一的运行期验收手段（无 linter、无 CI），而它自己 flaky：
前两个任务的核查代理都额外花时间证明「这不是我引入的」，`10-07-detail-predict-trim-heatmap`
的收尾还卡在它的断言上。**flaky 的验收工具 = 每次验收都打折**，且它的红会被当成新回归。

| # | 证据 | 观测值 |
|---|---|---|
| E1 | 「睡固定值 → 单点取一次 DOM」的判据数量 | 同行写法 `r.x = (await exec(…)) ? 'ok' : …` **39 处**；**换行写法另 13 处**（按行 grep 会漏），合计 **52 处** |
| E2 | 正确做法已存在但没铺开 | `waitFor` 只被 dock/岛段使用；`uitest.ts` 里同时存在 5 种轮询写法（`waitFor` / `waitIdle` / `dockWait` / 手写 for / `sleep`） |
| E3 | 最典型的坏例 | 改造前 `:766-772`：`setRefreshInterval('10')` → `sleep(900)` → `intervalFlash = !!document.querySelector('.saved-flash')`（该元素 1600ms 后自己消失） |
| E4 | 修复前 3 轮基线（本任务实测） | 键数 171/171/171；**翻转键 1 个**：`grpUnknownBucket`（`fail:{"at":null}, ok, ok`）；墙钟 4m15s / 2m26s / 2m25s |
| E5 | `grpUnknownBucket` 的翻转机制 | `setExtras({refreshInterval:'300'})` 会触发一轮真实采集，旧代码 `sleep(2500)` 等它落定；一轮出网慢过 2.5s 时它落在 `debugPush(ghost)` **之后**，把注入夹具冲掉 → 读到 `{"at":null}` |
| E6 | 与 10-07 遗留的交叉 | `.trend-cell` / `.trend-head` 全仓零命中（真实类名 `.trend-chart` / `.trend-bar` / `.trend-records-*`）—— 见「未完成 / 存疑」 |

## 改了什么

| 文件 | 改动 |
|---|---|
| `src/main/qa/uitest.ts` | 新增**唯一**轮询原语 `pollCheck(condJs, { mode, budgetMs, stepMs, diagJs })` + 断言串包装 `pollAssert`；`waitFor` / `waitIdle` / `waitCollectIdle` / `dockWait` 全部收敛成它的薄壳（**删掉了第二套 for 循环**）。52 处瞬时判据按 ①②③ 三类改完。 |
| `src/main/qa/uitest.ts` | 4 处 `refreshNow()/setExtras(…) + sleep(2500)`（等一轮真实采集收尾）→ `waitCollectIdle()`（先等 `scanning` 为真、再等它为假）。这是 `grpUnknownBucket` 翻转的直接修法。 |
| `src/main/qa/uitest.ts` | `grpUnknownBucket`：由「先 `waitFor` 卡片出现 → 再单点读 at/tag/aria 三个字段」改成**一条复合谓词**整条等。 |
| `src/main/qa/uitest.ts` | `islandDisable` / `islandNoPct` / `petBallCenterValue` / `petBallHitRect`：夹具推下去后先等谓词（combo 数 / 该家节点 / `.isl-body`）成立再读，不再 `sleep(400)` 后单点取。 |
| `src/main/qa/uitest.ts` | `runPetMenu`：派发 `contextmenu` 前先等 `.isl-hit` 出现（旧写法在岛 DOM 还没挂上时被 `if(!b) return 'no-hit'` 吞掉 → `captured` 停在 `<not-called>` → `petRingRemoved: fail:menu=<not-called>`）。 |
| `src/main/qa/uitest.ts` | `dockSettings`：由「点 → `sleep(500)` → 单点读 extras」改成 `flipDockTo()`（等**落盘值**变成期望，失败时带出实际读到的那份）；并把还原判据从 `!== '0'` 改成「等于期望的还原值」（原判据在用户本来关着贴边隐藏时会把正确行为判红）。 |
| `src/main/qa/uitest.ts` | `islandPosSaved`（**探针跑新抓到**，见 §5）：由「单点读 `ui:islandX`」改成「等落盘值追上来」（`pollCheck`，`budgetMs: 2000`）。它是同一缺陷类，但形状是复合判据（不是 `r.X = (await exec(…)) ? 'ok'`），所以没进那 52 处的清单。 |
| `src/main/qa/uitest.ts` | **（核查阶段补）** `intervalFlash` 的轮询移到**派发处（t=0）**、并在派发前先清掉上一动作的残留 flash；`pollCheck` 的 `absent` 预算判据改到**每一条路**上（原来条件恒真时死循环）。见「核查代理独立复测」⑨⑩。 |
| `scripts/uitest-baseline.mjs` | **新增**。N 轮基线：解析 `--uitest` 的 stdout JSON，输出逐键通过率 / 跨轮翻转键 / 每轮耗时 / 失败诊断；`--selftest` 用构造数据自检聚合逻辑（15 项）。 |
| `scripts/uitest-baseline.mjs` | **收尾抗挂死**（实测踩到，见「存疑 1」）：JSON 一进 stdout 就算这轮结束（**不等进程退出**）+ `detached: true` 后 `process.kill(-pid, 'SIGKILL')` 整组杀 + 记 `exitHang`。旧实现在「断言跑完但 `app.quit()` 不退」时永远读不到结果（整轮测量卡死）。 |
| `scripts/test-structure.mjs` | **新增** N1–N7 棘轮守卫（瞬时判据必须 0 处、助手清单是闭集、`waitFor` 不许自带 for、负向必须走 `absent`）。 |
| `docs/knowledge/agents/uitest-timing.md` | **新增**沉淀：断言只许「等条件成立」+ 一个轮询实现 + 负向等满预算 + 失败带现场。 |

### R2 分类清单（52 处逐条：键名 + 改造前行号 + 类别 + 理由）

行号口径：**`git show HEAD:src/main/qa/uitest.ts` 的行号**（= 改造前）。核查代理用脚本把本表
解析出来、逐条对 HEAD 版找 `r.<键名> =` 所在行：**52/52 命中**（改正后）。
⚠ 初版有 **13 条**行号对不上任何版本（vrs 段 11 条 + `dockDefaultOn` + `grpDupCleanup`；
记录的数值比 HEAD 大 165–215 行不等，也**不是**改造后/`git diff` 新文件的行号）——
核查阶段已按 HEAD 实测改正。「键名 + 行号」是这张表唯一能被复核的凭据，行号错等于没写。

类别定义：**①** 必须轮询（谓词依赖异步渲染/动效/落盘后回读）；**②** 可保持瞬时（稳定结构，
或同一谓词前面已轮询确认过 → 写 `budgetMs: 0` 显式表达「不需要等」）；**③** 负向断言
（谓词正向写 + `mode: 'absent'`）。

| 键名 | 改造前行号 | 类别 | 理由 |
|---|---|---|---|
| `card` | 322 | ① | `expand()` 之后视图切换是异步的 |
| `cardGrid` | 323 | ① | 同上（网格 / 空态二选一，都依赖同一帧渲染） |
| `detailOpen` | 330 | ① | 卡片点击后详情页异步挂载 |
| `detailWindows` | 331 | ① | 详情页窗口行由快照驱动，晚于容器 |
| `detailBack` | 427 | ① | 返回后卡片视图异步重挂 |
| `dotDom` | 448 | ① | 收起态岛 DOM 由 `collapsed` 推送后挂载 |
| `cardBack2` | 639 | ① | 双击回卡片视图异步（**保留**原现场串「岛还在 = 双击没切走」） |
| `logoBadge` | 664 | ① | 徽标 `<img>` 异步加载 |
| `gridAfterRefresh` | 665 | ① | 刷新后网格重画 |
| `titleRefreshBtn` | 668 | ② | 标题栏静态标记，且上面 `card`/`gridAfterRefresh` 已确认卡片视图就位 |
| `settingsOpen` | 686 | ① | `footerClick('设置')` 后设置页异步挂载 |
| `settingsProviders` | 687 | ① | 供应商行由 `listProviders()` 异步填充 |
| `settingsAddBtns` | 688 | ① | 按钮数由 catalog 拉取后决定 |
| `settingsAddCustom` | 735 | ① | 添加后 `body.innerText` 要等重渲染 |
| `settingsRemoveCustom` | 746 | ③ | 「行真的没了」= 等出现过的它消失 |
| `intervalSaved` | 769 | ① | 落盘回读（IPC 往返 + 整文件重写） |
| `intervalFlash` | 772 | ① | **瞬时**元素（1600ms 自灭），出现时刻取决于 `await setExtras` 的耗时 |
| `vrsHiddenWhenOff` | 818 | ③ | 「配置区不该渲染」= 等它（若在）消失 |
| `vrsPowerOn` | 824 | ① | 开关点击后配置区异步出现 |
| `vrsEndpoint` | 847 | ① | 读的是**渲染出来的分支**（预设分支才有只读端点） |
| `vrsCustom` | 853 | ① | 切自定义后三项异步出现 |
| `vrsRoutineHidden` | 904 | ③ | 「兜底间隔不该在」= 等它消失 |
| `vrsGradeNote` | 927 | ② | `.vrs-foot` 静态文案，且 `vrsPowerOn` 已确认配置区就位 |
| `vrsNotifyVisible` | 945 | ② | 系统通知分组刻意在 `{ttsOn && …}` 之外 = 静态结构 |
| `vrsSection` | 801 | ② | `.section-title` 静态结构，设置页已渲染多时 |
| `vrsPowerSaved` | 827 | ① | 落盘回读 |
| `vrsPresetSaved` | 856 | ① | 落盘回读 |
| `vrsPresetUrlSynced` | 872 | ① | 落盘回读（JSON 往返） |
| `vrsFormatSaved` | 890 | ① | 落盘回读 |
| `vrsRoutineOn` | 908 | ① | 落盘回读 |
| `vrsRoutineSaved` | 917 | ① | 落盘回读 |
| `vrsPowerOff` | 934 | ① | 落盘回读 |
| `vrsNotifyOff` | 958 | ① | 落盘回读 |
| `vrsNotifyHidden` | 963 | ③ | 「阈值输入收起来」= 等它消失 |
| `vrsNotifyCfg` | 977 | ① | 落盘回读（`JSON.parse` 后比字段） |
| `settingsBack` | 989 | ① | 返回后卡片视图异步 |
| `trayExpandRestore` | 1153 | ① | `expand()` 后卡片视图异步 |
| `petCardRemoved` | 1226 | ③ | 已删除的功能：等它（若被写回）消失；一直没出现则等满预算 |
| `petSectionGone` | 1231 | ③ | 同上（整个分区已下线） |
| `petToggleOff` | 1282 | ① | 落盘回读 |
| `cachedCard` | 1619 | ① | `debugPush` 后渲染层重画（**保留**原 `[cachedDom]` 现场串） |
| `offlineBanner` | 1622 | ① | 状态行文案随推送更新 |
| `cachedBanner` | 1627 | ① | 点进详情后横幅异步挂载 |
| `localChip` | 1635 | ① | 注入后角标异步 |
| `errorState` | 1639 | ① | 状态行文案随推送更新 |
| `settingsOpen`（第二次赋值） | 1734 | ① | 拖拽段之后重新进设置页 |
| `settingsProviders`（第二次） | 1735 | ① | 同上 |
| `settingsIcons` | 1736 | ① | `.pmark` 由 catalog 异步决定 |
| `settingsAddBtns`（第二次） | 1737 | ① | 同上 |
| `settingsDeleteConfirm` | 1757 | ① | 二次确认态（`data-confirm="1"`）是点击后的异步重渲染结果 |
| `dockDefaultOn` | 2093 | ② | 读的是**没被任何动作改过**的偏好（本段之前只有 `primePrefs` 写过） |
| `grpDupCleanup` | 2067 | ③ | 清理必须真的生效：谓词正向写（还存在），等它不再成立 |

合计：① **40** 处 / ② **5** 处 / ③ **7** 处 = **52** 处（AC1 口径的 39 处是其中的同行写法；
换行写法另 13 处是**同一个缺陷**，一并收口 —— 取证时按行 grep 漏掉了它们）。

**第 53 处**（`islandPosSaved`）不在上面这张表里：它不是 `r.X = (await exec(…)) ? 'ok' : …`
形状，而是复合判据，所以按行/按归一化文本都数不到它 —— 是 §5 的临时探针跑**实测抓到**的
（3 轮里 1 次红）。已一并修掉。这条本身就是「按形状 grep 收口」的边界案例：
**形状清单能覆盖的只是「同一种写法」，覆盖不了「同一个缺陷」**，所以 R4 的实测环节不能省。

## 设计取舍

### ① `pollCheck` 收成一个原语，其余全是薄壳（而不是新增第二个助手）

`design.md` §2 要求「不许留两套」。落地时发现文件里**已有 5 种**轮询写法，所以不是「新增一个」
而是「收敛成一个」：`pollCheck` 是唯一的 `for` 循环，`pollAssert` / `waitIdle` /
`waitCollectIdle` / `waitFor` / `dockWait` 各自只做一件事（拼串 / 等当前轮结束 / 等一轮起止 /
旧签名的兼容壳）。代价：`waitFor` 的 `tries × 250ms` 语义被换算成 `budgetMs`，
调用点数字含义变了（80 → 20s，与原来一致）。

### ② `absent` 的两条路都要走通（不是「等满预算」一条）

`design.md` 写「`absent` 必须等满预算才可判成立」。实施时把它实现成两条路：
**出现过又消失 = 立即成立**；**一直没出现 = 等满预算才成立**。理由：`petCardRemoved`
这类「功能已删除」的断言永远等不到「出现」，只能靠第二条路；而 `settingsRemoveCustom`
这类「动作后该消失」的断言如果强行走第一条路，就要在删除前先确认它存在 —— 那是多余的一步，
且会引入新的时序假设。两条路合起来既满足「现在没看到 ≠ 不会出现」，又不拖慢。

### ③ ② 类不改成 `waitFor`，而是 `budgetMs: 0`

`design.md` §5 给的两条路是「改成 `pollCheck(..., {budgetMs:0})`」或「加显式白名单注释」。
选了前者：判据形状统一（都走助手），且 `budgetMs: 0` 本身把「这里不需要等」写进了代码，
守卫可以数它（N7）。代价：`budgetMs: 0` 与「忘了传预算」在文本上无法区分 —— 靠 N7 的下限 +
注释兜。

### ④ 保留两处 `sleep`（不当判据用）

- 刷新压力段 `sleep(2500)`：本段测的是「刷新进行中收起来，窗口尺寸不被余波带歪」——
  等 `scanning` 为假反而把要测的窗口等没了。已在注释里写明它是压力的一部分，不是判据。
- `runPetMenu` 的 `sleep(600)`：等原生菜单回调（没有可观察谓词）。改法是**在它之前**先等
  `.isl-hit` 出现（真正的不确定源）。

### ⑤ 没有做：把 `const x = (await exec(...)) as boolean` 这类**前置**瞬时读也轮询

`hasCard` / `pickerOpen` / `customFormOpen` / `ballCanvas` 等是**前置**（决定走哪个分支），
不是断言键：它们读错只会让断言变 `skipped`，不会给出错误的绿。本任务按 R2 的范围只收口
「断言键」，前置读留给后续任务（棘轮守卫也只看断言键，避免守卫变成噪声）。

## 取证（命令 + 原始输出）

### 1. 修复前 3 轮基线（翻转键 1 个）

```bash
node scripts/uitest-baseline.mjs --runs 3 --all
```

```
uitest flaky 基线：3 轮，每轮独立 BD_USER_DATA=/tmp/bd-uitest-r<i>，墙钟上界 5m0s
  · run 1/3 4m15s 171 键
  · run 2/3 2m26s 171 键
  · run 3/3 2m25s 171 键

── 键总数 ──
171（各轮 171/171/171）

── 跨轮翻转键 ──
grpUnknownBucket（值序列 fail:{"at":null},ok,ok）

── 恒定红键（不是 flaky，但没被掩盖）──
无

结论：翻转键 1 / 键集合不稳 0 / timeout 0 ❌
```

### 2. 基线脚本自检（构造数据 → 通过率 / 翻转集合）

```bash
node scripts/uitest-baseline.mjs --selftest
```

```
S. 基线脚本自检（构造数据 → 通过率 / 翻转集合）
  ✓ 键总数 6（实际 6）
  ✓ 恒绿键 a 通过率 3/3（实际 3/3）
  ✓ 翻转键 b 通过率 1/3（实际 1/3）
  ✓ 翻转键 c 通过率 2/3（实际 2/3）
  ✓ skip 不算绿也不算红
  ✓ 翻转集合 = [b,c]（实际 [b,c]）
  ✓ 翻转键带最后一轮诊断串
  ✓ 键集合不稳定（e 少了一轮）能被判出来
  ✓ 不稳定集合含缺失键（实际 [b,c,e]）
  ✓ 判据键 = [a,b,c,d,e]（诊断串 f 不算，实际 [a,b,c,d,e]）
  ✓ 诊断键 = [f]（实际 [f]）
  ✓ extractResult 跳过字符串内的括号与转义
  ✓ 没有 JSON 时返回 null（不抛）

通过 13 项，失败 0 项
```

### 3. 修复后 5 轮：翻转键 **0**（同一命令、同一机器）

```bash
node scripts/uitest-baseline.mjs --runs 5 --all --user-data /tmp/bd-final3
```

```
uitest flaky 基线：5 轮，每轮独立 BD_USER_DATA=/tmp/bd-final3-r<i>，墙钟上界 5m0s
  · run 1/5 2m17s 171 键 [断言跑完但进程未退]
  · run 2/5 2m16s 171 键 [断言跑完但进程未退]
  · run 3/5 2m18s 171 键 [断言跑完但进程未退]
  · run 4/5 2m16s 171 键 [断言跑完但进程未退]
  · run 5/5 2m37s 171 键 [断言跑完但进程未退]

── 键总数 ──
171（各轮 171/171/171/171/171）

── 跨轮翻转键 ──
无（每一条要么全绿、要么全红）

── 恒定红键（不是 flaky，但没被掩盖）──
无

⚠ 5 轮「断言跑完但进程未退」：JSON 已写到 stdout，但 app.quit() 没让进程退出
  （主进程 0% CPU 空转）。这些轮的断言结果**计入**通过率（真的跑过了），收尾问题记进存疑。

结论：翻转键 0，键集合稳定 ✅（5 轮收尾未退，不影响结果）
```

⚠ `[断言跑完但进程未退]` 是本任务新加的**收尾诊断**（不是断言失败）：见「存疑 1」——
`app.quit()` 之后进程不退，JSON 其实早就写出来了。旧脚本只在进程 `'close'` 时解析，
所以这种轮会被误读成「挂死 / 无结果」。

关键键（本任务 E4 列出的曾 flaky 键 + 探针新抓到的 `islandPosSaved`）**全部 5/5**：

```
cachedCard: 5/5        cardBack2: 5/5          detailRefreshSpin: 5/5
dockSettings: 5/5      grpDupCardName: 5/5    grpUnknownBucket: 5/5
intervalFlash: 5/5     islandDisable: 5/5     islandNoPct: 5/5
islandPosSaved: 5/5    petBallCenterValue: 5/5 petBallHitRect: 5/5
petRingRemoved: 5/5    settingsDeleteConfirm: 5/5
```

- **键总数 171 = 修复前 171**（AC9：既有键一个都没丢；`islandPosSaved` 本来就在）。
- `intervalFlash` 的值带实测等待时长：`ok(waited=0ms)` / `ok(waited=1ms)` ×4。
- 另有一批（52 处收口、尚未含 `islandPosSaved` 修复的中间构建）也是 5 轮 0 翻转：
  `2m21s / 2m16s / 3m10s / 3m19s / 3m9s` —— 与上面这批互相对照，两批都 0 翻转。
- 交付前的**最终源码**（含 `islandPosSaved` 的严格版：空串不算「落盘成 0」）另跑了 1 轮确认：
  `171 键 / 0 翻转 / islandPosSaved = ok`（`--runs 1`）。

### 4. 墙钟对比（AC6）

| | run1 | run2 | run3 | run4 | run5 | 中位数 | 最大值 |
|---|---|---|---|---|---|---|---|
| 修复前 | 4m15s | 2m26s | 2m25s | — | — | 2m26s | 4m15s |
| 修复后（本批） | 2m17s | 2m16s | 2m18s | 2m16s | 2m37s | **2m17s** | 2m37s |
| 修复后（上一批） | 2m21s | 2m16s | 3m10s | 3m19s | 3m9s | 3m9s | 3m19s |

**中位数 2m17s / 2m26s = 0.94×**；两批修复后的最大值 3m19s 对修复前最大值 4m15s = **0.78×**。
按最保守口径（修复后最大 / 修复前最小 = 3m19s / 2m25s = 1.38×）也仍在 1.5× 红线内 ✅。

⚠ 同一台机器的轮间波动比改动本身大得多（修复前 4m15s vs 2m26s；修复后 2m16s vs 3m19s）——
**「哪一轮跑在负载高峰」才是主要变量**。所以列全部三轮/五轮的实际值，不挑一个好看的。


### 5. R4：`.saved-flash` 出现耗时（临时实验，跑完即撤）

为了不把「产品竞态」用轮询掩盖掉（`design.md` §7：轮询会把「偶尔红」变成「偶尔慢」，而慢不报警），
临时把 `intervalFlash` 改成**从 t=0 起轮询**并记录出现耗时（`r.intervalDiag = flashAppear=…`），
跑 3 轮：

```bash
# 临时把 intervalFlash 改成「从 t=0 起轮询 + 把出现耗时写进 r.intervalDiag」后跑 3 轮
node scripts/uitest-baseline.mjs --runs 3 --user-data /tmp/bd-flashprobe
```

```
run1: 3m22s / run2: 2m14s / run3: 3m12s      # 同一构建（含临时探针）

r.intervalDiag（逐轮，探针值 + 原有诊断）：
  run1: flashAppear=1ms | 已保存 …
  run2: flashAppear=1ms | 已保存 …
  run3: flashAppear=2ms | 已保存 …
```

**结论：`.saved-flash` 在 1–2ms 内就出现，3/3 都出现** → 按 design §7「最终会出现」判为
**测试时序 bug**，不是产品竞态。

⚠ 这一测**推翻了我原先的猜测**（「`await setExtras` 慢到 900ms 时 flash 还没出现」）——
它根本不慢。真正的失败机制是**取样点落到 1.6s 存活窗口之外**：`sleep(900)` 的实际耗时会被
当时的负载拉长（同机轮间墙钟差可达 50s），一旦越过 1600ms，元素已自灭 → `fail:no-flash`。
所以「把 sleep 从 900 加大到 2000」**同样修不了**（加长只会更容易越过 1600ms）；
**只有轮询能修**（t=0 起、命中即早退，早了晚了都不会错过）。这正是 `design.md` §7 要防的
「用加大 sleep 换绿」。

⚠⚠ 这一轮临时探针还**顺手抓到一个不在 52 处清单里的 flaky 键**：`islandPosSaved`

```
islandPosSaved: 2/3  ← 翻转
islandPosSaved（值序列 ok,ok,fail:extras= posX=0.5535714285714286）
```

它是**同一个缺陷类**：`const savedX = (await exec("getExtras(['ui:islandX'])")) as string`
单点读一个**异步落盘值**，读到 `''` 时 `Number('')=0` 与 `posX=0.55` 差 0.55 → 假红。
它没进那 52 处清单，是因为形状不是 `r.X = (await exec(…)) ? 'ok' : …`（是复合判据）。
**已一并修掉**（改成「等落盘值追上来」，`budgetMs: 2000`），并把同类残留写进「存疑」。

（探针本身在跑完后已撤除，最终构建里没有它；上面这 3 轮是**含探针的中间构建**，
不参与 AC4/AC6 的计数。）





### 6. R4 判定：每个曾 flaky 键是「测试时序 bug」还是「产品竞态」

判定口径（`design.md` §7）：把预算放大后**最终会出现** → 测试时序 bug（本任务修测试）；
**始终不出现** → 产品竞态（只记录，不在本任务里猜着修）。

| 键 | 观测（修复前） | 判定 | 依据 |
|---|---|---|---|
| `intervalFlash` | 前任务核查代理实测约 1/2 失败（HEAD 基线也红）；本任务修复前 3 轮 3/3 绿（未复现） | **测试时序 bug** | 实测（§5 探针）：元素 **1–2ms 就出现**、1600ms 后自灭（`SettingsView.tsx:400-405`）。失败机制是**取样点落到 1.6s 窗口之外** —— `sleep(900)` 的实际耗时被负载拉长（同机轮间墙钟差可达 50s），越过 1600ms 元素已自灭。判据改「等它出现」后 5/5（`waited ≤ 1ms`）。 |
| `dockSettings` | 前任务核查代理 3 次里 1 次红；注释里记着上一次是「收起态点设置 = 没点」 | **测试时序 bug** | 判据是**落盘值**，旧写法「点 → `sleep(500)` → 单点读 extras」，而 `.dock-hide` 的写入是异步 IPC + 整文件重写。改成等落盘值变成期望后 5/5。 |
| `grpUnknownBucket` | 本任务修复前 3 轮 **1 次红**：`fail:{"at":null}` | **测试时序 bug** | 机制已定位并可复现：`setExtras({refreshInterval:'300'})` 触发的那一轮真实采集慢过 `sleep(2500)` → 落在 `debugPush(ghost)` 之后把夹具冲掉。改成 `waitCollectIdle()` + 复合谓词后 5/5。 |
| 岛上夹具簇 `islandDisable` / `islandNoPct` / `petBallCenterValue` / `petBallHitRect` / `petRingRemoved` / `cachedCard` | 前任务核查代理 3 次里 1 次成簇红 | **测试时序 bug** | 五个键都是「夹具/注入推下去 → 固定 400~2500ms → 单点读 DOM」。`petRingRemoved: fail:menu=<not-called>` 的机制尤其明确：`.isl-hit` 还没挂上时 `contextmenu` 派发被 `if(!b) return 'no-hit'` 吞掉。改后 5/5。 |
| `islandPosSaved` | **本任务探针跑新抓到**：3 轮里 1 次红（`fail:extras= posX=0.5535714285714286`，`extras` 读到空串） | **测试时序 bug** | 单点读**异步落盘值** `ui:islandX`（读到 `''` → `Number('')=0`）；不在 52 处清单里（形状是复合判据）。已改成「等落盘值追上来」（`budgetMs: 2000`）。 |
| 「整轮挂死」（进程不退 / 旧口径 timeout） | 前任务核查代理 1 次（主线程空转在 `kevent`）；本任务 8/8 轮（23:16 之后） | **产品收尾问题（断言跑完但 `app.quit()` 不退）—— 未修，不在本任务范围** | 三个实验：直接跑不退（JSON 后 60s 仍活）、`--smoke` 正常退（2s）、**HEAD 版 uitest.ts 同样不退（A/B）**。测试工具侧已改成「JSON 一到就算完」不再被它拖死。详见「存疑 1」。 |

**没有发现产品竞态**：所有曾 flaky 的键在放大预算后都会出现，且都能指到「判据取样点」这一侧。

### 7. 门禁

```bash
npm run typecheck   # tsc --noEmit -p tsconfig.node.json && -p tsconfig.web.json
npm test
node scripts/test-structure.mjs
```

```
$ npm run typecheck
> tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json
（无输出 = 通过）

$ npm test        # 24 个套件串联，exit=0
结果：132 通过 / 0 失败      ← 最后一个套件
grep -c '✗' → 0
（全部套件：21 / 133 / 32 / 98 / 533 / 477 / 119 / 44 / 197 / 146 / 240 / 73 / 54 /
  58 / 47 / 107 / 53 / 155 / 115 / 37 / 14 / 58 / 49 / 132 通过，**0 失败**）
（原稿写「23 个套件」，实测 `package.json` 的 test 链是 24 条，上面列出的也是 24 个数字 —— 核查时改正）

$ node scripts/test-structure.mjs
通过 477 项，失败 0 项     ← 含新增的 N1–N7
（核查阶段补了 N7 的注释过滤 + N8a/N8b ⇒ 现为 **479 项**，见「核查代理独立复测」）
```

### 8. 基线脚本自检（新增 2 项：收尾形态分类）

```
$ node scripts/uitest-baseline.mjs --selftest
  …（前 13 项同 §2）
  ✓ 完全没产出 JSON 的轮计成 noResult 且键集合判不稳
  ✓ 「断言跑完但进程未退」计成 exitHang 但不计 noResult（结果仍可用）

通过 15 项，失败 0 项
```

**超时路径实测**（这条必须能失败才算数）：

```
$ node scripts/uitest-baseline.mjs --runs 1 --timeout-ms 8000
…
⚠ 1 轮完全没产出 JSON（墙钟上界 10.0s 内没跑完）—— 见存疑。
结论：翻转键 0 / 键集合不稳 1 / 无结果 1 ❌
$ ps … | grep 'Electron . --uitest'      → 空（进程组被杀干净，无残留）
```


## 每条新护栏「弄坏一次」的红集（实测）

| 变异 | 红集 |
|---|---|
| 把 `r.card = await pollAssert(…)` 改回**同行**瞬时判据 `(await exec(…)) ? 'ok' : …` | `N1`（1 处）—— 476 通过 / 1 失败 |
| 把 `r.cardGrid` 改回**换行**写法 `r.cardGrid =\n (await exec(…)) ? 'ok' : …` | `N1`（1 处）—— 476 通过 / 1 失败（证明守卫按归一化文本计数，不会被换行绕过） |
| （基线脚本）喂一份含已知翻转键的构造 JSON | `--selftest` 13 项全绿，且把 `b` 的通过率算成 1/3、翻转集合算成 `[b,c]` |

**核查阶段补测的三条**（基线 479 项，每条只红 1 项、还原即绿）：

| 变异 | 红集 |
|---|---|
| 把 `absent` 的预算判据挂回 `else if (Date.now() - t0 >= budgetMs)`（= 死循环形态） | `N8b` —— 478 通过 / 1 失败 |
| 删掉真实的 `budgetMs: 0` 调用（注释里的两处仍留着） | `N7` —— 478 通过 / 1 失败（证明 N7 数的是代码行，注释顶不了数） |
| 把一处 `mode: 'absent'` 退回 `appear` | `N6` —— 478 通过 / 1 失败 |

## 核查代理独立复测（2026-10-19，trellis-check）

> 8 条核查重点逐条独立复跑。**修掉 1 个真缺陷**（`pollCheck` 的 `absent` 分支在条件恒真时
> **死循环** —— 一条负向断言的失败会变成整轮挂死）、**1 处判据位置与它自己的机制结论不符**
> （`intervalFlash` 的轮询起点在 `sleep(900)` **之后**，而 §5 的结论是「必须从 t=0 起」）、
> **13 条对不上任何版本的行号**、**2 处护栏被注释顶数 / 下限写松**。没有发现「用 sleep 换绿」。
> 核查后门禁：`npm run typecheck` 通过；`npm test` 24 套件 **0 失败**；
> `node scripts/test-structure.mjs` **479 通过 / 0 失败**（含核查新增的 N8a/N8b）。

### ① 键集合（AC9）：**一个都没丢**；「172 / 171」的差是**数法不同**

- 修复前基线（`/tmp/bd-uitest-runs.json`，22:38，3 轮）与核查独立跑的 3 轮**逐键对比**：
  `only-before = []`、`only-after = []`，两边都是 **171 键**（155 判据 + 16 诊断）。
- 更早两个任务记的「**172** 个 key」是**把 `"uitest": true` 这个标志也算成一个键**：
  `modes.ts:81` 打的是 `{ uitest: true, consoleErrors, ...results }`。实测（解析
  `/tmp/bd-head-exit.log`，HEAD 版那一轮）：**172 键 = 170 断言键 + consoleErrors + uitest 标志**；
  基线脚本的口径是「排除 `uitest`」⇒ 171。**两处都不矛盾，也没有断言被悄悄删掉。**
- 「修复前那份基线真的是改动前」的指纹也核过：`intervalFlash` 是裸 `ok`（无 `waited=`）、
  `grpUnknownBucket` 序列 `fail:{"at":null}, ok, ok`。

### ② 有没有用 sleep 换绿（R7）：**没有**

`git diff` 里**新增**的 `sleep` 只有 3 处，逐条核过：

| 新增 sleep | 位置 | 判定 |
|---|---|---|
| `await sleep(stepMs)` ×2 | `pollCheck` 的 appear / absent 循环体 | 轮询**步长**，不是判据 |
| `await sleep(150)` | `waitCollectIdle` 收尾后「状态经 IPC 再一帧」的落定窗口 | 有界 + 有注释；判据是 `scanning` |

- 4 处 `sleep(2500)`（1661 / 1876 / 2188 / 2230）确实换成了 `waitCollectIdle()`，它是**谓词**：
  先等 `scanning` 为真、再等它为假。**机制回源码核过**：`scheduler.ts:189-196` 的 `refreshNow()`
  在 `queued` 时当场 `push(stateWith(true))`，`runRound()` 入口第一行就 `push?.(stateWith(true))`
  —— 所以「先等它出现」这一步不会空等、也不会漏掉整轮。
- 被删的 `sleep(400)/(2500)/(500)` 等都有对应的 `pollCheck`/`pollAssert` 替代（逐条对过 diff）。
- 保留的 2 处固定 sleep（刷新压力段 2500、`runPetMenu` 的 600）在代码里写明了「不是判据」的理由，
  核查**认可**：前者测的就是「刷新进行中」那个窗口（等它收尾反而把被测窗口等没了）；
  后者等的是**原生菜单回调**（没有可观察谓词），且已把真正的不确定源（`.isl-hit` 未挂载）
  改成先等。

### ③ 独立复现「翻转键 = 0」（同机、独立临时 `BD_USER_DATA`）

```bash
node scripts/uitest-baseline.mjs --runs 3 --all --user-data /tmp/bd-finalcheck   # 核查后最终源码
node scripts/uitest-baseline.mjs --runs 3 --all --user-data /tmp/bd-check        # 核查中途（仅 pollCheck 修复）
```

| 批次 | 墙钟 | 键数 | 翻转键 | 恒定红 |
|---|---|---|---|---|
| 修复前（实施代理） | 4m15s / 2m26s / 2m25s | 171/171/171 | **1**（`grpUnknownBucket`） | 0 |
| 核查 3 轮（中间构建） | 2m16s / 2m15s / 2m16s | 171/171/171 | **0** | 0 |
| 核查 3 轮（**最终源码**） | 2m08s / 2m10s / 2m18s | 171/171/171 | **0** | 0 |

关键键（最终构建逐轮）全部 `ok`：`intervalFlash`（`ok(waited=6ms)` / `3ms` / `5ms`）、
`dockSettings`、`grpUnknownBucket`、`islandPosSaved`、`islandDisable`、`islandNoPct`、
`petBallCenterValue`、`petBallHitRect`、`petRingRemoved`、`cachedCard`、`settingsDeleteConfirm`、
`grpDupCardName`、`detailRefreshSpin`。墙钟中位数 2m14s / 修复前 2m26s = **0.92×**（R5 红线 1.5×）。

### ④ `pollCheck` 的语义：`absent` 有**死循环**，已修（本次核查最重要的发现）

源码读出来的问题：`absent` 分支的预算判据写成了 `else if`，挂在「一直没出现」那条路下 ——
**条件恒真时（该消失的东西一直没消失）那条分支永远走不到，循环永不退出**：

```ts
// 修前（会死循环）
if (v === true) sawTrue = true
else if (sawTrue) { hit = true; break }          // 出现过又消失
else if (Date.now() - t0 >= budgetMs) { hit = true; break }   // ← 只有「一直没出现」才判预算
await sleep(stepMs)                               // v === true 时直接落到这里 → 无限循环
```

- **构造复现（逐字照抄该分支的探针）**：条件恒真 + `budgetMs: 300` → 8s 后仍不返回，被 SIGKILL
  （`exit=137`，无输出）。
- **可达性**：7 处 ③ 类断言都在这条路径上。其中 `settingsRemoveCustom`（删行没删掉）、
  `grpDupCleanup`（清理没生效）正是**会真的失败**的两处 —— 修前它们不会报红，而是**整轮挂死**；
  `--uitest` 又不设退出码，调用方会一起卡住。比它想修的 flaky 更糟（一次失败吃掉整轮）。
- **修法**：预算判据落在**每一条路**上 —— `hit = !sawTrue`（一直没出现 = 成立；出现过却没消失 = 不成立）。
  探针复测三条路：恒真 → `ok=false waited=307ms`；恒假 → `ok=true waited=309ms`；
  先真后假 → `ok=true waited=103ms`（早退）。
- **新增守卫 N8a/N8b** 钉住它；变异「挂回 `else if`」→ `N8b` 红（478/1）。

### ⑤ 分类清单：52 条**逐条**核过（含 ② 类全部 5 条）

- **行号**：写脚本把本表解析出来，逐条到 `git show HEAD:src/main/qa/uitest.ts` 找 `r.<键名> =`
  所在行 —— 初版 **39/52** 命中，13 条对不上**任何**版本（vrs 段 11 条 + `dockDefaultOn` +
  `grpDupCleanup`，记录值比 HEAD 大 165–215 行，也不是 `git diff` 的新文件行号）。**已按 HEAD 改正，现 52/52。**
- **类别与理由**：① 抽查 `card`/`cardGrid`/`detailOpen`/`intervalSaved`/`intervalFlash`/`cachedCard`/
  `grpUnknownBucket`（复合谓词整条等）—— 与代码一致；③ 7 条全部核对「谓词正向写 + `mode: 'absent'`」——一致。
- **② 类 5 条逐条回源码核理由**（这是最可能藏「其实该轮询却被放过」的地方）：

  | ② 键 | 理由 | 回源码核对 |
  |---|---|---|
  | `titleRefreshBtn` | 标题栏静态标记 | `CardView.tsx:665-670` 的 `IconButton title="立即刷新"` 在 header 里**无条件渲染**；且同段 `r.card`/`r.gridAfterRefresh` 已轮询确认卡片视图就位 ✅ |
  | `vrsSection` | `.section-title` 静态结构 | `VoiceReminderSection.tsx:446` `<div className="section-title">语音提醒</div>` 无条件；`SettingsView.tsx:741` 也无条件挂载该分区 ✅ |
  | `vrsGradeNote` | `.vrs-foot` 静态文案 | `VoiceReminderSection.tsx:925`，且在 `{ttsOn && …}`（475→816）**之外** —— 比理由说的还稳 ✅ |
  | `vrsNotifyVisible` | 通知分组刻意在 `{ttsOn && …}` 之外 | `:817-830` 注释 + `:831` 的 `.vrs-notify-on` 确实在闸门之外 ✅ |
  | `dockDefaultOn` | 读的是**没被任何动作改过**的偏好 | 全文件 `setExtras({'ui:dockHide'…})` 只出现在 2597/2604（本断言之后）；`overlay.setDockHideEnabled()` 只改内存不写 extras ✅ |

### ⑥ 棘轮守卫的牙齿（核查独立重跑变异）

| 变异 | 红集（核查实测） |
|---|---|
| `r.card` 改回**同行**瞬时判据 | `N1`（1 处）—— 478 通过 / 1 失败 |
| `r.cardGrid` 改回**换行**瞬时判据 | `N1`（1 处）—— 478 通过 / 1 失败 |
| 一处 `mode: 'absent'` 退回 `appear` | `N6`（1 处）—— 478 / 1 |
| 删掉真实的 `budgetMs: 0`（注释里的 2 处留着） | `N7`（1 处）—— 478 / 1 |
| `absent` 预算判据挂回 `else if` | `N8b`（1 处）—— 478 / 1 |

核查**改了 3 处护栏本身**（都先弄坏确认变红）：
1. **N6 下限 7 → 8**：核查新增的 `intervalFlash` 前置 `absent` 让计数变成 8，下限写 7 时
   「把任意一处 ③ 类退回 `appear`」仍然绿（8→7 还在下限之上）—— 棘轮漏了。
2. **N7 只数代码行**：原来把注释里的 2 处 `budgetMs: 0` 也数进去了（7 = 5 真实 + 2 注释），
   删掉 2 处真实调用守卫仍绿。改成剥注释后计数（`stripTsComments`，本文件已有的助手）。
3. **N1/N3/N4/N5/N6 一并改用剥注释后的文本**（同一纪律：本仓栽过「断言的是注释里的文案」）。
- **绕过面（如实写）**：`N1` 认的是**形状** `r.X = (await exec(`。写成
  `const ok1 = await exec(…); r.X = ok1 ? 'ok' : 'fail'` 能绕过 —— 静态守卫的通病，
  故 R4 的**实测探针不能省**（`islandPosSaved` 就是这么抓到的，见 §5）。
  另：文件里还剩 **30 处**「前置类瞬时读」（`const hasCard = (await exec(…)) as boolean` 等，
  改造前 31 处，少的那 1 处是 `savedX` —— 它的判据已移进 `pollCheck`，只剩诊断用途）。
  它们**不产生错误的绿**（读错只会让断言 `skipped`），本任务按 R2 的范围没收口，
  见「存疑 4」。核查**同意**这个边界，但要写明：棘轮只覆盖「断言键」。

### ⑦ `app.quit()` 不退：A/B **独立复现**（HEAD 同样不退）

核查自己跑了一遍（`/tmp/bd-check-ab.sh`，全部用独立临时 `BD_USER_DATA`）：

| # | 实验 | 核查实测 |
|---|---|---|
| 1 | 当前构建 + `--smoke`（**完全不经过 `uitest.ts`**） | **9s 内自己退出 ✅** |
| 2 | **HEAD 版** `uitest.ts`（本任务全部改动都在这个文件里）+ `--uitest` | JSON 出现于 00:33:15，**30s 后仍存活 ❌** |
| 3 | 核查 3 轮（00:30，改动后的构建） | **3/3 不退** |
| 4 | 核查 3 轮（00:36，最终构建） | **1/3 不退**（2 轮自己退了） |

⇒ **结论与实施代理一致**：`--uitest` 跑完不退与本任务改动无关（HEAD 同样不退），
且它是**间歇性**的（同一台机器同一天：3/3、1/3 都出现过；更早三批 11/11 正常退）。
`--smoke` 正常 ⇒ 挡着 `quit()` 的是 uitest 现场留下的东西（最可疑的仍是那段**真实原生右键菜单**，
实施代理的假设未被证伪也未被证实）。**建议单开任务**，不要在本任务里猜着修产品：

- 判据：`BD_USER_DATA=/tmp/x node_modules/.bin/electron . --uitest`，看 JSON 后 60s 内进程是否自退。
- 先量出现率（10 轮），再定位；两个低成本实验：① 在 `runPetMenu` 收尾处主进程调 `menu.closePopup()`
  （或记录 `popup` 后是否 `close` 过）；② 造一个 `--uitest-nomenu` 跳过 `runPetMenu`，
  看是否 10/10 正常退 —— 这一步能把「原生菜单」从假设变成结论。

### ⑧ 回归面

- `npm run typecheck`：无输出（通过）。
- `npm test`：**24 套件全 0 失败**、`exit=0`（`grep -c '✗'` = 0）。核查实测的套件数与
  日志 §7 原稿写的「23 个套件」不符 —— 已按 `package.json` 的 test 链（24 条）改正。
- `node scripts/test-structure.mjs`：**479 通过 / 0 失败**（原 477 + 核查的 N8a/N8b；N7 改成剥注释计数后数量不变）。
- **产品代码零改动**：`git status --porcelain` 只有
  `src/main/qa/uitest.ts`、`scripts/test-structure.mjs`、`scripts/uitest-baseline.mjs`（新）、
  `docs/index.md`、`docs/knowledge/agents/index.md`、`docs/knowledge/agents/uitest-timing.md`（新）、
  `docs/daily/2026-10-18_uitest-timing-hardening.md`（新）、`.trellis/tasks/…`（任务目录）——
  **没有一行 `renderer/` `shared/` `main/`（qa 之外）`preload/` 的改动**。

### ⑨ 核查阶段发现并修掉：`intervalFlash` 的轮询起点与它自己的结论矛盾

日志 §5 的结论是「失败不是读早了，是取样点太晚 ⇒ **只有轮询能修（t=0 起、命中即早退）**」，
但**落地的代码把轮询放在 `sleep(900)` 与 `intervalSaved` 之后**（`uitest.ts` 原 949 行）——
轮询的**第一次取样**仍在那个「可能已经越过 1600ms」的时刻：

- 命中条件（修前）：`sleep 实际耗时 + intervalSaved ≤ 700ms + δ`；一旦 sleep 被负载拉长越过窗口，
  **重试再多次也等不到**（重试只能救「还没出现」，救不了「已经没了」）。
- 修后：轮询紧接派发（t=0），预算 2500ms ⇒ 命中条件变成「flash 在 2500ms 内出现」，
  **与 sleep 无关**。
- 但「从 t=0 起」有个坑：上面刚删的 `uitest-provider` 走 `remove()`（`SettingsView.tsx:476-482`），
  它**也** `flash()`，而它离这里只差 ~1.1s < 1600ms ⇒ 直接从 t=0 起轮询会读到**上一动作的残留**，
  把「这次没闪」判成绿。所以修法是「**先确认残留自灭，再派发，再轮询**」：
  `stale`（一次取样）→ 若在则 `absent` 等它消失 → 派发 → `pollCheck(budgetMs: 2500)`。
- 实测（最终构建 3 轮）：`ok(waited=6ms)` / `ok(waited=3ms)` / `ok(waited=5ms)` —— 轮询确实从
  t=0 起（第一次取样就命中，等待时长 = 一次 exec 往返），而修前那一批是 `0–1ms`（起点在 sleep 之后）。

### ⑩ 核查阶段改动的文件（均未提交）

| 文件 | 改动 | 理由 |
|---|---|---|
| `src/main/qa/uitest.ts` | `pollCheck` 的 `absent` 预算判据改到每一条路上；`intervalFlash` 轮询移到派发处（t=0）+ 派发前清残留 | 前者是死循环（一次失败吃掉整轮）；后者是「判据位置与机制结论不符」 |
| `scripts/test-structure.mjs` | N6 下限 7→8；N1/N3–N7 改用剥注释文本；新增 N8a/N8b | 棘轮被注释顶数、下限写松会漏；死循环无守卫 |
| `docs/daily/2026-10-18_uitest-timing-hardening.md` | 13 条行号改正；补本「核查代理独立复测」；补 `exitHang` 时间线；「23 个套件」→ 24 | 行号对不上任何版本；数字与实测不符 |
| `docs/knowledge/agents/uitest-timing.md` | 修掉**被推翻的旧机制**（原写「慢到 900ms 还没出现」，实测是「取样点太晚」）；补「预算判据必须在每条路上」；N1–N7 → N1–N8 | 留一条**错的**准则比留空更危险 |
| `docs/knowledge/agents/index.md` | 一句话补上「否则 Z」（flaky 的红会被当成新回归） | P2 门禁的「遇到 X → 做 Y，否则 Z」 |

## 未完成 / 存疑

1. **「整轮挂死」的真实形状 = 断言跑完但进程未退**（AC5 的例外项，**产品侧未修**）。
   本任务第三次观测时拿到了完整现场，并做了三个决定性实验：

   | # | 实验 | 结果 |
   |---|---|---|
   | 1 | `ps` / `sample` 看现场 | 主进程 `0.1% CPU` 存活 10m02s，GPU/渲染/网络/音频四个 helper 全在，主线程空转（等事件，与前任务核查代理记的 `kevent` 一致）；**stdout 里已有完整 JSON（171 键）** |
   | 2 | 直接从 shell 跑（不经 node 包装、不 detached）：`BD_USER_DATA=… node_modules/.bin/electron . --uitest` | JSON 出现在启动后 2m08s；**此后 60s 进程仍存活** ❌ |
   | 3 | 同一构建跑 `--smoke`（**完全不经过 uitest.ts**） | JSON 后 **2s 自己退出** ✅ |
   | 4 | **A/B**：把 `uitest.ts` 换回 `HEAD` 版（本任务全部改动都在这一个文件里）重建后跑 | JSON 后 25s 仍存活 ❌ —— **与本任务改动无关**（实验 4 后已还原并重建，见下） |

   结论：这不是「断言路径卡死」，而是**产品收尾问题**——`--uitest` 这条路径跑完之后
    `app.quit()` 不生效（`--smoke` 正常，说明是 uitest 留在现场的东西挡着；
   最可疑的是那段**真实弹出原生右键菜单**的步骤：它用合成 `Escape` 去关一个**原生**菜单，
   而原生菜单收不到渲染层的合成键盘事件 —— 这只是**假设，未验证**）。
   按 design §7 属产品侧问题，**不在本任务范围**（本任务只改测试与测试工具）。

   **核查阶段补的时间线**（把 `/tmp/*-runs.json` 逐批的 `exitHang` 抽出来；早期批次用的是
   还没有 `exitHang` 字段的脚本版本 —— 它只在进程 `'close'` 时解析，所以「有结果且没 timeout」
   等价于「进程真的退了」）：

   | 批次 | 时刻 | 轮数 | 收尾 |
   |---|---|---|---|
   | 修复前基线 | 22:38 | 3 | 3/3 正常退 |
   | 修复后（第一批） | 22:58 | 5 | 5/5 正常退 |
   | 探针批 | 23:12 | 3 | 3/3 正常退 |
   | 修复后（最终批） | 23:53 | 5 | **5/5 不退** |
   | 严格版 1 轮 | 00:12 | 1 | 不退 |
   | **核查独立 3 轮** | 00:30 | 3 | **3/3 不退**（同机、同命令） |

   ⇒ 转折点落在 **23:12–23:53** 之间，且核查代理在 00:30 独立复现（3/3）。

   测试工具这一侧不能受它影响（否则每挂一次就丢一轮测量），已在 `scripts/uitest-baseline.mjs` 修：
   JSON 一到就算这轮结束（**不等进程退出**）、整进程组 SIGKILL、把这种轮记成 `exitHang`
   （断言结果**照常计入通过率**，收尾问题单独报）。

   ⚠ **两处不粉饰**：
   - 更早的三批（修复前 3 轮 + 修复后 5 轮 + 探针 3 轮 = **11 轮**）都**正常退出**了，
     之后变成 **不退**（最终批 5/5 + 严格版 1/1 + 核查 3/3）。差异原因**未定位**
     （A/B 已排除本任务改动，核查阶段独立复跑过 A/B，见「核查代理独立复测」）。
     复现命令见下；下一个任务应先量出「不退」的出现率基线，再谈修不修。
   - 本任务的三次观测里 **1 次**发生在改动后的构建上，虽然 A/B 已证明 HEAD 同样不退，
     但「改动是否改变出现率」本任务**没有预算量化**。

   复现命令与判据：
   ```bash
   node scripts/uitest-baseline.mjs --runs 5 --timeout-ms 300000
   # 输出里出现「（断言跑完但进程未退）」即复现；
   # 或直接跑一条：BD_USER_DATA=/tmp/x node_modules/.bin/electron . --uitest
   #   看 JSON 出现后进程是否在 60s 内自己退出。
   ```
2. **`intervalFlash` 的失败机制是「取样点太晚」，不是「太早」**（这一条是被实测**推翻重写**的）：
   临时探针量到 `.saved-flash` **1–2ms 就出现**（3/3 轮），所以「`await setExtras` 慢到 900ms
   还没 flash」这个原先的猜测**不成立**。真正的机制是：`sleep(900)` 的**实际**耗时会被当时
   的负载拉长（同机轮间墙钟差可达 50s），一旦取样点越过元素的 1600ms 存活窗口，
   元素已经自灭 → `fail:no-flash`。
   **直接推论**：把 `sleep(900)` 加大到 2000 **反而更容易红** —— 这正是 R7 禁止的「加大 sleep 换绿」。
   ⚠ 不粉饰的部分：本任务**没有**直接观测到「取样点越过 1600ms」那一帧（要复现得让主进程
   卡住 ~700ms，本任务没有可重复的手段）；本机 3 轮探针 + 修复后 6 轮都是 `waited ≤ 1ms`。
   机制结论由「1–2ms 出现 + 1600ms 自灭 + 取样点实际时刻不可控」三条**源码/实测事实**推出，
   加上前任务核查代理在 HEAD 上 1/2 失败的实测。
   **⚠ 核查阶段补**：这条推论当时**没有落到代码上** —— 落地的轮询起点在 `sleep(900)` **之后**，
   仍受「sleep 被拉长」影响。核查已把轮询移到派发处（t=0）并先清上一动作的残留 flash；
   最终构建 3 轮实测 `waited = 6ms / 3ms / 5ms`（第一次取样即命中），见「核查代理独立复测」⑨。
3. **AC1 的口径修正**：prd 取证写「瞬时判据 39 处」，那是**同行写法**的数量。实施时按
   归一化文本数出**换行写法另 13 处**（`r.x =\n (await exec(…)) ? 'ok' : …`），合计 **52 处**，
   已全部收口；棘轮守卫按归一化文本计数（否则换行写法能绕过守卫）。分类清单按 52 条给。
4. **前置类瞬时读没动**（`const hasCard = (await exec(...)) as boolean` 等 31 处）：
   它们是分支前置而不是断言键 —— 读错只会让断言变 `skipped`，不会给出错误的绿。
   见「设计取舍 ⑤」。棘轮守卫也只看断言键，避免守卫变成噪声。
5. **10-07 的 `.trend-cell` / `.trend-head` 仍然不存在**（全仓零命中，真实类名是
   `.trend-chart` / `.trend-bar` / `.trend-records-*`）。本任务按 Out of Scope 没补这些断言；
   现在 `10-07` 的收尾至少有了可信的 uitest（跑一次就知道 `.trendChart` / `trendBars` 的真实值，
   而不是「跑一次看运气」）。
6. **`--uitest` 仍不设退出码**（`modes.ts:14-15` 明确如此），所以基线脚本靠解析 stdout JSON
   判成败。要接 CI 需先补退出码 —— 不在本任务范围。
7. **同类残留（本任务 19 轮实测未翻红，故未动）**：还有几处「单点读**异步落盘值/注册表**再判」
   的复合判据，形状与 `islandPosSaved` 同源，只是没翻红：
   `r.dragPersist`（`reorderProviders` 之后单点读 `listProviders()`）、
   `r.hideBalance` / `r.hideBalanceRestore`（`flip()` 里 `readHidden()` 单点读 extras）。
   为什么不顺手改：它们的判据是复合表达式（`first.hidden === !wasHidden && masked === hidden`），
   改法要连语义一起动，而本任务 19 轮（修复前 3 + 修复后/探针 16）都没翻红 ——
   按「先量再改」的纪律不动。**若日后翻红**，收口方式就是本任务给 `islandPosSaved` 用的那一种：
   `pollCheck` 等落盘值追上来。`scripts/uitest-baseline.mjs --runs 5` 就是判据。



## 后续

- `10-07-detail-predict-trim-heatmap` 收尾时可直接引用本任务的基线脚本结论（`.trend-*` 断言从未存在）。
- 若后续要给 `--uitest` 接 CI：`modes.ts` 明确「不设置退出码」，需要先补退出码。
