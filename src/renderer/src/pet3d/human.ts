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

export interface HumanInstance {
  group: THREE.Group
  mixer: THREE.AnimationMixer
  clips: Record<HumanClip, THREE.AnimationClip>
  height: number
  /** clip 里引用但骨骼上缺失的非 helper 节点（空 = 完全绑定） */
  unbound: string[]
  dispose: () => void
}

/** 面向镜头的朝向修正：Max 系 FBX 转 Y-up 后若背对镜头，把该值改成 Math.PI 验证 */
const HUMAN_YAW = 0

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
  group.rotation.y = HUMAN_YAW
  holder.add(group)
  holder.scale.setScalar(scale)

  const mixer = new THREE.AnimationMixer(group)
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
    const mat = m.material as THREE.MeshStandardMaterial
    if (mat && 'envMapIntensity' in mat) mat.envMapIntensity = 0.9
  })

  return {
    group: holder,
    mixer,
    clips: template.clips,
    height: size.y * scale,
    unbound: [...unbound],
    dispose: () => {
      mixer.stopAllAction()
      mixer.uncacheRoot(group)
      holder.clear()
    }
  }
}

export { HELPER_NODES }
