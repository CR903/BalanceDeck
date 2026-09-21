import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'

// ═══════════════════════════════════════════════════════════════════════════════
// 数字人素材加载（Microsoft Rocketbox，MIT）：带骨骼 FBX + 同系列动作剪辑。
//
// 三个关键点：
//   · 实例化必须用 SkeletonUtils.clone（普通 clone 不会重绑骨骼蒙皮）
//   · 动作是骨骼动画（AnimationMixer + crossfade），剪辑**按需加载**（见下）
//   · 贴图外链 TGA 已在采集期转成 PNG（scripts/fetch-human-pets.mjs），
//     这里按 basename 把 *.tga 重定向到 textures/*.png
//   · 素材走 bd-asset:// 协议（主进程 human-assets.ts 限定目录服务），
//     打包后在 extraResources，dev 在 resources/ —— 渲染层只认 URL，不管落点
//
// 为什么剪辑要懒加载：动作库每条 FBX 都自带整套骨骼+蒙皮（1.5–5MB），
// 13 条一次性解析会让人物出场等上好几秒（用户反馈过"3D 效果拖慢启动"）。
// 现在：BASE_CLIPS（静息/走动/挥手/说话）随模型一起加载，其余动作第一次被抽到才解析，
// 解析好的 action 挂在 mixer 上缓存 —— 第二次播就是瞬时的。
// ═══════════════════════════════════════════════════════════════════════════════

import { BASE_CLIPS, clipFile, type HumanClip } from './clips'
import type { PetId } from '../../../shared/pet'

const asset = (id: PetId, rel: string): string => `bd-asset://${id}/${rel}`

// 角色相关的纹理重定向：FBX 里记的是 `xxx.tga`（可能带相对目录），
// 统一按 basename 换成采集期转好的 textures/<base>.png。
function managerFor(id: PetId): THREE.LoadingManager {
  const m = new THREE.LoadingManager()
  m.setURLModifier((url) => {
    const base = url.split(/[\\/]/).pop() ?? url
    if (/\.tga$/i.test(base)) return asset(id, `textures/${base.replace(/\.tga$/i, '.png')}`)
    return url
  })
  return m
}

const loaderOf = (id: PetId): FBXLoader => new FBXLoader(managerFor(id))

interface HumanTemplate {
  scene: THREE.Group
}

const modelCache = new Map<PetId, Promise<HumanTemplate>>()
/** 剪辑缓存：键 `${id}/${clip}`（同一角色的两条动作互不干扰，跨实例共享） */
const clipCache = new Map<string, Promise<THREE.AnimationClip>>()
/** 最近一次动作解析耗时（ms）：诊断"人物为什么卡了一下"的现场证据 */
let lastParseMs = 0

export interface HumanMaterialStats {
  converted: number
  albedoFixed: number
}

type HumanSourceMaterial = THREE.MeshPhongMaterial | THREE.MeshLambertMaterial

/**
 * 真人素材材质归一：Phong/Lambert → Standard + 反照率修正。
 * 必须在模板上做一次 —— SkeletonUtils.clone 只深拷贝骨骼/蒙皮、共享材质对象，
 * 在实例上遍历既改不到共享材质也会每次切宠物重复执行。
 */
export function normalizeHumanMaterials(root: THREE.Object3D): HumanMaterialStats {
  const stats = { converted: 0, albedoFixed: 0 }
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    // 实测 1 个 SkinnedMesh 挂 3 个材质分组（geometry.groups 全覆盖顶点），必须逐元素处理
    const src = mesh.material as THREE.Material | THREE.Material[]
    if (Array.isArray(src)) {
      mesh.material = src.map((m) => toStandard(m, stats))
    } else {
      mesh.material = toStandard(src, stats)
    }
  })
  return stats
}

function toStandard(src: THREE.Material, stats: HumanMaterialStats): THREE.Material {
  if (!(src instanceof THREE.MeshPhongMaterial) && !(src instanceof THREE.MeshLambertMaterial)) {
    return src
  }
  const s = src as HumanSourceMaterial
  const mat = new THREE.MeshStandardMaterial()
  mat.name = s.name
  mat.map = s.map
  // FBX 的 DiffuseColor 是 sRGB albedo
  if (mat.map && mat.map.colorSpace !== THREE.SRGBColorSpace) mat.map.colorSpace = THREE.SRGBColorSpace
  mat.normalMap = s.normalMap
  mat.normalScale.copy(s.normalScale)
  mat.alphaMap = s.alphaMap
  // specularMap 刻意不搬迁：采集期用 !/specular|wrinkle/i 排除了 specular 贴图（human-assets 返回 404）
  mat.transparent = s.transparent
  mat.opacity = s.opacity
  mat.roughness = 0.62
  mat.metalness = 0
  // 转 Standard 之后 scene.environment 才作用得到（Phong 上根本没有这个属性）
  mat.envMapIntensity = 0.9
  const lum = 0.2126 * s.color.r + 0.7152 * s.color.g + 0.0722 * s.color.b
  if (lum < 0.05) {
    // Rocketbox 把 albedo 全交给贴图、DiffuseColor factor 留黑，FBXLoader 忠实写进 material.color；
    // 而漫反射是 color × map.rgb → 黑 × 贴图 = 纯黑剪影。
    mat.color.setRGB(1, 1, 1)
    stats.albedoFixed++
  } else {
    mat.color.copy(s.color)
  }
  stats.converted++
  s.dispose()
  return mat
}

function loadFBX(loader: FBXLoader, url: string): Promise<THREE.Group> {
  return new Promise<THREE.Group>((resolve, reject) => {
    loader.load(url, (g) => resolve(g), undefined, (e) =>
      reject(e instanceof Error ? e : new Error(String(e)))
    )
  })
}

/**
 * 非变形的辅助节点：动作剪辑里有、骨骼上没有（或反之），mixer 会静默跳过，
 * 这里显式声明以便断言时区分「预期缺失」与「真·绑定失败」。
 */
const HELPER_NODES = new Set(['Bip01_Footsteps', 'MotionExtractionHelper'])

export function loadHumanTemplate(id: PetId): Promise<HumanTemplate> {
  const hit = modelCache.get(id)
  if (hit) return hit
  const task = (async (): Promise<HumanTemplate> => {
    const loader = loaderOf(id)
    const scene = await loadFBX(loader, asset(id, 'model.fbx'))
    const mats = normalizeHumanMaterials(scene)
    if (mats.converted === 0) {
      console.warn(`[pet3d] 真人材质未命中 Phong/Lambert，反照率修正不会生效：${id}`)
    }
    return { scene }
  })().catch((e) => {
    modelCache.delete(id)
    throw e
  })
  modelCache.set(id, task)
  return task
}

/**
 * 按需加载一条动作剪辑（缓存 + 并发去重）。
 * 动作 FBX 自带整套骨骼+网格：只取它的第一段 clip，场景部分直接丢弃。
 */
export function loadHumanClip(id: PetId, clip: HumanClip): Promise<THREE.AnimationClip> {
  const key = `${id}/${clip}`
  const hit = clipCache.get(key)
  if (hit) return hit
  const name = clipFile(id, clip)
  if (!name) return Promise.reject(new Error(`素材表里没有这个动作：${id}/${clip}`))
  const task = (async (): Promise<THREE.AnimationClip> => {
    const t0 = performance.now()
    const holder = await loadFBX(loaderOf(id), asset(id, `anims/${name}.fbx`))
    const c = holder.animations[0]
    if (!c) throw new Error(`动作无 clip：${name}`)
    // 动作 FBX 自带整套骨骼+蒙皮，解析发生在主线程上（几百毫秒）。留一条现场证据：
    // 台架日志里出现它，就说明那一下"人物卡住"是解析造成的，而不是渲染或调度出问题。
    lastParseMs = performance.now() - t0
    if (lastParseMs > 300) {
      console.warn(`[pet3d] 动作解析占用主线程 ${Math.round(lastParseMs)}ms：${id}/${clip}`)
    }
    return c
  })().catch((e) => {
    clipCache.delete(key)
    throw e
  })
  clipCache.set(key, task)
  return task
}

/** 这条动作在这个模型上的绑定情况（mixer 会静默跳过缺失节点，这里显式报出来） */
function unboundOf(clip: THREE.AnimationClip, bones: Set<string>): string[] {
  const out = new Set<string>()
  for (const track of clip.tracks) {
    const node = track.name.split('.')[0]
    if (!bones.has(node) && !HELPER_NODES.has(node)) out.add(node)
  }
  return [...out]
}

/** 剪辑自带的根位移幅度（世界单位）：walk 一圈拖走多少，用来反算步幅速度 */
function clipTravel(clip: THREE.AnimationClip, rootName: string, scale: number): number {
  let min = Infinity
  let max = -Infinity
  const trackName = `${rootName}.position`
  for (const t of clip.tracks) {
    if (t.name !== trackName) continue
    // values 是 xyz 交错的一维数组，取 z（Rocketbox 的前进轴）
    for (let i = 2; i < t.values.length; i += 3) {
      min = Math.min(min, t.values[i])
      max = Math.max(max, t.values[i])
    }
  }
  return Number.isFinite(min) ? Math.abs(max - min) * scale : 0
}

/**
 * 骨骼层根节点：没有骨骼祖先的那根骨骼（Rocketbox/Max 的 Bip01）。
 * 刻意不按下标或写死的名字取——名字换了这里静默失效，结构关系不会。
 */
function findRootBone(root: THREE.Object3D): THREE.Object3D {
  let hit: THREE.Object3D | null = null
  root.traverse((o) => {
    const bone = (o as THREE.Bone).isBone === true
    if (hit || !bone) return
    for (let p = o.parent; p; p = p.parent) {
      if ((p as THREE.Bone).isBone) return
    }
    hit = o
  })
  if (!hit) throw new Error('骨骼层根节点缺失（剪辑里的根位移无法抵消）')
  return hit
}

export interface HumanInstance {
  group: THREE.Group
  mixer: THREE.AnimationMixer
  height: number
  /** clip 里引用但骨骼上缺失的非 helper 节点（随剪辑按需加载累积；空 = 完全绑定） */
  unbound: () => string[]
  /** 该剪辑的秒数；未加载返回 null（调度器据此判断"这一步现在能不能播"） */
  clipSeconds: (clip: HumanClip) => number | null
  /** 确保剪辑已加载并建好 action（可重入）；失败返回 null（离线/文件缺失不炸场景） */
  ensureClip: (clip: HumanClip) => Promise<THREE.AnimationAction | null>
  /** 走动的自然速度（世界单位/秒）：由 walk 剪辑的根位移 ÷ 时长算出；未就位为 0 */
  strideSpeed: () => number
  /** 最近一次动作解析占用的主线程毫秒数（诊断卡顿来源） */
  lastParseMs: () => number
  /** 抵消剪辑自带的根位移（每帧在 mixer.update 之后调，见 instantiateHuman 内注释） */
  cancelRootMotion: () => void
  /** 迄今抵消掉的根位移峰值（世界单位）：>0 就是「素材确实在拖」的现场证据 */
  rootMotion: () => number
  dispose: () => void
}

export { HUMAN_YAW } from './rig'

/** 循环播放的剪辑：静息与走动；其余都是一次性（播完定格再由调度器接管） */
const LOOPED = new Set<HumanClip>(['idle', 'walk'])

/**
 * 实例化一位数字人。
 *
 * `base` 是**当场**要加载的剪辑（默认 BASE_CLIPS）：静息姿态是立即可见的底线，
 * 走动与挥手是进场动作的两半 —— 它们决定了"人物出现"这一刻的观感，值得先付成本。
 * 其余剪辑由 ensureClip 按需加载。
 */
export async function instantiateHuman(
  id: PetId,
  targetHeight: number,
  base: HumanClip[] = BASE_CLIPS
): Promise<HumanInstance> {
  const template = await loadHumanTemplate(id)
  // SkinnedMesh 必须走 clone（会重绑骨骼），普通 Object3D.clone 的蒙皮会粘在模板骨骼上
  const group = cloneSkinned(template.scene) as THREE.Group

  group.updateWorldMatrix(true, true)
  const box = new THREE.Box3().setFromObject(group)
  const size = box.getSize(new THREE.Vector3())
  const scale = targetHeight / Math.max(1e-6, size.y)
  const holder = new THREE.Group()
  group.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2)
  holder.add(group)
  holder.scale.setScalar(scale)

  const mixer = new THREE.AnimationMixer(group)
  // 剪辑自带根位移（实测坐实，别只信目录名 all_animations_max_motextr_xy）：位移曲线挂在
  // **骨骼层根节点** Bip01 的 position 上 —— walk 一圈沿局部 z 拖走 159.7cm（归一化后 ≈33 世界
  // 单位），连 idle 都有 ≈12； Bip01 之上本该承载位移的 MotionExtractionHelper 在 FBX 里根本没
  // 导出（mixer 报 no target），所以抵消必须做在 Bip01 上，做在 holder/内层 group 上都不管用。
  // 位置由动作编排驱动（见 gesture.ts）：否则角色每 1.2~2.7s 自己滑出去再被循环边界瞬移回来。
  // y 保留：那是步伐起伏/呼吸，是要的。
  const rootBone = findRootBone(group)
  const bindX = rootBone.position.x
  const bindZ = rootBone.position.z
  let rootSpan = 0
  const cancelRootMotion = (): void => {
    const dx = rootBone.position.x - bindX
    const dz = rootBone.position.z - bindZ
    rootSpan = Math.max(rootSpan, Math.hypot(dx, dz) * scale)
    rootBone.position.x = bindX
    rootBone.position.z = bindZ
  }
  const bones = new Set<string>()
  group.traverse((o) => bones.add(o.name))

  holder.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    m.castShadow = true
    m.receiveShadow = false
  })

  const actions = new Map<HumanClip, THREE.AnimationAction>()
  const seconds = new Map<HumanClip, number>()
  const loading = new Map<HumanClip, Promise<THREE.AnimationAction | null>>()
  const unbound = new Set<string>()

  const install = (clip: HumanClip, c: THREE.AnimationClip): THREE.AnimationAction => {
    const action = mixer.clipAction(c)
    const looped = LOOPED.has(clip)
    action.setLoop(looped ? THREE.LoopRepeat : THREE.LoopOnce, looped ? Infinity : 1)
    action.clampWhenFinished = !looped
    actions.set(clip, action)
    seconds.set(clip, c.duration)
    for (const n of unboundOf(c, bones)) unbound.add(n)
    return action
  }

  const ensureClip = (clip: HumanClip): Promise<THREE.AnimationAction | null> => {
    const hit = actions.get(clip)
    if (hit) return Promise.resolve(hit)
    const inflight = loading.get(clip)
    if (inflight) return inflight
    const task = loadHumanClip(id, clip)
      .then((c) => install(clip, c))
      .catch((e) => {
        // 单条动作拿不到不该毁掉整个人物：记一条日志，调度器会跳过它
        console.warn(`[pet3d] 动作加载失败：${id}/${clip}`, e)
        loading.delete(clip)
        return null
      })
    loading.set(clip, task)
    return task
  }

  let stride = 0
  const refreshStride = (): void => {
    const walk = actions.get('walk')
    const secs = seconds.get('walk')
    if (!walk || !secs || !(secs > 0)) return
    const clip = walk.getClip()
    const travel = clipTravel(clip, rootBone.name, scale)
    // 步幅速度 = 一圈拖走的距离 ÷ 一圈时长；这是"脚下不打滑"的唯一正确来源
    if (travel > 0) {
      stride = travel / secs
      return
    }
    // 量不到（骨骼名与剪辑轨道对不上）也别让进场永远卡住：按身高给个保守估计并留痕，
    // 台架会用 --uitest 的 stride 观测点核对真实值（15–45 世界单位/秒都是合理步速）。
    if (stride === 0) {
      stride = targetHeight * 0.8
      console.warn(`[pet3d] walk 剪辑的根位移没量到（${rootBone.name}.position），步速退化为 ${stride.toFixed(1)}`)
    }
  }

  for (const clip of base) {
    const a = await ensureClip(clip)
    if (!a) throw new Error(`基础动作加载失败：${id}/${clip}`)
  }
  refreshStride()

  return {
    group: holder,
    mixer,
    height: size.y * scale,
    unbound: () => [...unbound],
    clipSeconds: (clip) => seconds.get(clip) ?? null,
    ensureClip: (clip) =>
      ensureClip(clip).then((a) => {
        if (clip === 'walk') refreshStride()
        return a
      }),
    strideSpeed: () => stride,
    lastParseMs: () => Math.round(lastParseMs),
    cancelRootMotion,
    rootMotion: () => rootSpan,
    dispose: () => {
      mixer.stopAllAction()
      mixer.uncacheRoot(group)
      holder.clear()
      actions.clear()
      seconds.clear()
      loading.clear()
    }
  }
}

export { HELPER_NODES }

