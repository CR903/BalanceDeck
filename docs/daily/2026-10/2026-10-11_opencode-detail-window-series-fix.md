# 2026-10-11 opencode 详情页修复：周/月序列与模型受 `since` 保留期限制

任务：`.trellis/tasks/10-11-opencode-detail-window-series-fix`（PRD + design + implement）。

## 起因

归档任务 `10-11-opencode-detail-v2-sync` 上线后，在**真实授权会话**下补做 live 取证时发现：
`GET /api/usage/cost-by-day` 与 `GET /api/usage/models` 的 `since` 参数走的是**服务端短期数据路径
（约 48h 保留）**，超出保留期的 `since` 会被**静默钳制到最近约 2 天**。而 v2 给「本周/本月」也传了
`since=<窗口起点>`，于是：

- 周/月 `seriesByWindow` 只回最近 **2** 天；
- 周/月 `modelsByWindow` 只含最近 **2** 天的模型。

不报错、只是少 —— 属于本项目最忌的「静默口径错误」。
详见 `research/since-retention.md`（真实会话实测）。

## 改了什么

**主进程（数据层）**

- `opencode-details.ts`
  - `costByDayUrl(range, bucket, since?)`：`since` 改**可选**，仅在有值时拼。
  - 抽出纯函数 **`modelsRequestOf(kind, starts)` / `seriesRequestOf(kind, starts)`**（窗口 → 请求口径）：
    rolling → `range=24h` + `since=<fiveHour.start>`；**周/月 → `range=7d|30d`（不带 `since`）**；
    rolling 缺起点 → `null`。`scrape` 的两段循环改为消费这两个函数。
  - `seriesByWindowOf(details, windows)` 改签名：`windows: SeriesWindowBound[]`
    （`{kind,name,startAt?,resetAt?,spanMs}`），对每个窗口把桶**裁到 `[startAt, resetAt)`**；
    key 契约不变（空数组保留、缺失不产出）。
  - 头部/字段注释更正 `since` 语义（保留期）。
- `opencode.ts`：`seriesByWindow` 改为从 `officialWindows` 的 `ProviderWindow[]` 构造边界后调用带裁剪的
  `seriesByWindowOf`；`modelsByWindow` 无需改（周/月现在已是全量）。
- `opencode-console-api.ts`：更正 `MODELS_RANGES` / `MODELS_RANGE_ROLLING` / `USAGE_COST_BY_DAY_PATH`
  的注释（`since` 仅 48h 保留期有效）。

**未改**：鉴权、base、`shared/types.ts` 对外形状、渲染层组件（`seriesByWindow` 已是裁剪后的桶）。

## 裁剪口径（核心决定）

**保留与窗口相交的桶**，条件 `桶起点 + 桶宽 > lower && 桶起点 < upper`：
`lower = startAt ?? resetAt - spanMs`，`upper = resetAt ?? +∞`。

- 端点的桶按 UTC **整点/整日向下取整**，窗口第一个桶可能早于 `startAt`
  （rolling 小时桶最多早 59 分钟；month 的订阅起点 `access.startsAt` 是非整日时刻，首日桶可能早近一天）。
- 若按「桶起点 `>= startAt`」裁，会把这**第一个不完整桶整只丢掉** → 时序求和 < meter 已用量。
- 用「相交」既**不漏窗口内用量**，又**不会把前一整桶带进来**：自然周对齐时
  （`startAt` = 周一 00:00）前驱桶末端恰好 `= startAt`，不含在相交内。
- 代价：首桶可能含极少量窗口外用量（≤ 一个桶宽）—— 刻意取舍，M 段单测钉住。

> ⚠️ 与 PRD AC4 的字面表述（「桶全部落在 `[startAt, resetAt]` 内」）有**一处已知偏差**：为保留
> 窗口内首个不完整桶，相交首桶的 `t` 可能略早于 `startAt`。已在测试与注释写明口径并报告。

## 波折

- **`since` 的「覆盖 range 起点」结论只在保留期内成立**：v2 的 research/spec/知识页都把它写成了
  通用规律。实测发现超期被钳制，三处文档同步更正（保留历史记录 + 追加更正段）。
- **编排层是测试盲区**：`scrape` 至今没有 fetch 桩，所以「给周/月塞回 `since`」原先改坏了也没人拦。
  本次把「窗口 → 请求口径」抽成纯函数 `modelsRequestOf`/`seriesRequestOf`，让这条契约**有牙**。

## 验证

- `npm run typecheck` ✓（node + web 两个 project）。
- `npm run test` ✓ 全绿（退出码 0）；`test:ssr` **133 通过 / 0 失败**
  （新增 M 段窗口裁剪 10 条 + N 段请求口径 10 条，原 L 段改写）。
- **护栏自证（先弄坏再恢复）**：
  - 令 `clipBucketsToWindow` 恒返回 `true` → M 段 **5 红**（M2/M3/M4a/M5/M6），恢复 → 绿；
  - 令 `modelsRequestOf` 的周/月分支加回 `since` → N 段 **2 红**（N2a/N3a），恢复 → 绿。
- `npm run build` ✓。
- **live 复核**（真实授权会话，`electron . --details-test`）：
  ```
  models:  rolling 1 | weekly 11 | monthly 20      ← 修复前周/月仅最近 2 天
  series:  rolling 3(hour) | weekly 7(day) | monthly 29(day)   ← 修复前周/月仅 2 桶
  rolling 时序: 12:00=$0.7486 · 13:00=$0.4607 …（与 5h 窗口逐时一致）
  weekly 时序 7 桶（10-05..10-11，整自然周）
  monthly 时序 29 桶（09-12..10-11，range=30d 全量；裁到订阅月后应从 09-21 起）
  ```
  ⚠️ `--details-test` 打印的是 **scrape 原始桶**（裁剪前）；AC4 的裁剪结果由 M 段单测钉住
  （诊断命令拿到的是裁剪前数据，未改动其口径）。

## AC 对照

| AC | 状态 | 依据 |
|---|---|---|
| AC1 周/月序列覆盖全窗口（≥2 天时不止 2 天） | ✅ | live：weekly 7 桶、monthly 29 桶（裁后 09-21..10-11） |
| AC2 周/月每模型为整周/整月口径 | ✅ | live：weekly 11 / monthly 20，与 `models?range=7d|30d`（无 since）一致 |
| AC3 5 小时保持逐分一致（不回归） | ✅ | live：rolling 3 小时桶、1 模型；`seriesRequestOf` rolling 仍带 since |
| AC4 序列桶落在 `[startAt, resetAt)` | ⚠️ 有意偏差 | 相交首桶 `t` 可略早于 `startAt`（为不漏窗口内用量）；M 段钉住口径 |
| AC5 官方不可达时退回本机 + 标注 | ✅ | 降级链未改；key 缺失/空数组契约不变（L 段） |
| AC6 typecheck/test 全绿 + spec/research 同步 | ✅ | 见「验证」与「沉淀」 |

## 沉淀

- `docs/knowledge/frontend/window-series-view.md` §1 重写（`since` 仅 48h 保留期 + 周/月不带 + 客户端裁窗口），
  新增 **§1.1 裁剪口径：保留与窗口相交的桶**；§2 代码片段更新为新签名。
- `.trellis/spec/adapters/opencode-console.md`：§2 签名（`modelsRequestOf`/`seriesRequestOf`/新 `seriesByWindowOf`）、
  §3.3/§3.5 `since` 保留期语义、§4 错误矩阵新增「周/月带 since → 静默少 2 天」、§5 Good 案例、§6 测试表新增 M/N 组、
  §7.4 新增 Wrong vs Correct、§6 已知缺口收窄说明。
- `docs/knowledge/frontend/index.md` 一句话索引同步。
- 归档任务 research `console-api-v2.md` 追加 §0.1 更正段并就地标注过时结论（保留历史）。
