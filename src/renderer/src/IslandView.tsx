import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderInfo, ProviderSnapshot, ProviderWindow } from '../../shared/types'
import { ISLAND_VIEW } from '../../shared/pet-view'
import { isPlan } from '../../shared/quality'
import { defaultWaterAnchors, resolveWaterAnchors, waterColor, type WaterAnchors } from '../../shared/water-color'
import { shortWindowLabel } from '../../shared/tray-text'
import { orderForDisplay, snapshotLevel, windowLevel, worstWindow } from './read-model'
import { Bar, Ring, StatusDot } from './components'
import { ProviderMark } from './ProviderMark'
import {
  fmtAmount,
  fmtPercent,
  humanDur,
  isStale,
  levelOfPercent,
  staleLabel,
  windowPercent,
  type Level
} from './format'

// 顶部灵动岛（10-10-dynamic-island）：收起态的唯一形态，水球已退役。
//
//   · 收起：平铺全部启用的供应商 —— plan 家嵌套用量环（外→内 = 窗口顺序，
//     最多 3 环）+ 中央真实 logo，无名称、无轮询；balance 家 logo + 金额。
//     超长岛身自动加长（fit-content，上限后横滑）；缺失值保持缺失（灰环 `--`）。
//   · 展开：点击岛身弹簧 pop 出 2 列卡片（各家多窗口明细 + 余额卡），只读；
//     点击空白收起；双击 /「展开面板」回到卡片视图。
//   · 隐藏：dwell 时序沿用 dockHide（1s 藏 / 300ms 唤 / 1.5s 重藏），隐藏态缩成
//     A 式 mini-pill（窄条 + 各家等级点，顶部原位收缩）；唤出 = 点击 pill。
//   · 位置：顶栏内左右拖动（岛身，落盘 `ui:islandX` 0..1，与 `ui:*` 偏好同机制）；
//     岛边缘 rim / 命中层空白拖 = 主进程窗口拖拽（R7 拖拽分区，CLICK_SLOP 内算点击）；
//     容器深黑独立文件不跟换皮，嵌套环色跟皮肤水色锚点（`.app` 计算样式 +
//     data-skin 监听，与 PetBall 同路；等级点保持语义色）。
//
// 单文件命名导出、无 children、返回 React.JSX.Element；>5 props 用具名接口。
// 命中测试走主进程 `pet:hitbox`，渲染层只报几何；控件用 `title` 不用 aria。
// ═══════════════════════════════════════════════════════════════════════════════

/** 岛内横向位置落盘键（0..1，相对窗口宽；Y 恒定吸顶不存） */
const ISLAND_X_KEY = 'ui:islandX'
/** 圆环统一尺寸（PRD：收起嵌套环与展开主环都是 40px） */
const RING_SIZE = 40
/** 顶栏内拖动范围（两侧留边，不贴死窗口边） */
const POS_MIN = 0.08
const POS_MAX = 0.92
/** 点击与拖动的位移分界（prototype：移动 <6px 算点击展开/收起） */
const CLICK_SLOP = 6
/**
 * 拖拽分区带宽：落点距岛边不足此像素 = 移窗区（抓边框移动窗口），
 * 岛身内部 = 岛内区（顶栏内调 posX）。命中层空白（岛框之外）同样走移窗。
 */
const EDGE_PX = 10
/** 命中分区：'body' = 岛身（调 posX），'edge' = 边缘/空白（主进程移窗） */
type DragZone = 'body' | 'edge'

/**
 * 读当前皮肤的水色锚点（与 PetBall.readWaterAnchors 同一路胶水，shared 不碰 DOM）。
 * 令牌落在 `.app` 上，不在 body（写错位置会形成继承屏障，读到 :root 旧值）；
 * 读不到/解析失败 → 缺省三色：环退化成"阈值处仍对"的静态色，不断裂；
 * 缺失值（pct == null）仍走灰环 `#636366` + `--`，与锚点无关。
 */
function readWaterAnchors(): WaterAnchors {
  try {
    const app = document.querySelector('.app')
    if (!app) return defaultWaterAnchors()
    const cs = getComputedStyle(app)
    return resolveWaterAnchors((n) => cs.getPropertyValue(n)) ?? defaultWaterAnchors()
  } catch {
    return defaultWaterAnchors()
  }
}

export interface IslandViewProps {
  /** 全部快照（App state.snapshots；可见口径 = 启用实例，见 ordered） */
  snapshots: ProviderSnapshot[]
  /** 实例身份（providers:list：启用开关与展示顺序的唯一真相源） */
  instanceInfo: ProviderInfo[]
  /** 余额打码（ui:hideBalance，跨收起态共享） */
  hideBalance: boolean
  /** 是否已缩成 mini-pill（主进程 dock:hidden 推，此时单击 = 唤出） */
  dockHidden: boolean
  /** 流体相位 + 贴边（主进程 dock:fluid 推，只切呈现类，不算几何） */
  fluidPhase?: string
  fluidEdge?: string | null
  /** 回到卡片视图（双击岛身 / 展开态「展开面板」/ 右键菜单 Expand） */
  onExpand: () => void
  /** 右键菜单：交给主进程弹原生菜单，返回被选中的 action */
  onMenu: () => Promise<string | null>
  /** 语音提醒的视觉通知文案（'' = 无；与确认气泡同位，确认优先） */
  notice?: string
  /** 待确认预警原文（'' = 无）；倒计时分钟数与确认回调与 PetBall 同源 */
  alertText?: string
  alertMinutes?: number
  onConfirmAlert?: () => void
}

/** 嵌套用量环：外→内 = windows[0..2]，最多 3 环；无可比窗口时灰环 `--` */
function NestedRings({ s, size = RING_SIZE }: { s: ProviderSnapshot; size?: number }): React.JSX.Element {
  const wins = s.windows.slice(0, 3)
  // 实时皮肤水色锚点（10-10-island-fixes R3，与 PetBall.readWaterAnchors 同路：
  // 令牌落在 `.app` 上 + data-skin MutationObserver；读不到 → 缺省三色。
  // 等级点（isl-dot）保持语义 lvl-* 色，不走这里；容器深黑不动。）
  const [anchors, setAnchors] = useState<WaterAnchors>(() => readWaterAnchors())
  useEffect(() => {
    const app = document.querySelector('.app')
    if (!app) return
    const mo = new MutationObserver(() => setAnchors(readWaterAnchors()))
    mo.observe(app, { attributes: true, attributeFilter: ['data-skin'] })
    return () => mo.disconnect()
  }, [])
  const pcts = wins.map((w) => windowPercent(w))
  const lvls = wins.map((w) => levelOfPercent(windowPercent(w), s.status))
  // 半径档：外→内逐层收（40 viewBox 下 17 / 12.5 / 8），线宽 3.2
  const radii = [17, 12.5, 8]
  return (
    <svg className="isl-rings" width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r={17} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth={3.2} />
      {pcts.map((p, i) => {
        const lvl = lvls[i] ?? 'muted'
        const stroke = p == null ? '#636366' : waterColor(p, anchors)
        return (
          <circle
            key={i}
            cx="20"
            cy="20"
            r={radii[i] ?? 8}
            fill="none"
            stroke={stroke}
            strokeWidth={3.2}
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${p == null ? 0 : Math.min(100, Math.max(0, p)).toFixed(2)} 100`}
            transform="rotate(-90 20 20)"
            data-lvl={lvl}
          />
        )
      })}
    </svg>
  )
}

/** 供应商在岛上的等级（mini-pill 等级点与 combo 高亮同源） */
function islandLevel(s: ProviderSnapshot): Level {
  if (s.status === 'error') return 'danger'
  if (s.status !== 'ok') return 'muted'
  return snapshotLevel(s)
}

export function IslandView({
  snapshots,
  instanceInfo,
  hideBalance,
  dockHidden,
  fluidPhase = 'edge-visible',
  fluidEdge = null,
  onExpand,
  onMenu,
  notice,
  alertText,
  alertMinutes = 0,
  onConfirmAlert
}: IslandViewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const press = useRef({
    down: false,
    moved: false,
    x: 0,
    y: 0,
    basePos: 0.5,
    zone: 'body' as DragZone,
    winDragging: false
  })
  /** 展开态（内存态，不落盘；隐藏时强制收起） */
  const [open, setOpen] = useState(false)
  /** 顶栏内横向位置（0..1；落盘 ui:islandX，缺省 0.5 居中） */
  const [posX, setPosX] = useState(0.5)
  /** 展开态重置倒计时的显示时钟（15s 粒度，与 CardView 同口径） */
  const [now, setNow] = useState(Date.now())

  // 展示列表 = 启用的供应商（注册表 enabled 口径；注册表未到 / 快照不在表内时不过滤，
  // 空集过滤会把每一家都滤掉 —— 与 CardView 的 shown 兜底同一条纪律）。
  const ordered = useMemo(() => {
    if (!snapshots.length) return []
    if (!instanceInfo.length) return [...snapshots]
    const seq = orderForDisplay(instanceInfo)
    const rank = new Map(seq.map((id, i) => [id, i] as const))
    const enabled = new Map(instanceInfo.map((p) => [p.id, p.enabled !== false] as const))
    const BIG = 1e9
    return [...snapshots]
      .filter((s) => enabled.get(s.id) !== false)
      .sort((a, b) => (rank.get(a.id) ?? BIG) - (rank.get(b.id) ?? BIG))
  }, [snapshots, instanceInfo])

  // 位置落盘读回（extras:get 对缺失键给 ''，判 !v 不判 == null）
  useEffect(() => {
    let cancelled = false
    void window.api
      .getExtras([ISLAND_X_KEY])
      .then((e) => {
        if (cancelled) return
        const n = Number.parseFloat(e[ISLAND_X_KEY] ?? '')
        if (Number.isFinite(n)) setPosX(Math.min(POS_MAX, Math.max(POS_MIN, n)))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // 展开态才走倒计时（收起态无倒计时文案，不挂空转定时器）
  useEffect(() => {
    if (!open) return
    const t = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(t)
  }, [open ])

  // 隐藏时强制收起展开态（pill 上没有可读内容，直接唤出）
  useEffect(() => {
    if (dockHidden) setOpen(false)
  }, [dockHidden])

  // 测试钩子：__bd_island 读展开/位置/家数（纯数据，可结构化克隆）
  useEffect(() => {
    const w = window as unknown as { __bd_island?: () => unknown }
    w.__bd_island = () => ({ open, posX, count: ordered.length })
    return () => {
      delete w.__bd_island
    }
  }, [open, posX, ordered.length])

  // 点击穿透：把岛 / pill / 展开卡的实测矩形报给主进程（窗口其余区域穿透到桌面）
  const reportHit = useCallback(() => {
    const host = hostRef.current
    const hw = host?.clientWidth || ISLAND_VIEW.width
    const hh = host?.clientHeight || ISLAND_VIEW.height
    const el = bodyRef.current
    if (!el || !host) {
      window.api.setPetHitbox({ x: 0, y: 0, width: hw, height: Math.min(hh, 60) })
      return
    }
    const cb = el.getBoundingClientRect()
    const hb = host.getBoundingClientRect()
    if (cb.width <= 0 || hb.width <= 0) return
    window.api.setPetHitbox({
      x: cb.left - hb.left,
      y: cb.top - hb.top,
      width: cb.width,
      height: cb.height
    })
  }, [])

  useEffect(() => {
    reportHit()
    const t = window.setInterval(reportHit, 90)
    return () => window.clearInterval(t)
  }, [reportHit, open, posX, dockHidden, ordered.length])

  // 兜底：指针在窗口外抬起时复位按下态（否则残留态会让移动鼠标 = 拖岛）
  useEffect(() => {
    const onGlobalUp = (): void => resetPress()
    window.addEventListener('pointerup', onGlobalUp)
    window.addEventListener('pointercancel', onGlobalUp)
    window.addEventListener('blur', onGlobalUp)
    return () => {
      window.removeEventListener('pointerup', onGlobalUp)
      window.removeEventListener('pointercancel', onGlobalUp)
      window.removeEventListener('blur', onGlobalUp)
    }
    // resetPress 只碰 ref 与 window.api，不读 state —— 首帧闭包即终身有效
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 命中分区（R7 拖拽分区）：落点在岛身内部 = 岛内区（顶栏内调 posX），
   * 落在岛边缘 EDGE_PX 带内或岛框之外（命中层空白）= 移窗区（主进程窗口拖拽）。
   * 按坐标判，不按 target—— 合成事件的 target 是 .isl-hit，真实事件的 target
   * 是岛内元素，两者只有坐标可比。
   */
  const zoneOf = useCallback((x: number, y: number): DragZone => {
    const el = bodyRef.current
    if (!el) return 'edge'
    const rc = el.getBoundingClientRect()
    if (x < rc.left || x > rc.right || y < rc.top || y > rc.bottom) return 'edge'
    if (x - rc.left < EDGE_PX || rc.right - x < EDGE_PX || y - rc.top < EDGE_PX || rc.bottom - y < EDGE_PX)
      return 'edge'
    return 'body'
  }, [])

  /** 边缘拖：启动主进程窗口拖拽（抓取点 = 光标位置，不跳窗；调一次，重复调无意义） */
  const startWinDrag = useCallback((clientX: number, clientY: number): void => {
    if (press.current.winDragging) return
    press.current.winDragging = true
    window.api.dragStart({ x: clientX, y: clientY })
  }, [])

  const stopWinDrag = useCallback((): void => {
    if (!press.current.winDragging) return
    press.current.winDragging = false
    window.api.dragEnd()
  }, [])

  /** 复位指针状态（含主进程拖拽）：窗口外抬起、失焦、右键菜单、点击收尾时都要调用。
   * 主进程拖拽无条件停 —— 起过 winDrag 而收尾时不断开，主进程会一直跟光标走。 */
  const resetPress = useCallback((): void => {
    stopWinDrag()
    press.current = {
      down: false,
      moved: false,
      x: 0,
      y: 0,
      basePos: press.current.basePos,
      zone: 'body',
      winDragging: false
    }
  }, [stopWinDrag])

  const persistPos = (x: number): void => {
    void window.api.setExtras({ [ISLAND_X_KEY]: String(Math.round(x * 1000) / 1000) })
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    // 真实按钮（展开面板 / 确认）走自己的 onClick，不进拖拽/点击状态机 ——
    // 否则点按钮那一下会在 root 上起 press，抬起时再误触一次展开/收起
    if ((e.target as HTMLElement | null)?.closest?.('button')) return
    press.current = {
      down: true,
      moved: false,
      x: e.clientX,
      y: e.clientY,
      basePos: posX,
      zone: zoneOf(e.clientX, e.clientY),
      winDragging: false
    }
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      // 合成事件/无效 pointerId：忽略
    }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!press.current.down || dockHidden) return
    if ((e.buttons & 1) === 0) {
      resetPress()
      return
    }
    const dx = e.clientX - press.current.x
    if (!press.current.moved && Math.hypot(dx, e.clientY - press.current.y) <= CLICK_SLOP) return
    press.current.moved = true
    // 分区：岛身拖 = 顶栏内调 posX（仅收起态；展开态居中固定，拖即移窗）；
    // 边缘/空白拖 = 主进程窗口拖拽。CLICK_SLOP 内仍算点击（见 finishPress）。
    if (press.current.zone === 'body' && !open) {
      // 顶栏内左右拖动：位移按窗口宽折成 0..1（Y 恒定吸顶，不存）
      const hostW = hostRef.current?.clientWidth || ISLAND_VIEW.width
      setPosX(Math.min(POS_MAX, Math.max(POS_MIN, press.current.basePos + dx / hostW)))
    } else {
      startWinDrag(e.clientX, e.clientY)
    }
  }

  const finishPress = (cancel = false): void => {
    if (!press.current.down) return
    const wasMoved = press.current.moved
    const wasBody = press.current.zone === 'body' && !open
    // 边缘拖的 dragEnd 在这里调（resetPress 无条件停主进程拖拽）；岛身拖没起过，空操作
    resetPress()
    if (cancel) return
    if (wasMoved) {
      if (wasBody) persistPos(posX)
      return
    }
    // 单击（非拖）：隐藏态 = 唤出；可见态 = 切换展开/收起
    if (dockHidden) {
      window.api.dockReveal()
      return
    }
    setOpen((v) => !v)
  }

  const openMenu = async (e: React.MouseEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    resetPress()
    await onMenu()
    resetPress()
  }

  const fluid: string =
    fluidPhase === 'absorbing' || fluidPhase === 'hidden' || fluidPhase === 'revealing'
      ? fluidPhase
      : 'edge-visible'
  const edgeAttr = fluidEdge === 'right' || fluidEdge === 'top' || fluidEdge === 'bottom' ? fluidEdge : 'left'
  const mode: string = dockHidden ? 'hidden' : open ? 'open' : 'collapsed'

  const tooltip = dockHidden
    ? '灵动岛已隐藏 · 单击唤出 · 右键菜单'
    : open
      ? '点击空白收起 · 双击回到卡片'
      : ordered.length
        ? `${ordered.length} 家用量 · 单击展开明细 · 岛内拖动调位置（边缘拖移窗口）· 双击回到卡片 · 右键菜单`
        : '暂无数据 · 右键菜单'

  return (
    // 手势挂在根节点：.isl-hit 与 .isl-body 是兄弟，岛身事件冒泡到根但到不了 hit ——
    // 挂 hit 上真实输入永远收不到（此前只有合成事件能驱动拖动）。命中分区见 zoneOf。
    <div
      className="isl-root"
      ref={hostRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => {
        try {
          ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
        } catch {
          // 忽略
        }
        finishPress()
      }}
      onPointerCancel={() => finishPress(true)}
      onDoubleClick={(e) => {
        // 按钮上双击不回卡片：连点「好的」确认时会顺带切走视图，等于吞掉一次确认
        if ((e.target as HTMLElement | null)?.closest?.('button')) return
        if (!dockHidden) onExpand()
      }}
      onContextMenu={(e) => void openMenu(e)}
    >
      {/* 主体以外的窗口区域不接收鼠标：命中层只覆盖岛 / pill / 展开卡的范围 */}
      <div className="isl-hit" title={tooltip} />
      <div
        className={`isl-body lvl-${worstLevel(ordered)}${open ? ' open' : ''}`}
        ref={bodyRef}
        data-island={mode}
        data-fluid={fluid}
        data-edge={edgeAttr}
        style={open ? undefined : ({ left: `${(posX * 100).toFixed(1)}%` } as React.CSSProperties)}
      >
        {dockHidden ? (
          // A 式 mini-pill：窄条 + 各家等级点（顶部原位收缩，不贴边）
          <div className="isl-pill" title="灵动岛已隐藏 · 单击唤出">
            {ordered.length ? (
              ordered.map((s) => <span key={s.id} className={`isl-dot lvl-${islandLevel(s)}`} title={s.name} />)
            ) : (
              <span className="isl-dot lvl-muted" title="暂无数据" />
            )}
          </div>
        ) : open ? (
          <IslandOpen
            ordered={ordered}
            hideBalance={hideBalance}
            now={now}
            onBackdrop={() => setOpen(false)}
            onExpand={onExpand}
          />
        ) : (
          <div className="isl-strip">
            {ordered.length ? (
              ordered.map((s) =>
                isPlan(s) ? (
                  <span
                    key={s.id}
                    className={`isl-combo lvl-${islandLevel(s)}${isStale(s) ? ' stale' : ''}`}
                    data-supplier={s.id}
                    data-kind="plan"
                    data-lvl={islandLevel(s)}
                    title={`${s.name}${staleLabel(s) ? `（${staleLabel(s)}）` : ''}`}
                  >
                    <NestedRings s={s} />
                    <span className="isl-logo">
                      <ProviderMark mark={s.mark} size={22} glyph={14} />
                    </span>
                  </span>
                ) : (
                  <span
                    key={s.id}
                    className={`isl-combo bal lvl-${islandLevel(s)}${isStale(s) ? ' stale' : ''}`}
                    data-supplier={s.id}
                    data-kind="balance"
                    data-lvl={islandLevel(s)}
                    title={`${s.name}${staleLabel(s) ? `（${staleLabel(s)}）` : ''}`}
                  >
                    <ProviderMark mark={s.mark} size={22} glyph={14} />
                    <span className="isl-amount">{balanceText(s, hideBalance)}</span>
                  </span>
                )
              )
            ) : (
              <span className="isl-empty" title="暂无启用的供应商">
                暂无数据
              </span>
            )}
          </div>
        )}
      </div>
      {!dockHidden && !alertText && notice ? (
        <div className="isl-bubble" aria-hidden="true">
          {notice}
        </div>
      ) : null}
      {!dockHidden && alertText ? (
        // 确认条是气泡的兄弟节点（.isl-bubble 是 aria-hidden 纯装饰，交互元素不许藏进去）
        <div className="isl-confirm" role="status">
          <span className="isl-confirm-text">{alertText}</span>
          <span className="isl-confirm-foot">
            <span className="isl-confirm-eta" aria-hidden="true">
              {alertMinutes > 0 ? `${alertMinutes} 分钟后不再提示` : '即将不再提示'}
            </span>
            <button
              type="button"
              className="isl-confirm-btn"
              title="确认这条提醒，不再重复播报"
              aria-label="确认这条提醒，不再重复播报"
              onClick={() => onConfirmAlert?.()}
            >
              好的
            </button>
          </span>
        </div>
      ) : null}
    </div>
  )
}

/** 岛整体等级 = 各家中最严重的一档（环境辉光用；无数据时 muted） */
function worstLevel(snaps: ProviderSnapshot[]): Level {
  let worst: Level = 'muted'
  let seen = false
  for (const s of snaps) {
    const l = islandLevel(s)
    if (!seen) {
      worst = l
      seen = true
      continue
    }
    const rank: Record<Level, number> = { danger: 0, warn: 1, ok: 2, muted: 3 }
    if (rank[l] < rank[worst]) worst = l
  }
  return seen ? worst : 'muted'
}

/** 余额家 collapsed 金额（BalanceCard 口径：金额为主；打码只管读数） */
function balanceText(s: ProviderSnapshot, hide: boolean): string {
  if (s.status !== 'ok') return s.status === 'error' ? '!' : '—'
  const w: ProviderWindow | undefined = s.windows[0]
  if (!w) return '—'
  if (hide) return '••••'
  return fmtAmount(w.used, w.unit)
}

/** 展开态：2 列只读卡片（plan = 主环 + 各窗口单行条；balance = 大金额） */
function IslandOpen({
  ordered,
  hideBalance,
  now,
  onBackdrop,
  onExpand
}: {
  ordered: ProviderSnapshot[]
  hideBalance: boolean
  now: number
  onBackdrop: () => void
  onExpand: () => void
}): React.JSX.Element {
  return (
    <div className="isl-open" data-open={ordered.length}>
      <div className="isl-open-head">
        <span className="isl-open-hint" title="点击空白收起，双击回到卡片">
          点击空白收起 · 双击回到卡片 · {ordered.length} 家 · 主环 = 各家最满窗口
        </span>
        <button type="button" className="isl-open-expand" title="回到卡片视图" onClick={onExpand}>
          展开面板
        </button>
      </div>
      <div
        className="isl-backdrop"
        title="点击空白收起"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => {
          e.stopPropagation()
          onBackdrop()
        }}
      />
      <div className="isl-grid">
        {ordered.length ? (
          ordered.map((s) =>
            isPlan(s) ? (
              <PlanCell key={s.id} s={s} now={now} />
            ) : (
              <BalanceCell key={s.id} s={s} hide={hideBalance} />
            )
          )
        ) : (
          <div className="isl-cell">
            <span className="isl-cell-empty">暂无启用的供应商</span>
          </div>
        )}
      </div>
    </div>
  )
}

/** 展开态 plan 卡：主环（= 最满窗口）+ 各窗口单行条（名 · % · 重置倒计时） */
function PlanCell({ s, now }: { s: ProviderSnapshot; now: number }): React.JSX.Element {
  const main = worstWindow(s.status === 'ok' ? s : undefined)
  const mainPct = main ? windowPercent(main) : null
  const lvl = snapshotLevel(s)
  return (
    <div className="isl-cell" data-supplier={s.id} data-kind="plan" data-lvl={lvl}>
      <div className="isl-cell-top">
        <ProviderMark mark={s.mark} size={20} glyph={12} />
        <span className="isl-cell-name" title={s.name}>
          {s.name}
        </span>
        <StatusDot lvl={lvl} />
      </div>
      <div className="isl-cell-mid">
        {s.status === 'ok' && mainPct != null ? (
          <Ring pct={mainPct} lvl={lvl} size={RING_SIZE} stroke={4} />
        ) : (
          <span className="isl-cell-fallback" title={s.status === 'error' ? '出错' : '暂无用量'}>
            {s.status === 'error' ? '!' : '—'}
          </span>
        )}
        <div className="isl-wins">
          {s.windows.length ? (
            s.windows.map((w) => {
              const p = windowPercent(w)
              return (
                <div className="isl-win" key={w.name} data-win={w.name}>
                  <span className="isl-win-name">{shortWindowLabel(w.name)}</span>
                  <span className="isl-win-pct">{p != null ? fmtPercent(p) : '—'}</span>
                  <span className="isl-win-reset">
                    {w.resetAt ? `${humanDur(new Date(w.resetAt).getTime() - now)}后重置` : ''}
                  </span>
                  {p != null && <Bar pct={p} lvl={windowLevel(w)} />}
                </div>
              )
            })
          ) : (
            <span className="isl-win-empty">无窗口数据</span>
          )}
        </div>
      </div>
    </div>
  )
}

/** 展开态 balance 卡：大金额为主（BalanceCard 口径），有 limit 才附 Bar */
function BalanceCell({ s, hide }: { s: ProviderSnapshot; hide: boolean }): React.JSX.Element {
  const lvl = snapshotLevel(s)
  const w: ProviderWindow | undefined = s.windows[0]
  const active = s.status === 'ok' && !!w
  const pct = w ? windowPercent(w) : null
  return (
    <div className="isl-cell" data-supplier={s.id} data-kind="balance" data-lvl={lvl}>
      <div className="isl-cell-top">
        <ProviderMark mark={s.mark} size={20} glyph={12} />
        <span className="isl-cell-name" title={s.name}>
          {s.name}
        </span>
        <StatusDot lvl={lvl} />
      </div>
      <div className="isl-big">
        {active ? (
          hide ? (
            <span className="amount-hidden" aria-label="余额已隐藏">
              ••••
            </span>
          ) : (
            fmtAmount(w.used, w.unit)
          )
        ) : s.status === 'error' ? (
          '!'
        ) : (
          '—'
        )}
      </div>
      <div className="isl-sub">{active ? w.name : s.status === 'error' ? '连接失败' : '未配置'}</div>
      {active && pct != null && w.limit != null && <Bar pct={pct} lvl={lvl} />}
    </div>
  )
}
