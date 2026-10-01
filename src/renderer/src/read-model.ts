import type { ProviderInfo, ProviderSnapshot, ProviderWindow } from '../../shared/types'
import { levelOfPercent, windowPercent, type Level } from './format'

// 纯函数模块（无 electron / 无 DOM / 无 React），scripts/test-read-model.mjs 直接加载本文件。
// ═══════════════════════════════════════════════════════════════════════════════
// 供应商快照的读模型：**一个**回答「哪个窗口重要、多严重」的地方
//
// 为什么独立成模块：此前主页卡片、详情页、收起态悬浮球各写一套 —— 同一个概念四处实现
// （CardLevel / snapLevel / severity / ballLevel，外加两份「主窗口」选择）。阈值与口径
// 分头改就会互相不一致，而且没有一处能被测试直接盯住。
//
// 分工：阈值判定仍在 format.levelOfPercent（百分比计算在 shared/percent，主进程托盘与
// 渲染层共用）；这里只决定「拿哪个数去比」「按什么排序」。三处视图都必须从这里取答案。
// ═══════════════════════════════════════════════════════════════════════════════

/** 卡片 / 详情页的主窗口：第一个带限额的窗口，否则第一个 */
export function primaryWindowIndex(s: ProviderSnapshot): number {
  if (s.windows.length === 0) return 0
  const i = s.windows.findIndex((w) => w.limit != null && w.limit > 0)
  return i >= 0 ? i : 0
}

export function primaryWindow(s: ProviderSnapshot): ProviderWindow | undefined {
  return s.windows[primaryWindowIndex(s)]
}

/** 最接近限额的窗口：收起态悬浮球用它（球面只放得下一个数） */
export function worstWindow(s: ProviderSnapshot | undefined): ProviderWindow | undefined {
  if (!s || s.status !== 'ok' || s.windows.length === 0) return undefined
  let best: ProviderWindow | undefined
  let bestPct = -1
  for (const w of s.windows) {
    const p = windowPercent(w)
    if (p != null && p > bestPct) {
      bestPct = p
      best = w
    }
  }
  return best ?? s.windows[0]
}

/** 快照里最大的百分比；没有可比的窗口则 null */
export function maxPercent(s: ProviderSnapshot): number | null {
  const pcts = s.windows.map(windowPercent).filter((p): p is number => p != null)
  return pcts.length ? Math.max(...pcts) : null
}

/** 整张快照的等级：状态优先（error 危险 / 非 ok 静音），否则取最严重的窗口 */
export function snapshotLevel(s: ProviderSnapshot): Level {
  if (s.status === 'error') return 'danger'
  if (s.status !== 'ok') return 'muted'
  const max = maxPercent(s)
  return max == null ? 'ok' : levelOfPercent(max, 'ok')
}

/** 单个窗口的等级 */
export function windowLevel(w: ProviderWindow): Level {
  return levelOfPercent(windowPercent(w), 'ok')
}

/**
 * 排序用的严重度：越需要关注越靠前。
 * 阈值不在这里重写 —— 直接由 snapshotLevel 推导，避免第二份 85/60。
 */
export function severityRank(s: ProviderSnapshot): number {
  if (s.status === 'error') return 3
  if (s.status === 'nodata') return 4
  switch (snapshotLevel(s)) {
    case 'danger':
      return 0
    case 'warn':
      return 1
    default:
      return 2
  }
}

/**
 * 哪些供应商可以播报：所有状态正常、且没被静音的。
 * muted 传「不要播报的 id」而不是「允许播报的 id」—— 这样默认空列表就等于全部允许，
 * 老用户没有这个偏好时行为与从前一致，而「只关掉其中一个」也表达得出来。
 *
 * 返回数组而非单个：用户配置了多个供应商时，每个都应该播报（2026-09-28 修复）。
 */
export function speakableSnapshots(
  snapshots: ProviderSnapshot[],
  muted: readonly string[] = []
): ProviderSnapshot[] {
  return snapshots.filter((s) => s.status === 'ok' && !muted.includes(s.id))
}

// ─── 同名多账号的区分（D5）────────────────────────────────────────────────────
//
// 区分依据只能从 `ProviderInfo` 拿：`ProviderSnapshot` 里没有 baseUrl/presetId/protocol
// （shared/types.ts 的刻意选择），而 `mark = presetId || protocol` 在同一预设下完全相同
// —— 今天两家公司同名账号**连 logo 都一样**。

/**
 * 需要加区分后缀的实例 id → 后缀文本。
 *
 * ⚗ 只有**同名的多个**账户才加后缀（`Claude 公司` / `Claude 个人`）：
 *   只有一个 Claude 账号时把 host 拼到名字后面纯粹是噪音。
 * ⚗ 缺区分依据的那个**不加**（`Claude`），而不是编一个「(2)」：
 *   假区分会让用户以为那确实是另一个账户 —— 比看不出来更糟。
 */
export function distinguishSuffixes(info: ProviderInfo[]): Record<string, string> {
  // 按名字分桶时**不过滤**缺区分依据的实例 —— 否则「两家同名、只有一家读得出 host」
  // 会被算成一组（读不出 host 的那个根本没进桶），结果是两家都不加后缀，
  // 白白丢掉唯一可用的那条区分信息。
  const byName = new Map<string, ProviderInfo[]>()
  for (const p of info) {
    const arr = byName.get(p.name)
    if (arr) arr.push(p)
    else byName.set(p.name, [p])
  }
  const out: Record<string, string> = {}
  for (const arr of byName.values()) {
    if (arr.length < 2) continue
    // 同名 ≥2 家才加；没有依据的那家仍然不加（不编「(2)」）
    for (const p of arr) if (p.distinguishKey) out[p.id] = p.distinguishKey
  }
  return out
}

/** 卡片显示名：有区分后缀时 `名称 后缀`，否则原样（不造假区分） */
export function displayName(name: string, suffix?: string): string {
  return suffix ? `${name} ${suffix}` : name
}

// ═══════════════════════════════════════════════════════════════════════════════
// 多账户分组（P1-4）：**只决定列表怎么显示**，不决定采不采集
//
// 为什么放在这里而不是 App.tsx：这个仓库没有 React 测试基础设施（quality-guidelines
// 记着这条），组件里的任何东西都测不到。本文件已被 scripts/test-read-model.mjs 加载，
// 所以分组的判定规则从今天起有契约 —— 而「筛的是组 id 还是实例 id」「组序从哪来」
// 这两件事正是最容易被后人手滑改错的。
//
// 语义边界（design.md D1）：筛选**只是不展示**，采集照跑。为什么不复用
// `enabled: false` —— 那是停止采集，切回要等一轮，而且这段时间的历史会断掉，
// P1-1 的趋势图会出现空档。
// ═══════════════════════════════════════════════════════════════════════════════

/** 未分组实例的显示名。渲染与存储都不能让用户看到空字符串当组名 */
export const UNGROUPED = '未分组'

/**
 * 「全部」的哨兵值 —— **空串**，不是 `'ALL'`。
 *
 * 为什么不另造一个字面量：存储（`ui:groupFilter`）与这个值是同一个字符串，
 * `extras:get` 对从未写过的键返回的也是空串，于是「没筛过」与「存的就是空串」
 * 是同一件事，不需要第二个状态。`setExtra` 遇空串直接删键（store.ts），
 * 读回来还是空串 —— 天然幂等。
 *
 * ⚠ 组名永远不可能等于空串（`sanitizeGroupId` 先 trim，空串 = 未分组），
 *   所以这个哨兵**不会**与用户数据撞名。
 */
export const ALL_GROUPS = ''

/**
 * 实例所属的分组 id —— 空串/缺省归一化成 `UNGROUPED`。
 *
 * ⚠ 归一化只在这里发生：**不要**让「空串」与「未分组」两种形状流进别处，
 * 那是 state-management.md 记过的「同一件事两处写法」那一类漂移。
 */
export function groupOf(info: ProviderInfo): string {
  return info.groupId ? info.groupId : UNGROUPED
}

/**
 * 全部分组 id（去重 + 升序）。
 *
 * 组名不是独立存储的：它就是「哪些实例的 groupId 等于这个字符串」的去重结果。
 * 没有组注册表，也就没有「组列表与实例列表不一致」的第二份真相源（design.md D2）。
 *
 * `UNGROUPED` 排在末尾 —— 它是兜底桶，不是用户建的组，不该混在自定义组里排序。
 */
export function groupNames(info: ProviderInfo[]): string[] {
  const names = new Set<string>()
  for (const p of info) names.add(groupOf(p))
  const out = [...names].sort()
  const i = out.indexOf(UNGROUPED)
  if (i >= 0) out.push(...out.splice(i, 1))
  return out
}

/**
 * 可见实例 id —— **单选筛选器**语义：选中某一组时**只显示该组**（2026-10-01 用户决策）。
 *
 * ⚠ `group` 传的是**组 id**，不是实例 id；`ALL_GROUPS`（空串）时返回全部。
 *
 * ⚠️ **单选筛选器无法表达「同时藏起 A 和 B、但要看 C」** —— 这是用户明确选择的
 *   心智模型（产品原话：「点组 = 只看它」），不是实现偷懒。真要藏起多组得逐个切过去。
 *
 * 筛选值指向一个**已不存在的组**时返回空集（而不是全部）：组会随最后一个成员被删而
 * 自然消失（design.md D2），此时「回落全部」是**渲染层**的判断 —— 它手里还有下拉的
 * 选项列表能证明那个组确实没了，而纯函数只回答「这个组里有哪些成员」。
 */
export function visibleIds(info: ProviderInfo[], group: string = ALL_GROUPS): Set<string> {
  const out = new Set<string>()
  for (const p of info) if (!group || groupOf(p) === group) out.add(p.id)
  return out
}

/**
 * 展示顺序：**组间按「该组第一个成员在数组里的位置」，组内按数组顺序**。
 *
 * 为什么组序不另存一层（design.md D4）：注册表只有一个数组、extras 是扁平 map，
 * `providers:reorder` 的入参形状已被 ipc.ts 的守卫写死成 `string[]`。把组序定义成
 * 成员的数组位置，就不需要新的持久化维度，reorder 的形状也不用动 —— 用户的拖拽结果
 * 天然就蕴含了组序（把 A 组的卡拖到 B 组前面，A 组就在前面）。
 *
 * 代价（钉在测试第 5 条）：某组最后一个成员被移走后，组的位置按剩下的成员重算。
 *
 * 返回的是**实例 id 列表**，被筛掉的组不出现 —— 渲染层据此直接少渲染几张卡。
 */
export function orderForDisplay(info: ProviderInfo[], group: string = ALL_GROUPS): string[] {
  const shown = visibleIds(info, group)
  // 每个可见组的「组首下标」= 该组第一个可见成员在数组里的位置（组序的唯一定义）
  const firstAt = new Map<string, number>()
  for (let i = 0; i < info.length; i++) {
    const p = info[i]
    if (!shown.has(p.id)) continue
    const g = groupOf(p)
    if (!firstAt.has(g)) firstAt.set(g, i)
  }
  // 按组首下标排序。Array.prototype.sort 自 ES2019 起保证**稳定** ——
  // 键相同的成员维持原数组顺序，于是「组内按数组顺序」这条规则由它免费给出，
  // 不需要把下标拼进排序键（那会让 id 里带分隔符的实现变得难读）。
  return info
    .filter((p) => shown.has(p.id))
    .map((p) => ({ id: p.id, key: firstAt.get(groupOf(p)) ?? 0 }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.id)
}

/**
 * 收起态悬浮球的等级：状态优先（error=危险 / 非 ok=静音），
 * 否则看它当前显示的那个窗口 —— 与 snapshotLevel 的差别在于**没有百分比时**：
 * 球显示不出百分比就应该是灰的（muted），而不是按「取最大百分比」判成 ok。
 */
export function ballLevel(s: ProviderSnapshot | undefined, w: ProviderWindow | undefined): Level {
  if (!s) return 'muted'
  if (s.status === 'error') return 'danger'
  if (s.status !== 'ok') return 'muted'
  return w ? windowLevel(w) : 'muted'
}
