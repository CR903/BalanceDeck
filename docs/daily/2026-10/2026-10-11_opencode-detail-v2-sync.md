# 2026-10-11 opencode 详情页 v2：官网数据对齐与用量视图重构

任务：`.trellis/tasks/10-11-opencode-detail-v2-sync`（复杂任务，PRD + design + implement）。

## 起因

opencode 官网控制台改版：`go/status` 每个 meter 新增 `startsAt`，新增
`usage/cost-by-day`（`bucket=hour|day` + `since`），鉴权路径不变。现有实现仍只吃旧字段，
趋势区画的是**本机**历史、与官方窗口脱节，且「5 小时窗口没有模型明细」是旧限制（实测已被
`since` 推翻）。目标：三处口径（窗口 / 模型明细 / 趋势）统一并随窗口联动，补齐 5 小时窗口，
接入余额只读展示，并落一份「官网还能拿什么」的调研报告。

## 改了什么

**主进程（数据层）**

- `opencode-console-api.ts`：新增 `USAGE_COST_BY_DAY_PATH`、`COST_BUCKETS`、
  `MODELS_RANGE_ROLLING='24h'`；更新 `MODELS_RANGES` 注释（rolling 靠 `since` 对齐，
  推翻 v1「故意不映射」）。
- `opencode-cookie.ts`：`parseGoStatus` 消费 `startsAt`（`month` 回落 `access.startsAt`）；
  `SsrRawWindow` 增可选 `startAt`（ISO）；新增导出纯函数 `windowStartIso`（官方优先、
  缺失才 `resetAt - span` 反推）。
- `opencode-details.ts`：新增纯函数 `parseCostByDay`（升序、容忍未知键/坏行）；
  `fetchJson` 统一「串行 + 重试一次」；`scrape` 扩展为三档 models + 三档 cost-by-day；
  `ConsoleDetails` 改为 `{ models?, series? }`，**key 缺失 = 抓取失败、空数组 = 官方确认无用量**；
  缓存键含窗口起点（否则滚动后最多 5 分钟串窗）。
- `opencode.ts`：窗口起点用官方 `startsAt`（缺失回退）；`modelsByWindow` 覆盖三窗口；
  新增 `seriesByWindow`；`GET /api/billing/status` → `extraCredit`（失败不产出，不写 0）。
- `shared/types.ts`：`ProviderWindow.startAt?`、`UsageBucket`、`ProviderSnapshot.seriesByWindow?`
  与 `extraCredit?`（全部可选，旧快照自动退回本机历史）。

**渲染层**

- 新增纯函数模块 `seriesView.ts`（粒度映射 / 节点标签 / 官方搬运 / 本机重置感知增量）。
- `usageHistory.ts` 新增 `bucketByHour`（本地小时桶，三条纪律同 `bucketByDay`）。
- `TrendChart.tsx` 重写为**窗口驱动序列视图**：删「7/30 天」切换与日历热力图接线；
  5 小时画逐小时柱、周/月画逐日柱；记录表列 = 时间节点 / 用量 / tokens / 请求数；
  官方 `seriesByWindow` 优先，key 缺失才退回本机并标注「本机估算」。
- `DetailView.tsx`：接线 `seriesByWindow`；新增「额外额度」区块（`extraCredit` 缺失不渲染）。
- `skins.css`：`.trend-bar/.trend-axis/.trend-axis-label` + 记录表四列 + `.credit-*` + `.tag.local`。
- 退役删除：`usageHeatmap.ts` + `scripts/test-usage-heatmap.mjs`（不留死接线）。

## 波折

- **滚动窗口必须进缓存键**：`since` 来自 `go/status`，5 小时窗口每 5 小时滚动一次；
  键里只有 cookie 时会拿到上一窗口的序列，而百分比已是新窗口 —— 正是本任务要消灭的串窗。
- **`key 缺失` 与 `空数组` 必须分开**：否则「官方确认该窗口没用过」会被误标成「本机估算」。
- **本机兜底只有 1 个采样点时会画空坐标系**（实机 `--uitest` 抓到
  `trendChart: fail:missing-bars`）：所有桶 cost 都是 `null`。改判据为「至少一根已知花费的柱」，
  否则整个区块返回 `null`。
- 结构门切片切了被删的 DOM/函数：`test-usage-history.mjs` G 段同步改写；
  新增 `test-series-view.mjs` 覆盖新纯函数与诚实纪律。

## 返工（check 后：拆假护栏 + 契约漂移校准）

check 判定功能正确、门禁全绿，但揪出三处「假护栏 / 假论据」与若干契约漂移，按仓库纪律返工：

- **F2 假护栏**：AC9 的余额块断言只 grep `s.extraCredit` —— 那个字符串在注释里也有，
  删掉整块 UI 照绿。改成按渲染分支切片（`{s.extraCredit && (` → `</section>`）断言
  `.credit-row` 且全文件恰好一处；`--uitest` 加 `.credit-row` 与快照 `extraCredit`
  的**两态一致性**断言（本机 = `ok:absent`）。自证：删块 → 4 条红，恢复 → 绿。
- **F1 假护栏**：`modelsByWindow`/`seriesByWindow` 的组装内联在 `collect()` 里，
  删 rolling 映射或把 `if (rows)` 改成 `if (rows.length)` 都 0 红。抽成纯函数
  `modelsByWindowOf` / `seriesByWindowOf`（`opencode-details.ts`），`test:ssr` 新增 L 段
  钉住三条契约（三窗口 key / 空数组保留 / 缺失不产出）。自证：两种改坏分别 3 红、4 红。
- **F7 契约漂移**：代码用 `rows.length` 丢掉空数组，与 spec 的「空数组保留」矛盾 →
  统一为「抓取成功就产出 key（空数组也算），失败才不产出」，spec §3.3/§5 + 知识页同步。
- **F6 假论据**：「`resetAt - WINDOW_SPANS` 反推会偏（周窗口自然周对齐）」是**错的** ——
  实测 `week.startsAt → resetsAt` 恰好 7 天，反推与起点逐毫秒相同；会偏的是 `now - 7d`。
  代码注释（3 处）+ spec + 知识页统一改为「官方 startsAt 为权威，反推只是缺字段兜底」。
- **F5 诚实性**：`parseCostByDay` 把缺失金额落成 0（会把「不知道」渲染成 $0.00）→
  改为**跳过该桶**；K 段断言同步（缺金额 / 不可解析 / 真 0 三态）。
- **F3 落地**：`ProviderModelRow.requests?` + `mergeConsoleModels` 透传 + `WindowModels`
  增请求数列；表头「用量 / 配额」→「用量」（不暗示每模型有独立配额）。
- **F4**：自愈后 billing 改用实时 cookie（与明细同源）。
- 结构门补 `test-structure.mjs` M 段（序列视图 / 余额块 / 测试接线 / 退役模块）；
  `usageHistory.ts` 头部注释与尾换行、`test-usage-history.mjs` 的 `heatmapOf` 残留一并清理。

## 验证

- `npm run typecheck` ✓；`npm run build` ✓。
- `test:ssr` 113 / `test:series-view` 47 / `test:structure` 461 / `test:adapters` 532 /
  `test:usage-history` 58 / `test:read-model` 119 / `test:quality` 32 / `test:cli-export` 46，
  全绿；完整 `npm run test` 退出码 0。
- 护栏自证（先弄坏再恢复）：删 AC9 余额块 → `test-series-view` 4 红；
  改 `if (rows)` → `test:ssr` 3 红；删 rolling 映射 → 4 红。
- 实机 `--uitest`（`perl alarm` 限时，全新 `BD_USER_DATA`）全绿：
  `consoleErrors`/`execErrors` 均 `none`，`trendChart: ok:no-history`、
  `creditRow: ok:absent`（无 cookie → 官方不可达 → 不渲染余额块，符合 AC9）。
- 提交：见任务收尾（本实现未 commit）。

## 沉淀

- 新增 `docs/knowledge/frontend/window-series-view.md`（替换已退役的
  `heatmap-calendar-grid.md`）：窗口起点对齐（含「反推不会偏」的实测纠错）/
  key 缺失 vs 空数组且映射必须落在纯函数 / 本机回退不补 0 / 退役可视化清单 /
  可选字段不升 version。
- `.trellis/spec/adapters/opencode-console.md`：新增 `cost-by-day` 与 `since` 契约、
  `startsAt` 消费、`extraCredit`、`modelsByWindowOf`/`seriesByWindowOf` 与空数组契约、
  `parseCostByDay` 缺金额跳过；修正 v1「5 小时没有明细是正确行为」与「反推会偏」两处结论。
- `docs/knowledge/frontend/index.md` 索引同步。
