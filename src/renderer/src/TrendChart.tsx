import type React from 'react'
import { useState } from 'react'
import type { UsagePoint } from '../../shared/usage-predict'
import { fmtPercent, levelOfPercent } from './format'
import { bucketByDay, scaleY, windowsWithHistory, xOf, type DayBucket } from './usageHistory'

// 详情页的历史趋势图（轻量 SVG，**不引图表库** —— 竞品调研原话：「轻量 SVG 即可」）。
//
// 它只画一根柱序列，没有 tooltip、没有缩放、没有动画 —— 因为数据诚实比交互丰富重要得多：
// 一张「每天末值」的柱状图，用户可以自己拿它跟上方卡片的数字对上号。

/** 纵轴参考线（百分比）。纵轴固定 0..100，所以只有 100% / 50% 两条参考线 + 底边 */
const GRID = [100, 50]

/** 图区尺寸。viewBox + CSS 宽度自适应；坐标换算全部交给 usageHistory 的纯函数 */
const VB_W = 320
const VB_H = 76

/** 柱宽上限：天数少时（刚装 2 天）别让一根柱占满整幅图 */
const BAR_MAX = 14

/** 可见天数选项。7 / 30 共用**同一份**已取回的历史（切换不发请求） */
const DAY_CHOICES = [7, 30] as const

// ─── 面板（取数已在上游完成，这里只管显示与切换）──────────────────────────────

/**
 * 趋势图区块：窗口切换 + 天数切换 + 图。
 *
 * ⚠ **切换不发 IPC**：历史一次取回 30 天（design.md D4），两个视图都从这份数组里切。
 *   快照文件每 15 分钟才动一次，而切换会频繁发生 —— 把 IPC 往返放在切换路径上是本末倒置。
 *
 * ⚠ **默认画主窗口**（`primaryWindow`），其余窗口给切换控件。不做三窗口叠画：5H 窗口
 *   在 7 天内重置 33 次，叠画出来是锯齿，用户看不出「哪条线是本月用量」。
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

// ─── 图 ───────────────────────────────────────────────────────────────────────

/**
 * 每天一根柱的趋势图。
 *
 * ⚠ `buckets` 为空 → **返回 null**（界面上什么都不显示）。历史为空、`usage:predict` 返回
 *   `{}`、余额类根本没请求 —— 这三种情况下详情页少一个区块，比多一个「暂无数据」的
 *   占位块诚实。
 *
 * ⚠ `lastPct === null` 的天**不画柱**（该天没采到可用数值）。缺口可见 = 用户知道那天
 *   应用没跑；填 0 补齐反而会让他以为「那几天用量是 0」，并据此得出错误结论。
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

  const slots = buckets.length
  // 单根柱时铺满（避免 30 天空档只有一根柱子孤零零），多根时每槽留 1px 缝
  const barW = Math.min(BAR_MAX, (slots > 1 ? VB_W / slots : VB_W) - 1)
  const hasBar = buckets.some((b) => b.lastPct != null)

  return (
    <div className="trend" data-window={windowName} data-days={slots}>
      <svg
        className="trend-chart"
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${windowName} 每天末值用量趋势，共 ${slots} 天`}
      >
        {GRID.map((p) => (
          <line
            key={p}
            className="trend-grid"
            x1={0}
            x2={VB_W}
            y1={round1(scaleY(p, VB_H))}
            y2={round1(scaleY(p, VB_H))}
          />
        ))}
        {buckets.map((b, i) => {
          // 缺样本 / 全 null 的天不画柱：缺口可见
          if (b.lastPct == null) return null
          const y = scaleY(b.lastPct, VB_H)
          return (
            <rect
              key={b.day}
              className={`trend-bar lvl-${levelOfPercent(b.lastPct, 'ok')}`}
              x={round1(xOf(i, slots, VB_W) - barW / 2)}
              y={round1(y)}
              width={round1(barW)}
              height={round1(VB_H - y)}
            >
              <title>{`${b.day} 末值 ${fmtPercent(b.lastPct)}`}</title>
            </rect>
          )
        })}
      </svg>
      {hasBar ? (
        <div className="trend-axis">
          <span>{buckets[0].day.slice(5)}</span>
          <span className="trend-scale">纵轴 0–100% · 每根柱 = 当天末值</span>
          <span>{buckets[slots - 1].day.slice(5)}</span>
        </div>
      ) : (
        /* 桶在但一天都没读出百分比：这与「没有历史」是**两回事**，所以给一句实话，
           而不是画一张空图（空图看起来像「这 30 天用量都是 0」）。 */
        <div className="trend-axis">
          <span className="trend-scale">这段时间采到了，但没有读到可用数值</span>
        </div>
      )}
    </div>
  )
}

/** 坐标取一位小数：SVG 属性里写 12.800000000000001 不会报错，但会让 DOM 体积暴涨 */
function round1(v: number): number {
  return Math.round(v * 10) / 10
}