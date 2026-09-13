import type React from 'react'
import type { Level } from './format'
import { fmtPercent } from './format'

// 展示型基础组件：环形进度、细进度条、状态点、内联矢量图标。
// 图标全部内联 SVG（离线可用、随主题着色、无 emoji）。

export function Ring({ pct, lvl, size = 68, stroke = 6, dim = false }: { pct: number; lvl: Level; size?: number; stroke?: number; dim?: boolean }): React.JSX.Element {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const clamped = Math.min(100, Math.max(0, pct))
  return (
    <div className={`ring lvl-${lvl}${dim ? ' dim' : ''}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} aria-hidden="true">
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
        <circle
          className="ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${(c * clamped) / 100} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="ring-text">{fmtPercent(clamped)}</span>
    </div>
  )
}

export function MiniBar({ pct, lvl }: { pct: number; lvl: Level }): React.JSX.Element {
  return (
    <span className="mini-bar" aria-hidden="true">
      <span className={`mini-fill lvl-${lvl}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </span>
  )
}

export function Bar({ pct, lvl }: { pct: number; lvl: Level }): React.JSX.Element {
  return (
    <div className="bar" aria-hidden="true">
      <div className={`bar-fill lvl-${lvl}`} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  )
}

export function StatusDot({ lvl }: { lvl: Level }): React.JSX.Element {
  return <span className={`dot lvl-${lvl}`} aria-hidden="true" />
}

// ─── 内联矢量图标（Lucide 风格，24×24 线性）─────────────────────────────────

type IconName =
  | 'refresh'
  | 'settings'
  | 'collapse'
  | 'expand'
  | 'back'
  | 'plus'
  | 'trash'
  | 'edit'
  | 'chevron'
  | 'close'
  | 'check'
  | 'lightning'
  | 'spark'
  | 'history'
  | 'flask'
  | 'wifiOff'

const PATHS: Record<IconName, React.JSX.Element> = {
  refresh: (
    <>
      <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" />
      <path d="M3 21v-5h5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>
  ),
  collapse: <path d="M5 12h14" />,
  expand: (
    <>
      <path d="M8 3v3a2 2 0 0 1-2 2H3" />
      <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
      <path d="M3 16h3a2 2 0 0 1 2 2v3" />
      <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
    </>
  ),
  back: (
    <>
      <path d="M15 18l-6-6 6-6" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </>
  ),
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  chevron: <path d="M6 9l6 6 6-6" />,
  close: (
    <>
      <path d="M18 6L6 18" />
      <path d="M6 6l12 12" />
    </>
  ),
  check: <path d="M20 6L9 17l-5-5" />,
  lightning: <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />,
  spark: (
    <>
      <path d="M12 3v4" />
      <path d="M12 17v4" />
      <path d="M3 12h4" />
      <path d="M17 12h4" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 2.6-6.4L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7.5V12l3 1.8" />
    </>
  ),
  flask: (
    <>
      <path d="M10 2v6.4" />
      <path d="M14 8.5V2" />
      <path d="M8.5 2h7" />
      <path d="M14 8.6a6.5 6.5 0 1 1-4 0" />
      <path d="M5.6 16h12.8" />
    </>
  ),
  wifiOff: (
    <>
      <path d="M12 20h.01" />
      <path d="M8.5 16.4a5 5 0 0 1 7 0" />
      <path d="M5 12.9a10 10 0 0 1 5.2-2.7" />
      <path d="M19 12.9a10 10 0 0 0-2-1.5" />
      <path d="M2 8.8a15 15 0 0 1 4.2-2.6" />
      <path d="M22 8.8a15 15 0 0 0-11.3-3.8" />
      <path d="m2 2 20 20" />
    </>
  )
}

export function Icon({ name, size = 16, className = '' }: { name: IconName; size?: number; className?: string }): React.JSX.Element {
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}

export function IconButton({
  name,
  title,
  onClick,
  className = ''
}: {
  name: IconName
  title: string
  onClick?: (e: React.MouseEvent) => void
  className?: string
}): React.JSX.Element {
  return (
    <button type="button" className={`icon-btn ${className}`} title={title} aria-label={title} onClick={onClick}>
      <Icon name={name} />
    </button>
  )
}
