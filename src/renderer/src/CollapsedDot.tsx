import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, ProviderSnapshot } from '../../shared/types'
import { fmtAmount, fmtPercent, windowPercent, levelOfPercent, dataTime, isStale, type Level } from './format'
import { Icon } from './components'

// 收起态圆点（56×56）：环形仪表 + 中心数值。
// 设计依据：单一 KPI 对目标值 → 环形 gauge；数字置于环心（小尺寸下最易读）。
// 多供应商时按「严重度」排序后轮播（最接近限额的优先出现），底部细圆点指示位置。
// >8px 判拖拽，否则点击展开。

/** 余额类金额的紧凑写法（万元以下保留两位，保证圆点内可读且不失真） */
function compactAmount(v: number, unit: 'usd' | 'cny' | 'token' | 'request' | 'percent'): string {
  switch (unit) {
    case 'usd':
      return '$' + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v >= 100 ? v.toFixed(0) : v.toFixed(2))
    case 'cny':
      return '¥' + (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v >= 100 ? v.toFixed(0) : v.toFixed(2))
    case 'token':
      return fmtAmount(v, 'token')
    default:
      return String(Math.round(v))
  }
}

/** 严重度排序：危险 > 警告 > 正常 > 无数据（最需要关注的排前面） */
function severity(s: ProviderSnapshot): number {
  if (s.status === 'error') return 3
  if (s.status === 'nodata') return 4
  const pcts = s.windows.map(windowPercent).filter((p): p is number => p != null)
  if (!pcts.length) return 2
  const max = Math.max(...pcts)
  return max >= 85 ? 0 : max >= 60 ? 1 : 2
}

function dotLevel(s: ProviderSnapshot | undefined): Level {
  if (!s) return 'muted'
  if (s.status === 'error') return 'danger'
  if (s.status !== 'ok') return 'muted'
  const pcts = s.windows.map(windowPercent).filter((p): p is number => p != null)
  if (!pcts.length) return 'ok'
  return levelOfPercent(Math.max(...pcts), 'ok')
}

export function CollapsedDot({ onExpand }: { onExpand: () => void }): React.JSX.Element {
  const [state, setState] = useState<AppState>({ snapshots: [], lastSync: null, scanning: false })
  const [idx, setIdx] = useState(0)
  const press = useRef({ down: false, moved: false, x: 0, y: 0 })

  useEffect(() => {
    void window.api.getState().then(setState)
    return window.api.onState(setState)
  }, [])

  // 按严重度排序：最接近限额的排最前（轮播第一帧即最重要信息）
  const snaps = useMemo(
    () => [...state.snapshots].sort((a, b) => severity(a) - severity(b)),
    [state.snapshots]
  )
  const count = snaps.length

  useEffect(() => {
    if (count <= 1) return
    const t = setInterval(() => setIdx((i) => (i + 1) % count), 5000)
    return () => clearInterval(t)
  }, [count])

  const s: ProviderSnapshot | undefined = count ? snaps[idx % count] : undefined

  const startDrag = (): void => {
    press.current.moved = true
    window.api.dragStart()
  }
  const onPointerDown = (e: React.PointerEvent): void => {
    press.current = { down: true, moved: false, x: e.clientX, y: e.clientY }
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      // 合成事件/无效 pointerId 时忽略
    }
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    if (!press.current.down || press.current.moved) return
    if (Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 8) startDrag()
  }
  const finish = (cancel = false): void => {
    if (!press.current.down) return
    const wasMoved = press.current.moved
    press.current = { down: false, moved: false, x: 0, y: 0 }
    if (wasMoved || cancel) window.api.dragEnd()
    else onExpand()
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      // 忽略
    }
    finish()
  }
  const onPointerCancel = (): void => finish(true)

  const lvl = dotLevel(s)
  // 取「最接近限额」的窗口作为圆点主指标：数值与颜色一致，且是用户最关心的那个
  const worst = useMemo(() => {
    if (!s || s.status !== 'ok' || s.windows.length === 0) return undefined
    let best: (typeof s.windows)[number] | undefined
    let bestPct = -1
    for (const w of s.windows) {
      const p = windowPercent(w)
      if (p != null && p > bestPct) {
        bestPct = p
        best = w
      }
    }
    return best ?? s.windows[0]
  }, [s])

  const pct = worst ? windowPercent(worst) : null

  // 中心数值：套餐类显示百分比（有小数则带小数），余额类显示紧凑金额
  let value = '…'
  if (s) {
    if (s.status === 'error') value = '!'
    else if (s.status === 'nodata') value = '—'
    else if (pct != null) value = fmtPercent(pct)
    else if (worst) value = compactAmount(worst.used, worst.unit)
    else value = '—'
  }

  // 环形几何：半径 22（56 视野内留 6px 边距），周长供 dasharray 使用
  const r = 22
  const c = 2 * Math.PI * r
  const filled = pct != null ? Math.min(100, Math.max(0, pct)) : 0

  return (
    <button
      type="button"
      className={`dot-btn lvl-${lvl}${isStale(s ?? {}) ? ' stale' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      title={
        s
          ? `${s.name}${pct != null ? ` · ${fmtPercent(pct)}` : ''}${isStale(s) ? `（${s.dataQuality === 'cached' ? '缓存数据 · ' + (dataTime(s) ? new Date(dataTime(s)!).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '') : '本机估算'}）` : ''} · 点击展开`
          : '点击展开'
      }
    >
      <svg className="dot-ring" viewBox="0 0 56 56" aria-hidden="true">
        <circle className="dot-ring-track" cx="28" cy="28" r={r} fill="none" strokeWidth={5} />
        {pct != null && (
          <circle
            className="dot-ring-fill"
            cx="28"
            cy="28"
            r={r}
            fill="none"
            strokeWidth={5}
            strokeLinecap="round"
            strokeDasharray={`${(c * filled) / 100} ${c}`}
            transform="rotate(-90 28 28)"
          />
        )}
      </svg>
      <span className={`dot-value${value.length > 4 ? ' small' : ''}`}>{value}</span>
      {isStale(s ?? {}) && (
        <span className="dot-badge" aria-hidden="true">
          <Icon name={s?.dataQuality === 'local' ? 'flask' : 'history'} size={9} />
        </span>
      )}
      {count > 1 && (
        <span className="dot-pager" aria-hidden="true">
          {snaps.map((_, i) => (
            <i key={i} className={i === idx % count ? 'on' : ''} />
          ))}
        </span>
      )}
    </button>
  )
}
