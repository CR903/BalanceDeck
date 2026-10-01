# Research: 快照读回路径 / IPC 链路 / 余额类可用性

- **Query**: usageStore 的 `loadRecent` 返回 `Record<窗口名, UsagePoint[]>`，渲染层走哪条 IPC 拿？趋势图需不需要余额类历史？余额类窗口名是什么、pct 是否有意义？
- **Scope**: internal
- **Date**: 2026-10-01

---

## 1. 完整链路（采集 → 落盘 → IPC → 渲染层）

四跳，全部已存在，**趋势图不需要新增 IPC**：

```
scheduler.sampleUsageHistory()        src/main/scheduler.ts:126-147
  └─ usageHistoryStore.appendBatch()  src/main/scheduler.ts:142
       └─ usageStore.appendBatch()    src/main/usageStore.ts:133-156
            └─ writeFileSync usage-history.json
scheduler.loadUsageHistory()          src/main/scheduler.ts:162-164   ← IPC 的数据源
ipcMain.handle('usage:predict')       src/main/ipc.ts:374-380        ← 现有通道
preload api.usagePredict()            src/preload/index.ts:98-99
DetailView usePredictions()           src/renderer/src/DetailView.tsx:52-96
```

### 1.1 采集侧：只记 `windowPercent(w)`，窗口名来自 `w.name`

```ts
// src/main/scheduler.ts:131-137
for (const s of lastSnapshots) {
  if (s.status !== 'ok') continue
  for (const w of s.windows) {
    // 百分比不可知时写 null（**不写 0**）
    points.push({ providerId: s.id, window: w.name, pct: windowPercent(w), t: now })
  }
}
```

⚠ **采集侧没有任何 `isPlan` 过滤** —— 余额类供应商的窗口**也在被采样并落盘**。
唯一的过滤是 `s.status !== 'ok'`。这一点与渲染层的过滤是两层独立的东西。

### 1.2 IPC handler：`usage:predict` 逐字段复验，不看 kind

```ts
// src/main/ipc.ts:374-380
ipcMain.handle('usage:predict', async (_e, providerId: unknown, days: unknown, now: unknown) => {
  if (typeof providerId !== 'string' || !providerId) return {}
  if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) return {}
  const t = typeof now === 'number' && Number.isFinite(now) && now > 0 ? now : Date.now()
  return loadUsageHistory(providerId, days, t)
})
```

**IPC 层不做任何 kind / isPlan 判据** —— 它是无差别的历史读取通道。
「只在套餐类时请求」这个限制**只存在于渲染层**：

```tsx
// src/renderer/src/DetailView.tsx:243-246
// 余额类**不请求**：它没有窗口也没有限额，速率估算的整个前提不成立（design.md D5），
// 而发一次 IPC 换回一个必然为空的结果只是白费一次往返。
const planish = !!s && isPlan(s)
const predictions = usePredictions(s, planish ? now : 0, predictOn, predictConfig)
```

`predictAll` 里还有第二道（`src/renderer/src/usagePredict.ts:238`）：
```ts
if (!isPlan(s)) return []
```

### 1.3 loadRecent：按窗口名分组的拍平数组

```ts
// src/main/usageStore.ts:158-180
loadRecent(providerId, days, now) {
  const cut = cutoffDayKey(now, keepDaysOf(days))
  const out: Record<string, UsagePoint[]> = {}
  for (const k of Object.keys(f.days).sort()) {   // ← 天序遍历，跨天分桶在此被拍平
    if (k < cut) continue
    const arr = f.days[k]?.[providerId]
    ...
    ;(out[w] ??= []).push({ t: d.t, pct: ... })
  }
  for (const w of Object.keys(out)) out[w].sort((a, b) => a.t - b.t)
  return out
}
```

磁盘是三层 `{ day → providerId → DayPoint[] }`，`loadRecent` **把 day 层压掉了**。
读回来的是 `{ 窗口名: UsagePoint[] }`（窗口名 → 按 t 升序的点数组）。

---

## 2. 余额类的窗口名与 pct：**两者都不可用于趋势图**

### 2.1 余额类窗口名

唯一的通用构造函数：

```ts
// src/main/adapters/types.ts:55-58
/** 余额类通用窗口：单条"账户余额"窗口（limit 未知，仅展示金额） */
export function balanceWindow(amount: number, unit: Unit, note?: string): ProviderWindow {
  return { name: '账户余额', used: amount, unit, note }
}
```

`grep -rn '账户余额' src/main/` 命中 `adapters/types.ts:57` / `qwen.ts:108` /
`volc.ts:106`，全部经由它。**全部 8 个 `kind:'balance'` 协议**（`adapters/protocols.ts`
113/145/169/186/202/217/234/250）都走 `balanceWindow`。

**唯一的例外**是 OpenAI 计费协议，它自己拼了一个不同的窗口名：

```ts
// src/main/adapters/protocols.ts:242
return [{ name: '账户额度', used: 0, limit: limit as number, unit: 'usd', note: '官方计费接口（不含已用量）' }]
```

→ 余额类的窗口名只有 **两个**：`'账户余额'`（通用）与 `'账户额度'`（openai-billing）。
两者都**没有** `percent` 字段。

### 2.2 pct 对余额类没有意义 —— 实测

`windowPercent` 的口径（`src/shared/percent.ts:14-20`）：
```ts
if (w.percent != null && Number.isFinite(w.percent)) raw = w.percent
else if (w.limit != null && w.limit > 0) raw = (w.used / w.limit) * 100
if (raw == null) return null
return roundPercent(Math.max(0, Math.min(100, raw)))
```

实测（`loadTs('src/shared/percent.ts')` 跑真源码）：

| 窗口 | 输入 | `windowPercent` |
|---|---|---|
| 通用余额 | `{ name:'账户余额', used:1288.5, unit:'cny' }` | **`null`** |
| 账户额度 | `{ name:'账户额度', used:0, limit:120, unit:'usd' }` | **`0`** |
| 套餐 5 小时 | `{ name:'5 小时', used:40, limit:100, unit:'usd' }` | `40` |

两种余额窗口给出两种**都无意义**的结果：

- `'账户余额'` → `pct: null`。30 天历史里每一条都是 `null`，**画不出任何东西**。
  （这批数据真实存在于磁盘上：`scheduler.ts:132` 没有 kind 过滤，
  余额供应商的窗口每 15 分钟确实被采样并落盘 —— 只是 pct 全是 null。）
- `'账户额度'` → `pct: 0` **恒为 0**。这是协议注释自己承认的
  （`protocols.ts:230`：`// ── OpenAI 计费：返回的是额度而非余额（used 恒为 0）──`），
  画出来是一条贴底的平线 —— 比 null 更糟，因为它**看起来像有数据**。

### 2.3 为什么「余额类不请求」是对的，但对趋势图的理由不同

`DetailView.tsx:243-244` 的理由是「速率估算的整个前提不成立」（预测的是「什么时候用完
100%」，余额没有上限）。趋势图问的是另一个问题：「用量怎么变的」—— 对余额而言，
有意义的是**账户余额金额随时间的下降曲线**（今天 ¥1288 → 7 天前 ¥1500），
而 `UsagePoint` 只有 `pct` 一个数值字段，**没有 `used`/金额字段**：

```ts
// src/shared/usage-predict.ts:27-36
export interface UsagePoint {
  t: number
  pct: number | null   // ← 只有百分比
}
```

落盘的 `DayPoint` 同样只有这三个字段（`usageStore.ts:44-48`）。
**磁盘上根本没有余额金额的历史** —— 采样时 `w.used`（金额）被丢掉了，只留了
`windowPercent(w)`。

---

## 结论（Q1）

| 问题 | 答案 |
|---|---|
| 走哪条 IPC？ | 现有的 `usage:predict`（`ipc.ts:374` → `preload/index.ts:98` → `api.usagePredict`）。**不需要新增通道** —— 它已经返回 `loadRecent` 的原始结果，趋势图可以直接复用。 |
| 但现在只返回预测结果吗？ | 不是。`usage:predict` 返回的是**原始历史** `Record<string, UsagePoint[]>`；是渲染层的 `predictAll` 才把它变成 `Prediction[]`。趋势图可以直接用前者。 |
| 需不需要余额类历史？ | **不需要，且当前数据不支持**。余额窗口名是 `'账户余额'`/`'账户额度'`，pct 分别是恒 `null` / 恒 `0`，都画不出曲线。 |
| 唯一的额外成本 | 如果要做余额趋势（金额下降曲线），需要**改 `UsagePoint` 加 `used` 字段 + 改 `scheduler` 采样时带上 `w.used`**，这是 P0-2 的磁盘格式 v1 变更，属于本任务范围外。 |

---

## 需要澄清的问题

1. **余额类要不要单独处理？** 若要（画「余额余额下降」而不是百分比），
   需要扩展 `UsagePoint`（加 `used: number | null`）与 `DayPoint`。
   这是跨进程契约变更（`shared/usage-predict.ts` 的注释明确警告过：
   `preload` 与 `usageStore` 各写一份类型会「无声漂移」）。
   **或者**保持现状：余额供应商不显示趋势图。

2. **`usage:predict` 现有调用点要不要复用？**
   `DetailView.tsx:66-85` 的 `usePredictions` 已经取过一次历史，
   但它**只把 `Prediction[]` 交给渲染层，原始 points 在 `useMemo` 里就被吃掉了**
   （`DetailView.tsx:91-95`）。趋势图若要复用同一次 IPC，
   得让 hook 返回 `{ predictions, pointsByWindow }` 两个值 ——
   这样能复用**同一次往返**，否则趋势图要再发一次 `usagePredict`。

3. **`predictOn` 开关与趋势图的关系？**
   `ui:predictOn` 的语义是「预计耗尽」的开关（`VoiceReminderSection.tsx:916-917`
   的 title 是「关闭后详情页不再显示预计耗尽时间」）。
   趋势图**不是**预计耗尽，挂在同一个开关下会让关掉预测的用户连趋势也看不到。
   `usePredictions` 在 `on === false` 时**根本不请求**（`DetailView.tsx:67`），
   趋势图若复用这个 hook 会一起消失。

---

## 相关文件

| 文件 | 作用 |
|---|---|
| `src/main/usageStore.ts` | 落盘 + `loadRecent`（v1 格式，天分桶） |
| `src/main/scheduler.ts:126-164` | 采样 + `loadUsageHistory` 出口 |
| `src/main/ipc.ts:374-380` | `usage:predict` handler（逐字段复验） |
| `src/preload/index.ts:98-99` | `api.usagePredict` 声明 |
| `src/shared/usage-predict.ts:27-54` | `UsagePoint` / `PredictConfig` / 默认值 |
| `src/renderer/src/DetailView.tsx:52-96` | `usePredictions` hook |
| `src/renderer/src/usagePredict.ts:232-252` | `predictAll`（第二道 isPlan 闸门） |
| `src/shared/percent.ts:14-20` | `windowPercent` 口径 |
| `src/main/adapters/types.ts:55-58` | `balanceWindow`（`'账户余额'`） |
| `src/main/adapters/protocols.ts:242` | `'账户额度'` 例外 |
