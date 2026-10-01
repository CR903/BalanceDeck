import { ALL_GROUPS, distinguishSuffixes, displayName, groupOf, orderForDisplay, primaryWindowIndex, snapshotLevel, windowLevel } from './read-model'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AppState, ProviderInfo, ProviderSnapshot, ProviderWindow } from '../../shared/types'
import { shortWindowLabel } from '../../shared/tray-text'
import { isPlan } from '../../shared/quality'
import { Ring, Icon, IconButton, Bar, StatusDot } from './components'
import { ProviderMark } from './ProviderMark'
import {
  fmtAmount,
  windowPercent,
  levelOfPercent,
  humanDur,
  timeAgo,
  shortAgo,
  dataTime,
  isStale,
  staleLabel,
  type Level
} from './format'
import badgeIcon from './assets/icon.png?inline'

// 主页：所有「已启用且有数据」的供应商以卡片网格呈现，点击任一卡片进入详情。
// 卡片可拖拽排序（⌥←/⌥→ 亦可），顺序即优先级 —— 状态栏取第一位展示。

/** 数据可信度徽章（缓存 / 本机估算）；官方数据返回空 */
function QualityChip({ s }: { s: ProviderSnapshot }): React.JSX.Element | null {
  const label = staleLabel(s)
  if (!label) return null
  return (
    <span className={`qchip ${s.dataQuality}`} title={s.degradedReason ?? ''}>
      {s.dataQuality === 'cached' ? <Icon name="history" size={10} /> : <Icon name="flask" size={10} />}
      {label}
    </span>
  )
}

/**
 * 卡片上的组名标签（design.md D5b）。
 *
 * ⚗ 它与 `distinguishSuffixes` 的**名称后缀是两件不同的事**，不能合并：
 *   · 后缀区分「同名供应商的**不同实例**」（`Claude 公司` / `Claude 个人`）
 *   · 本标签表达「这个账户属于**哪一组**」（它可能是「公司」也可能是「个人」）
 *   两者会同时出现在一张卡上（`Claude 公司` + 标签「公司」）—— 看着冗余，但它们回答的
 *   是不同问题；而且同名实例**可能同组**，那时只有后缀、标签给不出任何区分。
 *
 * ⚗ `group` 为空串 = **不知道**（快照有、instanceInfo 里查不到该实例），此时**不渲染**。
 *   写「未分组」是撒谎：那是在声称一个我们并不知道的事实（它可能属于「公司」）。
 *   数据诚实优先于「每张卡都有标签」这种整齐。
 */
function GroupTag({ group }: { group: string }): React.JSX.Element | null {
  if (!group) return null
  return (
    <span className="pcard-group" title={`所属分组：${group}`}>
      {group}
    </span>
  )
}

/** 套餐卡（coding / token）：窗口切换 + 环形进度 + 用量 + 重置 */
function PlanCard({
  s,
  now,
  winIndex,
  suffix,
  group,
  onSelectWindow
}: {
  s: ProviderSnapshot
  now: number
  winIndex: number
  /** 同名多账号的区分后缀；空串 = 不加（不造假区分） */
  suffix: string
  /** 所属组名（空串 = 不知道，不渲染标签）—— 见 design.md D5b */
  group: string
  onSelectWindow: (name: string) => void
}): React.JSX.Element {
  const lvl = snapshotLevel(s)
  const idx = Math.min(Math.max(0, winIndex), Math.max(0, s.windows.length - 1))
  const w: ProviderWindow | undefined = s.windows[idx]
  const pct = w ? windowPercent(w) : null
  const isActive = s.status === 'ok' && pct != null
  const stale = isStale(s)
  const multi = s.windows.length > 1

  return (
    <>
      <span className="pcard-top">
        <ProviderMark mark={s.mark} size={22} />
        <span className="pcard-name">{displayName(s.name, suffix)}</span>
        <GroupTag group={group} />
        <StatusDot lvl={lvl} />
      </span>
      {multi && (
        <span className="pcard-wins" role="group" aria-label="切换用量窗口">
          {s.windows.map((win, i) => (
            <button
              key={win.name}
              type="button"
              className={
                'win-chip' +
                ` lvl-${windowLevel(win)}` +
                (i === idx ? ' on' : '')
              }
              title={`${win.name}${windowPercent(win) != null ? ` · ${windowPercent(win)}%` : ''}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onSelectWindow(win.name)
              }}
            >
              {shortWindowLabel(win.name)}
            </button>
          ))}
        </span>
      )}
      <span className="pcard-mid">
        {isActive ? (
          <Ring pct={pct!} lvl={lvl} size={58} stroke={5} dim={stale} />
        ) : (
          <span className={`pcard-fallback lvl-${lvl}`}>
            <Icon name={s.status === 'nodata' ? 'plus' : s.status === 'error' ? 'lightning' : 'spark'} size={20} />
          </span>
        )}
        <span className="pcard-meta">
          {isActive && w?.limit != null && w.limit > 0 ? (
            <>
              <span className="pcard-amount">{fmtAmount(w.used, w.unit)}</span>
              <span className="pcard-limit">/ {fmtAmount(w.limit, w.unit)}</span>
            </>
          ) : s.status === 'ok' && w && w.used > 0 ? (
            <span className="pcard-amount">{fmtAmount(w.used, w.unit)}</span>
          ) : (
            <span className="pcard-hint">
              {s.status === 'nodata' ? '未配置' : s.status === 'error' ? '出错' : s.status === 'ok' ? '暂无用量' : '—'}
            </span>
          )}
        </span>
      </span>
      <span className="pcard-foot">
        {stale ? (
          // 缓存/估算时信息优先级交换：数据"有多旧"比重置倒计时更重要（详情页仍可看倒计时）
          <>
            <QualityChip s={s} />
            <span className="pcard-when">{shortAgo(dataTime(s), now)}</span>
          </>
        ) : isActive && w?.resetAt ? (
          <span>{humanDur(new Date(w.resetAt).getTime() - now)}后重置</span>
        ) : (
          <span>{s.status === 'error' ? '点击查看原因' : (s.plan ?? '')}</span>
        )}
      </span>
    </>
  )
}

/** 余额卡：金额为主 */
function BalanceCard({
  s,
  now,
  hide,
  suffix,
  group
}: {
  s: ProviderSnapshot
  now: number
  hide: boolean
  /** 同名多账号的区分后缀；空串 = 不加 */
  suffix: string
  /** 所属组名（空串 = 不知道，不渲染标签）—— 见 design.md D5b */
  group: string
}): React.JSX.Element {
  const lvl = snapshotLevel(s)
  const w = s.windows[0]
  const isActive = s.status === 'ok' && !!w
  const pct = w ? windowPercent(w) : null
  const stale = isStale(s)

  return (
    <>
      <span className="pcard-top">
        <ProviderMark mark={s.mark} size={22} />
        <span className="pcard-name">{displayName(s.name, suffix)}</span>
        <GroupTag group={group} />
        <StatusDot lvl={lvl} />
      </span>
      <span className="pcard-big">
        {isActive ? (
          hide ? (
            <span className="amount-hidden" aria-label="余额已隐藏">
              ••••
            </span>
          ) : (
            fmtAmount(w.used, w.unit)
          )
        ) : s.status === 'error' ? (
          <Icon name="lightning" size={22} />
        ) : (
          '—'
        )}
      </span>
      <span className="pcard-foot">
        {stale ? (
          <>
            <QualityChip s={s} />
            <span className="pcard-when">{shortAgo(dataTime(s), now)}</span>
          </>
        ) : isActive ? (
          <span>{w.name}</span>
        ) : (
          <span>
            {s.status === 'nodata' ? '未配置' : s.status === 'error' ? '连接失败 · 点击查看' : ''}
          </span>
        )}
      </span>
      {isActive && pct != null && w.limit != null && <Bar pct={pct} lvl={lvl} />}
    </>
  )
}

/** 首屏骨架：采集尚未返回时的占位（避免"空荡荡"和布局跳动） */
function Skeleton(): React.JSX.Element {
  return (
    <div className="pcard-grid" aria-hidden="true">
      {[0, 1].map((i) => (
        <div className="pcard skeleton" key={i}>
          <span className="sk-line sk-md" />
          <span className="sk-line sk-lg" />
          <span className="sk-line sk-sm" />
        </div>
      ))}
    </div>
  )
}

/** 下拉里「全部」那一项的**哨兵 value**（显示文案是「全部」，不是这个 value）。
 *
 * ⚠ value 里带一个控制字符：`sanitizeGroupId` 会剥掉全部 C0 控制字符，所以**任何用户
 *   输入的组名都不可能等于它**。用裸的「全部」当 value 的话，用户自建一个叫「全部」的组
 *   就会与哨兵撞名 —— `<option value>` 出现两个同值项，选中哪一项变成浏览器的实现细节
 *   （state-management.md 记过的「存下的值不能兼任哨兵」，这里是同一类，只是撞名的是用户数据）。
 *
 * ⚠ **故意不用 `ALL_GROUPS`（空串）当 value**：存储里空串就是「全部」，但 `<option value="">`
 *   在受控 select 里与「值没匹配上任何 option」读起来一样（都得到第一个选项）——
 *   「选中的是哪一项」会读不准，下拉断言就变成恒真。于是分两层：存储用空串、
 *   控件用哨兵，映射只在 onChange 一处。
 */
const ALL_GROUPS_VALUE = '\u0001all'
/** 哨兵那一项在界面上的文案（与 value 分开，正是为了上面那条撞名防护） */
const ALL_GROUPS_LABEL = '全部'

/** 顺序对齐：保留已有顺序，新出现的追加到末尾 */
function reconcileOrder(prev: string[], ids: string[]): string[] {
  const set = new Set(ids)
  const kept = prev.filter((id) => set.has(id))
  const added = ids.filter((id) => !kept.includes(id))
  return [...kept, ...added]
}

export function CardView({
  state,
  hideBalance,
  onToggleHideBalance,
  onOpen,
  onRefresh,
  onSettings,
  onCollapse,
  instanceInfo,
  groupFilter,
  groups,
  onSetGroupFilter
}: {
  state: AppState
  hideBalance: boolean
  onToggleHideBalance: () => void
  onOpen: (id: string) => void
  onRefresh: () => void
  onSettings: () => void
  onCollapse: () => void
  /**
   * 实例身份列表（`providers:list` 的 ProviderInfo[]）—— **卡片只认它，不认 extras**。
   *
   * 为什么必须跨进程取：`ProviderSnapshot` 里没有 baseUrl/presetId/protocol
   * （types.ts 的刻意选择），而同名的两家公司账号 `mark = presetId || protocol` 完全相同，
   * 连 logo 都一样。不给它，卡片就只能裸渲染 `{s.name}`。
   */
  instanceInfo: ProviderInfo[]
  /** 当前筛选的**分组 id**（不是实例 id）—— `ALL_GROUPS`（空串）= 全部显示 */
  groupFilter: string
  /** 分组下拉的选项（含「未分组」兜底） */
  groups: string[]
  /** 切换筛选：`ALL_GROUPS` = 看全部。见 App.tsx 的 applyGroupFilter */
  onSetGroupFilter: (group: string) => void
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])

  const snaps = state.snapshots
  const configured = useMemo(() => snaps.filter((s) => s.status !== 'nodata'), [snaps])
  const idsKey = configured.map((s) => s.id).join(',')
  const suffixes = useMemo(() => distinguishSuffixes(instanceInfo), [instanceInfo])
  const suffixOf = (id: string): string => suffixes[id] ?? ''
  /**
   * 卡片上的组名标签（design.md D5b）：查不到实例 → 空串 → **不渲染**标签。
   * 「未分组」由 read-model 的 `groupOf` 归一化给出（groupId 缺省 / 空串都归它），
   * 这里不重复那份判定（同一件事两处写法的漂移）。
   */
  const infoById = useMemo(() => new Map(instanceInfo.map((p) => [p.id, p])), [instanceInfo])
  const groupOfId = (id: string): string => {
    const it = infoById.get(id)
    return it ? groupOf(it) : ''
  }
  const [order, setOrder] = useState<string[]>([])
  useEffect(() => {
    setOrder((prev) => reconcileOrder(prev, idsKey ? idsKey.split(',') : []))
  }, [idsKey])

  // 卡片窗口偏好：`ui:cardWindow:<实例id>` = 窗口名（如「本周」），未设置时用默认窗口
  const [winPrefs, setWinPrefs] = useState<Record<string, string>>({})
  const winKeys = useMemo(() => configured.map((s) => `ui:cardWindow:${s.id}`), [idsKey])
  const winKeysKey = winKeys.join(',')
  useEffect(() => {
    if (!winKeys.length) {
      setWinPrefs({})
      return
    }
    void window.api.getExtras(winKeys).then(setWinPrefs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [winKeysKey])

  const activeWindowIndex = (s: ProviderSnapshot): number => {
    const pref = winPrefs[`ui:cardWindow:${s.id}`]
    if (pref) {
      const i = s.windows.findIndex((w) => w.name === pref)
      if (i >= 0) return i
    }
    return primaryWindowIndex(s)
  }
  const selectWindow = (id: string, name: string): void => {
    setWinPrefs((p) => ({ ...p, [`ui:cardWindow:${id}`]: name }))
    void window.api.setExtras({ [`ui:cardWindow:${id}`]: name })
  }

  /**
   * **生效**的筛选值：存储里指向一个已不存在的组时回落「全部」。
   *
   * 为什么必须有这一步：组不是独立存储的，它是「成员 groupId 的去重集合」——
   * 最后一个成员被删掉，那个组就自然消失了（design.md D2）。此时若不回落：
   *   ① `visibleIds` 返回空集 → 一张卡都不剩，界面却把原因说成「这个组被筛掉了」；
   *   ② 受控 `<select>` 的 value 匹配不到任何 option → 静默回落到第一个选项，
   *      界面上写着「全部」而状态里存着一个不存在的组（state-management.md 记过这个坑）。
   * 这里只**读**不写：不回写用户的存储（那是写侧的事，且下次启动再回落一次也无害）。
   *
   * ⚠ 排序与空态判据**都用它**，不是原始 `groupFilter` —— 两处用不同的值，
   *   就会出现「下拉写着 A 组、列表却是全部」这种自相矛盾的画面。
   */
  const effFilter = groupFilter && groups.includes(groupFilter) ? groupFilter : ALL_GROUPS
  /** 下拉的 value：哨兵（全部）或组 id。effFilter 保证了它永远匹配得到某个 option */
  const selectValue = effFilter === ALL_GROUPS ? ALL_GROUPS_VALUE : effFilter

  /**
   * 展示列表 = 可见的卡片，按**分组序 ⨯ 组内拖拽序**排。
   *
   * 为什么两个维度都要：`order` 是用户在网格里拖出来的**组内**次序，
   * `orderForDisplay` 给的是**组与组**之间的次序（组首成员的位置）。只按其中一层排，
   * 另一层的语义就没了 —— 只按 order 排，A 组的卡会被拖散到别的组中间。
   *
   * 组合方式：先按 read-model 给出的展示序列把**组**编号，再在每组内部按 `order`
   * 的名次排。`Array.sort` 稳定（ES2019+），所以名次相同的卡维持原顺序。
   *
   * ⚠ 筛选只是**不展示**（D1）：不碰 `order` 状态，切回来立刻恢复用户原来的排法。
   * ⚠ 被筛掉的账户**仍然在采集**，因此托盘与提醒覆盖全部账户（design.md D6）。
   */
  const shown = useMemo(() => {
    // 组内名次 < BIG 是前提（卡片数远小于 1000），于是两个整数合成一个词典序键
    const BIG = 1000
    const rank = new Map(order.map((id, i) => [id, i]))
    const byId = new Map(instanceInfo.map((p) => [p.id, p]))
    // ⚠ `instanceInfo` 还没到手时（首帧 IPC 未返回 / providers:list 失败）**一律不过滤**。
    //   orderForDisplay 对空数组返回空集，拿空集去过滤会把**每一张卡**都滤掉 →
    //   用户看到一个与事实相反的空态。快照 id 就是实例 id（bind-instance 用实例 id
    //   铸快照 id），所以「查不到实例」只可能是加载问题，不可能是「没有实例」。
    if (!instanceInfo.length) {
      return {
        hidden: (_id: string): boolean => false,
        key: (id: string): number => rank.get(id) ?? BIG
      }
    }
    const seq = orderForDisplay(instanceInfo, effFilter)
    // 组序：组 → 名次（它在展示序列里第一次出现的位置）
    // ⚠ 用 read-model 的 `groupOf` 而不是裸 `p.groupId`：未分组实例的 groupId 是**空串**
    //   （假值），裸读会把所有未分组的卡踢出组序，它们的**拖拽名次就成了死代码**。
    //   今天恰好不出错，只因为 resort 让 configured 的序与 order 始终同步 —— 那是巧合，
    //   一旦采集侧开始自己重排（resort 不再只在拖拽时调），全部老用户的卡片就会开始乱跳。
    const groupRank = new Map<string, number>()
    for (const id of seq) {
      const it = byId.get(id)
      if (!it) continue
      const g = groupOf(it)
      if (!groupRank.has(g)) groupRank.set(g, groupRank.size)
    }
    const inDisplay = new Set(seq)
    return {
      // ⚗ 只筛**注册表里有、且被筛选排除掉**的实例。快照有、instanceInfo 里查不到的
      //   id（IPC 竞态下的短暂状态、debugPush 注入的快照）**必须照样显示**：
      //   我们不知道它属于哪一组，凭什么替用户把它藏起来？早先写成 `!inDisplay.has(id)`
      //   时那些快照被整张滤掉，`--uitest` 的 cachedCard / cachedBanner / localChip
      //   三条一起红（2026-10-01 实机），而界面上只表现为「卡片全没了 + 空态谎称
      //   『分组已全部隐藏』」。下面 key() 里那条「未知实例排到末尾」分支在那时是死代码。
      hidden: (id: string): boolean => byId.has(id) && !inDisplay.has(id),
      // 未知实例（快照有、instanceInfo 里查不到 —— IPC 竞态下的短暂状态）排到末尾：
      // 混进任何一组的名次里，用户看到的是「某张卡莫名其妙换了个位置」，排最后反而可诊断。
      key: (id: string): number => {
        const it = byId.get(id)
        if (!it) return Number.MAX_SAFE_INTEGER
        return (groupRank.get(groupOf(it)) ?? 0) * BIG + (rank.get(id) ?? BIG)
      }
    }
  }, [instanceInfo, effFilter, order])

  const ordered = useMemo(
    () =>
      // ⚠ filter 天然返回新数组，所以这个 sort 不会就地改 configured 的顺序
      configured.filter((s) => !shown.hidden(s.id)).sort((a, b) => shown.key(a.id) - shown.key(b.id)),
    [configured, shown]
  )

  // ─── 拖拽排序 ──────────────────────────────────────────────────────────────
  //
  // 设计要点（两次实机踩坑后定型）：
  //   ① **拖拽期间绝不改动 DOM 顺序**：只做 transform 预览（被拖卡片跟手、
  //      其余卡片按槽位偏移让位），松手才提交新顺序。
  //      早期实现用 elementFromPoint + 即时重排 → 布局在指针下反复变化，
  //      卡片会左右高频闪动。
  //   ② **目标槽位由「拖拽开始时捕获的静态几何」算出**（纯函数），与实时布局无关，
  //      所以同一个指针位置永远映射到同一个槽位 —— 不会来回抖。
  //   ③ 事件统一挂在 window（不用 setPointerCapture）：避免捕获丢失或元素重建
  //      导致拖拽卡死（实机出现过卡片悬在半空不落位）。
  //   ④ 兜底：Escape / 窗口失焦 / 4 秒无移动 → 自动落位，绝不留下悬空卡片。
  const gridRef = useRef<HTMLDivElement>(null)
  const prevRects = useRef(new Map<string, DOMRect>())
  const orderRef = useRef<string[]>([])
  orderRef.current = ordered.map((s) => s.id)
  const suppressClickUntil = useRef(0)
  const dragRef = useRef<{
    id: string
    index: number
    startX: number
    startY: number
    slots: DOMRect[]
    target: number
    moved: boolean
    lastMoveAt: number
  } | null>(null)
  const [dragView, setDragView] = useState<{
    id: string
    index: number
    target: number
    dx: number
    dy: number
  } | null>(null)
  const [pressSeq, setPressSeq] = useState(0)

  // FLIP：顺序变化时让卡片平滑滑到新位置（键盘排序、拖拽落位）
  const orderKey = orderRef.current.join(',')
  useLayoutEffect(() => {
    const el = gridRef.current
    if (!el) return
    const cards = [...el.querySelectorAll<HTMLElement>('[data-card-id]')]
    const next = new Map<string, DOMRect>()
    for (const c of cards) next.set(c.dataset.cardId ?? '', c.getBoundingClientRect())
    for (const c of cards) {
      const id = c.dataset.cardId ?? ''
      const prev = prevRects.current.get(id)
      const cur = next.get(id)
      if (!prev || !cur) continue
      const dx = prev.left - cur.left
      const dy = prev.top - cur.top
      if (dx || dy) {
        c.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
          duration: 200,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
        })
      }
    }
    prevRects.current = next
  }, [orderKey])

  /** 网格槽位几何（按 DOM 顺序；拖拽开始时取一次） */
  const slotRects = useCallback((): DOMRect[] => {
    const el = gridRef.current
    if (!el) return []
    return [...el.querySelectorAll<HTMLElement>('[data-card-id]')].map((c) => c.getBoundingClientRect())
  }, [])

  /**
   * 指针 → 目标槽位：取「到槽位矩形的距离」最小者（矩形内为 0）。
   * 纯几何 + 静态槽位 → 同一指针位置永远同一结果，不会来回抖。
   */
  function slotIndexAt(slots: DOMRect[], x: number, y: number): number {
    let best = 0
    let bestD = Number.POSITIVE_INFINITY
    for (let i = 0; i < slots.length; i++) {
      const r = slots[i]
      const dx = Math.max(0, r.left - x, x - r.right)
      const dy = Math.max(0, r.top - y, y - r.bottom)
      const d = dx * dx + dy * dy
      if (d === 0) return i
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return best
  }

  const endDrag = useCallback((commit: boolean): void => {
    const d = dragRef.current
    dragRef.current = null
    setPressSeq((v) => v + 1) // 注销 window 监听
    if (!d) return
    setDragView(null)
    if (!d.moved) return // 未移动 → 交给 onClick 打开详情
    suppressClickUntil.current = Date.now() + 300
    if (!commit) return
    const ids = orderRef.current
    const from = ids.indexOf(d.id)
    const to = Math.max(0, Math.min(ids.length - 1, d.target))
    if (from < 0 || from === to) return
    const next = [...ids]
    next.splice(from, 1)
    next.splice(to, 0, d.id)
    setOrder(next)
    void window.api.reorderProviders(next)
  }, [])

  // 按下之后：window 级监听（移动 / 抬起 / 取消 / 失焦 / Escape / 无移动兜底）
  useEffect(() => {
    if (!dragRef.current) return
    const onMove = (e: PointerEvent): void => {
      const d = dragRef.current
      if (!d) return
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 6) return
        d.moved = true
        d.slots = slotRects() // 此刻布局还没变，几何最准
        prevRects.current.clear()
      }
      d.lastMoveAt = Date.now()
      d.target = slotIndexAt(d.slots, e.clientX, e.clientY)
      setDragView({ id: d.id, index: d.index, target: d.target, dx: e.clientX - d.startX, dy: e.clientY - d.startY })
    }
    const onUp = (): void => endDrag(true)
    const onCancel = (): void => endDrag(false)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') endDrag(false)
    }
    const watchdog = window.setInterval(() => {
      const d = dragRef.current
      if (d?.moved && Date.now() - d.lastMoveAt > 4000) endDrag(true)
    }, 1000)
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onCancel)
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearInterval(watchdog)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onCancel)
      window.removeEventListener('keydown', onKey)
    }
  }, [pressSeq, endDrag, slotRects])

  const onCardPointerDown = (e: React.PointerEvent<HTMLDivElement>, id: string, index: number): void => {
    if (e.button !== 0) return
    dragRef.current = {
      id,
      index,
      startX: e.clientX,
      startY: e.clientY,
      slots: slotRects(),
      target: index,
      moved: false,
      lastMoveAt: Date.now()
    }
    setPressSeq((v) => v + 1) // 注册 window 监听
  }

  /** 拖拽预览位移：被拖卡片跟手；其余卡片按槽位让位（不改 DOM 顺序） */
  const dragStyleFor = (id: string, i: number): React.CSSProperties | undefined => {
    const slots = dragRef.current?.slots
    if (!dragView || !slots || !slots.length) return undefined
    if (id === dragView.id) {
      return {
        transform: `translate3d(${dragView.dx}px, ${dragView.dy}px, 0) scale(1.03)`,
        zIndex: 5,
        transition: 'none'
      }
    }
    const from = dragView.index
    const to = dragView.target
    const shift = from < to && i > from && i <= to ? -1 : from > to && i >= to && i < from ? 1 : 0
    if (!shift) return undefined
    const a = slots[i]
    const b = slots[i + shift]
    if (!a || !b) return undefined
    return {
      transform: `translate3d(${b.left - a.left}px, ${b.top - a.top}px, 0)`,
      transition: 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)'
    }
  }

  /** 键盘：⌥←/⌥→ 调整顺序；Enter/Space 打开详情（可访问性） */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, id: string): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpen(id)
      return
    }
    if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
    e.preventDefault()
    const ids = orderRef.current
    const i = ids.indexOf(id)
    const j = e.key === 'ArrowLeft' ? i - 1 : i + 1
    if (i < 0 || j < 0 || j >= ids.length) return
    const next = [...ids]
    next.splice(i, 1)
    next.splice(j, 0, id)
    setOrder(next)
    void window.api.reorderProviders(next)
  }

  // ─── 状态汇总 ──────────────────────────────────────────────────────────────
  const offline = !!state.offline
  const errCount = snaps.filter((s) => s.status === 'error').length
  const cachedCount = snaps.filter((s) => s.dataQuality === 'cached').length
  const localCount = snaps.filter((s) => s.dataQuality === 'local').length
  const nearCount = snaps.filter((s) => snapshotLevel(s) === 'danger').length
  const scanning = state.scanning
  const firstLoad = snaps.length === 0 && scanning

  const status = offline
    ? { cls: 'warn', text: cachedCount > 0 ? `离线 · ${cachedCount} 项为缓存数据` : '网络不可用' }
    : errCount > 0
      ? { cls: 'danger', text: `${errCount} 家出错` }
      : cachedCount > 0
        ? { cls: 'warn', text: `${cachedCount} 项为缓存数据` }
        : localCount > 0
          ? { cls: 'warn', text: `${localCount} 项为本机估算` }
          : nearCount > 0
            ? { cls: 'warn', text: `${nearCount} 家接近限额` }
            : configured.length
              ? { cls: 'ok', text: '全部正常' }
              : { cls: 'dim', text: scanning ? '正在采集…' : '暂无数据' }

  const newest = snaps
    .map((s) => dataTime(s))
    .filter((x): x is string => !!x)
    .sort()
    .pop()

  return (
    <div className="card">
      <header className="titlebar">
        <span className="brand-badge">
          <img src={badgeIcon} alt="BalanceDeck" draggable={false} />
        </span>
        <span className="title-text">
          <span className="brand">BalanceDeck</span>
          <span className={`status-line ${status.cls}`}>
            <i className="status-dot" />
            {status.text}
            {newest && (
              <span className="dim">
                {' '}
                · {timeAgo(newest, now)}更新
              </span>
            )}
          </span>
        </span>
        {/* 分组筛选：只影响**列表显示**，采集照跑（被筛掉的账户仍在托盘与提醒里）。

            ⚠ 语义是**单选**（2026-10-01 用户决策）：选中某一组 = **只显示它**，
              「全部」= 显示所有组。刻意不复用 `enabled: false` —— 那是停止采集，
              切回要等一轮，历史还会断档。 */}
        <span className="grp-filter">
          <select
            className="grp-select"
            value={selectValue}
            aria-label="按分组筛选"
            title="按分组筛选卡片（只影响列表显示，托盘与提醒仍覆盖全部账户）"
            onChange={(e) => onSetGroupFilter(e.target.value === ALL_GROUPS_VALUE ? ALL_GROUPS : e.target.value)}
          >
            <option value={ALL_GROUPS_VALUE}>{ALL_GROUPS_LABEL}</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </span>
        <IconButton
          name={hideBalance ? 'eyeOff' : 'eye'}
          title={hideBalance ? '显示余额' : '隐藏余额'}
          onClick={onToggleHideBalance}
        />
        <IconButton
          name="refresh"
          title="立即刷新"
          className={scanning ? 'spinning' : ''}
          onClick={onRefresh}
        />
      </header>

      <div className="body-scroll">
        {firstLoad ? (
          <Skeleton />
        ) : configured.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">
              <Icon name="plus" size={22} />
            </span>
            <span className="empty-title">还没有配置供应商</span>
            <span className="empty-sub">添加供应商与凭据后，这里会显示余额与用量</span>
            <button type="button" className="btn-primary sm empty-cta" onClick={onSettings}>
              去添加
            </button>
          </div>
        ) : ordered.length === 0 && effFilter !== ALL_GROUPS ? (
          // ① **筛选把卡片都筛掉了**（单选语义下 = 选中的那一组一个能显示的都没有）。
          //    **不是**错误状态 —— 采集与托盘都还在跑（design.md D6），所以文案说清
          //    「仍在采集」，并给一个真能回来的按钮。
          <div className="empty-state">
            <span className="empty-icon">
              <Icon name="eyeOff" size={22} />
            </span>
            <span className="empty-title">分组已全部隐藏</span>
            <span className="empty-sub">这些账户仍在正常采集，托盘与提醒依然覆盖它们</span>
            <button type="button" className="btn-primary sm empty-cta" onClick={() => onSetGroupFilter(ALL_GROUPS)}>
              显示全部分组
            </button>
          </div>
        ) : ordered.length === 0 ? (
          // ② 兜底：有 configured 却一张卡都渲染不出来。**当前不可达**（`hidden` 只对
          //    「注册表里有且被筛掉」的 id 为真，所以筛=全部时 ordered.length 恒等于
          //    configured.length），但它必须在这里 —— 哪天上面那条判据又漏了条件，
          //    兜底就是「给一句中性的话」而不是「谎称分组被隐藏」或干脆渲染一张空白网格
          //    （design.md D1b）。上面那条 `configured.length === 0` 已经接走了
          //    「本来就没配置」的情形，所以这里不需要另一套文案。
          <div className="empty-state">
            <span className="empty-icon">
              <Icon name="plus" size={22} />
            </span>
            <span className="empty-title">还没有配置供应商</span>
            <span className="empty-sub">添加供应商与凭据后，这里会显示余额与用量</span>
            <button type="button" className="btn-primary sm empty-cta" onClick={onSettings}>
              去添加
            </button>
          </div>
        ) : (
          <div className="pcard-grid" ref={gridRef}>
            {ordered.map((s, i) => {
              const dragging = dragView?.id === s.id
              const suffix = suffixOf(s.id)
              const group = groupOfId(s.id)
              return (
                <div
                  key={s.id}
                  data-card-id={s.id}
                  tabIndex={0}
                  role="button"
                  // ⚠ `aria-label` **覆盖**卡内全部可见文本，所以只写 `s.name` 会让读屏用户
                  //   听到两个一模一样的名字 —— 那正是 P1-4 要解决的问题在无障碍通道上复发。
                  //   后缀与组名都补进来；组名为空串（查不到实例）时不提「未分组」（D5b 的数据诚实）。
                  aria-label={`${displayName(s.name, suffix)}${group ? `（${group}）` : ''} 详情`}
                  className={
                    'pcard ' +
                    (isPlan(s) ? 'plan' : 'balance') +
                    ` lvl-${snapshotLevel(s)}` +
                    (isStale(s) ? ' stale' : '') +
                    (dragging ? ' dragging' : '')
                  }
                  style={dragStyleFor(s.id, i)}
                  title="点击查看详情 · 拖拽调整顺序（⌥←/⌥→）"
                  onPointerDown={(e) => onCardPointerDown(e, s.id, i)}
                  onKeyDown={(e) => onKeyDown(e, s.id)}
                  onClick={() => {
                    if (Date.now() < suppressClickUntil.current) return // 拖拽后的补发 click
                    onOpen(s.id)
                  }}
                >
                  {/* 与上面的 className 同一个口径（shared/quality 的 isPlan）：
                      这里原先写的是裸 `s.kind === 'balance'`，与 558 行的 isPlan() 并存 ——
                      今天两者等价，但 isPlan 的规则一旦改动，分支与类名就会各走各的 */}
                  {!isPlan(s) ? (
                    <BalanceCard s={s} now={now} hide={hideBalance} suffix={suffix} group={group} />
                  ) : (
                    <PlanCard
                      s={s}
                      now={now}
                      winIndex={activeWindowIndex(s)}
                      suffix={suffix}
                      group={group}
                      onSelectWindow={(name) => selectWindow(s.id, name)}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <footer className="footer">
        <button className="btn-primary" onClick={onRefresh}>
          <Icon name="refresh" size={15} className={scanning ? 'spinning' : ''} />
          {scanning ? '刷新中…' : '立即刷新'}
        </button>
        <div className="footer-row">
          <button className="btn-secondary" onClick={onSettings}>
            <Icon name="settings" size={14} />
            设置
          </button>
          <button className="btn-secondary" onClick={onCollapse}>
            <Icon name="collapse" size={14} />
            收起
          </button>
        </div>
      </footer>
    </div>
  )
}
