import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, ProviderSnapshot, ProviderWindow } from '../../shared/types'
import { BALL_VIEW } from '../../shared/pet-view'
import { isPlan } from '../../shared/quality'
import { level as fluidLevel, POUR_FILL_MS, POUR_TOTAL_MS, type FluidPhase } from '../../shared/fluid'
import { shortWindowLabel } from '../../shared/tray-text'
import { fmtAmount, fmtPercent, windowPercent, dataTime, isStale } from './format'
import { ballLevel, severityRank } from './read-model'
import {
  defaultWaterAnchors,
  resolveWaterAnchors,
  rgbStr,
  waterColor,
  type WaterAnchors
} from '../../shared/water-color'
import { skinWaves, POUR_DROPS } from './skin-waves'
import { ringDash, RING_DASH_SPACE } from './skin-rings'
import { Icon } from './components'
import { markColor, markDataUrl } from './ProviderMark'

// ═══════════════════════════════════════════════════════════════════════════════
// 收起态：唯一的形态是 2D 小水球 —— 56×56 窗口、全屏水体、环心一个数；
// 纯 DOM，不建 3D 场景、不占显存、不加载任何角色素材（首版 56×56 窗口，`d5a028e`；
// 外圈用量环已于 10-04 退役，进度改由球内水位表达）。
//
// 人物形态已下线（10-03-remove-human）：pet3d 整目录、FIGURE_VIEW、形态分支、
// 人物泡泡/动作上报全部删除。本文件只剩圆环 + 轮播 + 流体 + 确认气泡。
//
// 共同点（保留）：鼠标穿透（主进程按渲染层上报的命中区轮询）、单击展开、
// 拖动移动、右键菜单。
//
// 设计依据见 DESIGN.md「收起态」。
// ═══════════════════════════════════════════════════════════════════════════════

// 自动轮播节奏：6 秒换一位供应商（手动操作后暂停 MANUAL_HOLD_MS，见 onWheel）
const AUTO_MS = 6000
/** 手动切换后自动轮播暂停多久（PRD AC4.3：8 秒内不推进，第 9 秒起恢复） */
const MANUAL_HOLD_MS = 8000
/** 滚轮：累计多少像素算「够一格」（挡抖动） */
const WHEEL_THRESHOLD = 60
/** 滚轮：同一轴两次切换的最短间隔 ms（挡触控板惯性连发） */
const WHEEL_COOLDOWN = 250
/**
 * 滚轮：距上一个事件超过这个 ms 就算**断流（新手势）**，先把残量清掉再累加（见 onWheel ①）。
 *
 * 为什么必须有：`acc` 只在「真的切了一次」时归零，被 COOLDOWN 挡下的事件会继续往上垒 ——
 * 一次 30×`deltaY:40` 的惯性手势走完能残留 1000+px 而一步未切；冷却一过，
 * 下一次哪怕 1px 的轻扫也立刻过阈值，**误切一格且用户毫无感觉**。
 * 150ms 是因为触控板惯性事件连续到达（间隔 <15ms），而人重新起手必然 >150ms；
 * 鼠标滚轮单格（`deltaY≈100`）清完再累加照样第一格就过阈值，一格一跳不变。
 */
const WHEEL_GESTURE_GAP = 150
/** 数字递增时长（PRD R5：看得见在动、又不嫌慢的下限） */
const COUNTUP_MS = 600
/**
 * 确认气泡的最坏高度：padding 4 + 文案行 11×1.2 = 13.2 + 间距 2 + 操作行 24 + padding 5 = 48.2，
 * 取整 49。它是 .petball-confirm 的实测高度在**首次测量前**的兜底值 —— 锚点要按它反推才不会
 * 顶出窗口被 overflow 裁掉。取不到实测值又用 0 兜底的话，第一帧整个气泡会挂在窗口外。
 * ⚠ 这个数是 .petball-confirm 的 padding / line-height / min-height 之和，改那边就得改这里
 * （test-alert-orchestration.mjs 的 L77 会按同一份加法验一遍）。
 */
const CONFIRM_BUBBLE_H = 49

/**
 * 波浪路径（全屏水满的液面）：56 viewBox 内一条正弦液面 + 两侧下沉封口。
 * 三层错速（A 快层 2.2/28 / B 慢层 1.6/36 反向 / C 细纹 0.9/18），phase 互相错开半个周期。
 * 位移走 CSS translateX 循环（只位移、不逐帧重算 d），循环距离取波长的整数倍
 * （-28 / -36 / -36）保证首尾无缝；x 起止（-40..96）盖住最大位移 36。
 * 纯视图构造（SVG 形状），共享契约（液位/相位/水柱几何）归 shared/fluid.ts。
 */
function wavePoints(surfaceY: number, phase: number, A: number, L: number): string[] {
  const pts: string[] = []
  for (let x = -40; x <= 96; x += 4) {
    pts.push(`${x} ${(surfaceY + A * Math.sin(((x + phase) / L) * Math.PI * 2)).toFixed(2)}`)
  }
  return pts
}

/**
 * 读当前皮肤的水色锚点（本文件唯一碰 DOM 的水色胶水 —— 插值本身是 shared 纯函数）。
 * 令牌落在 `.app` 上，不在 body（见 skins.css 注释 —— 写错位置会形成继承屏障，
 * 读到 :root 的旧值）。读不到/解析失败 → 缺省三色：水退化成"阈值处仍对"的静态色，
 * 不断裂、不透明（与 --water-foam/--water-deep 的 :root 兜底同纪律）。
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

function waveD(surfaceY: number, phase: number, A = 2.2, L = 28): string {
  const pts = wavePoints(surfaceY, phase, A, L)
  return `M -40 ${surfaceY.toFixed(2)} L ${pts.join(' L ')} L 96 60 L -40 60 Z`
}

/**
 * 液面高光线（已退役，P1 皮肤落地）：白色 crest 与读数重叠，拿掉只留深浅两层。
 * 函数与 JSX 的 path 保留（K2a/K2b 的形状不断；CSS 侧 display:none，不渲染）。
 * 与 A 层同参数同 drift-a 的构造关系不变 —— 万一以后要回白线，直接把 CSS 那条
 * display:none 摘掉即回旧版（回滚点，不删代码）。
 */
function waveLine(surfaceY: number, phase: number, A = 2.2, L = 28): string {
  return `M ${wavePoints(surfaceY, phase, A, L).join(' L ')}`
}

/**
 * 泡沫带 → 深色后浪（P1 皮肤落地，原型 waveSvg 双层浪口径）：上沿 = A 波顶上浮 3px，
 * 下沿 = A 波顶下沉 3.5px，闭合。与 A 同参数同 drift-a，同进同退。
 * fill 走 CSS 的 --water-deep（深色后浪），前浪水色（A/B/C 内联 water）压在它上 ——
 * 深浅两层，无白线。B/C 冒头盖进深色里（aero 最坏 4.7px 错位，吃进 ±3px 深色带里
 * 读作浪影；极端对齐的残留闪过可接受）。
 */
function waveBand(surfaceY: number, phase: number, A = 2.2, L = 28, up = 3, down = 3.5): string {
  const top = wavePoints(surfaceY - up, phase, A, L)
  const bottom = wavePoints(surfaceY + down, phase, A, L).reverse()
  return `M ${top.join(' L ')} L ${bottom.join(' L ')} Z`
}

/**
 * 水柱顶的小波浪（固定形状，周期 4px，-4..12 盖住 4px 宽的柱面加两侧余量）。
 * 位移走 CSS（0 → -4px 循环，整数个周期，无缝）；横槽那条把同一张 svg 转 90°
 * （见 skins.css），不另画第二份路径。
 */
const COLUMN_WAVE_D = `M -4 1.5 q 1 -1 2 0${' t 2 0'.repeat(8)}`

/**
 * 环形进度的五个圆（V1 刻度圈 / V3 双环 / V5 分段环 / 轨道 / 进度弧）。
 *
 * 分工（唯一口径，两处消费：球本体与 peek 预览气泡共用本函数，不复制第二份）：
 *   · **JSX 只负责归一化空间** —— 每个 circle 带 `pathLength`，周长被折算成
 *     100（弧）/ 96（刻度圈，24 粒 × 4）。有了它 stroke-dasharray 的单位是
 *     「百分比」而不是像素，于是半径可以留在 CSS 令牌里（--ring-r 逐皮肤不同），
 *     TS 不必知道任何几何数 —— 见 skin-rings.ts 的注释。
 *   · **CSS 只负责图案** —— 刻度/分段的 dasharray 走令牌（--ring-ticks-dash /
 *     --ring-seg-dash），换皮肤改缺口不用动 TS。
 *   · **进度弧长**由 ringDash(fluidLvl) 内联（唯一的数据口径，与柱内液高同一个
 *     fluidLvl），弧色内联 water（等级色连续插值，不在 CSS 里写死 ok/warn/danger）。
 *
 * 五个圆全部常驻 DOM，逐皮肤的显隐/几何/线宽由 --ring-* 令牌决定
 * （V5 的分段轨道与 V3 的内环对别的皮肤 display:none —— 省不了这份 DOM，
 * 但换皮零代码：新增皮肤不写一行 TS）。
 */
function ringSvg(lvl: number, water: string | null): React.JSX.Element {
  return (
    <>
      {/* 轨道：满圈底色，走 --ring-track（逐皮肤令牌，默认借 --track） */}
      <circle className="ring-track" cx="28" cy="28" pathLength={RING_DASH_SPACE} />
      {/* 分段轨道（V5）：缺口兼刻度；pattern 在 CSS 令牌里，仍是 0..100 归一化空间 */}
      <circle className="ring-seg" cx="28" cy="28" pathLength={RING_DASH_SPACE} />
      {/* 刻度圈（V1）：24 粒；24×4 = 96 是它的归一化空间，缺口 pattern 见 CSS */}
      <circle className="ring-ticks" cx="28" cy="28" pathLength={96} />
      {/* 内装饰细环（V3）：恒满圈，不承载进度 */}
      <circle className="ring-inner" cx="28" cy="28" pathLength={RING_DASH_SPACE} />
      {/* 进度弧：**唯一**承载 fluidLvl 的图形。12 点起画（rotate -90），与原型 arc() 同向 */}
      <circle
        className="ring-arc"
        cx="28"
        cy="28"
        pathLength={RING_DASH_SPACE}
        strokeDasharray={ringDash(lvl)}
        transform="rotate(-90 28 28)"
        style={{ stroke: water ?? undefined }}
      />
    </>
  )
}

/**
 * 中心读数的两态（R5 的核心分离：**显示值 ≠ 目标值**）：
 *   · `lit` —— 非数值（`!` 采集失败 / `—` 无数据 / `…` 快照未到位 / `••••` 打码余额）
 *              直接落定，**结构上**进不了数字动画 —— hideBalance 的余额在构造 reading
 *              时就变成了 lit，动画链路拿不到数字，不靠「记得跳过」（AC5.3）
 *   · `num` —— 真实数值 + 本次渲染该用的格式化器；百分比与金额走同一套动画（AC5.4）
 */
type Reading =
  | { k: 'lit'; text: string }
  | { k: 'num'; target: number; fmt: (n: number) => string }

export interface PetBallProps {
  onExpand: () => void
  onDragStart: (grab: { x: number; y: number }) => void
  onDragEnd: () => void
  /** 右键菜单：交给主进程弹原生菜单，返回被选中的 action */
  onMenu: () => Promise<string | null>
  hideBalance: boolean
  /**
   * 语音提醒的视觉通知文案（'' = 无）。由 App 侧持有计时（12s 自动消失），本组件只负责
   * 显示 —— 它和确认气泡共用一个位置，两者都是「一句话的临时提示」，
   * 同时存在时确认气泡优先：它带着可点的确认按钮，是用户真正要动手的那个。
   */
  notice?: string
  /**
   * 待确认预警的原文（'' = 无待确认的预警，AC7）。由 App 从 alertOrchestrate 的待确认批次
   * 里派生，并已过 confirmLine 收敛成不截断的短句 —— 播报原文可能拼好几条明细，全塞进
   * 190px 的气泡必然 ellipsis 截断，而"余额不足"这类最该看见的往往被砍掉。
   * 本组件不持有任何计时 —— 重复间隔与倒计时都归那条 30s 轮询链管。
   */
  alertText?: string
  /** 距自动确认还剩几分钟（由 App 侧按分钟粒度给，见 App 里那段注释） */
  alertMinutes?: number
  /** 点「好的」：确认最近播的那一批，停止重复 */
  onConfirmAlert?: () => void
  /**
   * 是否已藏到只剩痕迹（主进程推，App 订阅 dock:hidden）。
   * 痕迹态下单击 = 唤出（dock:reveal）而不是展开 —— 痕迹上没有可读内容，
   * 直接展开会跳过"滑出确认"这一步，而触屏/无 hover 设备靠的就是这次点击。
   */
  dockHidden?: boolean
  /**
   * 流体相位 + 贴边（主进程 dock:fluid 推，App 订阅后透传）。
   * 渲染层只切 CSS 类、不算几何（几何唯一来源仍是 shared/dock-hide + shared/fluid）；
   * 非法值按 edge-visible 画整球 —— 默认安全态必须是"看得见的整球"而不是水渍。
   */
  fluidPhase?: string
  fluidEdge?: string | null
}

export function PetBall({
  onExpand,
  onDragStart,
  onDragEnd,
  onMenu,
  hideBalance,
  notice,
  alertText,
  alertMinutes = 0,
  onConfirmAlert,
  dockHidden = false,
  fluidPhase = 'edge-visible',
  fluidEdge = null
}: PetBallProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const hitRef = useRef<HTMLDivElement | null>(null)
  /** 2D 小水球本体：命中区按它的实测方块上报（它就是整块窗口） */
  const fallbackRef = useRef<HTMLDivElement | null>(null)
  /** 确认气泡本体：命中区必须并进它才算点得动（见 reportHit） */
  const confirmRef = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<AppState>({ snapshots: [], lastSync: null, scanning: false })
  const [idx, setIdx] = useState(0)
  /** 当前看的是该供应商的第几个时限窗口（仅内存，不落盘；上下滚轮切换它） */
  const [winIdx, setWinIdx] = useState(0)
  /**
   * 测试观测点：球上的两个索引（`--uitest` 守「滚轮切窗口 / 轮播推进」）。
   * 渲染期镜像写法与 App.tsx:78-84 同源 —— 赋值放在渲染里（见 winCount 之后那行），
   * 读方是 `__bd_ball` 的纯数据钩子（可结构化克隆，函数不能进那个 payload）。
   */
  const idxMirror = useRef({ idx: 0, winIdx: 0, winCount: 0 })

  useEffect(() => {
    void window.api.getState().then(setState)
    return window.api.onState(setState)
  }, [])

  // 测试钩子：让 --uitest 能读到轮播索引（纯数据，可结构化克隆）
  useEffect(() => {
    // ⚠️ 返回值必须是「可结构化克隆」的纯数据：里面塞函数会让 executeJavaScript
    //    的结果无法回传（报 An object could not be cloned）。
    const w = window as unknown as { __bd_ball?: () => unknown }
    w.__bd_ball = () => ({
      idx: idxMirror.current.idx,
      winIdx: idxMirror.current.winIdx,
      winCount: idxMirror.current.winCount
    })
    return () => {
      delete w.__bd_ball
    }
  }, [])

  // 鼠标停在主体上时暂停？不 —— 悬停反馈：悬停时停步，避免「抓不到」
  /** 光标是否悬停在球上（主进程轮询回传）：悬停时停步，避免「抓不到」 */
  const [hover, setHover] = useState(false)
  const press = useRef({ down: false, moved: false, x: 0, y: 0 })

  // 点击穿透：把主体的屏幕矩形报给主进程（窗口里只有那一块接收鼠标）
  const reportHit = useCallback(() => {
    const host = hostRef.current
    const hw = host?.clientWidth || BALL_VIEW.width
    const hh = host?.clientHeight || BALL_VIEW.height
    // 无 3D 场景，按 **2D 小水球的实测方块**上报，不写死尺寸。
    // 窗口 56×56 本身就是那个环 → 整块窗口可点（主进程再外扩 pad=3）。
    const el = fallbackRef.current
    const w = el?.clientWidth || BALL_VIEW.width
    const h = el?.clientHeight || BALL_VIEW.height
    let box: { x: number; y: number; width: number; height: number } = {
      x: (hw - w) / 2,
      y: (hh - h) / 2,
      width: w,
      height: h
    }

    // 确认气泡超出主体矩形 —— 主进程只按这个矩形决定窗口哪块收鼠标，
    // 不把它并进来的话气泡就是「画得出、点不动」。
    // 只在气泡可见时才并：平时不给环顶多一块挡到桌面的死区。
    const c = confirmRef.current
    if (c && c.offsetHeight > 0 && host) {
      const cb = c.getBoundingClientRect()
      const hb = host.getBoundingClientRect()
      if (cb.width > 0 && hb.width > 0) {
        const o = { x: cb.left - hb.left, y: cb.top - hb.top, width: cb.width, height: cb.height }
        const x = Math.min(box.x, o.x)
        const y = Math.min(box.y, o.y)
        box = {
          x,
          y,
          width: Math.max(box.x + box.width, o.x + o.width) - x,
          height: Math.max(box.y + box.height, o.y + o.height) - y
        }
      }
    }
    window.api.setPetHitbox(box)
  }, [])

  useEffect(() => {
    reportHit()
    // 命中区持续刷新（90ms 与主进程光标轮询同频）。
    const t = window.setInterval(() => {
      reportHit()
      // 确认气泡的高度也在这里量（同一条链，不新增定时器）：它的锚点是底边，
      // 高度一变锚点就得跟着动，否则顶出窗口被 overflow 裁掉。气泡不在时归零，
      // 下次出现用最坏高度兜底（CONFIRM_BUBBLE_H）而不是拿上一个值顶上去。
      const cf = confirmRef.current
      setConfirmH((prev) => {
        const next = cf ? cf.offsetHeight : 0
        return Math.abs(prev - next) < 0.5 ? prev : next
      })
      const host = hostRef.current
      if (host) {
        const w = host.clientWidth
        const h = host.clientHeight
        setViewSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
      }
    }, 90)
    return () => window.clearInterval(t)
  }, [reportHit])

  // 鼠标停在主体上时高亮（主进程轮询回传，用于 hover 反馈）
  useEffect(() => {
    return window.api.onPetCursor?.((over) => setHover(over)) ?? (() => {})
  }, [])

  // ─── 轮播 ───────────────────────────────────────────────────────────────────
  const snaps = useMemo(() => [...state.snapshots].sort((a, b) => severityRank(a) - severityRank(b)), [state.snapshots])
  const count = snaps.length

  /**
   * `idx`（换供应商）的**唯一出口** —— 自动轮播与滚轮横向步进都必须调它。
   * 换供应商 → 窗口索引固定落回 `windows[0]`（PRD §6 已拍板的 Q1=B：上下滚动的起始点可预期），
   * 两个 setState 在同一次调用里由 React 批处理成一帧，`winIdx` 与 `s` 永远同帧更新。
   *
   * ⚠ 不许在 interval 里另写一次 `setIdx`（那条路径就不会重置窗口），
   *   也不许改成 `useEffect(..., [idx])` 去重置 —— 后者会先用**旧 winIdx** 画一帧
   *   新供应商的窗口，再被 effect 打回 0：中心数字闪一下别的读数，动画起点也会算错。
   *
   * R4 后放宽的只有一句：它不再要求自己是「自动轮播的**唯一出口**」——自动轮播会在同一家内
   * 逐个走完窗口，那条路径不碰 `idx`。红线收紧成了「**`idx` 的唯一出口**」，方向没变松。
   */
  const advanceProvider = useCallback(
    (dir: number): void => {
      if (count <= 1) return // 只有一位时「换供应商」是空操作：也不该把用户选好的窗口打回 0
      setIdx((i) => (i + dir + count) % count)
      setWinIdx(0)
    },
    [count]
  )

  /** 上次自动推进的时刻 / 手动操作要求的暂停截止（轮播节奏的两个时间戳） */
  const lastAdvance = useRef(0)
  const holdUntil = useRef(0)

  /**
   * 轮播 tick 要读的两个**渲染期取值**（窗口数 / 窗口索引）的 ref 镜像。
   * 为什么这么做：自动轮播的判断依赖 `s` 与 `winIdx`，而它们每切一次窗口就变一次。
   * 让 tick 直接闭包捕获它们、或做成 useCallback 再塞进依赖数组，代价是
   * **每切一次窗口就重建一次 interval effect** —— 定时器反复拆建，且「满 6 秒」的基准
   * 从「上次推进」变成「上次 effect 重跑」；数据刷新若顺带改了 `count`/`s`，
   * 用户等的那一步就被往后推。
   *
   * 赋值放在渲染期（不是 effect 里），与下面 `idxMirror` 同一个模式：ref 永远新鲜。
   */
  const live = useRef({ winCount: 0, winIdx: 0 })

  useEffect(() => {
    if (count <= 1) return
    // 节奏从挂载起算：不重置的话 lastAdvance 一直是 0，第 1 秒的 tick 就会判定「已满 6 秒」
    lastAdvance.current = Date.now()
    // 秒级 tick + 两个时间戳，而不是「固定 6s interval + hold 守卫」：后者在手动操作落在
    // 第 5.9 秒时，下一跳会被推到第 12 秒 —— 实测是「说了暂停 8 秒却等了 12 秒」。
    // 1s tick 只做判断、未必 setState，零渲染开销，而语义精确到 ±1 秒。
    const t = window.setInterval(() => {
      const now = Date.now()
      if (now < holdUntil.current) return // 还在手动操作后的暂停期（AC4.3）
      if (now - lastAdvance.current < AUTO_MS) return // 满 6 秒才推进一步
      lastAdvance.current = now
      const { winCount: n, winIdx: w } = live.current
      // 先在同一家里把窗口走完（5H → 周 → 月），走完才换供应商 —— 旧行为只换供应商、
      // 且永远停在 windows[0]，用户看到的正是「快速切供应商但从不切时限」（R4）。
      // 单窗口供应商：n > 1 不成立 → 直接换供应商，不空转一步（AC4.2）；充值余额供应商
      // 没有环但走同一条路径（AC4.6），不为视觉特殊-case。
      if (n > 1 && w + 1 < n) {
        setWinIdx((i) => (i + 1) % n)
      } else {
        advanceProvider(1) // ← 换供应商的同一个入口：窗口落回 windows[0]
      }
    }, 1000)
    return () => window.clearInterval(t)
    // ⚠ 依赖里只有 count / advanceProvider（后者本身只依赖 count）。**不要**把任何
    //   窗口相关的量（live、winIdx、s）加进来 —— 理由与实测见 live 的注释。
  }, [count, advanceProvider])

  const s: ProviderSnapshot | undefined = count ? snaps[idx % count] : undefined

  /** 当前供应商有几个时限窗口（上下滚轮在其中逐个切换） */
  const winCount = s?.windows.length ?? 0
  // 渲染期镜像（见 idxMirror 的注释）：与上面的 ref 同一帧刷新，`__bd_ball` 读到的永远是本次渲染的索引
  idxMirror.current = { idx, winIdx, winCount }
  // 同一个渲染期镜像模式：轮播 tick 读的是这个（不重跑 effect）——见 live 的注释
  live.current = { winCount, winIdx }

  // 窗口夹紧：同一个供应商的窗口数量变了（数据刷新）就把索引收回范围内，防止越界。
  // ⚠ 依赖必须是**长度**而不是 `s`：依赖 s 的话，每轮采集（10–300s 一次）都会把用户
  //   正在浏览的窗口打回 0，滚轮浏览会被周期性重置。
  useEffect(() => {
    setWinIdx((i) => (winCount === 0 ? 0 : i < winCount ? i : winCount - 1))
  }, [winCount])

  /** 选中的窗口；status 非 ok 时不选窗口 —— 出错/无数据没有可读的窗口 */
  const wBall: ProviderWindow | undefined =
    s && s.status === 'ok' && winCount ? s.windows[Math.max(0, Math.min(winIdx, winCount - 1))] : undefined

  /** 本次读数用哪个窗口（环、等级、读数、短标签都从它取，不会各选各的） */
  const active = wBall

  const pct = active ? windowPercent(active) : null
  const lvl = ballLevel(s, active)

  const reading = useMemo<Reading>(() => {
    if (!s) return { k: 'lit', text: '…' }
    if (s.status === 'error') return { k: 'lit', text: '!' }
    if (s.status === 'nodata') return { k: 'lit', text: '—' }
    if (pct != null) return { k: 'num', target: pct, fmt: fmtPercent }
    if (active) {
      // hideBalance 下的余额**从不构建数字**（k:'lit'）—— 动画链路拿不到它（AC5.3）
      if (hideBalance && !isPlan(s)) return { k: 'lit', text: '••••' }
      return { k: 'num', target: active.used, fmt: (n) => fmtAmount(n, active.unit, { compact: true }) }
    }
    return { k: 'lit', text: '—' }
  }, [s, pct, active, hideBalance])

  /** 落定后的完整读数：余额播报、tooltip 用它 */
  const valueText = reading.k === 'lit' ? reading.text : reading.fmt(reading.target)

  // ─── 流体隐藏的呈现相位（R8/R9 + design Fluid 节）─────────────────────────
  //
  // 主进程 dockHide 状态机经 dock:fluid 推送相位，这里只切 CSS 类 ——
  // 几何（边/偏移/水渍矩形）与时序（150/300/80/400）归 shared/fluid.ts，
  // 位移仍走主进程 setPosition 步进（OS 级遮挡正确），morph 与位移串行不重叠。
  const fluid: FluidPhase =
    fluidPhase === 'absorbing' || fluidPhase === 'hidden' || fluidPhase === 'revealing'
      ? fluidPhase
      : 'edge-visible'
  const fluidEdgeAttr =
    fluidEdge === 'right' || fluidEdge === 'top' || fluidEdge === 'bottom' ? fluidEdge : 'left'
  /**
   * 挂水条件（R4-6）：套餐类有比例挂水（液位 = 用量）；余额类（直充）状态 ok 即挂满水
   * （fluidLvl=1，语义是"钱足=满杯"，与用量比例无关 —— 不是 pct，不叫百分比）。
   * error/nodata 仍无水（坏数据不配满杯）；hideBalance 打码只管读数，水不泄露数字。
   */
  const showWaves = !!s && s.status === 'ok' && (isPlan(s) ? pct != null : true)
  const fluidLvl = !showWaves || !s ? 0 : isPlan(s) ? fluidLevel(pct) : 1
  // 液面在 56 viewBox 里的高度：全屏水体的 clip 圆 r=27（圆心 28,28）→ 顶 1 / 底 55
  const surfaceY = 55 - fluidLvl * 54
  /**
   * 本皮肤波形（R1）：振幅/波长逐皮肤各一套（SKIN_WAVES 表），高光线与 A 层同参数。
   * skinId 与水色锚点走同一个 data-skin observer（一事一监听是浪费）。
   * ext 外部皮肤回退默认波形（不断裂）；漂移距离由 CSS --wave-len-* 同步（单测跨钉）。
   */
  const [skinId, setSkinId] = useState<string>(
    () => document.querySelector('.app')?.getAttribute('data-skin') ?? 'aero'
  )
  const waves = skinWaves(skinId)
  const waveA = useMemo(() => waveD(surfaceY, 0, waves.a.A, waves.a.L), [surfaceY, waves])
  const waveB = useMemo(() => waveD(surfaceY, 18, waves.b.A, waves.b.L), [surfaceY, waves])
  const waveC = useMemo(() => waveD(surfaceY, 9, waves.c.A, waves.c.L), [surfaceY, waves])
  const surfaceLine = useMemo(() => waveLine(surfaceY, 0, waves.a.A, waves.a.L), [surfaceY, waves])
  /** 泡沫带：与 A 同参数（见 waveBand 注释），B/C 冒头盖进泡沫里 */
  const foamBand = useMemo(() => waveBand(surfaceY, 0, waves.a.A, waves.a.L), [surfaceY, waves])
  /** 水柱方向：左右边竖柱（液高从底起）、上下边横槽（液宽从左起），与 shared/fluid.waterColumn 同口径 */
  const columnVertical = fluidEdgeAttr === 'left' || fluidEdgeAttr === 'right'
  /**
   * 水色锚点：当前皮肤的 --ok/--warn/--danger（.app 上读，见 water-color.ts）。
   * 换肤经 MutationObserver 重读 —— useState 存整套锚点对象，observer 只在 data-skin
   * 变化时触发，不存在"每渲染读一次 computed"的开销。
   */
  const [waterAnchors, setWaterAnchors] = useState<WaterAnchors>(() => readWaterAnchors())
  useEffect(() => {
    const app = document.querySelector('.app')
    if (!app) return
    const mo = new MutationObserver(() => {
      setWaterAnchors(readWaterAnchors())
      setSkinId(app.getAttribute('data-skin') ?? 'aero')
    })
    mo.observe(app, { attributes: true, attributeFilter: ['data-skin'] })
    return () => mo.disconnect()
  }, [])
  /**
   * 水体连续色（10-04-water-color-by-usage）：阈值处精确命中等级色，段间插值。
   * 用原始 pct（不用量化后的 fluidLvl）—— 液位不动的那几帧，颜色仍在走。
   * 余额类取 accent 实色（R4-6 实例，色值待用户看效果再定）；无水时 null，
   * CSS 的 lvl-* 兜底继续生效。
   */
  const water = !showWaves || !s ? null : isPlan(s) ? waterColor(pct, waterAnchors) : rgbStr(waterAnchors.accent)
  /**
   * 雨落点（R4-6）：满水时液面在顶（surfaceY=1），雨若落到 1 就只剩 9px 的 drizzle；
   * 钳到 24 —— 雨没入水体，溅落读作水花没入水中。套餐类用真实液面。
   */
  const pourSurfaceY = !s || isPlan(s) ? surfaceY : Math.max(surfaceY, 24)
  /**
   * 倒水入场（10-04-pour-in-slosh）：mount + 每次切供应商/窗口都播完整三段（G1 结论）。
   * `data-pour="in"` 挂载 → CSS 三段动画（灌入 600 / 冲顶 250 / 荡漾 1600，
   * 时序归 shared/fluid POUR_*）→ POUR_TOTAL_MS 后摘属性，不留尾巴。
   * reduced-motion 下不挂（直接终态，计时器不启动）；unmount/重切时清计时器。
   * reducedMotion 是 mount 时的一次性取值（换系统设置需重载窗口，不另起监听器）。
   */
  const [reducedMotion] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  const [pour, setPour] = useState<string | null>(() => (reducedMotion ? null : 'in'))
  useEffect(() => {
    if (reducedMotion) return
    setPour('in')
    const t = window.setTimeout(() => setPour(null), POUR_TOTAL_MS)
    return () => window.clearTimeout(t)
    // idx/winIdx 是唯一的重播信号；reducedMotion 已在 state 里，不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, winIdx])

  /**
   * 页面不可见时暂停波浪（三处暂停之一，另两处是 hidden 相位与 reduced-motion）。
   * CSS 动画在隐藏页签里本来也不绘制，但恢复可见那一刻会按「从没停过」跳一格 ——
   * 肉眼是一次液面抽动。挂一个类让它真的停，回来继续走（计时器不归这里管）。
   */
  const [docHidden, setDocHidden] = useState(false)
  useEffect(() => {
    const onVis = (): void => setDocHidden(document.hidden)
    setDocHidden(document.hidden)
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // 取帧钩子（--shots 用）：`window.__bd_fluid_freeze('stretch'|'bridge'|'stain')`
  // 把 goo 定在某一 morph 帧并暂停动画，`'pour-mid'|'pour-top'` 定在倒水入场中段
  // （10-04-pour-in-slosh，不依赖 data-pour 是否还在播 —— freeze 规则自带终态位移），
  // `'peek'` 定在悬停预览（P4：强制显现 peek 气泡，像素对拍 hover 不可达的态）。
  // `'off'` 恢复 live。纯呈现层冻结 ——
  // 返回值是 void（结构化克隆安全），与 __bd_ball 的数据钩子分开。
  useEffect(() => {
    const w = window as unknown as { __bd_fluid_freeze?: (stage: string) => void }
    w.__bd_fluid_freeze = (stage: string) => {
      const goo = document.querySelector('.petball-fallback')
      if (!goo) return
      if (stage === 'stretch' || stage === 'bridge' || stage === 'stain' || stage === 'pour-mid' || stage === 'pour-top' || stage === 'peek')
        goo.setAttribute('data-freeze', stage)
      else goo.removeAttribute('data-freeze')
    }
    return () => {
      delete w.__bd_fluid_freeze
    }
  }, [])

  // ─── 数字递增（R5）：显示值 ≠ 目标值 ───────────────────────────────────────
  /** 当前显示值（**渲染就读它**）；数值动画逐帧改写它 */
  const display = useRef(0)
  /** 显示值变化的重渲染信号：display 是 ref，改了不会自己触发渲染 */
  const [, setTick] = useState(0)
  const raf = useRef<number | null>(null)
  /** 上一次动画时的索引：区分「切窗口/切供应商」（从 0 涨）与「数据刷新」（从旧值补） */
  const pose = useRef({ idx: 0, winIdx: 0 })

  // 渲染期镜像：索引一变，**本帧**就把显示值归零。
  // 放在渲染里而不是 effect 里才有这个效果 —— 等 effect 再归零的话，新供应商会先闪
  // 一帧旧读数（`41%` → `0%` → 涨到新值）。与 App.tsx:78-84 的 ref 镜像同一写法：
  // 变换只在索引变化的那一帧发生，之后两值相同、不会重复改写（StrictMode 双渲染亦然）。
  if (pose.current.idx !== idx || pose.current.winIdx !== winIdx) {
    pose.current = { idx, winIdx }
    display.current = 0
  }

  const countUpKey = reading.k === 'num' ? reading.target : null
  useEffect(() => {
    const cancel = (): void => {
      if (raf.current !== null) {
        cancelAnimationFrame(raf.current)
        raf.current = null
      }
    }
    if (countUpKey === null) {
      // 读数不是数字（! / — / … / ••••）：停掉上一条动画（刷新打断上一次动画）。
      cancel()
      return
    }
    const target = countUpKey
    // 起点：切窗口/切供应商那一帧，渲染期镜像已经把 display 归零（见上面的 pose 判断），
    // 所以这里直接读它就是「切了 → 0、只是刷新 → 旧值」两种语义的分界（AC5.1 / 平时刷新）
    const from = display.current
    cancel() // 每次 start 前必须取消上一条，否则快速连切会有多条 rAF 并发（AC5.5）
    const commit = (v: number): void => {
      display.current = v
      setTick((t) => t + 1)
    }
    if (from === target) {
      commit(target)
      return
    }
    const t0 = performance.now()
    const step = (now: number): void => {
      const t = Math.min(1, (now - t0) / COUNTUP_MS)
      if (t >= 1) {
        // 收尾必须**精确赋目标值**：easeOut 末帧插值会留下 40.999999 这类尾差（AC5.2）
        commit(target)
        raf.current = null
        return
      }
      commit(from + (target - from) * (1 - (1 - t) ** 3))
      raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
    // countUpKey 已经是 target 的全部信息（lit 时为 null）；display 是 ref 镜像，不能进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countUpKey, idx, winIdx])

  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current)
    },
    []
  )

  /** 环心实际渲染的文本：非数值直接落定，数值按动画中的显示值格式化 */
  const shownText = reading.k === 'lit' ? reading.text : reading.fmt(display.current)

  const label = s?.name ?? ''

  /**
   * 覆盖层锚点横向夹紧（R8）：元素可能贴窗口两侧，而 .petball 是 overflow:hidden ——
   * 不夹的话贴边帧会被切成半截。
   * pad 取该元素 CSS 里保证的半宽上界（语音泡泡 max-width 62 → 半宽 31）。
   */
  const clampX = (x: number, pad: number): number => {
    const w = hostRef.current?.clientWidth ?? BALL_VIEW.width
    return Math.min(Math.max(x, pad), w - pad)
  }

  /**
   * 窗口像素尺寸：确认气泡的宽度上限要按它夹在窗内。
   */
  const [viewSize, setViewSize] = useState({ w: BALL_VIEW.width, h: BALL_VIEW.height })
  /**
   * 确认气泡实测高度：锚点是底边，高度一变锚点就得跟着动，否则顶出窗口被 overflow 裁掉。
   * 初值取最坏高度，第一帧就不夹错；实测回来后逐帧校正。
   */
  const [confirmH, setConfirmH] = useState(CONFIRM_BUBBLE_H)

  /**
   * 确认气泡的锚点与宽度上限（贴环心：窗口 56 宽、两侧各留余量后横向只剩 48px ——
   * 纵向要留给读数，所以只留按钮，文案与倒计时退给语音。见 skins.css 那一支）。
   * 命中区 = 环盒（56 宽）+ 主进程的 pad 3，两侧各留 3px 余量。
   */
  const confirmAnchor = {
    left: '50%',
    top: (viewSize.h - BALL_VIEW.height) / 2,
    // 命中区 = 环盒（56 宽）+ 主进程的 pad 3，两侧各留 3px 余量
    maxWidth: Math.min(62, viewSize.w - 8)
  }

  // ─── 交互 ───────────────────────────────────────────────────────────────────
  /** 复位指针状态（含主进程拖拽）：菜单弹出、指针在窗口外抬起、窗口失焦时都要调用 */
  const resetPress = useCallback(
    (endDrag = false): void => {
      const wasDown = press.current.down
      press.current = { down: false, moved: false, x: 0, y: 0 }
      if (endDrag && wasDown) onDragEnd()
    },
    [onDragEnd]
  )

  // 兜底：指针在窗口外抬起、窗口失焦、或指针取消时，按下状态必须复位，
  // 否则残留状态会让"移动鼠标 = 拖拽"，表现为主体黏着光标乱跑（只能再点一下才释放）
  useEffect(() => {
    const onGlobalUp = (): void => resetPress(true)
    const onBlur = (): void => resetPress(true)
    window.addEventListener('pointerup', onGlobalUp)
    window.addEventListener('pointercancel', onGlobalUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerup', onGlobalUp)
      window.removeEventListener('pointercancel', onGlobalUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [resetPress])

  const onPointerDown = (e: React.PointerEvent): void => {
    // 只处理主键：右键会弹原生菜单，此时若还进入"按下"状态，
    // 菜单关闭后残留的按下标记会把随后的鼠标移动误判成拖拽（"黏住光标"乱跑）
    if (e.button !== 0) return
    press.current = { down: true, moved: false, x: e.clientX, y: e.clientY }
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      // 合成事件/无效 pointerId：忽略
    }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    if (!press.current.down || press.current.moved) return
    // buttons 里没有主键 = 按下状态已经失效（指针抬起丢失/菜单抢走了事件序列）→ 复位，不起拖拽
    if ((e.buttons & 1) === 0) {
      resetPress()
      return
    }
    if (Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 8) {
      press.current.moved = true
      // 抓取点 = 按下时鼠标在窗口内的位置：拖动时该点始终贴着光标，球不会跳到光标中心
      const rc = (e.currentTarget as HTMLElement).getBoundingClientRect()
      onDragStart({ x: press.current.x - rc.x, y: press.current.y - rc.y })
    }
  }

  const finish = (cancel = false): void => {
    if (!press.current.down) return
    const wasMoved = press.current.moved
    press.current = { down: false, moved: false, x: 0, y: 0 }
    if (wasMoved || cancel) onDragEnd()
    else {
      // 痕迹态下单击 = 唤出（主进程滑出到贴边全可见），不展开（R3：无 hover 设备靠点击唤出）
      if (dockHidden) {
        window.api.dockReveal()
        return
      }
      // 点击 = 立即展开。
      onExpand()
    }
  }

  const openMenu = async (e: React.MouseEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    // 右键也要把按下状态清干净：原生菜单会抢走后续的 pointerup
    resetPress(true)
    const picked = await onMenu()
    resetPress(true)
    if (picked === 'rename') {
      // 改名已随人物形态下线：菜单里不再有这一项，走到这里说明主进程与渲染层版本不一致
      console.warn('[petball] 未知的菜单动作已忽略：', picked)
    }
  }

  // ─── 滚轮切换（R4）：上下切时限窗口、左右切供应商 ─────────────────────────

  /** 切时限窗口：单窗口供应商是空操作（AC3.4），多窗口按数组顺序循环、含回绕（AC3.1） */
  const stepWindow = (dir: number): void => {
    const n = s?.windows.length ?? 0
    if (n <= 1) return
    setWinIdx((i) => ((i % n) + dir + n) % n)
  }

  /** 分轴累积状态：触控板一次轻扫会连发几十个 wheel 事件（AC4.4 防的就是它） */
  const wheel = useRef({ accX: 0, accY: 0, lastX: 0, lastY: 0, lastEvent: 0 })

  const onWheel = (e: React.WheelEvent): void => {
    const now = performance.now()
    const dx = e.deltaX
    const dy = e.deltaY
    const st = wheel.current
    // ① 断流清残量 —— **必须写在累加之前**：acc 只在真的切了一次时归零，被 COOLDOWN
    //    挡下的事件一路往上垒，一个惯性手势下来能剩 1000+px；冷却过后下一次 1px 轻扫
    //    就过阈值了（误切一格、用户无感）。放累加之后等于先用残量判一次，等于没写。
    if (now - st.lastEvent > WHEEL_GESTURE_GAP) {
      st.accX = 0
      st.accY = 0
    }
    st.lastEvent = now
    // ② 每个事件只喂**主导轴**：斜向手势不至于同时切两个维度（AC4.2）
    if (Math.abs(dx) > Math.abs(dy)) {
      st.accX += dx
      // ③ 判据取 |累加量|，**方向取累加量的符号**（不是本事件的 dx 符号）：
      //    acc 里可能带着同手势内上一次同向的残量，用本事件的符号会让「累计量」与
      //    「方向」不自洽；带符号直接 `acc >= 60` 判断则对上滚/左滚永假（静默失效）。
      if (Math.abs(st.accX) >= WHEEL_THRESHOLD && now - st.lastX > WHEEL_COOLDOWN) {
        advanceProvider(st.accX > 0 ? 1 : -1) // 左右 = 换供应商（唯一入口，同时把窗口打回 windows[0]）
        st.accX = 0
        st.lastX = now
        holdUntil.current = Date.now() + MANUAL_HOLD_MS // 手动切换 → 自动轮播暂停 8 秒（AC4.3）
      }
    } else if (dy !== 0) {
      st.accY += dy
      if (Math.abs(st.accY) >= WHEEL_THRESHOLD && now - st.lastY > WHEEL_COOLDOWN) {
        stepWindow(st.accY > 0 ? 1 : -1) // 上下 = 切时限窗口
        st.accY = 0
        st.lastY = now
        holdUntil.current = Date.now() + MANUAL_HOLD_MS
      }
    }
  }

  /**
   * 球形态的 tooltip 后缀：当前看的是哪个时限（多窗口才有意义）+ 滚轮怎么用（没得切就不说）。
   */
  const ballHint = !s
    ? ''
    : `${s.windows.length > 1 && active ? ` · ${active.name}` : ''}${
        count > 1 || winCount > 1 ? ' · 滚轮：上下切时限，左右切供应商' : ''
      }`

  const tooltip = dockHidden
    ? '悬浮球已贴边隐藏 · 单击唤出 · 拖动移动'
    : s
      ? `${s.name}${ballHint}${pct != null ? ` · ${fmtPercent(pct)}` : ''}${
        isStale(s)
          ? `（${s.dataQuality === 'cached' ? '缓存数据 · ' + (dataTime(s) ? new Date(dataTime(s)!).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '') : '本机估算'}）`
          : ''
      } · 单击展开 · 拖动移动 · 右键菜单`
    : `单击展开 · 拖动移动 · 右键菜单`

  return (
    <div className={`petball lvl-${lvl}${hover ? ' hover' : ''} no3d`}>
      <div className="petball-stage" ref={hostRef} />

      {/* 主体以外的窗口区域不接收鼠标：命中层只覆盖小水球的范围 */}
      <div
        className="petball-hit"
        ref={hitRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => {
          try {
            ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
          } catch {
            // 忽略
          }
          finish()
        }}
        onPointerCancel={() => finish(true)}
        onContextMenu={(e) => void openMenu(e)}
        title={tooltip}
        role="button"
        tabIndex={-1}
      />

      {(
        // 2D 小水球：唯一的收起形态（不建 3D）。
        // data-ring：与 L1 **完全同源**的探针（--uitest 的 petBallCenterValue 靠它区分
        // 「套餐没环」= 回归 与 「余额没环」= 设计）。没有它，DOM 上两种情形长得一模一样，
        // 断言只能靠猜读数格式，余额一旦显示成百分比就会误判。
        // ⚠ 没有快照时是 ''（既非套餐也非余额 —— 此时 L1 本来就不画 SVG），不是 'balance'：
        //   写成 'balance' 会让断言在「一个供应商都没有」时照样绿（track 本来就没有），
        //   那是标签与机制对不上的永真兜底。
        <div
          className={`petball-fallback${docHidden ? ' doc-hidden' : ''}`}
          ref={fallbackRef}
          data-ring={s ? (isPlan(s) ? 'plan' : 'balance') : ''}
          data-fluid={fluid}
          data-edge={fluidEdgeAttr}
          data-pour={pour ?? undefined}
        >
          {/* 流体三元素（R2/R3 + design Fluid 节）：渐变球盘 + 液桥 blob + 贴边水渍 pill。
              挂 filter: url(#petball-goo) 的只有这一层 —— 环/数字/标记在它之外，
              读数永远 crisp（goo 只融合形状，不糊文字）。
              滤镜区裁到 56×56 内（filter x/y/width/height），避免全屏 blur 开销。 */}
          <div className="petball-goo" aria-hidden="true">
            <svg className="goo-defs" width="0" height="0" aria-hidden="true">
              <defs>
                <filter
                  id="petball-goo"
                  x="0"
                  y="0"
                  width="56"
                  height="56"
                  filterUnits="userSpaceOnUse"
                  colorInterpolationFilters="sRGB"
                >
                  <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
                  <feColorMatrix
                    in="blur"
                    mode="matrix"
                    values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7"
                    result="goo"
                  />
                  <feComposite in="SourceGraphic" in2="goo" operator="atop" />
                </filter>
                <clipPath id="fluid-clip">
                  <circle cx="28" cy="28" r="27" />
                </clipPath>
              </defs>
            </svg>
            <div className="fluid-disc" />
            {showWaves && (
              /* .slosh：倒水入场③荡漾的位移层（10-04-pour-in-slosh）。absolute 抽离 grid 流，
                 不参与环心两行的排布；transform 只跑合成器（见 skins.css pour-slosh）。 */
              <div className="slosh" aria-hidden="true">
                <svg className="fluid-waves" viewBox="0 0 56 56" aria-hidden="true">
                  <g clipPath="url(#fluid-clip)">
                    {/* 三层 fill 走内联连续水色（water）；CSS 的 lvl-* 填充保留为兜底 ——
                        内联色不可用时仍是三档，不透明不断裂（见 water-color.ts）。 */}
                    <path d={waveA} className="fluid-wave fluid-wave-a" style={{ fill: water ?? undefined }} />
                    <path d={waveB} className="fluid-wave fluid-wave-b" style={{ fill: water ?? undefined }} />
                    <path d={waveC} className="fluid-wave fluid-wave-c" style={{ fill: water ?? undefined }} />
                    {/* 深色后浪（P1）：B/C 冒头盖进深色里；白线已退役（CSS display:none） */}
                    <path d={foamBand} className="fluid-foam" />
                    <path d={surfaceLine} className="fluid-surface" />
                  </g>
                </svg>
              </div>
            )}
            <div className="fluid-bridge" />
            {/* 贴边水柱（10-03-holo-sphere 水满 + 10-04-edge-sip-column 温度计）：
                隐藏态的水渍 pill 改为水柱 —— 几何（竖柱/横槽、占满痕迹条）归
                shared/fluid.waterColumn，这里只摆液位与波浪：柱内液高/液宽 = 同一 fluidLvl，
                柱顶一条小波浪，水色跟 water（连续插值，CSS lvl 兜底；与球内水体同源同色）。
                温度计三件套：液头弯月（fill ::before，随水色走）+ 管壁三格刻度（.fluid-ticks，
                空槽也看得见）+ 管壁侧光（pill ::after）。液位 0 时只留空槽 + 不挂波浪，
                不造假水位。absorbing 灌满/revealing 缩走都只动位移，不碰高度值
                （高度是数据的，位移是演的 —— 见 skins.css column-rise）。 */}
            <div className="fluid-pill">
              <div
                className="fluid-column-fill"
                style={
                  columnVertical
                    ? { height: `${(fluidLvl * 100).toFixed(1)}%`, background: water ?? undefined }
                    : { width: `${(fluidLvl * 100).toFixed(1)}%`, background: water ?? undefined }
                }
              >
                {/* 柱顶小波浪：坐在液面上（fill 的顶部/前缘），液位 0 时 fill 高度
                    为 0，波浪无处附着 —— 与「不造假水位」同一条件，不单独再判。
                    hidden 态保持动画（柱内动荡，见 skins.css hidden 暂停名单）。 */}
                {fluidLvl > 0 && (
                  <>
                    <span className="fluid-column-wave" aria-hidden="true">
                      <svg viewBox="-4 0 16 3" preserveAspectRatio="none" aria-hidden="true">
                        <path d={COLUMN_WAVE_D} className="fluid-column-wave-path" />
                      </svg>
                    </span>
                    {/* 液内高光漂移（P3，原型 cshim 口径）：与柱顶波同条件挂载 ——
                        空槽不挂波浪也不挂光，不造假水位（K8k1）；hidden 下保持动画。 */}
                    <i className="fluid-shimmer" aria-hidden="true" />
                  </>
                )}
              </div>
              {/* 管壁刻度：纯装饰（aria-hidden），温度计读数感；空槽时也在（管子的刻度不依赖有没有水） */}
              <i className="fluid-ticks" aria-hidden="true" />
            </div>
          </div>
          {/* 环形进度（V1/V3/V5 环形态皮肤）：**替代**球内水体，同一数字只编码一次
              （用户拍板：环与水不共存 —— 两者同时在场等于同一个百分比被画两遍）。
              DOM 位置在 goo 容器**之外**（goo 只融合形状；2px 的弧经 stdDeviation=4
              会被 blur 吃掉，与雨/读数同一理由），摆位与 .fluid-disc 一致
              （left/top 50% + translate(-50%,-50%)），因此 hidden/absorbing/revealing
              三条既有 [data-fluid] 规则只要把本选择器加进去，就随 disc 一起收尽/回弹，
              不另写一套 morph。显隐走 --ring-display 令牌（水体皮 none，:root 缺省 none，
              外部皮肤零代码退回水体形态）。 */}
          {showWaves && (
            <div className="fluid-ring" aria-hidden="true">
              <svg viewBox="0 0 56 56" aria-hidden="true">
                {ringSvg(fluidLvl, water)}
              </svg>
            </div>
          )}
          {/* 雨是 crisp 覆盖层（R4-1 取证结论）：细雨滴经整容器 goo 滤镜会被 blur 吃掉
              （3px 滴在 stdDeviation=4 下糊成无色条 —— 5l 取证：DOM 全对但像素无色），
              而雨不需要与水体融合 —— 与读数同理，放在 goo 容器之外，
              靠 .pour-clip 自己的 circle 裁剪约束（r=27，不画出界）。 */}
          {showWaves && (
            <div className="pour-clip" aria-hidden="true">
              {POUR_DROPS.map((d, i) => (
                <div
                  key={i}
                  className={`pour-drop kind-${d.kind}`}
                  style={
                    {
                      left: `${d.left}%`,
                      background: water ?? undefined,
                      animationDelay: `${d.delay}ms`,
                      '--drop-dur': `${Math.round(POUR_FILL_MS * d.dur)}ms`,
                      '--drop-travel': `${Math.max(8, pourSurfaceY + 8).toFixed(1)}px`
                    } as React.CSSProperties
                  }
                />
              ))}
              {POUR_DROPS.filter((d) => d.kind === 'center').map((d, i) => (
                <span
                  key={`s${i}`}
                  className="pour-splash"
                  style={{
                    left: `${d.left}%`,
                    top: pourSurfaceY - 6,
                    animationDelay: `${d.delay + Math.round(POUR_FILL_MS * d.dur * 0.55)}ms`
                  }}
                />
              ))}
              <span
                className="pour-trickle left"
                style={{ top: pourSurfaceY, background: water ?? undefined }}
                aria-hidden="true"
              />
              <span
                className="pour-trickle right"
                style={{ top: pourSurfaceY, background: water ?? undefined }}
                aria-hidden="true"
              />
            </div>
          )}
          {/* 外圈进度环已退役（10-03-holo-sphere 水满 pivot）：进度唯一载体是球盘内的
              全屏水体（液位 = fluidLevel(pct)，余额类恒满；水色 = water 连续插值 / accent，
              CSS lvl 兜底）。data-ring 探针保留 ——
              它与「套餐画水 / 余额满水」的判定同源（--uitest 靠它区分「套餐没水」=
              回归 与 「余额没水」= 回归），删掉的话 DOM 上两种情形长得一模一样。
              ⚠ 没有快照时是 ''（既非套餐也非余额），不是 'balance'：写成 'balance'
              会让断言在「一个供应商都没有」时照样绿（水体本来就没有），那是标签与
              机制对不上的永真兜底。 */}
          {/* 供应商标记：10px 品牌色图标，环内数值正上方。
              复用 ProviderMark 的 markDataUrl/markColor，不引入新依赖。
              仅当 mark 字段存在且非空时显示（FR5）。 */}
          {s?.mark && (
            <span
              className="dot-provider"
              aria-hidden="true"
              style={{
                width: 10,
                height: 10,
                backgroundColor: markColor(s.mark) || 'currentColor',
                WebkitMaskImage: `url("${markDataUrl(s.mark)}")`,
                maskImage: `url("${markDataUrl(s.mark)}")`,
                opacity: 0.85,
                pointerEvents: 'none'
              }}
            />
          )}
          {/* 读数：数值走逐帧动画的显示值，非数值（! / — / … / ••••）直接落定；
              .small 按**落定后的目标值**分类，否则动画中途长度变化会来回切字号 */}
          <span
            className={`dot-value${valueText.length > 4 ? ' small' : ''}`}
            aria-label={`${s?.name ?? ''} 用量 ${shownText}`}
          >
            {shownText}
          </span>
          {/* 当前时限短标签（D3 已拍板：要，但只在多窗口时显示 —— 单窗口写 5H 是噪音）。
              没有它，切时限就只有数字在变，用户不知道停在 5H 还是周，功能等于盲切。 */}
          {active && s && s.windows.length > 1 && (
            <span className="dot-winlabel" aria-hidden="true">
              {shortWindowLabel(active.name)}
            </span>
          )}
          {/* 悬停 peek（P4，原型 D 区口径）：hidden 下柱上停留冒完整波浪预览，
              移开即散。纯视觉层（aria-hidden + CSS pointer-events:none），从不拦截点击 ——
              单击仍是唤出（dockReveal），悬停永不唤出。波浪/水色/读数全部复用本次渲染的
              waveA/water/shownText，不另起取数；落雨 3 滴固定位（原型 pk-drops 口径）。
              与柱顶波/shimmer 同条件（fluidLvl > 0）：空槽不挂预览，不造假水位。
              默认 opacity 0（5n 柱 shot 像素无影响）；--shots 经 data-freeze='peek' 强制显现。 */}
          {fluidLvl > 0 && (
            <div className="fluid-peek" aria-hidden="true">
              <svg className="fluid-peek-waves" viewBox="0 0 56 56" aria-hidden="true">
                <circle cx="28" cy="28" r="27" className="fluid-peek-bg" />
                {/* 预览跟随本体形态（P6）：环形态皮预览环、水体皮预览波，两者同一条件
                    由 CSS 的 --ring-display / --water-display 切换（不双份 DOM：
                    预览要预览的就是本体那张脸）。环复用同一个 ringSvg —— 弧长、弧色、
                    半径、线宽与本体逐值同源。 */}
                <g className="fluid-peek-ring">{ringSvg(fluidLvl, water)}</g>
                <g clipPath="url(#fluid-clip)">
                  <path d={waveA} className="fluid-peek-wave" style={{ fill: water ?? undefined }} />
                </g>
              </svg>
              <span className="fluid-peek-drop p1" aria-hidden="true" />
              <span className="fluid-peek-drop p2" aria-hidden="true" />
              <span className="fluid-peek-drop p3" aria-hidden="true" />
              <span className="fluid-peek-value">{shownText}</span>
            </div>
          )}
        </div>
      )}

      {!alertText && notice && (
        // 语音提醒的视觉通知：和确认气泡同族同位（环上方），读作临时的提示。
        //
        // ⚠ 有确认气泡时**不渲染**这个泡泡：两者共用环上方同一个位置，而 notice 的内容
        //   就是刚播完的那句 TTS（notice = ttsVisualText），确认气泡里已经是它的收敛版。
        //   一起画会叠在一起；让位给能点的那条是对的 —— 那条需要用户动手，这条只是回声。
        <div
          className="petball-bubble"
          style={{ left: clampX(BALL_VIEW.width / 2, 31), top: 46, maxWidth: 62 }}
          aria-hidden="true"
        >
          {notice}
        </div>
      )}
      {alertText && (
        // ⚠ 确认气泡是泡泡的**兄弟节点**，不是它的子节点 —— .petball-bubble 是
        //   aria-hidden="true" 的纯装饰（见上面），交互元素藏进去对辅助技术不可见，
        //   而且 aria-hidden 容器里的可聚焦元素会破坏「隐藏内容不可聚焦」。
        //   不新增浮层（NFR3）：它只是同位置多出来的一条小控件。
        // role="status" 挂在容器上，让播报内容作为状态变化被读出；真正的按钮在它**内部**，
        // 可聚焦、可点击（这不是 aria-hidden 装饰件）。
        <div ref={confirmRef} className="petball-confirm" style={confirmAnchor} role="status">
          <span className="petball-confirm-text">{alertText}</span>
          <span className="petball-confirm-foot">
            <span className="petball-confirm-eta" aria-hidden="true">
              {alertMinutes > 0 ? `${alertMinutes} 分钟后不再提示` : '即将不再提示'}
            </span>
            <button
              type="button"
              className="petball-confirm-btn"
              title="确认这条提醒，不再重复播报"
              aria-label="确认这条提醒，不再重复播报"
              onClick={() => onConfirmAlert?.()}
            >
              好的
            </button>
          </span>
        </div>
      )}
      {isStale(s ?? {}) && (
        // 可信度角标。小水球上也要有（2026-09-27 复核补上）：ballLevel() 只看 status、
        // 不看 dataQuality，所以缓存/本机估算的数字在小环上是和权威数据一模一样的绿/琥珀色，
        // 看上去就是实时值。tooltip 里虽然写了「（缓存数据 · 14:03）」，可那要悬停才看得到 ——
        // 而「数字在骗人」正是最该一眼看出的场景。角标只在该出现时出现，不是装饰。
        <div
          className="petball-badge"
          // 窗口只有 56×56：角标 10px 正方形，中心在 (89.9%, 10.1%)，
          // 离盘心最近的角距离 24.5（translate(-50%,-50%) 后的实测几何）。
          // 它本来就骑在盘缘上（旧盘 r=28，新水盘 r=27）—— 角标底是半不透
          // 明深色（见 .petball-badge），压住一小块水面不影响可读；而它绝不能
          // 再往外挪：10px 的块再往角落去会被 overflow:hidden 裁掉（旧方案 15px
          // 被裁的死结）。读数与水位才是进度载体，角标只是可信度注脚。
          style={{ left: '89.9%', top: '10.1%' }}
          aria-hidden="true"
        >
          <Icon name={s?.dataQuality === 'local' ? 'flask' : 'history'} size={7} />
        </div>
      )}
    </div>
  )
}
