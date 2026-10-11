import type React from 'react'
import { useState } from 'react'
import type { ProviderWindow, UsageBucket } from '../../shared/types'
import type { UsagePoint } from '../../shared/usage-predict'
import { fmtAmount } from './format'
import { windowsWithHistory } from './usageHistory'
import {
  granularityOf,
  localSeriesNodes,
  maxCostOf,
  nodeLabel,
  officialSeriesNodes,
  type SeriesNode
} from './seriesView'

// ═══════════════════════════════════════════════════════════════════════════════
// 详情页「用量趋势」—— 窗口驱动的序列视图（2026-10-11 重构）
//
// 与之前的两版都不同：
//   · 2026-10-07：GitHub 式日历热力图（列=周、行=星期、颜色=当天日增量）
//   · 现在：**跟随左侧用量窗口的序列** —— 5 小时窗口画逐小时柱，本周/本月画逐日柱。
//     右侧的「7 天 / 30 天」切换删除（它就是旧口径的残留，与新窗口联动冲突）。
//
// 数据源优先级（口径诚实）：
//   ① 官方 `usage/cost-by-day`（快照 `seriesByWindow[窗口名]`）—— 标题标「官方」；
//   ② 官方拿不到该窗口序列（key 缺失）→ 退回本机 `usagePredict` 历史，标「本机估算」。
//      官方给了空数组是「该窗口无用量」，**不**退回（那会把「确认没用」误标成本机估算）。
//
// 旧热力图的纯函数模块（`usageHeatmap.ts` + `placeDays`）随接线一起退役删除，不留死代码。
// ═══════════════════════════════════════════════════════════════════════════════

/** 图表几何（viewBox 坐标；SVG 宽度 100% 自适应卡片宽） */
const VB_W = 320
const PAD = 6
const PLOT_H = 92
const AXIS_H = 15

/** 图表：窗口驱动的柱状序列。日桶 = 细柱，小时桶 = 宽列。 */
export function SeriesChart({
  nodes,
  windowName
}: {
  nodes: SeriesNode[]
  windowName: string
}): React.JSX.Element | null {
  if (nodes.length === 0) return null
  const gran = granularityOf(windowName)
  const max = maxCostOf(nodes)
  const N = nodes.length
  const innerW = VB_W - PAD * 2
  const slot = innerW / N
  const barW = Math.max(2, Math.min(gran === 'hour' ? 30 : 12, slot * 0.62))
  const baseline = PLOT_H
  // 轴标签密度：小时桶全标（≤24，5 小时窗口通常 ≤6），日桶最多 6 个
  const step = gran === 'hour' ? Math.max(1, Math.ceil(N / 8)) : Math.max(1, Math.ceil(N / 6))

  return (
    <div className="trend" data-window={windowName} data-bucket={gran}>
      <svg
        className="trend-chart"
        viewBox={`0 0 ${VB_W} ${PLOT_H + AXIS_H}`}
        width="100%"
        role="img"
        aria-label={`${windowName} 用量趋势，共 ${N} 个${gran === 'hour' ? '小时' : '日'}节点，柱高表示该节点花费`}
      >
        <line className="trend-axis" x1={PAD} y1={baseline} x2={VB_W - PAD} y2={baseline} />
        {nodes.map((n, i) => {
          const x = PAD + i * slot + (slot - barW) / 2
          const h = n.cost != null && max > 0 ? Math.max(1.5, (n.cost / max) * (PLOT_H - 6)) : 0
          const y = baseline - h
          const showLabel = i % step === 0 || i === N - 1
          return (
            <g key={n.t}>
              {/* 已知花费才画柱；未知（本机首桶无基准）留空 —— 缺口可见，不补 0 */}
              {h > 0 && (
                <rect
                  className={`trend-bar${n.cost === max && max > 0 ? ' peak' : ''}`}
                  x={x}
                  y={y}
                  width={barW}
                  height={h}
                  rx={Math.min(2.5, barW / 2)}
                >
                  <title>{nodeTitle(n)}</title>
                </rect>
              )}
              {showLabel && (
                <text className="trend-axis-label" x={PAD + i * slot + slot / 2} y={PLOT_H + 11} textAnchor="middle">
                  {n.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <div className="trend-legend">
        <span>
          柱高 ∝ 该{gran === 'hour' ? '小时' : '日'}花费 · 悬停看 tokens / 请求数
        </span>
        {gran === 'hour' && nodes.length > 0 && (
          <span>{nodeLabel(nodes[0].t, 'hour')} → {nodeLabel(nodes[nodes.length - 1].t, 'hour')}</span>
        )}
      </div>
      <SeriesRecords nodes={nodes} />
    </div>
  )
}

function nodeTitle(n: SeriesNode): string {
  const parts = [n.label]
  parts.push(n.cost != null ? `用量 ${fmtAmount(n.cost, 'usd')}` : '用量 —')
  if (n.tokens > 0) parts.push(`tokens ${fmtAmount(n.tokens, 'token')}`)
  if (n.requests > 0) parts.push(`${n.requests} 次请求`)
  return parts.join(' · ')
}

/**
 * 记录表：节点 / 用量 / tokens / 请求数。**新近优先**（与旧明细一致，查账先看今天）。
 * 未知值显示「—」，不写 0（0 是一个断言）。
 */
export function SeriesRecords({ nodes }: { nodes: SeriesNode[] }): React.JSX.Element | null {
  if (nodes.length === 0) return null
  const rows = nodes.slice().reverse()
  return (
    <div className="trend-records" role="table" aria-label="分窗口用量明细">
      <div className="trend-records-head" role="row">
        <span role="columnheader">时间节点</span>
        <span role="columnheader">用量</span>
        <span role="columnheader">tokens</span>
        <span role="columnheader">请求数</span>
      </div>
      {rows.map((n) => (
        <div key={n.t} className="trend-records-row" role="row">
          <span className="trend-records-date" role="cell">
            {n.label}
          </span>
          <span className="trend-records-used" role="cell">
            {n.cost != null ? fmtAmount(n.cost, 'usd') : '—'}
          </span>
          <span className="trend-records-tokens" role="cell">
            {n.tokens > 0 ? fmtAmount(n.tokens, 'token') : '—'}
          </span>
          <span className="trend-records-req" role="cell">
            {n.requests > 0 ? String(n.requests) : '—'}
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── 面板（取数已在上游完成，这里只管显示与窗口切换）──────────────────────────

/**
 * 用量趋势区块：窗口切换 + 序列图 + 记录表。
 *
 * ⚠ **切换不发 IPC**：官方序列与本机历史都在快照 / 已取回的数据里，切换纯前端。
 *   快照每 15 分钟才动一次，把 IPC 往返放在切换路径上是本末倒置。
 *
 * ⚠ **窗口列表来自 `s.windows`**（不再是「有本机历史的窗口」）：这样三窗口都在，
 *   与上方「用量窗口」一一对应。可切换的判据是「有官方序列 **或** 有本机历史」。
 *
 * 没有可展示的节点 → 返回 null（界面上什么都不显示，不是空壳）。
 */
export function TrendPanel({
  windows,
  seriesByWindow,
  pointsByWindow,
  primaryWindowName,
  now
}: {
  windows: ProviderWindow[]
  seriesByWindow?: Record<string, UsageBucket[]>
  pointsByWindow: Record<string, UsagePoint[]>
  primaryWindowName: string | undefined
  now: number
}): React.JSX.Element | null {
  const [picked, setPicked] = useState<string | null>(null)

  const nodesFor = (name: string): SeriesNode[] => {
    const official = seriesByWindow?.[name]
    if (official != null) return officialSeriesNodes(official)
    return localSeriesNodes(pointsByWindow[name] ?? [], name, now)
  }

  // 可切换的窗口：有官方序列 key（空数组也算 —— 那是官方确认无用量）或有本机历史。
  // 本机那半边用 windowsWithHistory（纯函数，与旧版同一判据：空数组不算「有历史」）。
  const withLocal = new Set(windowsWithHistory(pointsByWindow))
  const available = windows
    .map((w) => w.name)
    .filter((n) => seriesByWindow?.[n] != null || withLocal.has(n))
  // 判据是「能画出至少一根已知花费的柱」：本机兜底只有 1 个采样点时，所有桶的 cost 都是
  // null —— 此时画一个没有柱的空坐标系，比什么都不显示更像坏了。整个区块这时返回 null。
  const hasKnownCost = (nodes: SeriesNode[]): boolean => nodes.some((n) => n.cost != null)
  if (!available.some((n) => hasKnownCost(nodesFor(n)))) return null

  const active =
    picked && available.includes(picked)
      ? picked
      : primaryWindowName && available.includes(primaryWindowName)
        ? primaryWindowName
        : available[0]

  const official = seriesByWindow?.[active]
  const source = official != null ? 'official' : 'local'
  const nodes = nodesFor(active)

  return (
    <section className="section">
      <div className="section-title">
        用量趋势
        <em className={`tag ${source === 'official' ? 'env' : 'local'}`}>
          {source === 'official' ? '官方' : '本机估算'}
        </em>
      </div>
      {available.length > 1 && (
        <div className="trend-switch">
          <span className="trend-switch-group" role="group" aria-label="切换用量窗口">
            {available.map((w) => (
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
        </div>
      )}
      {nodes.length > 0 ? (
        <SeriesChart nodes={nodes} windowName={active} />
      ) : (
        // 官方确认该窗口无用量（key 在但为空）—— 说一句实话，不画空图
        <div className="trend">
          <div className="trend-legend">
            <span>{active} · 该窗口暂无用量</span>
          </div>
        </div>
      )}
    </section>
  )
}
