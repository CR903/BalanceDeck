import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'

// ═══════════════════════════════════════════════════════════════════════════════
// 真人系宠物（Microsoft Rocketbox，MIT）：带骨骼 FBX + 同系列动作剪辑。
//
// 与无骨骼 Cube Pets（models.ts）的关键差异：
//   · 实例化必须用 SkeletonUtils.clone（普通 clone 不会重绑骨骼蒙皮）
//   · 动作是骨骼动画（AnimationMixer + crossfade），不是整体变换
//   · 贴图外链 TGA 已在采集期转成 PNG（scripts/fetch-human-pets.mjs），
//     这里按 basename 把 *.tga 重定向到 textures/*.png（colormap  trick 同构）
//   · 素材走 bd-asset:// 协议（主进程 human-assets.ts 限定目录服务），
//     打包后在 extraResources，dev 在 resources/ —— 渲染层只认 URL，不管落点
// ═══════════════════════════════════════════════════════════════════════════════

export type HumanPetId = 'aria' | 'ray'
export type HumanClip = 'walk' | 'idle' | 'wave' | 'talk'

const CLIPS: Record<HumanPetId, Record<HumanClip, string>> = {
  aria: {
    walk: 'f_walk_neutral',
    idle: 'f_idle_breathe_01',
    wave: 'f_wave_01',
    talk: 'f_gestic_talk_neutral_01'
  },
  ray: {
    walk: 'm_walk_neutral',
    idle: 'm_idle_breathe_01',
    wave: 'm_wave_01',
    talk: 'm_gestic_talk_neutral_01'
  }
}

const asset = (id: HumanPetId, rel: string): string => `bd-asset://${id}/${rel}`

// 角色相关的纹理重定向：FBX 里记的是 `xxx.tga`（可能带相对目录），
// 统一按 basename 换成采集期转好的 textures/<base>.png。
function managerFor(id: HumanPetId): THREE.LoadingManager {
  const m = new THREE.LoadingManager()
  m.setURLModifier((url) => {
    const base = url.split(/[\\/]/).pop() ?? url
    if (/\.tga$/i.test(base)) return asset(id, `textures/${base.replace(/\.tga$/i, '.png')}`)
    return url
  })
  return m
}

const loaderOf = (id: HumanPetId): FBXLoader => new FBXLoader(managerFor(id))

interface HumanTemplate {
  scene: THREE.Group
  clips: Record<HumanClip, THREE.AnimationClip>
}

const cache = new Map<HumanPetId, Promise<HumanTemplate>>()

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

export function loadHumanTemplate(id: HumanPetId): Promise<HumanTemplate> {
  const hit = cache.get(id)
  if (hit) return hit
  const task = (async (): Promise<HumanTemplate> => {
    const loader = loaderOf(id)
    const scene = await loadFBX(loader, asset(id, 'model.fbx'))
    const mats = normalizeHumanMaterials(scene)
    if (mats.converted === 0) {
      console.warn(`[pet3d] 真人材质未命中 Phong/Lambert，反照率修正不会生效：${id}`)
    }
    const clips = {} as Record<HumanClip, THREE.AnimationClip>
    for (const [key, name] of Object.entries(CLIPS[id]) as [HumanClip, string][]) {
      // 动作 FBX 自带整套骨骼+网格：只要它的第一段 clip，场景部分直接丢弃
      const holder = await loadFBX(loader, asset(id, `anims/${name}.fbx`))
      const clip = holder.animations[0]
      if (!clip) throw new Error(`动作无 clip：${name}`)
      clips[key] = clip
    }
    return { scene, clips }
  })().catch((e) => {
    cache.delete(id)
    throw e
  })
  cache.set(id, task)
  return task
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
  clips: Record<HumanClip, THREE.AnimationClip>
  height: number
  /** clip 里引用但骨骼上缺失的非 helper 节点（空 = 完全绑定） */
  unbound: string[]
  /** 抵消剪辑自带的根位移（每帧在 mixer.update 之后调，见 instantiateHuman 内注释） */
  cancelRootMotion: () => void
  /** 迄今抵消掉的根位移峰值（世界单位）：>0 就是「素材确实在拖」的现场证据 */
  rootMotion: () => number
  dispose: () => void
}

/**
 * 模型固有朝向修正：Max 系 FBX 转 Y-up 后若背对镜头，把该值改成 Math.PI 验证。
 * 刻意作为**常量偏移**导出给 scene.ts 的 heading 使用（而非在这里写进实例旋转）：
 * 真人系已改为跟随行进方向偏航（R10），两处各转一次会互相打架。
 */
export const HUMAN_YAW = 0

export async function instantiateHuman(id: HumanPetId, targetHeight: number): Promise<HumanInstance> {
  const template = await loadHumanTemplate(id)
  // SkinnedMesh 必须走 clone（会重绑骨骼），普通 Object3D.clone 的蒙皮会粘在模板骨骼上
  const group = cloneSkinned(template.scene) as THREE.Group

  group.updateWorldMatrix(true, true)
  const box = new THREE.Box3().setFromObject(group)
  const size = box.getSize(new THREE.Vector3())
  const scale = targetHeight / Math.max(1e-6, size.y)
  const holder = new THREE.Group()
  group.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2)
  // 朝向不再写在这里：由 scene.ts 的 heading（含 HUMAN_YAW 常量偏移）统一驱动
  holder.add(group)
  holder.scale.setScalar(scale)

  const mixer = new THREE.AnimationMixer(group)
  // 剪辑自带根位移（实测坐实，别只信目录名 all_animations_max_motextr_xy）：位移曲线挂在
  // **骨骼层根节点** Bip01 的 position 上 —— walk 一圈沿局部 z 拖走 159.7cm（归一化后 ≈33 世界
  // 单位），连 idle 都有 ≈12； Bip01 之上本该承载位移的 MotionExtractionHelper 在 FBX 里根本没
  // 导出（mixer 报 no target），所以抵消必须做在 Bip01 上，做在 holder/内层 group 上都不管用。
  // 位置只能由 walker 驱动：否则角色每 1.2~2.7s 自己滑出去再被循环边界瞬移回来，
  // 而且滑出去的那段已经越出反算出的可行区（R9 的「任意可行位置不裁切」前提被破坏）。
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
  const unbound = new Set<string>()
  for (const clip of Object.values(template.clips)) {
    for (const track of clip.tracks) {
      const node = track.name.split('.')[0]
      if (!bones.has(node) && !HELPER_NODES.has(node)) unbound.add(node)
    }
  }

  holder.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    m.castShadow = true
    m.receiveShadow = false
  })

  return {
    group: holder,
    mixer,
    clips: template.clips,
    height: size.y * scale,
    unbound: [...unbound],
    cancelRootMotion,
    rootMotion: () => rootSpan,
    dispose: () => {
      mixer.stopAllAction()
      mixer.uncacheRoot(group)
      holder.clear()
    }
  }
}

export { HELPER_NODES }
