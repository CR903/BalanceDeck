import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { PetId } from '../../../shared/pet'
import { BALL_VIEW, FIGURE_VIEW } from '../../../shared/pet-view'
import type { HumanClip } from './human'
import { readSkinTokens, shade, type Rgb, type SkinTokens } from './tokens'
import { sphereNdcHalf } from './viewfit'
import {
  BALL_CENTER_Y,
  BALL_RADIUS,
  BAND_R,
  BAND_TUBE,
  CAM_FOV,
  FORMS,
  GROUND_Y,
  HUMAN_HALF_D,
  HUMAN_HALF_W,
  HUMAN_HEIGHT,
  HUMAN_YAW,
  RING_HALO_TUBE,
  RING_R,
  RING_TUBE,
  SHELL_EDGE_R,
  type FormRig,
  type PetForm
} from './rig'

// ═══════════════════════════════════════════════════════════════════════════════
// 收起态 3D 场景：悬浮球（默认形态）／个性人物（可选形态）
//
// 两种形态共用同一套渲染，只有「窗口尺寸 + 机位 + 球体装饰是否可见」不同（见 rig.ts 的 FORMS）：
//   · 球形态：玻璃球 + 环形仪表，球内有角色但不显示；
//   · 个性人物：**没有球壳、没有用量环**，只有人物独立站在窗口中央（读数走窗口下方的胶囊）。
//
// 人物形态不做自主走动：人物占满竖版画布时，横向只剩 ±3 个世界单位可动 —— 那既看不出
// 「在走」，又必然被窗口裁掉张臂的肩膀。走动能力连同 walker/viewfit 一起留给后续形态
// （随机动作/进出场），当前两形态都是静止取景。
//
// 渲染质量：ACES 色调映射 + RoomEnvironment 环境光照（PBR 材质的关键）+
//   实时软阴影（角色投在地面上）+ 玻璃球壳的菲涅尔亮边与镜面高光。
//
// 单位：球外径 56（球心 y = BALL_CENTER_Y），角色脚踩 GROUND_Y。
// ═══════════════════════════════════════════════════════════════════════════════

// 机位/轮廓常量见 ./rig —— 单一来源，命中框投影与单测都从那里取

interface HumanRuntime {
  mixer: THREE.AnimationMixer
  root: THREE.Group
  actions: Record<HumanClip, THREE.AnimationAction>
  cur: HumanClip
  /** 剪辑自带根位移的抵消（见 human.ts 的 instantiateHuman） */
  cancelRootMotion: () => void
  /** 迄今抵消掉的根位移峰值（世界单位）——「素材到底漂不漂」的现场证据 */
  rootMotion: () => number
}

export type PetAction = 'idle' | 'happy' | 'eat' | 'sleep'

export interface BallFrame {
  /** 环形进度 0–100（null = 无数据） */
  percent: number | null
  /** 严重度（决定环色） */
  level: 'ok' | 'warn' | 'danger' | 'muted'
  /** 环心主文字（如 70.7%） */
  value: string
  /** 副文字（供应商名） */
  label: string
  /** 轮播位置指示 */
  pager: { count: number; index: number } | null
  /** 是否显示用量环（右键菜单可关） */
  showRing?: boolean
}

export interface Pet3dHandle {
  canvas: HTMLCanvasElement
  setFrame: (f: BallFrame) => void
  setPet: (id: PetId) => void
  setAction: (a: PetAction, ms?: number) => void
  /** 播放一次性角色动作（wave / talk），到时自动回到 idle；非真人系素材为空实现 */
  playAnim: (animName: HumanClip, durationSec: number) => Promise<void>
  setSkin: () => void
  /** 手动推进一步并渲染（测试用；常规由内部 rAF 驱动） */
  tick: (dt: number) => void
  setPaused: (paused: boolean) => void
  /** 命中区在窗口内的矩形（CSS 像素）：球形态 = 球的投影，人物形态 = 人物的投影 */
  hitRect: () => { x: number; y: number; width: number; height: number }
  /** 命中区中心投影到窗口 CSS 坐标（覆盖层的锚点） */
  hitCenter: () => { x: number; y: number }
  /** 测试观测点：真人系素材「剪辑自带根位移」被抵消掉的峰值（世界单位）；非真人系为 null */
  rootMotion: () => number | null
  /** 测试观测点：帧率与最长一帧间隔（软化/卡顿的现场证据；命中区变化后用 perf() 复核） */
  perf: () => { fps: number; maxGap: number }
  /** 测试观测点：从 WebGL 缓冲读出「有像素的范围」与不透明像素占比 */
  measure: () => { box: { x: number; y: number; width: number; height: number }; ratio: number } | null
  /** 测试观测点：宠物素材是否已就位 */
  petReady: () => boolean
  /** 测试观测点：场景里可见物体的清单（排查"不该出现的东西"） */
  dump: () => { name: string; type: string; visible: boolean; pos: number[]; size: number[] }[]
  /** 测试观测点：按序号隐藏/显示物体（逐个排除法定位视觉问题） */
  hideIndex: (i: number, on: boolean) => void
  dispose: () => void
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

export function createPet3dScene(
  host: HTMLElement,
  id: PetId,
  opts: { form?: PetForm } = {}
): Pet3dHandle {
  const form: PetForm = opts.form ?? 'ball'
  const rig: FormRig = FORMS[form]
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const canvas = document.createElement('canvas')
  canvas.className = 'pet3d-canvas'
  host.appendChild(canvas)

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: dpr <= 1.5,
    premultipliedAlpha: true,
    powerPreference: 'low-power'
  })
  renderer.setClearAlpha(0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  // 电影级色调映射 + 软阴影：3D 素材的质感主要靠这两项
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  // 软渲染器（SwiftShader / llvmpipe）下降采样并关阴影，保帧率
  const glInfo = (() => {
    try {
      const gl = renderer.getContext()
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''
    } catch {
      return ''
    }
  })()
  const softRenderer = /swiftshader|llvmpipe|software/i.test(glInfo)
  if (softRenderer) renderer.shadowMap.enabled = false
  // 关阴影时：光源不能再 castShadow（否则 ShadowMaterial 会采到空阴影图，
  // 把整个承接面渲染成一块深色圆盘 —— 软渲染器上实测就是这样），
  // 阴影承接面同时隐藏，改用脚下的软阴影贴图表达「踩在地上」。
  const shadows = renderer.shadowMap.enabled

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 1, 2000)
  camera.position.set(0, rig.lookY + rig.pitch, rig.camZ)
  camera.lookAt(0, rig.lookY, 0)

  // ─── 环境光照（PBR 质感的关键：没有环境贴图，模型会像塑料片）───────────────
  const pmrem = new THREE.PMREMGenerator(renderer)
  let envRT: THREE.WebGLRenderTarget | null = null
  try {
    envRT = pmrem.fromScene(new RoomEnvironment(), 0.04)
    scene.environment = envRT.texture
    scene.environmentIntensity = 0.55
  } catch {
    // 环境贴图不可用（极老驱动）→ 退回纯灯光
  }

  // ─── 灯光：key（投影）+ fill + rim ─────────────────────────────────────────
  const key = new THREE.DirectionalLight(0xffffff, 2.4)
  key.position.set(42, 86, 58)
  key.castShadow = shadows
  key.shadow.mapSize.set(512, 512)
  key.shadow.camera.near = 40
  key.shadow.camera.far = 220
  key.shadow.camera.left = -46
  key.shadow.camera.right = 46
  key.shadow.camera.top = 60
  key.shadow.camera.bottom = -10
  key.shadow.bias = -0.0015
  key.shadow.radius = 2.5
  const fill = new THREE.DirectionalLight(0xffffff, 0.5)
  fill.position.set(-58, 30, 42)
  const rim = new THREE.DirectionalLight(0xffffff, 1.0)
  rim.position.set(-16, 28, -62)
  const ambient = new THREE.AmbientLight(0xffffff, 0.24)
  scene.add(key, fill, rim, ambient)

  // ─── 几何登记（dispose 时统一释放）──────────────────────────────────────────
  const sceneGeo: THREE.BufferGeometry[] = []
  const track = <T extends THREE.BufferGeometry>(g: T): T => {
    sceneGeo.push(g)
    return g
  }

  // ─── 球的容器（球壳 + 环 + 阴影承接面都挂在球心）────────────────────────────
  // 人物形态下球体装饰整体隐藏（见 applyForm），但两个「地面」物体保留 ——
  // 它们表达的是「角色踩在地上」，与球壳无关。
  const shellGroup = new THREE.Group()
  shellGroup.position.set(0, BALL_CENTER_Y, 0)
  scene.add(shellGroup)

  // 球内底面：承接角色的实时阴影（ShadowMaterial 只画阴影，不遮住球内空间）
  const shadowFloor = new THREE.Mesh(
    track(new THREE.PlaneGeometry(BALL_RADIUS * 1.7, BALL_RADIUS * 1.7)),
    new THREE.ShadowMaterial({ opacity: 0.34, color: 0x0b0d12 })
  )
  shadowFloor.rotation.x = -Math.PI / 2
  shadowFloor.position.y = -BALL_RADIUS + 7
  shadowFloor.receiveShadow = true
  shadowFloor.visible = shadows
  shellGroup.add(shadowFloor)

  // 软阴影贴图（角色脚下的环境遮蔽，补足实时阴影的硬度）。
  // 几何做成 1×1、世界尺寸由 rig.shadowW 经 scale 给出 —— 两种形态的铺开直径差 2.6 倍。
  const blobTex = (() => {
    const c = document.createElement('canvas')
    c.width = c.height = 128
    const g = c.getContext('2d')!
    const grd = g.createRadialGradient(64, 64, 2, 64, 64, 62)
    grd.addColorStop(0, 'rgba(0,0,0,0.7)')
    grd.addColorStop(0.6, 'rgba(0,0,0,0.28)')
    grd.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = grd
    g.fillRect(0, 0, 128, 128)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  })()
  const blobMat = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, opacity: 0.4, depthWrite: false })
  const blob = new THREE.Mesh(track(new THREE.PlaneGeometry(1, 1)), blobMat)
  blob.rotation.x = -Math.PI / 2
  blob.position.y = -BALL_RADIUS + 7.25
  blob.scale.setScalar(rig.shadowW)
  shellGroup.add(blob)

  // ─── 玻璃球壳 ───────────────────────────────────────────────────────────────
  const shellMat = new THREE.MeshPhysicalMaterial({
    color: 0xdfe8f5,
    transparent: true,
    opacity: 0.12,
    roughness: 0.06,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    envMapIntensity: 1.1,
    depthWrite: false,
    side: THREE.DoubleSide
  })
  const shell = new THREE.Mesh(track(new THREE.SphereGeometry(BALL_RADIUS, 40, 28)), shellMat)
  shell.renderOrder = 8
  shellGroup.add(shell)

  const rimMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.34,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  })
  const rimShell = new THREE.Mesh(track(new THREE.SphereGeometry(BALL_RADIUS * 1.012, 32, 22)), rimMat)
  rimShell.renderOrder = 9
  shellGroup.add(rimShell)

  // 皮肤色暗边（不是黑边）：浅色壁纸/浅色皮肤下靠它立住轮廓
  const edgeMat = new THREE.MeshBasicMaterial({
    color: 0x33363d,
    transparent: true,
    opacity: 0.14,
    side: THREE.BackSide,
    depthWrite: false
  })
  const edgeShell = new THREE.Mesh(track(new THREE.SphereGeometry(SHELL_EDGE_R, 32, 22)), edgeMat)
  edgeShell.renderOrder = 8
  shellGroup.add(edgeShell)

  const specMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false })
  const spec = new THREE.Mesh(track(new THREE.SphereGeometry(3.6, 16, 12)), specMat)
  spec.scale.set(1.7, 1, 0.55)
  spec.position.set(-BALL_RADIUS * 0.36, BALL_RADIUS * 0.52, BALL_RADIUS * 0.72)
  shellGroup.add(spec)
  const specSm = new THREE.Mesh(track(new THREE.SphereGeometry(1.5, 12, 10)), specMat)
  specSm.position.set(BALL_RADIUS * 0.42, -BALL_RADIUS * 0.42, BALL_RADIUS * 0.62)
  specSm.scale.set(1.4, 0.7, 0.5)
  shellGroup.add(specSm)

  const bandMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.26,
    roughness: 0.2,
    metalness: 0.2,
    envMapIntensity: 1,
    depthWrite: false
  })
  const band = new THREE.Mesh(track(new THREE.TorusGeometry(BAND_R, BAND_TUBE, 8, 48)), bandMat)
  band.rotation.set(1.05, 0.35, 0.4)
  band.renderOrder = 9
  shellGroup.add(band)

  // ─── 环形仪表（球面正前方的管状进度环）──────────────────────────────────────
  const ringGroup = new THREE.Group()
  ringGroup.position.set(0, BALL_CENTER_Y, 0)
  scene.add(ringGroup)
  const trackMat = new THREE.MeshBasicMaterial({ color: 0x8a8a94, transparent: true, opacity: 0.42, depthWrite: false })
  const trackRing = new THREE.Mesh(track(new THREE.TorusGeometry(RING_R, RING_TUBE * 0.62, 10, 96)), trackMat)
  trackRing.renderOrder = 10
  ringGroup.add(trackRing)

  const fillMat = new THREE.MeshBasicMaterial({ color: 0x30d158 })
  let fillMesh: THREE.Mesh | null = null
  let fillGeo: THREE.TubeGeometry | null = null
  const capMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
  let cap: THREE.Mesh | null = null

  /** 进度弧：从 12 点方向顺时针（与 2D 圆点一致） */
  const buildFill = (pct: number): void => {
    const frac = clamp01(pct / 100)
    if (fillMesh) {
      ringGroup.remove(fillMesh)
      fillGeo?.dispose()
      fillMesh = null
      fillGeo = null
    }
    if (cap) {
      ringGroup.remove(cap)
      cap = null
    }
    if (frac <= 0.001) return
    const start = Math.PI / 2
    const sweep = -Math.PI * 2 * frac
    const segments = Math.max(10, Math.round(96 * frac))
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= segments; i++) {
      const a = start + (sweep * i) / segments
      pts.push(new THREE.Vector3(Math.cos(a) * RING_R, Math.sin(a) * RING_R, 0))
    }
    const curve = new THREE.CatmullRomCurve3(pts)
    fillGeo = new THREE.TubeGeometry(curve, Math.max(8, segments), RING_TUBE, 10, false)
    fillMesh = new THREE.Mesh(fillGeo, fillMat)
    fillMesh.renderOrder = 11
    ringGroup.add(fillMesh)
    if (frac > 0.02 && frac < 0.995) {
      cap = new THREE.Mesh(track(new THREE.SphereGeometry(RING_TUBE * 1.15, 12, 10)), capMat)
      const a = start + sweep
      cap.position.set(Math.cos(a) * RING_R, Math.sin(a) * RING_R, 0)
      cap.renderOrder = 12
      ringGroup.add(cap)
    }
  }

  const haloMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.1,
    depthWrite: false,
    side: THREE.BackSide
  })
  const halo = new THREE.Mesh(track(new THREE.TorusGeometry(RING_R, RING_HALO_TUBE, 8, 80)), haloMat)
  halo.renderOrder = 6
  ringGroup.add(halo)

  // ─── 人物（世界坐标里的独立容器）────────────────────────────────────────────
  // 角色放在**世界坐标**（不是球壳的子节点）：球壳与用量环只按球心定位，角色脚踩地面。
  // 人物形态下球体装饰整体隐藏，这个容器就是窗口里唯一可见的东西。
  const petGroup = new THREE.Group()
  petGroup.position.y = GROUND_Y
  // 模型固有朝向修正：只在建场景时写一次（人物形态不做走动，没有逐帧偏航）
  petGroup.rotation.y = HUMAN_YAW
  scene.add(petGroup)

  let petId: PetId = id
  let petHolder: THREE.Group | null = null
  let human: HumanRuntime | null = null
  let loadToken = 0

  const disposeCurrentPet = (): void => {
    if (petHolder) {
      petGroup.remove(petHolder)
      petHolder = null
    }
    if (human) {
      human.mixer.stopAllAction()
      human.mixer.uncacheRoot(human.root)
      human = null
    }
  }

  const attachPet = async (want: PetId): Promise<void> => {
    const token = ++loadToken
    try {
        // 真人系：骨骼模型 + mixer，失败只留球体（与 legacy 同样的兜底姿态）
        // 动态导入：human.ts 静态依赖 FBXLoader + SkeletonUtils（约 200KB），
        // 只有真的要用数字人形态时才值得付这个下载/解析成本（默认形态是悬浮球）。
        const { instantiateHuman } = await import('./human')
        const inst = await instantiateHuman(want, HUMAN_HEIGHT)
        if (token !== loadToken) {
          inst.dispose()
          return
        }
        disposeCurrentPet()
        petHolder = inst.group
        petHolder.visible = rig.ball === false
        petGroup.add(petHolder)
        const actions = {
          walk: inst.mixer.clipAction(inst.clips.walk),
          idle: inst.mixer.clipAction(inst.clips.idle),
          wave: inst.mixer.clipAction(inst.clips.wave),
          talk: inst.mixer.clipAction(inst.clips.talk)
        }
        actions.walk.setLoop(THREE.LoopRepeat, Infinity)
        actions.idle.setLoop(THREE.LoopRepeat, Infinity)
        actions.idle.play()
        human = {
          mixer: inst.mixer,
          root: inst.group,
          actions,
          cur: 'idle',
          cancelRootMotion: inst.cancelRootMotion,
          rootMotion: inst.rootMotion
        }
        if (inst.unbound.length > 0) {
          console.warn('[pet3d] 真人动作绑定缺失节点：', inst.unbound.join(','))
        }
        return
    } catch (e) {
      // 素材加载失败：只留球体，不影响 KPI（再次切换宠物会重试）
      console.error('[pet3d] 宠物模型加载失败：', e)
    }
  }
  // 球形态**不加载**人物素材：默认形态启动时既不下载 human 分包、也不解析 5 个 FBX
  // （开「个性人物」时 PetBall 会按新形态重建场景，那时才加载）。
  if (!rig.ball) void attachPet(petId)

  // ─── 状态 ───────────────────────────────────────────────────────────────────
  let clock = 0
  let action: PetAction = 'idle'
  let actionUntil = 0
  let frame: BallFrame = { percent: null, level: 'muted', value: '', label: '', pager: null }
  let ringOn = true
  let tokens: SkinTokens = readSkinTokens(host)
  let paused = false
  let raf = 0
  let last = performance.now()
  /** 命中区（CSS 像素）：球形态 = 球的投影，人物形态 = 人物的投影 */
  let hitBox = { x: 0, y: 0, width: 0, height: 0 }
  /** 窗口尺寸兜底：与主进程形态表同源（shared/pet-view，见 FORMS） */
  const view = form === 'ball' ? BALL_VIEW : FIGURE_VIEW
  /** 悬停浮沉幅度（世界单位）：人物形态下 0.6 ≈ 5px，读作「悬浮」而不是「抖动」 */
  const BOB_AMP = 0.6

  const applyTokens = (): void => {
    tokens = readSkinTokens(host)
    const t = tokens
    const shellRgb = t.dark ? shade(t.shell, 0.18) : shade(t.shell, -0.04)
    shellMat.color.setRGB(shellRgb.r, shellRgb.g, shellRgb.b)
    shellMat.opacity = t.dark ? 0.14 : 0.12
    bandMat.color.setRGB(shellRgb.r, shellRgb.g, shellRgb.b)
    bandMat.opacity = t.dark ? 0.24 : 0.26
    rimMat.opacity = t.dark ? 0.22 : 0.38
    specMat.opacity = t.gloss
    trackMat.color.setRGB(t.track.r, t.track.g, t.track.b)
    trackMat.opacity = t.dark ? 0.5 : 0.42
    haloMat.opacity = t.dark ? 0.16 : 0.1
    const edge = t.fg
    edgeMat.color.setRGB(edge.r * 0.6, edge.g * 0.6, edge.b * 0.6)
    edgeMat.opacity = t.dark ? 0.22 : 0.14
    // 没有实时阴影时，脚下的软阴影贴图要更明确一点
    blobMat.opacity = (t.dark ? 0.5 : 0.36) * (shadows ? 1 : 1.5)
    scene.environmentIntensity = t.dark ? 0.4 : 0.55
    ambient.intensity = t.dark ? 0.18 : 0.26
    refreshColors()
  }

  const levelRgb = (lvl: BallFrame['level']): Rgb => {
    if (lvl === 'danger') return tokens.danger
    if (lvl === 'warn') return tokens.warn
    if (lvl === 'muted') return tokens.muted
    return tokens.ok
  }

  const refreshColors = (): void => {
    const rgb = levelRgb(frame.level)
    fillMat.color.setRGB(rgb.r, rgb.g, rgb.b)
    capMat.color.setRGB(Math.min(1, rgb.r + 0.3), Math.min(1, rgb.g + 0.3), Math.min(1, rgb.b + 0.3))
  }

  // ─── 形态可见性 ─────────────────────────────────────────────────────────────
  /**
   * 形态 → 可见性。球形态：玻璃球 + 环 + 装饰带（人物隐藏）；人物形态：只有人物与脚下的阴影。
   * 一处收口，避免「球壳忘了隐藏」这类只在某条路径上出现的残留（dump() 可核对实际可见集）。
   */
  const applyForm = (): void => {
    const ballOn = rig.ball
    for (const m of [shell, rimShell, edgeShell, spec, specSm, band]) m.visible = ballOn
    ringGroup.visible = ballOn && ringOn
    if (petHolder) petHolder.visible = !ballOn
  }

  // ─── 尺寸与投影 ─────────────────────────────────────────────────────────────
  /**
   * 命中区 = 可见物在窗口里的投影（CSS 像素）：
   *   · 球形态：球心投影 ± 球投影半径（含悬停浮沉，球固定在 x=0、z=0 所以是常量）；
   *   · 人物形态：人物包围盒八角的投影外接矩形 —— 世界盒是常量，故矩形也是常量，
   *     不必每帧量 Box3（浮沉的 ±BOB_AMP 一并算进盒高，见下）。
   * 覆盖层（数值胶囊/泡泡/角标）的锚点也取它，两种形态同一套锚点口径。
   */
  const updateHitRect = (): void => {
    const w = host.clientWidth || view.width
    const h = host.clientHeight || view.height
    if (rig.ball) {
      const c = new THREE.Vector3(0, BALL_CENTER_Y, 0)
      const v = c.clone().project(camera)
      const { ny } = sphereNdcHalf(camera.position.distanceTo(c), BALL_RADIUS, CAM_FOV, w / h)
      const r = ny * (h / 2) * 0.98
      hitBox = { x: ((v.x + 1) / 2) * w - r, y: ((1 - v.y) / 2) * h - r, width: r * 2, height: r * 2 }
      return
    }
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const sx of [-1, 1]) {
      for (const sy of [0, 1]) {
        for (const sz of [-1, 1]) {
          const p = new THREE.Vector3(
            sx * HUMAN_HALF_W,
            GROUND_Y - BOB_AMP + sy * (HUMAN_HEIGHT + BOB_AMP * 2),
            sz * HUMAN_HALF_D
          ).project(camera)
          minX = Math.min(minX, p.x)
          maxX = Math.max(maxX, p.x)
          minY = Math.min(minY, p.y)
          maxY = Math.max(maxY, p.y)
        }
      }
    }
    hitBox = {
      x: ((minX + 1) / 2) * w,
      y: ((1 - maxY) / 2) * h,
      width: ((maxX - minX) / 2) * w,
      height: ((maxY - minY) / 2) * h
    }
  }

  const resize = (): void => {
    const w = host.clientWidth || view.width
    const h = host.clientHeight || view.height
    renderer.setSize(w, h, false)
    renderer.setPixelRatio(softRenderer ? Math.min(dpr, 1.25) : dpr)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    // 两种形态都不走动 → 命中区是常量，视口一变重算即可（不必每帧投影）
    updateHitRect()
  }
  const ro = new ResizeObserver(resize)
  ro.observe(host)
  resize()

  // ─── 帧循环 ─────────────────────────────────────────────────────────────────
  const applyAction = (now: number): void => {
    if (action !== 'idle' && now > actionUntil) action = 'idle'
  }

  const step = (dt: number): void => {
    clock += dt
    applyAction(performance.now())

    // 人物形态站着不动（走动见文件头注释）：位置恒在世界原点，只有悬停浮沉
    const bob = Math.sin(clock * 1.2) * BOB_AMP
    petGroup.position.set(0, GROUND_Y + bob, 0)
    // 浮起来时脚下阴影略微变淡变大，读作「离地」而不是「整体缩放」
    blob.scale.setScalar(rig.shadowW * (1 - bob * 0.02))

    // ─── 真人系位姿：骨骼动画（mixer），action → clip 交叉淡化 ──────────────────
    if (human) {
      human.mixer.update(dt)
      const want: HumanClip = action === 'happy' ? 'wave' : action === 'eat' ? 'talk' : 'idle'
      if (want !== human.cur) {
        const prev = human.actions[human.cur]
        const next = human.actions[want]
        const looped = want === 'idle'
        next.reset()
        next.setLoop(looped ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
        next.clampWhenFinished = !looped
        next.fadeIn(0.25).play()
        prev.fadeOut(0.25)
        human.cur = want
      }
      // 剪辑自带根位移：实测 walk 的根骨骼 z 曲线振幅 159.7cm（归一化后 ≈33 世界单位/循环）、
      // idle ≈12 —— 不抵消的话角色会自己往前滑再被循环边界瞬移回来。
      human.cancelRootMotion()
    }

    // 玻璃高光轻微游走（有光在动的感觉；人物形态下球壳不可见，跳过）
    if (rig.ball) {
      spec.position.x = -BALL_RADIUS * 0.36 + Math.sin(clock * 0.4) * 1.6
      spec.position.y = BALL_RADIUS * 0.52 + Math.cos(clock * 0.35) * 1.2
    }

    renderer.render(scene, camera)
  }

  // 观测点：帧率与最长一帧间隔。人物形态把人物放大了 3.5 倍（像素多 4 倍），
  // 软渲染器（无 GPU）下这是「看着卡不卡」的现场证据 —— 猜不如量。
  let fps = 0
  let fpsFrames = 0
  let fpsSince = performance.now()
  let maxGap = 0
  const loop = (): void => {
    raf = requestAnimationFrame(loop)
    const now = performance.now()
    if (now - last > maxGap) maxGap = now - last
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    fpsFrames++
    if (now - fpsSince >= 500) {
      fps = Math.round((fpsFrames * 1000) / (now - fpsSince))
      fpsFrames = 0
      fpsSince = now
    }
    if (paused || document.hidden) return
    step(dt)
  }
  raf = requestAnimationFrame(loop)

  applyTokens()
  applyForm()
  buildFill(frame.percent ?? 0)

  const handle: Pet3dHandle = {
    canvas,
    setFrame: (f) => {
      const pctChanged = (f.percent ?? -1) !== (frame.percent ?? -1)
      const levelChanged = f.level !== frame.level
      ringOn = f.showRing !== false
      frame = f
      if (pctChanged) buildFill(f.percent ?? 0)
      if (levelChanged || pctChanged) refreshColors()
      applyForm()
    },
    setPet: (want) => {
      if (want === petId) return
      petId = want
      void attachPet(want)
    },
    setAction: (a, ms = 1600) => {
      if (rig.ball) return // 球形态看不到角色，不播动作
      action = a
      actionUntil = performance.now() + ms
    },
    setSkin: () => applyTokens(),
    tick: (dt) => step(dt > 0 && dt <= 0.1 ? dt : 0.016),
    setPaused: (p) => {
      paused = p
      last = performance.now()
    },
    hitRect: () => ({ ...hitBox }),
    hitCenter: () => ({ x: hitBox.x + hitBox.width / 2, y: hitBox.y + hitBox.height / 2 }),
    perf: () => ({ fps, maxGap: Math.round(maxGap) }),
    rootMotion: () => (human ? Math.round(human.rootMotion() * 100) / 100 : null),
    petReady: () => petHolder !== null,
    /** 播放宠物动画（供 App.tsx 调用） */
    playAnim: async (animName: HumanClip, durationSec: number): Promise<void> => {
      // 抓住当前实例：await 期间模型可能被销毁或换掉（human 会被置 null），
      // 之后再解引用就会抛 "Cannot read properties of null (reading 'actions')"，
      // 而且是 unhandled rejection（调用方是 fire-and-forget 的动效）。
      const inst = human
      if (!inst) return
      // 停止当前所有动作
      inst.actions.idle.stop()
      inst.actions.walk.stop()
      // 播放指定动作
      const action = inst.actions[animName]
      action.reset()
      action.clampWhenFinished = true
      action.play()
      action.setLoop(THREE.LoopOnce, 1)
      // 等待动画播放完成
      await new Promise((resolve) => setTimeout(resolve, durationSec * 1000))
      // 回到 idle —— 先确认实例还在（被换掉就什么都不做）
      if (inst !== human) return
      inst.actions.idle.reset()
      inst.actions.idle.play()
    },
    hideIndex: (i, on) => {
      let n = 0
      scene.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        if (n++ === i) m.visible = on
      })
    },
    dump: () => {
      const out: { name: string; type: string; visible: boolean; self: boolean; parent: string | null; pos: number[]; size: number[] }[] = []
      scene.updateWorldMatrix(true, true)
      scene.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        const box = new THREE.Box3().setFromObject(m)
        const size = box.getSize(new THREE.Vector3())
        const c = box.getCenter(new THREE.Vector3())
        let eff = m.visible
        let p: THREE.Object3D | null = m.parent
        while (p && eff) {
          if (!p.visible) eff = false
          p = p.parent
        }
        out.push({
          name: m.name || m.geometry?.type || 'mesh',
          type: m.geometry?.type ?? '',
          visible: eff,
          self: m.visible,
          parent: m.parent ? `${m.parent.type}${(m.parent as THREE.Group).visible === false ? '(hidden)' : ''}` : null,
          pos: [Math.round(c.x), Math.round(c.y), Math.round(c.z)],
          size: [Math.round(size.x), Math.round(size.y), Math.round(size.z)]
        })
      })
      return out
    },
    measure: () => {
      renderer.render(scene, camera)
      const gl = renderer.getContext()
      const cw = renderer.domElement.width
      const ch = renderer.domElement.height
      if (!cw || !ch) return null
      const px = new Uint8Array(cw * ch * 4)
      gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, px)
      let minX = cw
      let minY = ch
      let maxX = -1
      let maxY = -1
      let hits = 0
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          if (px[(y * cw + x) * 4 + 3] > 8) {
            hits++
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
        }
      }
      if (maxX < 0) return { box: { x: 0, y: 0, width: 0, height: 0 }, ratio: 0 }
      const pr = renderer.getPixelRatio()
      return {
        box: {
          x: minX / pr,
          y: (ch - 1 - maxY) / pr,
          width: (maxX - minX + 1) / pr,
          height: (maxY - minY + 1) / pr
        },
        ratio: hits / (cw * ch)
      }
    },
    dispose: () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      loadToken++ // 让在途的加载结果作废
      if (human) {
        human.mixer.stopAllAction()
        human = null
      }
      petHolder = null
      for (const g of sceneGeo) g.dispose()
      sceneGeo.length = 0
      blobTex.dispose()
      for (const m of [shellMat, rimMat, edgeMat, specMat, bandMat, trackMat, fillMat, capMat, haloMat, blobMat]) {
        m.dispose()
      }
      envRT?.dispose()
      pmrem.dispose()
      renderer.dispose()
      canvas.remove()
    }
  }

  // 挂载全局状态访问器（供 App.tsx 调用）
  if (typeof window !== 'undefined') {
    ;(window as any).__bd_pet_scene__ = handle
  }

  return handle
}
