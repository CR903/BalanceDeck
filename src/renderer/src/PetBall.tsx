import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppState, ProviderSnapshot, ProviderWindow } from '../../shared/types'
import { type PetId, type PetState } from '../../shared/pet'
import { BALL_VIEW, FIGURE_VIEW } from '../../shared/pet-view'
import { isPlan } from '../../shared/quality'
import { level as fluidLevel, type FluidPhase } from '../../shared/fluid'
import { shortWindowLabel } from '../../shared/tray-text'
import { fmtAmount, fmtPercent, windowPercent, dataTime, isStale } from './format'
import { ballLevel, severityRank, worstWindow } from './read-model'
import { Icon } from './components'
import { markColor, markDataUrl } from './ProviderMark'
// ⚠ 这里只留**类型**导入 —— `import type` 会被 esbuild 整条擦掉，不产生运行时代码。
//    createPet3dScene 必须走下面 effect 里的动态 import，理由见那段注释（2026-10-01 修）。
import type { Pet3dHandle } from './pet3d/scene'

// ═══════════════════════════════════════════════════════════════════════════════
// 收起态，两种形态（尺寸见 shared/pet-view）：
//
//   · 球形态（默认）：**2D 小圆环** —— 56×56 窗口、SVG 环、环心一个数；
//     纯 DOM，不建 3D 场景、不占显存、不加载任何角色素材（首版设计，`d5a028e`）。
//   · 个性人物：three.js 场景，**只有人物**独立站在 213×293 竖版窗口中央
//     （无球壳、无用量环），读数走窗口下方的胶囊。
//
// 共同点：鼠标穿透（主进程按渲染层上报的命中区轮询）、单击展开、拖动移动、右键菜单。
// 定位是**数字助理**：没有喂食/亲密度那套养成互动（2026-09-21 下线）。
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
 * 波浪路径（水满进度的液面）：56 viewBox 内一条正弦液面 + 两侧下沉封口。
 * 幅 2.2 / 波长 28；phase 错开的两层以 1:1.6 的速度反向漂（PRD R9 双层错速）。
 * 纯视图构造（SVG 形状），共享契约（液位/相位/水渍几何）归 shared/fluid.ts。
 */
function waveD(surfaceY: number, phase: number): string {
  const A = 2.2
  const L = 28
  const parts: string[] = [`M -4 ${surfaceY.toFixed(2)}`]
  for (let x = -4; x <= 60; x += 4) {
    parts.push(`L ${x} ${(surfaceY + A * Math.sin(((x + phase) / L) * Math.PI * 2)).toFixed(2)}`)
  }
  parts.push('L 60 60 L -4 60 Z')
  return parts.join(' ')
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
  pet: PetState
  /** 收起态是否为「个性人物」形态（关闭 = 默认的 2D 小圆环，省显存/不加载角色素材） */
  figure: boolean
  onExpand: () => void
  onDragStart: (grab: { x: number; y: number }) => void
  onDragEnd: () => void
  /** 右键菜单：交给主进程弹原生菜单，返回被选中的 action */
  onMenu: () => Promise<string | null>
  onRename: (name: string) => void
  hideBalance: boolean
  /**
   * 语音提醒的视觉通知文案（'' = 无）。由 App 侧持有计时（12s 自动消失），本组件只负责
   * 显示 —— 它和角色自己的说话泡泡共用一个位置，两者都是「一句话的临时提示」，
   * 同时存在时通知优先：它带着余额数值，是用户真正要读的那句。
   */
  notice?: string
  /**
   * 待确认预警的原文（'' = 无待确认的预警，AC7）。由 App 从 alertOrchestrate 的待确认批次
   * 确认气泡要显示的那句（'' = 无待确认的预警，AC7）。App 从 alertOrchestrate 的待确认批次
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
  pet,
  figure,
  onExpand,
  onDragStart,
  onDragEnd,
  onMenu,
  onRename,
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
  /** 2D 小圆环本体：命中区按它的实测方块上报（球形态它就是整块窗口） */
  const fallbackRef = useRef<HTMLDivElement | null>(null)
  /** 确认气泡本体：它落在角色**头顶**（主体投影之外），命中区必须并进它才算点得动 */
  const confirmRef = useRef<HTMLDivElement | null>(null)
  const sceneRef = useRef<Pet3dHandle | null>(null)
  const [state, setState] = useState<AppState>({ snapshots: [], lastSync: null, scanning: false })
  const [idx, setIdx] = useState(0)
  /** 当前看的是该供应商的第几个时限窗口（仅内存，不落盘；球形态上下滚轮切换它） */
  const [winIdx, setWinIdx] = useState(0)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  /** 真人系语音泡泡（打招呼 / 余额播报，比 toast 大、停留更久，最多两行） */
  const [bubble, setBubble] = useState('')
  /** 测试观测点：命中环（--uitest / --shots 打开，用于核对人物投影与命中判定；球形态无投影） */
  const debugRing = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('bddebug')
  const [ringBox, setRingBox] = useState({ x: 0, y: 0, w: 0, h: 0 })
  /** 命中区中心（DOM 覆盖层对准它；两种形态都由 scene 按投影给出） */
  const [center, setCenter] = useState({ x: 100, y: 105 })
  /** 命中区半宽/半高：覆盖层按它上下避开主体（球 = 半径，人物 = 半身高） */
  const [half, setHalf] = useState({ w: 90, h: 95 })
  /**
   * 窗口像素尺寸：胶囊锚点要按它夹在窗内 —— 人物形态下主体几乎占满窗口，
   * 覆盖层一律贴窗口边（不是贴主体）才不会溢出被 overflow 切掉。
   */
  const [viewSize, setViewSize] = useState({ w: FIGURE_VIEW.width, h: FIGURE_VIEW.height })
  /**
   * 确认气泡实测高度：它比 .petball-bubble 高一截（多一行操作行），窗口只有 293px、
   * 角色头又在靠上位置，锚点必须按实测高度反推才不会顶出窗口被 overflow 裁掉（R8 同族）。
   * 初值取最坏高度，第一帧就不夹错；实测回来后逐帧校正。
   */
  const [confirmH, setConfirmH] = useState(CONFIRM_BUBBLE_H)
  /** 光标是否悬停在球上（主进程轮询回传）：悬停时停步，避免「抓不到」 */
  const [hover, setHover] = useState(false)
  const petRef = useRef(pet)
  petRef.current = pet
  const press = useRef({ down: false, moved: false, x: 0, y: 0 })
  const bubbleTimer = useRef<number | null>(null)
  /**
   * 测试观测点：球上的两个索引（`--uitest` 守「滚轮切窗口 / 换人唯一入口 / 人物形态不许切」）。
   * 渲染期镜像写法与 App.tsx:78-84 同源 —— 赋值放在渲染里（见 winCount 之后那行），
   * 读方是 `__bd_ball` 的纯数据钩子（可结构化克隆，函数不能进那个 payload）。
   * 人物形态没有可见的窗口索引，不去掉 `onWheel` 首行的 figure 守卫就只能靠它测出来。
   */
  const idxMirror = useRef({ idx: 0, winIdx: 0, winCount: 0 })

  useEffect(() => {
    void window.api.getState().then(setState)
    return window.api.onState(setState)
  }, [])

  useEffect(
    () => () => {
      if (bubbleTimer.current !== null) window.clearTimeout(bubbleTimer.current)
    },
    []
  )

  /** 真人系泡泡：4.2s 后自动消失；新泡泡顶掉旧泡泡 */
  const showBubble = (msg: string, ms = 4200): void => {
    setBubble(msg)
    if (bubbleTimer.current !== null) window.clearTimeout(bubbleTimer.current)
    bubbleTimer.current = window.setTimeout(() => setBubble(''), ms)
  }

  // ─── 3D 场景（仅个性人物形态；挂载一次，换角色走 setPet，皮肤变化走 setSkin）────
  //
  // ⚠ `./pet3d/scene` 必须是**动态** import，且不能改回顶层静态 import（2026-10-01 实测后改）：
  //   scene.ts:1 静态 `import * as THREE from 'three'`，静态 import 会把 three.js 本体
  //   （实测 1,298,574 B）打进入口 chunk —— 首屏 1,699,669 B 的 **76%** 是它，
  //   而默认的球形态压根用不到（球形态在下面 `if (!figure) return` 就走了）。
  //   改后实测：入口 489,106 B（原 1,699,669 B，−71%），three 独立成 1,182,414 B 的
  //   three-*.js，CDP 取证里球形态首屏对它的请求数 = **0**，切人物形态时才出现。
  //   配套的 manualChunks 在 electron.vite.config.ts —— **两条缺一不可**：
  //     · 只拆 chunk 不改 import = 白拆（实测拆包前后球形态 V8 堆 5.7 vs 5.4 MB，
  //       拆 chunk 只影响何时*下载*，不影响何时*解析*）
  //     · 只改 import 不拆 chunk：vite 可能因 scene.ts 与 human.ts 同时引用 three
  //       而把它并回入口（仓库既有先例：App.tsx 的 voice.ts 就因为同时被静态+动态引用
  //       而被 vite 合并，构建时会有一条 dynamic-import 警告）
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    // 球形态**不建场景**。不是「建一个空场景」：createPet3dScene 在 scene.ts:151 无条件
    // `new THREE.WebGLRenderer`，省显存是这一版的硬要求（2026-09-27 用户原话：默认状态下
    // 桌面只有一个安静的小环，不占显存、不加载任何 3D 资源）。所以由调用方跳过构造，
    // 而不是给场景加一个「什么都不渲染」的形态 —— 后者照样占着 GPU 上下文。
    if (!figure) return
    let handle: Pet3dHandle | null = null
    // 动态 import 多出一个 await 空窗：这期间组件可能已经卸载 / 形态又切回去了。
    // 没有这个闸，加载完成后会把一个没人要的场景挂到 sceneRef 上（泄漏 + 幽灵 dispose）。
    let alive = true
    void import('./pet3d/scene')
      .then(({ createPet3dScene }) => {
        if (!alive) return
        try {
          handle = createPet3dScene(host, petRef.current.id)
        } catch (e) {
          // WebGL 不可用（老显卡/驱动异常）→ 退回 2D 小圆环，功能不丢
          setFailed(true)
          console.error('[pet3d] 初始化失败，退回 2D 小圆环：', e)
          return
        }
        sceneRef.current = handle
        // ⚠ setReady 必须落在 import 之后：ready 的下游（命中区上报 / 皮肤重算 /
        //   __bd_ball 的 petReady）都假定「3D 已就位」，报早了会拿一个不存在的场景算投影。
        setReady(true)
        // 上一轮失败留下的 failed 必须复位，否则「人物→球→人物」再来一次时，
        // 即便这次 WebGL 正常，也会被上一次的 failed 钉在 2D 兜底上（人物形态看得见人，
        // 但走的是 2D 环）。failed 只在失败分支里置 true，不复位就是单向棘轮。
        setFailed(false)
      })
      .catch((e) => {
        if (!alive) return
        // **chunk 加载失败**（文件缺失 / 打包漏了该 chunk / 网络不可达）——
        // 这是动态 import 引入的**新**失败模式。它的正确表现与 WebGL 失败完全相同：
        // 退回 2D 圆环。缺了这一段，three chunk 取不到时是**白屏**而不是兜底。
        setFailed(true)
        console.error('[pet3d] 场景模块加载失败，退回 2D 小圆环：', e)
      })
    return () => {
      alive = false
      // handle 可能还没被赋值（import 还没回来）；那种情况 alive 闸已经让上面不建场景，
      // 这里不需要额外处置 —— 没有 handle 就没有需要 dispose 的东西。
      handle?.dispose()
      sceneRef.current = null
      setReady(false)
    }
    // 形态切换要换窗口尺寸，直接重建场景最省心（换角色走 handle 的 setPet）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [figure])

  // 角色切换：换人 + 自报家门（进场动作由场景在模型就位那一刻自己播，见 scene.ts）
  //
  // `figure` 必须进依赖数组并在函数体里守卫（2026-09-27 修）：
  // 球形态里没有人，原实现无条件 `showBubble('你好，我是…～')`，
  // 于是「未开启个性人物」时点一下球也会冒出人物打招呼的泡泡。
  // 放进依赖是有意的：球 → 人物形态切换时角色"到场"，自报家门合理。
  useEffect(() => {
    sceneRef.current?.setPet(pet.id)
    if (figure) showBubble(`你好，我是${pet.name}～`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pet.id, figure])

  // 皮肤：主进程推送时 App 会重挂 data-skin，等一帧让 CSS 变量生效再重读令牌
  useEffect(() => {
    const t = window.setTimeout(() => sceneRef.current?.setSkin(), 60)
    return () => window.clearTimeout(t)
  }, [pet.id, ready])

  // 测试钩子：让 --uitest / --shots 能读到真实像素范围与命中区
  useEffect(() => {
    // ⚠️ 返回值必须是「可结构化克隆」的纯数据：里面塞函数会让 executeJavaScript
    //    的结果无法回传（报 An object could not be cloned）。调试用的操作型钩子
    //    单独挂在 window.__bd_hide 上。
    const w = window as unknown as {
      __bd_ball?: () => unknown
      __bd_hide?: (i: number, on: boolean) => void
      __bd_gesture?: (id: string) => Promise<void>
    }
    w.__bd_ball = () => ({
      // 索引观测点（渲染期镜像 idxMirror，纯数据）：人物形态没有可见的窗口索引，
      // 「滚轮在人物形态下什么都不做」全靠它才断言得出来
      idx: idxMirror.current.idx,
      winIdx: idxMirror.current.winIdx,
      winCount: idxMirror.current.winCount,
      rect: sceneRef.current?.hitRect() ?? null,
      center: sceneRef.current?.hitCenter() ?? null,
      rootMotion: sceneRef.current?.rootMotion() ?? null,
      perf: sceneRef.current?.perf() ?? null,
      stride: sceneRef.current?.stride() ?? 0,
      gesture: sceneRef.current?.gesture() ?? null,
      pose: sceneRef.current?.pose() ?? null,
      travel: sceneRef.current?.travel() ?? null,
      clipParseMs: sceneRef.current?.clipParseMs() ?? 0,
      measure: sceneRef.current?.measure() ?? null,
      petReady: sceneRef.current?.petReady() ?? false,
      dump: sceneRef.current?.dump() ?? []
    })
    w.__bd_hide = (i, on) => sceneRef.current?.hideIndex(i, on)
    // 动作触发口（测试用）：--uitest 要能在收起态下驱动一次退场，核对"真的走出去了"
    w.__bd_gesture = (id) => sceneRef.current?.playGesture(id as never) ?? Promise.resolve()
    return () => {
      delete w.__bd_ball
      delete w.__bd_hide
      delete w.__bd_gesture
    }
  }, [ready])

  useEffect(() => {
    const el = document.querySelector('.app')
    if (!el) return
    const obs = new MutationObserver(() => sceneRef.current?.setSkin())
    obs.observe(el, { attributes: true, attributeFilter: ['data-skin'] })
    return () => obs.disconnect()
  }, [])

  // 鼠标停在主体上时通知场景（主进程轮询回传，用于 hover 反馈）
  useEffect(() => {
    return window.api.onPetCursor?.((over) => setHover(over)) ?? (() => {})
  }, [])

  // 点击穿透：把主体的屏幕矩形报给主进程（窗口里只有那一块接收鼠标）
  const reportHit = useCallback(() => {
    const host = hostRef.current
    const hw = host?.clientWidth || BALL_VIEW.width
    const hh = host?.clientHeight || BALL_VIEW.height
    let box: { x: number; y: number; width: number; height: number }
    const handle = sceneRef.current
    if (!handle) {
      // 无 3D 场景时按 **2D 小圆环的实测方块** 上报，不写死尺寸：
      //   · 球形态恒走这里，窗口 56×56 本身就是那个环 → 整块窗口可点（主进程再外扩 pad=3）
      //   · 人物形态只在这里出现（WebGL 初始化失败），窗口 213×293、环仍是 56×56，
      //     所以必须按它在窗口里的**居中位置**算，不能拿整块窗口去撑成一个 213×293 的热点。
      // 旧实现一律回退到「居中 60×60 + FIGURE_VIEW 兜底值」，两个尺寸都写错了。
      const el = fallbackRef.current
      const w = el?.clientWidth || BALL_VIEW.width
      const h = el?.clientHeight || BALL_VIEW.height
      box = { x: (hw - w) / 2, y: (hh - h) / 2, width: w, height: h }
    } else {
      const r = handle.hitRect()
      const pad = 6
      box = { x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 }
    }

    // 确认气泡在角色**头顶**，超出主体投影矩形 —— 主进程只按这个矩形决定窗口哪块收鼠标
    // （overlay.ts 的 cursorInsideHit），不把它并进来的话气泡就是「画得出、点不动」。
    // 只在气泡可见时才并：平时不给角色头顶多一块挡到桌面的死区。
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
    // 命中区随视口（scene 的 ResizeObserver）变化 → 持续刷新（90ms 与主进程光标轮询同频）。
    // 同一个矩形同时喂给覆盖层锚点：中心 + 半宽/半高，一处口径。
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
      const h = sceneRef.current
      if (!h) return
      const r = h.hitRect()
      const c = { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      setCenter((prev) => (Math.abs(prev.x - c.x) < 0.5 && Math.abs(prev.y - c.y) < 0.5 ? prev : c))
      setHalf((prev) =>
        Math.abs(prev.w - r.width / 2) < 0.5 && Math.abs(prev.h - r.height / 2) < 0.5
          ? prev
          : { w: r.width / 2, h: r.height / 2 }
      )
      const host = hostRef.current
      if (host) {
        const w = host.clientWidth
        const h = host.clientHeight
        setViewSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
      }
      if (debugRing) setRingBox({ x: r.x, y: r.y, w: r.width, h: r.height })
    }, 90)
    return () => window.clearInterval(t)
  }, [ready, figure, reportHit, debugRing])

  // ─── 轮播 ───────────────────────────────────────────────────────────────────
  const snaps = useMemo(() => [...state.snapshots].sort((a, b) => severityRank(a) - severityRank(b)), [state.snapshots])
  const count = snaps.length

  /**
   * `idx`（换人）的**唯一出口** —— 自动轮播与滚轮横向步进都必须调它。
   * 换人 → 窗口索引固定落回 `windows[0]`（PRD §6 已拍板的 Q1=B：上下滚动的起始点可预期），
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
      if (count <= 1) return // 只有一位时「换人」是空操作：也不该把用户选好的窗口打回 0
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
   * ⚠ 一条**被实测推翻**的说法，别照抄：曾写「把窗口相关的量放进依赖数组 → lastAdvance
   *   归零 → 6 秒永远走不到 → 球彻底静止」。实测（uitest 两轮，各把 live.current.winIdx
   *   和一个每渲染都变的量塞进 deps）**静止不了**：tick 先把 lastAdvance 置成 now 再改状态，
   *   effect 紧接着重跑又置成同一个 now，两者相差不到 1ms，节奏仍是 6 秒。真实代价是上面
   *   两条（定时器 churn + 基准漂移），不是卡死。live ref 仍是对的写法，但理由按实测写。
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
      // 先在同一家里把窗口走完（5H → 周 → 月），走完才换人 —— 旧行为只换供应商、
      // 且永远停在 windows[0]，用户看到的正是「快速切供应商但从不切时限」（R4）。
      // 单窗口供应商：n > 1 不成立 → 直接换人，不空转一步（AC4.2）；充值余额供应商
      // 没有环但走同一条路径（AC4.6），不为视觉特殊-case。
      if (n > 1 && w + 1 < n) {
        setWinIdx((i) => (i + 1) % n)
      } else {
        advanceProvider(1) // ← 换人的同一个入口：窗口落回 windows[0]
      }
    }, 1000)
    return () => window.clearInterval(t)
    // ⚠ 依赖里只有 count / advanceProvider（后者本身只依赖 count）。**不要**把任何
    //   窗口相关的量（live、winIdx、s）加进来 —— 理由与实测见 live 的注释。
  }, [count, advanceProvider])

  const s: ProviderSnapshot | undefined = count ? snaps[idx % count] : undefined

  /** 主指标：最接近限额的窗口（选择规则归 read-model，三处视图同一份）——**人物形态**用它 */
  const worst = useMemo(() => worstWindow(s), [s])

  /** 当前供应商有几个时限窗口（球形态上下滚轮在其中逐个切换） */
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

  /** 球形态选中的窗口；status 非 ok 时不选窗口 —— 与 worstWindow 同口径（出错/无数据没有可读的窗口） */
  const wBall: ProviderWindow | undefined =
    s && s.status === 'ok' && winCount ? s.windows[Math.max(0, Math.min(winIdx, winCount - 1))] : undefined

  /**
   * 本次读数用哪个窗口（环、等级、读数、短标签都从它取，不会各选各的）：
   *   · 人物形态固定 `worstWindow()` —— R6 要求脚下的读数胶囊与改动前逐位相同
   *   · 球形态用滚轮选中的 `winIdx` —— R3 的多时限逐个显示
   */
  const active = figure ? worst : wBall

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

  /** 落定后的完整读数：人物形态胶囊、余额播报、tooltip 用它（人物形态不做数字动画，R6） */
  const valueText = reading.k === 'lit' ? reading.text : reading.fmt(reading.target)

  /**
   * 2D 小圆环的呈现条件（三种情形，缺一不可）：
   *   · 球形态：恒为真 —— 它本来就是 2D（这一版没有 3D 球）
   *   · 人物形态 + WebGL 初始化失败：`failed` 兜底，老显卡/驱动异常时仍要有可用界面
   * 这一条不能因为「球形态已经是 2D 了」顺手删掉：它服务的是**人物形态的失败路径**。
   * 放在这里（而不是 return 之前）是因为下面的数字动画也要按它分流：人物形态的读数
   * 走 valueText（静态，R6 要求逐位不变），动画只在真有 .dot-value 时才跑。
   */
  const dot2d = !figure || failed

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
  /** 水满只在套餐类挂波浪（余额类保持素盘）；算不出比例（pct == null）也不挂假液位 */
  const showWaves = !figure && !!s && isPlan(s) && pct != null
  const fluidLvl = showWaves ? fluidLevel(pct) : 0
  // 液面在 56 viewBox 里的高度：clip 圆 r=17（圆心 28,28）→ 顶 11 / 底 45
  const surfaceY = 45 - fluidLvl * 34
  const waveA = useMemo(() => waveD(surfaceY, 0), [surfaceY])
  const waveB = useMemo(() => waveD(surfaceY, 14), [surfaceY])

  // 取帧钩子（--shots 用）：`window.__bd_fluid_freeze('stretch'|'bridge'|'stain')`
  // 把 goo 定在某一 morph 帧并暂停动画，`'off'` 恢复 live。纯呈现层冻结 ——
  // 返回值是 void（结构化克隆安全），与 __bd_ball 的数据钩子分开。
  useEffect(() => {
    const w = window as unknown as { __bd_fluid_freeze?: (stage: string) => void }
    w.__bd_fluid_freeze = (stage: string) => {
      const goo = document.querySelector('.petball-fallback')
      if (!goo) return
      if (stage === 'stretch' || stage === 'bridge' || stage === 'stain') goo.setAttribute('data-freeze', stage)
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
    if (countUpKey === null || !dot2d) {
      // 读数不是数字（! / — / … / ••••），或压根没有 .dot-value（人物形态）：
      // 停掉上一条动画（刷新打断上一次动画）。人物形态的胶囊渲染静态 valueText（R6），
      // 但 display 仍要落定到目标值，否则「人物 → 球」切换会拿一个陈旧中间值当起点。
      cancel()
      if (countUpKey !== null) display.current = countUpKey
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
   * 覆盖层锚点横向夹紧（R8）：主体可能投影到窗口两侧，而 .petball 是 overflow:hidden ——
   * 不夹的话贴边帧会被切成半截。
   * pad 取该元素 CSS 里保证的半宽上界（caption max-width 140 → 70；bubble max-width 190+padding → 106）。
   */
  const clampX = (x: number, pad: number): number => {
    const w = hostRef.current?.clientWidth ?? FIGURE_VIEW.width
    return Math.min(Math.max(x, pad), w - pad)
  }

  /**
   * 确认气泡的锚点与宽度上限。
   *
   * **为什么在头顶、不在脚边**：原先它是一条白色不透明胶囊横跨在角色腿上（`center.y + half.h - 30`），
   * 在一整个人物形象前读起来像系统通知贴在身体上 —— 2026-09-30 的反馈正是这一点。
   * 现在它和 .petball-bubble 同族同位（角色头顶、尖角朝下），读作「角色在说」，
   * 也顺势把角色腿部让出来。
   *
   * **代价：必须扩大命中区。** 主进程只按渲染层上报的那**一个**矩形决定窗口哪一块接收鼠标
   * （main/overlay.ts 的 cursorInsideHit，未命中即 setIgnoreMouseEvents 穿透到桌面）。
   * 气泡在主体投影**之外**，不并进那个矩形就是「画得出、点不动」—— 并进的动作在 reportHit 里。
   * 2D 环那一支不需要（球形态整块窗口就是命中区），位置也照旧贴环心。
   *
   * **垂直空间的实测账（2026-09-30 ballshot 实测）**：人物窗口 213×293，角色投影 rect.y = 39.5，
   * 也就是头顶以上只有 39.5px 可用，而气泡高 48.2px —— **注定要压住发冠约 11px**，没有
   * 「完全在头顶上方」的解。要么压脸，要么把文案挤进一行（那样 eta 与按钮放不下）。
   * 所以这里把间隙收到 2px（普通语音泡泡给 4px），把重叠压到最小：压的是头顶那撮头发，
   * 不是五官；加上尖角朝下指向角色，读起来仍是「角色在说话」。
   */
  const confirmAnchor = dot2d
    ? {
        left: '50%',
        top: (viewSize.h - BALL_VIEW.height) / 2,
        // 命中区 = 环盒（56 宽）+ 主进程的 pad 3，两侧各留 3px 余量
        maxWidth: Math.min(62, viewSize.w - 8)
      }
    : {
        left: clampX(center.x, 95),
        // 锚点是气泡**底边**（transform: translate(-50%,-100%)），贴角色头顶上方 2px；
        // 再按实测高度夹一个下限（离窗口顶留 2px 呼吸位）—— 窗口只有 293px 而角色头在靠上
        // 位置，不夹会顶出窗口被 .petball 的 overflow:hidden 裁掉
        //（与 .petball-bubble 的 R8 同一类问题）。
        // 量不到实测高度（首帧）用最坏高度兜底，不用 0。
        top: Math.max((confirmH > 0 ? confirmH : CONFIRM_BUBBLE_H) + 2, center.y - half.h - 2),
        maxWidth: 190
      }

  useEffect(() => {
    sceneRef.current?.setPaused(renaming)
  }, [renaming])

  // 余额播报：每 90s 冒一次主指标泡泡（valueText 已含余额显隐与诚实口径）。
  // 数据变化会重置计时（新数据值得先播），球形态（没有人可以说话）即停。
  useEffect(() => {
    if (!figure || failed) return
    if (!s || s.status !== 'ok') return
    const stale = isStale(s) ? (s.dataQuality === 'cached' ? '（缓存）' : '（估算）') : ''
    const text = `${label} ${valueText}${stale}`
    const t = window.setTimeout(() => {
      showBubble(text)
      // 播报是"说话"的场合：让人物比划着讲（动作目录里的 talk，剪辑按需加载）
      void sceneRef.current?.playGesture?.('talk')?.catch?.(() => {})
    }, 90_000)
    return () => window.clearTimeout(t)
  }, [pet.id, figure, failed, s, valueText, label])

  // ─── 交互 ───────────────────────────────────────────────────────────────────
  /** 复位指针状态（含主进程拖拽）：菜单弹出、指针在窗口外抬起、窗口失焦时都要调用 */
  const resetPress = useCallback((endDrag = false): void => {
    const wasDown = press.current.down
    press.current = { down: false, moved: false, x: 0, y: 0 }
    if (endDrag && wasDown) onDragEnd()
  }, [onDragEnd])

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
    if (renaming) return
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
    else if (!renaming) {
      // 痕迹态下单击 = 唤出（主进程滑出到贴边全可见），不展开（R3：无 hover 设备靠点击唤出）
      if (dockHidden) {
        window.api.dockReveal()
        return
      }
      // 点击 = 立即展开。挥手动画**不阻塞**：等 1.5s 动画播完再展开，既是体验问题
      // （点一下要等一秒半），也会让 UI 断言在 700ms 的等待窗口里读不到展开后的窗口。
      // 球形态没有人可挥（2026-09-27 修：原来无条件挥手），但**展开照常**。
      if (figure) {
        const scene = (window as any).__bd_pet_scene__
        void scene?.playGesture?.('wave')?.catch?.(() => {})
      }
      onExpand()
    }
  }

  const openMenu = async (e: React.MouseEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    if (renaming) return
    // 右键也要把按下状态清干净：原生菜单会抢走后续的 pointerup
    resetPress(true)
    sceneRef.current?.setPaused(true)
    const picked = await onMenu()
    resetPress(true)
    sceneRef.current?.setPaused(false)
    if (picked === 'rename') {
      setNameDraft(pet.name)
      setRenaming(true)
    }
  }

  const commitRename = (): void => {
    const name = nameDraft.trim()
    if (name) onRename(name)
    setRenaming(false)
  }

  // ─── 滚轮切换（R4）：上下切时限窗口、左右切供应商 ─────────────────────────

  /** 切时限窗口：单窗口供应商是空操作（AC3.4），多窗口按数组顺序循环、含回绕（AC3.1） */
  const stepWindow = (dir: number): void => {
    const n = s?.windows.length ?? 0
    if (n <= 1) return
    setWinIdx((i) => (((i % n) + dir + n) % n))
  }

  /** 分轴累积状态：触控板一次轻扫会连发几十个 wheel 事件（AC4.4 防的就是它） */
  const wheel = useRef({ accX: 0, accY: 0, lastX: 0, lastY: 0, lastEvent: 0 })

  const onWheel = (e: React.WheelEvent): void => {
    // ⚠ 第一行守卫：人物形态**也渲染** .petball-hit，不挡住的话人物形态下滚轮照样会
    //   切窗口、切时限（R6 违规 —— 这是本步最容易漏的一处）。早退后滚轮照旧穿透到
    //   桌面：不新增命中区（AC4.5），也不调 preventDefault（React 的 onWheel 是
    //   passive 语义，调了只会告警；.petball 本来就无可滚动祖先）。
    //   判据是 `figure`（人物形态）本身 —— 写成 `!figure` 会正好挡住球形态，
    //   人球两种形态的表现整体互换（2026-09-27 出过一次，被步 7 的断言当场抓住）。
    if (figure) return
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
        advanceProvider(st.accX > 0 ? 1 : -1) // 左右 = 换人（唯一入口，同时把窗口打回 windows[0]）
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
   * 球形态才补的两句（人物形态的 tooltip 与改动前逐字相同，R6）：
   * 当前看的是哪个时限（多窗口才有意义）+ 滚轮怎么用（没得切就不说）。
   */
  const ballHint =
    figure || !s
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
    <div
      className={`petball lvl-${lvl}${hover ? ' hover' : ''}${dot2d ? ' no3d' : ''}`}
      data-pet={pet.id}
      data-figure={figure ? '1' : '0'}
    >
      <div className="petball-stage" ref={hostRef} />

      {/* 主体以外的窗口区域不接收鼠标：命中层只覆盖 scene 上报的那块投影范围 */}
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

      {dot2d && (
        // 2D 小圆环：球形态的**正常**呈现（不建 3D），也是人物形态 WebGL 失败时的兜底。
        // 这段 JSX 就是首版（`d5a028e` 的 CollapsedDot）的那份，逻辑早已在 PetBall 里
        // 重写过一遍（严重度排序 / 轮播 / 8px 拖拽 / tooltip），搬回旧组件会多出一份状态来源。
        // data-ring：与 L1 **完全同源**的探针（--uitest 的 petBallCenterValue 靠它区分
        // 「套餐没环」= 回归 与 「余额没环」= 设计）。没有它，DOM 上两种情形长得一模一样，
        // 断言只能靠猜读数格式，余额一旦显示成百分比就会误判。
        // ⚠ 没有快照时是 ''（既非套餐也非余额 —— 此时 L1 本来就不画 SVG），不是 'balance'：
        //   写成 'balance' 会让断言在「一个供应商都没有」时照样绿（track 本来就没有），
        //   那是标签与机制对不上的永真兜底。
        <div
          className="petball-fallback"
          ref={fallbackRef}
          data-ring={s ? (isPlan(s) ? 'plan' : 'balance') : ''}
          data-fluid={fluid}
          data-edge={fluidEdgeAttr}
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
                  <circle cx="28" cy="28" r="17" />
                </clipPath>
              </defs>
            </svg>
            <div className="fluid-disc" />
            {showWaves && (
              <svg className="fluid-waves" viewBox="0 0 56 56" aria-hidden="true">
                <g clipPath="url(#fluid-clip)">
                  <path d={waveA} className="fluid-wave fluid-wave-a" />
                  <path d={waveB} className="fluid-wave fluid-wave-b" />
                </g>
              </svg>
            )}
            <div className="fluid-bridge" />
            <div className="fluid-pill" />
          </div>
          {/* 环的三层判定（缺一层就少画一层，不合并成一个大布尔）：
              L1 只有**套餐**（plan）供应商有环 —— 充值余额连轨道都不画，只留素圆盘 + 金额
                 （判定与主卡片同一个 isPlan()，卡片说余额、球不会说套餐）
              L2 轨道与 pct **解耦**：套餐即使这个窗口算不出比例（无 limit）也必须有轨道。
                  沿用「pct != null 才画」会把它显示成素圆盘 —— 用户会读成「这个供应商
                  没环」，与 L2 的「余额才没环」自相矛盾（AC3.3）
              L3 填充弧才需要 pct：算不出比例就没有弧，绝不画 0% 的假弧（数据诚实） */}
          {s && isPlan(s) && (
            <svg viewBox="0 0 56 56" aria-hidden="true">
              <circle className="dot-ring-track" cx="28" cy="28" r="22" fill="none" strokeWidth="5" />
              {pct != null && (
                <circle
                  className="dot-ring-fill"
                  cx="28"
                  cy="28"
                  r="22"
                  fill="none"
                  strokeWidth="5"
                  strokeLinecap="round"
                  strokeDasharray={`${(2 * Math.PI * 22 * Math.min(100, Math.max(0, pct))) / 100} ${2 * Math.PI * 22}`}
                  transform="rotate(-90 28 28)"
                />
              )}
            </svg>
          )}
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
        </div>
      )}

      {/* 下方胶囊（供应商名 + 轮播点）只在人物形态出现：球形态的窗口只有 56×56，
          胶囊最宽 140px 会被 .petball 的 overflow:hidden 切掉；它的读数位就是上面的环心数字。 */}
      {figure && !failed && (
        <div
          className="petball-caption"
          style={{
            left: clampX(center.x, 70),
            // 优先贴在主体下方，但**夹在窗内**（窗口矮，按半身高推会溢出被切）
            top: Math.min(center.y + half.h + 20, viewSize.h - 26)
          }}
          aria-hidden="true"
        >
          <span className={`petball-value${valueText.length > 5 ? ' small' : ''}`}>{valueText}</span>
          {label && <span className="petball-label">{label}</span>}
          {count > 1 && (
            <span className="petball-dots">
              {snaps.slice(0, 6).map((_, i) => (
                <i key={i} className={i === idx % count ? 'on' : ''} />
              ))}
            </span>
          )}
        </div>
      )}

      {debugRing && ringBox.w > 0 && (
        <div
          className="petball-debugring"
          style={{
            left: ringBox.x,
            top: ringBox.y,
            width: ringBox.w,
            height: ringBox.h,
            // 只可能是人物形态：ringBox 由 3D 场景的 hitRect 填，球形态没有场景，w 恒为 0
            borderRadius: 10
          }}
          aria-hidden="true"
        />
      )}
      {!alertText && (notice || bubble) && (
        // 锚点是泡泡底边（translate(-50%,-100%)）：主体上方留白有限，两行文案高 46px，
        // 所以上移量最多 4 再按高度兜底，否则第一行被窗口顶切掉（R8）
        //
        // ⚠ 有确认气泡时**不渲染**这个泡泡：两者共用头顶同一个位置，而 notice 的内容
        //   就是刚播完的那句 TTS（notice = ttsVisualText），确认气泡里已经是它的收敛版。
        //   一起画会叠在一起；让位给能点的那条是对的 —— 那条需要用户动手，这条只是回声。
        <div
          className="petball-bubble"
          style={{ left: clampX(center.x, 95), top: Math.max(46, center.y - half.h - 4) }}
          aria-hidden="true"
        >
          {notice || bubble}
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
      {isStale(s ?? {}) && !failed && (
        // 可信度角标。**球形态也要有**（2026-09-27 复核补上）：ballLevel() 只看 status、
        // 不看 dataQuality，所以缓存/本机估算的数字在小环上是和权威数据一模一样的绿/琥珀色，
        // 看上去就是实时值。tooltip 里虽然写了「（缓存数据 · 14:03）」，可那要悬停才看得到 ——
        // 而「数字在骗人」正是最该一眼看出的场景。角标只在该出现时出现，不是装饰。
        <div
          className="petball-badge"
          // 人物形态贴右上肩侧。球形态窗口只有 56×56：环的 stroke 外缘在 r=24.5（圆心 28,28），
          // 空角沿 45° 对角线到盒角（距圆心 39.6）只有 15.1px，15px 的角标必然压弧或被
          // overflow:hidden 裁掉（实测 15px 落在 (37,5)-(52,20)，最近角距圆心仅 12.0）。
          // 所以球形态缩到 10px。注意是**正方形**：离圆心最近的是角不是边中点，半对角线
          // 5√2≈7.07，所以圆心要放到 24.5+7.07=31.57 才真正内切。百分比坐标跟着 viewBox 走。
          style={
            figure
              ? { left: clampX(center.x + half.w * 0.62, 8), top: center.y - half.h * 0.62 }
              : { left: '89.9%', top: '10.1%' }
          }
          aria-hidden="true"
        >
          <Icon name={s?.dataQuality === 'local' ? 'flask' : 'history'} size={figure ? 9 : 7} />
        </div>
      )}

      {renaming && (
        <div className="petball-rename">
          <input
            autoFocus
            value={nameDraft}
            maxLength={12}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setRenaming(false)
            }}
            onBlur={commitRename}
            aria-label="助理名字"
          />
        </div>
      )}
    </div>
  )
}
