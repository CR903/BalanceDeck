import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { PetId, PetMood } from '../../../shared/pet'
import { isHumanPet } from '../../../shared/pet'
import { ROAM_VIEW } from '../../../shared/pet-view'
import { hasPetModel, instantiatePet } from './models'
import { instantiateHuman, HUMAN_YAW, type HumanClip } from './human'
import { readSkinTokens, shade, type Rgb, type SkinTokens } from './tokens'
import { fitRoamArea, sphereNdcHalf } from './viewfit'
import {
  BALL_CENTER_Y,
  BALL_RADIUS,
  BAND_R,
  BAND_TUBE,
  CAM_DISTANCE,
  CAM_FOV,
  CAM_PITCH,
  CAM_Y,
  HUMAN_HEIGHT,
  PET_HEIGHT,
  RING_HALO_TUBE,
  RING_R,
  RING_TUBE,
  ROAM_DEPTH_BUDGET,
  ROAM_FIT_MARGIN,
  SHELL_EDGE_R,
  SILHOUETTE_R
} from './rig'
import {
  DEFAULT_WALKER,
  initialWalker,
  setWalkerAction,
  stepWalker,
  type Gait,
  type WalkerConfig,
  type WalkerState
} from './walker'

// ═══════════════════════════════════════════════════════════════════════════════
// 收起态 3D 场景：悬浮球（默认形态）／桌面宠物（可选形态）
//
// 两种形态共用同一套渲染，只有「窗口尺寸 + 是否放角色 + 是否自主走动」不同：
//   · 球形态（roam=false）：玻璃球 + 环形仪表，球在窗口中央轻轻浮动；
//   · 桌面宠物（roam=true）：球内站着 CC0 3D 素材角色（见 models.ts），会在球内走动。
//
// 渲染质量：ACES 色调映射 + RoomEnvironment 环境光照（PBR 材质的关键）+
//   实时软阴影（角色投在球内底面上）+ 玻璃球壳的菲涅尔亮边与镜面高光。
//
// 单位：球外径 56（球心 y = BALL_CENTER_Y），角色脚踩球内底面。
// ═══════════════════════════════════════════════════════════════════════════════

// 机位/轮廓常量见 ./rig —— 单一来源，viewfit 与单测都从那里取

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

export interface Pet3dStats {
  mood: PetMood
  affection: number
  fullness: number
}

export interface Pet3dHandle {
  canvas: HTMLCanvasElement
  setFrame: (f: BallFrame) => void
  setPet: (id: PetId) => void
  setStats: (s: Pet3dStats) => void
  setAction: (a: PetAction, ms?: number) => void
  /** 播放一次性角色动作（wave / talk），到时自动回到 idle；非真人系素材为空实现 */
  playAnim: (animName: HumanClip, durationSec: number) => Promise<void>
  /** 球形态 / 桌面宠物形态（决定是否放角色与走动） */
  setRoam: (roam: boolean) => void
  setSkin: () => void
  /** 手动推进一步并渲染（测试用；常规由内部 rAF 驱动） */
  tick: (dt: number) => void
  setPaused: (paused: boolean) => void
  /** 球体在窗口内的包围盒（CSS 像素，含投影），用于点击穿透命中判定 */
  ballRect: () => { x: number; y: number; width: number; height: number }
  /** 球心投影到窗口 CSS 坐标 */
  ballCenter: () => { x: number; y: number }
  /** 测试观测点：当前按视口反算出的漫游边界（世界单位）；裁切门禁拿它和 ink box 对照 */
  roamArea: () => { halfX: number; halfZ: number }
  /** 测试观测点：漫游状态机的当前位置（世界单位）；与 dump 的世界包围盒对照可测剪辑根位移漂移 */
  walkerPos: () => { x: number; z: number; gait: string }
  /** 诊断：把宠物钉到指定世界坐标（BD_PIN_POS 用；越界时被夹进可行区） */
  setPin: (x: number, z: number) => void
  /** 测试观测点：真人系素材「剪辑自带根位移」被抵消掉的峰值（世界单位）；非真人系为 null */
  rootMotion: () => number | null
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
  opts: { walker?: Partial<WalkerConfig>; roam?: boolean } = {}
): Pet3dHandle {
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
  camera.position.set(0, BALL_CENTER_Y + CAM_PITCH, CAM_DISTANCE)
  camera.lookAt(0, BALL_CENTER_Y, 0)

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

  // ─── 球的容器（球壳 + 环 + 阴影承接面都随球移动）──────────────────────────
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

  // 软阴影贴图（角色脚下的环境遮蔽，补足实时阴影的硬度）
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
  const blob = new THREE.Mesh(track(new THREE.PlaneGeometry(BALL_RADIUS * 1.5, BALL_RADIUS * 1.5)), blobMat)
  blob.rotation.x = -Math.PI / 2
  blob.position.y = -BALL_RADIUS + 7.25
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
  // ─── 宠物（3D 素材，异步加载 + 程序化位姿动画）──────────────────────────────
  // 角色放在**世界坐标**里（不是球壳的子节点）：球壳以轻微延迟跟随角色移动，
  // 若把角色挂在球壳下再按世界坐标赋值，位置会被叠加两次（角色跑到球外）。
  // 抬高 4 个单位：视觉上更居中，也给球底阴影留出空间。
  const petGroup = new THREE.Group()
  // 世界坐标：脚踩球内底面（球心 - 半径 + 抬高量）
  petGroup.position.y = BALL_CENTER_Y - BALL_RADIUS + 7
  scene.add(petGroup)

  let roam = opts.roam === true
  let petId: PetId = id
  let petHolder: THREE.Group | null = null
  let human: HumanRuntime | null = null
  let loadToken = 0
  /** 姿态动画相位（素材无骨骼，靠整体变换表达动作） */
  const pose = { phase: 0, time: 0, gait: 0 }

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
      if (isHumanPet(want)) {
        // 真人系：骨骼模型 + mixer，失败只留球体（与 legacy 同样的兜底姿态）
        const inst = await instantiateHuman(want, HUMAN_HEIGHT)
        if (token !== loadToken) {
          inst.dispose()
          return
        }
        disposeCurrentPet()
        petHolder = inst.group
        petHolder.visible = roam
        petGroup.add(petHolder)
        // 按真实包围盒重算漫游区：body 轮廓换了，halfZ/halfX 也跟着收放
        refitArea()
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
      }
      if (!hasPetModel(want)) return
      const inst = await instantiatePet(want, PET_HEIGHT)
      if (token !== loadToken) {
        inst.dispose()
        return
      }
      disposeCurrentPet()
      // 动画层与归一化层分离：inst.group 自带「缩放/居中」变换，
      // 动画只动外层容器，不会把归一化缩放覆盖掉（曾因此把模型缩回原始尺寸而看不见）
      const anim = new THREE.Group()
      anim.add(inst.group)
      petHolder = anim
      petHolder.visible = roam
      petGroup.add(petHolder)
      refitArea()
    } catch (e) {
      // 素材加载失败：只留球体，不影响 KPI（再次切换宠物会重试）
      console.error('[pet3d] 宠物模型加载失败：', e)
    }
  }
  void attachPet(petId)

  // ─── 状态 ───────────────────────────────────────────────────────────────────
  // area 由**本场景自己持有**：resize() 按视口原地改写它（stepWalker 每帧读 cfg.area，天然生效）。
  // 不复用 DEFAULT_WALKER.area，否则兜底常量会被上一个创建的场景的尺寸污染。
  const walkerCfg: WalkerConfig = {
    ...DEFAULT_WALKER,
    ...(opts.walker ?? {}),
    area: { ...(opts.walker?.area ?? DEFAULT_WALKER.area) }
  }
  let walker: WalkerState = initialWalker(walkerCfg)
  let gaitBlend = 0
  let clock = 0
  let idleTimer = 0
  let stats: Pet3dStats = { mood: 'fine', affection: 60, fullness: 70 }
  let action: PetAction = 'idle'
  let actionUntil = 0
  let actionStart = 0
  let frame: BallFrame = { percent: null, level: 'muted', value: '', label: '', pager: null }
  let tokens: SkinTokens = readSkinTokens(host)
  let paused = false
  let raf = 0
  let last = performance.now()
  let ballScreen = { x: 0, y: 0, r: BALL_RADIUS }

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

  // ─── 尺寸与投影 ─────────────────────────────────────────────────────────────
  /** 球心投影 → 窗口坐标（命中框用；随球移动每帧更新） */
  const updateBallScreen = (): void => {
    const w = host.clientWidth || ROAM_VIEW.width
    const h = host.clientHeight || ROAM_VIEW.height
    const ballPos = new THREE.Vector3(shellGroup.position.x, BALL_CENTER_Y, shellGroup.position.z)
    const v = ballPos.clone().project(camera)
    const dist = camera.position.distanceTo(ballPos)
    const { ny } = sphereNdcHalf(dist, BALL_RADIUS, CAM_FOV, w / h)
    ballScreen = {
      x: ((v.x + 1) / 2) * w,
      y: ((1 - v.y) / 2) * h,
      r: ny * (h / 2) * 0.98
    }
  }

  /**
   * 宠物本体的反算轮廓（包围球近似）：attach 后按**实际世界包围盒**测得——
   * 半径取 bbox 对角线的一半（形状无关的保守上界，也盖住步伐起伏/bob），
   * 中心高度取包围盒世界 y 中点。未就位时按目标身高 ×0.62 保守估计
   * （0.62 = aria/ray 实测包围球半径 ÷ 身高，Q 版更矮胖也仍覆盖）。
   *
   * 注意 three 的 SkinnedMesh.boundingBox 是**懒算后缓存**的（Box3.expandByObject 只在它为
   * null 时算一次），所以这里拿到的一直是绑定姿态的盒子：实测 aria 25.2×36×6.3 → r=22.19、
   * ray 26.6×36×6.9 → r=22.65。绑定态是张臂的 A-pose，比任何行走姿态都宽（行走中最坏 r≈20.9）
   * → 当保守上界用正合适，而且不会逐帧抖动让边界忽大忽小。
   */
  const bodySilhouette = (): { radius: number; centerY: number } => {
    const feetY = BALL_CENTER_Y - BALL_RADIUS + 7
    const h = isHumanPet(petId) ? HUMAN_HEIGHT : PET_HEIGHT
    if (!petHolder) return { radius: h * 0.62, centerY: feetY + h / 2 }
    const box = new THREE.Box3().setFromObject(petHolder)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    return { radius: Math.hypot(size.x, size.y, size.z) / 2, centerY: center.y }
  }

  /** 视口 → 漫游区反算：resize 与「换宠物」后都要重跑（body 轮廓随素材变） */
  const refitArea = (): void => {
    const fit = fitRoamArea({
      fovDeg: CAM_FOV,
      camY: CAM_Y,
      camZ: CAM_DISTANCE,
      lookY: BALL_CENTER_Y,
      viewW: host.clientWidth || ROAM_VIEW.width,
      viewH: host.clientHeight || ROAM_VIEW.height,
      // C1：球壳/环/装饰带外沿，恒定停在 z=0（R7）
      shell: { radius: SILHOUETTE_R, centerY: BALL_CENTER_Y },
      // C2：宠物本体，在 (±halfX, ±halfZ) 任意组合处完整可见（R9）
      body: bodySilhouette(),
      margin: ROAM_FIT_MARGIN,
      depthBudget: ROAM_DEPTH_BUDGET
    })
    walkerCfg.area.halfX = fit.halfX
    walkerCfg.area.halfZ = fit.halfZ
  }

  const resize = (): void => {
    const w = host.clientWidth || ROAM_VIEW.width
    const h = host.clientHeight || ROAM_VIEW.height
    renderer.setSize(w, h, false)
    renderer.setPixelRatio(softRenderer ? Math.min(dpr, 1.25) : dpr)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    // 漫游边界由视口反算，不再是硬编码常量：窗口尺寸/形态一变就重算
    refitArea()
    updateBallScreen()
  }
  const ro = new ResizeObserver(resize)
  ro.observe(host)
  resize()

  // ─── 帧循环 ─────────────────────────────────────────────────────────────────
  const applyAction = (now: number): void => {
    if (action !== 'idle' && now > actionUntil) {
      action = 'idle'
      walker = setWalkerAction(walker, null)
    }
  }

  const step = (dt: number): void => {
    clock += dt
    pose.time = clock
    applyAction(performance.now())

    const interactive = action !== 'idle'
    if (roam && !interactive) {
      walker = stepWalker(walker, dt, walkerCfg)
      idleTimer = walker.gait === 'walk' ? 0 : idleTimer + dt
      // 久坐发呆 → 打盹
      if (idleTimer > 45 && action === 'idle') {
        action = 'sleep'
        actionStart = clock
        actionUntil = performance.now() + 9000
      }
    } else if (!roam) {
      idleTimer += dt
    } else {
      idleTimer = 0
    }

    const gait: Gait = interactive
      ? action === 'eat'
        ? 'eat'
        : action === 'sleep'
          ? 'sleep'
          : 'pet'
      : roam
        ? walker.gait
        : 'idle'
    const target = gait === 'walk' ? 1 : 0
    gaitBlend += (target - gaitBlend) * Math.min(1, dt * 7)
    if (gait === 'walk') pose.phase += dt * (walkerCfg.speed * 0.42)
    pose.gait = gaitBlend

    // 位置：球形态固定在原点（球在窗口中央轻轻浮动）；宠物形态跟着角色走
    const px = roam ? walker.x : 0
    const pz = roam ? walker.z : 0
    petGroup.position.set(px, BALL_CENTER_Y - BALL_RADIUS + 7, pz)
    // R7（D4'）：球壳与用量环**只跟左右、不跟纵深**——球恒定居于 z=0，
    // 宠物朝镜头方向走出来时球不会跟着变大贴窗（永不裁切），纵深约束改由宠物本体承担。
    // 注意 ringGroup 必须与 shellGroup 同步停 z 跟随，否则用量环与球壳错位。
    shellGroup.position.x += (px - shellGroup.position.x) * Math.min(1, dt * 6)
    ringGroup.position.x = shellGroup.position.x

    // 悬停浮沉：球形态缓慢呼吸，宠物走动时随步伐起伏
    const bob =
      gait === 'walk'
        ? Math.abs(Math.sin(pose.phase)) * 0.9 * gaitBlend
        : Math.sin(clock * (roam ? 1.8 : 1.2)) * (roam ? 0.45 : 0.6)
    petGroup.position.y += bob
    blob.scale.setScalar(1 - bob * 0.02)

    // ─── 真人系位姿：骨骼动画（mixer），gait/action → clip 交叉淡化 ─────────────
    if (human) {
      human.mixer.update(dt)
      const want: HumanClip =
        gait === 'walk' ? 'walk' : action === 'happy' ? 'wave' : action === 'eat' ? 'talk' : 'idle'
      if (want !== human.cur) {
        const prev = human.actions[human.cur]
        const next = human.actions[want]
        const looped = want === 'walk' || want === 'idle'
        next.reset()
        next.setLoop(looped ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
        next.clampWhenFinished = !looped
        next.fadeIn(0.25).play()
        prev.fadeOut(0.25)
        human.cur = want
      }
      // 剪辑自带根位移：实测 walk 的根骨骼 z 曲线振幅 159.7cm（归一化后 ≈33 世界单位/循环）、
      // idle ≈12 —— 不抵消的话角色每 1.23s 自己往前滑再被循环边界瞬移回来，位置就不只由 walker 驱动了。
      human.cancelRootMotion()
      // R10：朝向跟随行进方向偏航（走向镜头见正面、走远见背面）。
      // 写 petGroup.rotation.y（绕自身原点转、子节点在局部 0 点）——绝不能写 petHolder，
      // 那是带 scale.setScalar 的归一化层，DESIGN.md:312-314 记录过被动画覆盖后宠物消失的回归。
      const wantYaw = Math.atan2(walker.dirX, walker.dirZ) + HUMAN_YAW
      let dy = wantYaw - petGroup.rotation.y
      dy = Math.atan2(Math.sin(dy), Math.cos(dy)) // 角差最短路径（转 270° 变转 -90°）
      petGroup.rotation.y += dy * Math.min(1, dt * 4)
    }

    // ─── 角色位姿（素材无骨骼：整体变换表达动作）─────────────────────────────
    // 真人系走 mixer 分支，跳过这里（动作剪辑自带呼吸/摆动）
    if (petHolder && !human) {
      // 场景跨宠物复用：切回 Q 版要清掉真人系留下的偏航，否则 Q 版被斜着摆
      petGroup.rotation.y = 0
      const g = gaitBlend
      const mood = stats.mood
      let y = 0
      let lean = 0
      let yaw = 0
      let squash = 1 + Math.sin(clock * 2.1) * 0.02
      if (gait === 'walk') {
        y = Math.abs(Math.sin(pose.phase)) * 2.6 * g
        lean = -0.06 * g
        yaw = Math.sin(pose.phase * 0.5) * 0.12 * g
        squash = 1 + Math.sin(pose.phase * 2) * 0.04 * g
      }
      if (action === 'happy') {
        const t = clamp01((clock - actionStart) / 1.4)
        y += Math.abs(Math.sin(t * Math.PI * 3)) * 7 * (1 - t * 0.3)
        yaw += Math.sin(t * Math.PI * 4) * 0.6
        squash = 1 + Math.sin(t * Math.PI * 6) * 0.08
      }
      if (action === 'eat') {
        const t = clamp01((clock - actionStart) / 1.6)
        lean = Math.sin(t * Math.PI * 6) * 0.12
        squash = 1 + Math.sin(t * Math.PI * 8) * 0.06
      }
      if (action === 'sleep') {
        squash = 1 + Math.sin(clock * 1.1) * 0.03
        lean = 0.06
      }
      if (mood === 'lonely') yaw += Math.sin(clock * 0.7) * 0.25
      if (mood === 'hungry') lean += 0.05
      petHolder.position.y = y
      petHolder.rotation.set(lean, yaw, 0)
      petHolder.scale.set(1 / Math.sqrt(squash), squash, 1 / Math.sqrt(squash))
      petHolder.visible = roam
    }

    // 玻璃高光轻微游走（有光在动的感觉）
    spec.position.x = -BALL_RADIUS * 0.36 + Math.sin(clock * 0.4) * 1.6
    spec.position.y = BALL_RADIUS * 0.52 + Math.cos(clock * 0.35) * 1.2

    updateBallScreen()
    renderer.render(scene, camera)
  }

  const loop = (): void => {
    raf = requestAnimationFrame(loop)
    const now = performance.now()
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    if (paused || document.hidden) return
    step(dt)
  }
  raf = requestAnimationFrame(loop)

  applyTokens()
  buildFill(frame.percent ?? 0)

  const handle: Pet3dHandle = {
    canvas,
    setFrame: (f) => {
      const pctChanged = (f.percent ?? -1) !== (frame.percent ?? -1)
      const levelChanged = f.level !== frame.level
      const ringVisible = f.showRing !== false
      if (ringVisible !== ringGroup.visible) {
        ringGroup.visible = ringVisible
        halo.visible = ringVisible
      }
      frame = f
      if (pctChanged) buildFill(f.percent ?? 0)
      if (levelChanged || pctChanged) refreshColors()
    },
    setPet: (want) => {
      if (want === petId) return
      petId = want
      void attachPet(want)
    },
    setStats: (s) => {
      stats = s
    },
    setAction: (a, ms = 1600) => {
      if (!roam) return // 球形态不播宠物动作
      action = a
      actionStart = clock
      actionUntil = performance.now() + ms
      if (a === 'sleep') idleTimer = 0
      if (a !== 'sleep') walker = setWalkerAction(walker, null)
    },
    setRoam: (on) => {
      if (on === roam) return
      roam = on
      if (on) {
        walker = initialWalker(walkerCfg)
        idleTimer = 0
      } else {
        action = 'idle'
        walker = setWalkerAction(walker, null)
      }
      if (petHolder) petHolder.visible = on
    },
    setSkin: () => applyTokens(),
    tick: (dt) => step(dt > 0 && dt <= 0.1 ? dt : 0.016),
    setPaused: (p) => {
      paused = p
      last = performance.now()
    },
    ballRect: () => ({
      x: ballScreen.x - ballScreen.r,
      y: ballScreen.y - ballScreen.r,
      width: ballScreen.r * 2,
      height: ballScreen.r * 2
    }),
    ballCenter: () => ({ x: ballScreen.x, y: ballScreen.y }),
    roamArea: () => ({ halfX: walkerCfg.area.halfX, halfZ: walkerCfg.area.halfZ }),
    walkerPos: () => ({ x: walker.x, z: walker.z, gait: walker.gait }),
    rootMotion: () => (human ? Math.round(human.rootMotion() * 100) / 100 : null),
    setPin: (x, z) => {
      // 诊断用：夹进可行区后钉死在 idle（waitFor 极大 → 短期不再自主走动），
      // 让 --ballshot 能定点拍最坏位置（角落 / z 两端）
      const ax = Math.max(-walkerCfg.area.halfX, Math.min(walkerCfg.area.halfX, x))
      const az = Math.max(-walkerCfg.area.halfZ, Math.min(walkerCfg.area.halfZ, z))
      walker = { ...walker, x: ax, z: az, gait: 'idle', since: 0, waitFor: 1e6 }
    },
    petReady: () => petHolder !== null,
    /** 播放宠物动画（供 App.tsx 调用） */
    playAnim: async (animName: HumanClip, durationSec: number): Promise<void> => {
      if (!human) return
      // 停止当前所有动作
      human.actions.idle.stop()
      human.actions.walk.stop()
      // 播放指定动作
      const action = human.actions[animName]
      action.reset()
      action.clampWhenFinished = true
      action.play()
      action.setLoop(THREE.LoopOnce, 1)
      // 等待动画播放完成
      await new Promise((resolve) => setTimeout(resolve, durationSec * 1000))
      // 回到 idle
      human.actions.idle.reset()
      human.actions.idle.play()
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
