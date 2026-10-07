import type React from 'react'
import { useState } from 'react'
import type { UsagePoint } from '../../shared/usage-predict'
import { Icon } from './components'
import { fmtAmount, fmtPercent } from './format'
import { bucketByDay, windowsWithHistory, type DayBucket } from './usageHistory'
import { heatmapOf, intensityOf, maxDelta, streakOf, type HeatDay } from './usageHeatmap'

// 详情页的用量热力图（P1-1）：GitHub 式日历网格 + streak 头。轻量 SVG，**不引图表库**。
//
// 2026-10-07 由「每天一根柱」改为日历网格 + streak：柱状图只给形状不给数值，用户读不出
// 趋势。颜色口径也换成**日增量 pp** —— 末值强度在高位用量下整张图全深（用量一直在 80%
// 附近就天天最深），看不出「哪天用得多」；日增量直接回答「这天用了多少」，悬停再给末值，
// 双数齐下。见 design.md「权衡」一节。
//
// 聚合口径全在纯函数里（`usageHistory.bucketByDay` 分桶 → `usageHeatmap.heatmapOf` 差分
// → `intensityOf` 分档 → `streakOf` 统计），本文件只管布局与显示。

/** 可见天数选项。7 / 30 共用**同一份**已取回的历史（切换不发请求） */
const DAY_CHOICES = [7, 30] as const

/** 日历网格几何。viewBox 与像素 1:1（SVG 上带 width/height），再靠 max-width 在窄卡上收缩 */
const CELL = 13
const GAP = 3
const ROWS = 7
const PAD_L = 18 // 左侧星期标签
const PAD_T = 14 // 顶部月份标签

/** 周一 = 0 .. 周日 = 6。JS 的 getDay 是周日 = 0，这里平移一格对齐日历习惯 */
function weekdayMon(d: Date): number {
  return (d.getDay() + 6) % 7
}

/** 解析 'YYYY-MM-DD'（本地日）。非法 → null，不让一张坏数据把整张图打掉 */
function parseDay(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const [y, m, d] = day.split('-').map(Number)
  const out = new Date(y, m - 1, d)
  return out.getFullYear() === y && out.getMonth() === m - 1 ? out : null
}

/** 一格的位置：列 = 周，行 = 周一..周日 */
interface PlacedCell {
  day: HeatDay
  col: number
  row: number
}

/**
 * 格序列 → 带坐标的格序列 + 总列数。
 *
 * 首列从**首日所在周的周一**开始（不是首日本身）：这样每一列都真的是「一周」，
 * 跨月的列边界才和月份标签对得上。代价是首列前面可能空 0..6 格，而**空格不渲染**
 * （它不代表「那天没采到」，只是网格的对齐留白）。
 */
function placeDays(days: HeatDay[]): { cells: PlacedCell[]; cols: number } {
  const dated = days
    .map((d) => ({ day: d, dt: parseDay(d.day) }))
    .filter((d): d is { day: HeatDay; dt: Date } => d.dt != null)
  if (dated.length === 0) return { cells: [], cols: 0 }

  const first = dated[0].dt
  const startMonday = new Date(first.getFullYear(), first.getMonth(), first.getDate() - weekdayMon(first))
  const WEEK = 7 * 86_400_000
  let cols = 0
  const cells: PlacedCell[] = []
  for (const { day, dt } of dated) {
    const col = Math.round((dt.getTime() - startMonday.getTime()) / WEEK)
    cells.push({ day, col, row: weekdayMon(dt) })
    if (col + 1 > cols) cols = col + 1
  }
  return { cells, cols }
}

/** 月份标签：只在列的**首日**换了月份时出现（GitHub 同款，避免每列都标） */
function monthMarks(cells: PlacedCell[], cols: number): Array<{ col: number; label: string }> {
  const out: Array<{ col: number; label: string }> = []
  let lastMonth = -1
  for (let c = 0; c < cols; c++) {
    const firstInCol = cells.find((x) => x.col === c)
    if (!firstInCol) continue
    const m = parseDay(firstInCol.day.day)?.getMonth()
    if (m == null) continue
    if (m !== lastMonth) {
      out.push({ col: c, label: `${m + 1}月` })
      lastMonth = m
    }
  }
  return out
}

/** 'YYYY-MM-DD' → 'MM-DD 周X'。列表窄，只留用户要的那两个信息 */
function dateLabel(day: string): string {
  const d = parseDay(day)
  if (!d) return day
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${m}-${dd} 周${'一二三四五六日'[weekdayMon(d)]}`
}

/**
 * 绝对量的显示：优先「当天增量」；首日无对比基准 → 回退到当天末值累计并标明口径。
 * 两者都拿不到（升级前的旧采样）→ 「—」，不填 0。
 */
function usedLabel(d: HeatDay): string {
  if (d.deltaUsed != null && d.unit) return fmtAmount(d.deltaUsed, d.unit)
  if (d.lastUsed != null && d.unit) return `${fmtAmount(d.lastUsed, d.unit)}累计`
  return '—'
}

/** 格子 tooltip：日期 + 末值% + 日增量pp + 当天用量。缺失如实写「未采样」，不凑数 */
function cellTitle(d: HeatDay): string {
  const head = `${d.day} · `
  if (d.lastPct == null) return `${head}未采样`
  const parts = [`末值 ${fmtPercent(d.lastPct)}`]
  if (d.deltaPp != null) parts.push(`日增量 ${d.deltaPp >= 0 ? '+' : ''}${d.deltaPp.toFixed(1)}pp`)
  else parts.push('首日，无对比基准')
  const u = usedLabel(d)
  if (u !== '—') parts.push(`当天用量 ${u}`)
  return `${head}${parts.join(' · ')}`
}

// ─── 面板（取数已在上游完成，这里只管显示与切换）──────────────────────────────

/**
 * 用量热力图区块：窗口切换 + 天数切换 + streak 头 + 日历网格。
 *
 * ⚠ **切换不发 IPC**：历史一次取回 30 天，两个视图都从这份数组里切。
 *   快照文件每 15 分钟才动一次，而切换会频繁发生 —— 把 IPC 往返放在切换路径上是本末倒置。
 *
 * ⚠ **默认画主窗口**（`primaryWindow`），其余窗口给切换控件。不做多窗口堆叠：
 *   堆叠要为每个窗口各算一份 streak/分档，纵向占 3x 空间，而用户多数时间只看主窗口。
 *
 * 没有任何历史 → 返回 null（界面上什么都不显示，不是「加载失败」，也不是空壳）。
 */
export function TrendPanel({
  pointsByWindow,
  primaryWindowName,
  now
}: {
  pointsByWindow: Record<string, UsagePoint[]>
  /** `primaryWindow(s)` 的窗口名；不在有历史的窗口里就退到第一个 */
  primaryWindowName: string | undefined
  now: number
}): React.JSX.Element | null {
  const [picked, setPicked] = useState<string | null>(null)
  const [days, setDays] = useState(7)

  const windows = windowsWithHistory(pointsByWindow)
  if (windows.length === 0) return null

  // ⚠ 有历史 ≠ 这个回看窗口里有历史。实测可达：最后一次采样在 10 天前，之后应用没跑 ——
  //   `windowsWithHistory` 照样列出该窗口，但 7 天窗口内一个桶都没有。这时候只渲染一个
  //   「用量趋势」标题加两组切换钮、底下空着，比不显示更像坏了（AC：界面上什么都不显示）。
  //   判据是「**所有**候选窗口在当前天数下都空」：任何一个还有数据就把面板留着，
  //   用户还能切过去看。
  if (!windows.some((w) => bucketByDay(pointsByWindow[w] ?? [], days, now).length > 0)) return null

  // 换供应商后 picked 可能指向一个这家没有的窗口 → 落回主窗口（不硬撑一个空图）
  const active = picked && windows.includes(picked) ? picked
    : primaryWindowName && windows.includes(primaryWindowName) ? primaryWindowName
    : windows[0]
  // ⚠ 纯函数重算在渲染里做（与本仓其余派生状态一致）：桶数 ≤ 30，亚毫秒级，
  //   不值得为它引一个 useMemo（而 useMemo 的依赖里塞 now 会让 30s 一圈的钟重算无意义）
  const buckets = bucketByDay(pointsByWindow[active] ?? [], days, now)

  return (
    <section className="section">
      <div className="section-title">
        用量趋势
        <em className="tag env">本机历史</em>
      </div>
      <div className="trend-switch">
        {windows.length > 1 && (
          <span className="trend-switch-group" role="group" aria-label="切换用量窗口">
            {windows.map((w) => (
              <button
                key={w}
                type="button"
                className={`trend-chip${w === active ? ' on' : ''}`}
                aria-pressed={w === active}
                onClick={() => setPicked(w)}
              >
                {w}
              </button>
            ))}
          </span>
        )}
        <span className="trend-switch-group" role="group" aria-label="切换回看天数">
          {DAY_CHOICES.map((d) => (
            <button
              key={d}
              type="button"
              className={`trend-chip${d === days ? ' on' : ''}`}
              aria-pressed={d === days}
              onClick={() => setDays(d)}
            >
              {d} 天
            </button>
          ))}
        </span>
      </div>
      <TrendChart buckets={buckets} windowName={active} />
    </section>
  )
}

// ─── streak 头 ────────────────────────────────────────────────────────────────

/**
 * streak 头：火焰 = 截至今天连续正增量天数，天数 = 有采样天数，右上徽标 = 今日增量。
 *
 * ⚠ 火焰是「连续正增量」而不是「连续有采样」：后者只要应用每天跑过就会一路涨，
 *   变成「我开了 BalanceDeck 30 天」而不是「我连续 30 天在消耗额度」。
 * ⚠ 零/负增量的天**断** streak，而不是跳过：跳过会让「中间有天没用」和「天天都在用」
 *   显示成同一个连击数，而这个正是 streak 想回答的问题。
 */
export function TrendHeader({ days: heatDays }: { days: HeatDay[] }): React.JSX.Element | null {
  const st = streakOf(heatDays)
  const badge = st.todayDelta != null
    ? `${st.todayDelta >= 0 ? '+' : ''}${st.todayDelta.toFixed(1)}pp`
    : st.todayPct != null
      ? fmtPercent(st.todayPct)
      : null

  return (
    <div className="trend-head" data-streak={st.streak} data-sampled={st.sampledDays}>
      <span className="trend-head-main">
        <Icon name="flame" size={13} />
        {st.streak} 连击
      </span>
      <span className="trend-head-sub">{st.sampledDays} 天有记录</span>
      {badge && (
        <span className="trend-head-badge" title="今日日增量；今天还没有第二次采样时改显示今日末值">
          {badge}
        </span>
      )}
    </div>
  )
}

// ─── 逐日明细 ─────────────────────────────────────────────────────────────────

/**
 * 逐日明细：热力图给「哪天用得多」的形状，这里给**具体数值**。
 *
 * 为什么要它：热力图的颜色深浅是**相对**的（标尺 = 本轮最大日增量），而且百分比是
 * 相对数 —— $12 额度和 $120 额度都可以是 60%。用户问「今天具体花了多少钱」，
 * 只有绝对值能答。这正是 PRD 里那句「无法知道具体是使用量」的症结。
 *
 * ⚠ **只显示有采样的天**（用户明确要求「不要显示空的」）。这与热力图的「缺口可见」
 *   不矛盾：热力图的空格是**位置**信息（那天在日历上的哪），明细是**数值**信息，
 *   列一行全是「—」的日期没有任何信息量，只是把列表拉长。
 * ⚠ **新近优先**（与热力图左→右相反）：明细是「查账」用的，最新的一天在最上面，
 *   而不是让人先滚 20 行才能看到今天。
 * ⚠ 绝对量是**当天增量**（reset 口径与热力图一致），不是累计：累计值随窗口周期
 *   重置，直接列出来会被误读成「今天用了这么多」。首日无基准时回退到末值累计并标注。
 */
export function TrendRecords({ days: heatDays }: { days: HeatDay[] }): React.JSX.Element | null {
  // 有采样的天 → 新近优先
  const rows = heatDays.filter((d) => d.lastPct != null).slice().reverse()
  if (rows.length === 0) return null

  return (
    <div className="trend-records" role="table" aria-label="逐日用量明细">
      <div className="trend-records-head" role="row">
        <span role="columnheader">日期</span>
        <span role="columnheader">末值</span>
        <span role="columnheader" title="当天绝对用量增量；首日无对比基准时改显示累计值">
          当天用量
        </span>
      </div>
      {rows.map((d) => (
        <div key={d.day} className="trend-records-row" role="row">
          <span className="trend-records-date" role="cell">
            {dateLabel(d.day)}
          </span>
          <span className="trend-records-pct" role="cell">
            {fmtPercent(d.lastPct)}
          </span>
          <span className="trend-records-used" role="cell">
            {usedLabel(d)}
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── 图 ───────────────────────────────────────────────────────────────────────

/**
 * 日历网格热力图：列 = 周，行 = 周一..周日，颜色深浅 = 当天日增量。
 *
 * ⚠ `buckets` 为空 → **返回 null**。历史为空、`usage:predict` 返回 `{}`、余额类根本没请求
 *   —— 这三种情况下详情页少一个区块，比多一个「暂无数据」的占位块诚实。
 *
 * ⚠ `lastPct === null` 的天**不画格子**（该天没采到可用数值）。缺口可见 = 用户知道那天
 *   应用没跑；填成最浅一档反而会让他以为「那几天用量是 0」，并据此得出错误结论。
 *   分档 0（空）与 1（有记录但没涨）必须视觉上分开，CSS 里空格用 `--track` 而 1 档用
 *   `color-mix(--ok, --track)`，就是为了这一点。
 *
 * ⚠ 强度档是**相对**的：标尺取本轮 active 窗口的 maxDelta，不跨窗口比（usageHeatmap 的
 *   第 3 条纪律）。所以切窗口后同一天的深浅可能变，这是刻意的。
 */
export function TrendChart({
  buckets,
  windowName
}: {
  buckets: DayBucket[]
  /** 当前画的窗口名（无障碍标签要说清是哪个窗口的数） */
  windowName: string
}): React.JSX.Element | null {
  if (buckets.length === 0) return null

  const heatDays = heatmapOf(buckets)
  const { cells, cols } = placeDays(heatDays)
  if (cells.length === 0) return null

  // 标尺只取**当前窗口**的最大日增量（相对分档，不跨窗口比）
  const mx = maxDelta(heatDays)
  const vbW = PAD_L + cols * (CELL + GAP) - GAP
  const vbH = PAD_T + ROWS * (CELL + GAP) - GAP
  const hasData = cells.some((c) => c.day.lastPct != null)

  return (
    <div className="trend" data-window={windowName} data-days={heatDays.length}>
      <TrendHeader days={heatDays} />
      <svg
        className="trend-chart"
        viewBox={`0 0 ${vbW} ${vbH}`}
        width={vbW}
        height={vbH}
        role="img"
        aria-label={`${windowName} 近 ${heatDays.length} 天用量热力图，列为一周、行从周一到周日，颜色越深当天用量越大`}
      >
        {monthMarks(cells, cols).map((m) => (
          <text key={`${m.col}-${m.label}`} className="trend-month" x={PAD_L + m.col * (CELL + GAP)} y={8}>
            {m.label}
          </text>
        ))}
        {['一', '三', '五'].map((w, i) => (
          <text key={w} className="trend-weekday" x={11} y={round1(PAD_T + i * 2 * (CELL + GAP) + CELL - 3)} text-anchor="end">
            {w}
          </text>
        ))}
        {cells.map((c) => {
          // 缺样本的天不画格：缺口可见（空格与「有记录但没涨」必须能区分）
          if (c.day.lastPct == null) return null
          const level = intensityOf(c.day.deltaPp, mx)
          return (
            <rect
              key={c.day.day}
              className={`trend-cell heat-${level}`}
              x={PAD_L + c.col * (CELL + GAP)}
              y={PAD_T + c.row * (CELL + GAP)}
              width={CELL}
              height={CELL}
              rx={2}
            >
              <title>{cellTitle(c.day)}</title>
            </rect>
          )
        })}
      </svg>
      {hasData ? (
        <div className="trend-legend">
          <span>纵轴周一–周日 · 颜色深浅 = 当天日增量</span>
          <span className="trend-legend-scale">
            <span className="trend-legend-less">少</span>
            {[1, 2, 3, 4].map((l) => (
              <span key={l} className={`trend-cell heat-${l} trend-legend-cell`} aria-hidden="true" />
            ))}
            <span className="trend-legend-more">多</span>
          </span>
        </div>
      ) : (
        /* 格在但一天都没读出百分比：这与「没有历史」是**两回事**，所以给一句实话，
           而不是画一张空图（空图看起来像「这 30 天用量都是 0」）。 */
        <div className="trend-legend">
          <span>这段时间采到了，但没有读到可用数值</span>
        </div>
      )}
      <TrendRecords days={heatDays} />
    </div>
  )
}

/** 坐标取一位小数：SVG 属性里写 12.800000000000001 不会报错，但会让 DOM 体积暴涨 */
function round1(v: number): number {
  return Math.round(v * 10) / 10
}
