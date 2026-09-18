import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { PetId } from '../../../shared/pet'
import colormapUrl from '../assets/pets/colormap.png?inline'

// ═══════════════════════════════════════════════════════════════════════════════
// 宠物 3D 素材（GLB）
//
// 素材来源：**Kenney「Cube Pets 2.0」**（CC0 1.0，公共领域）——
//   https://kenney.nl/assets/cube-pets ｜ 随包附 License 原文：assets/pets/LICENSE-kenney-cube-pets.txt
//   CC0 允许个人/教育/商业使用且无需署名（本项目仍在 README 致谢）。
//
// 加载方式：`?inline` 把 GLB 转成 data URL 由 Vite 内联进产物 ——
//   打包后渲染层是 file:// 页面，fetch/XHR 取本地 .glb 会被 Chromium 拦掉；
//   内联成 data URL 走 GLTFLoader 自己的 FileLoader 就没有跨源问题。
//   每个模型是独立 chunk（动态 import），首屏只加载当前宠物那一只。
//
// 归一化：模型原始尺寸/朝向各不相同，加载后统一「居中 + 缩放到目标高度」，
//   并把朝向转成 +Z（面向镜头），下层动画只关心位姿，不关心素材差异。
// ═══════════════════════════════════════════════════════════════════════════════

/** 每只宠物的模型加载器（动态 chunk，按需拉取；真人系走 human.ts，不在此表） */
const SOURCES: Partial<Record<PetId, () => Promise<string>>> = {
  mochi: () => import('../assets/pets/animal-cat.glb?inline').then((m) => m.default),
  shiba: () => import('../assets/pets/animal-dog.glb?inline').then((m) => m.default),
  penguin: () => import('../assets/pets/animal-penguin.glb?inline').then((m) => m.default),
  fox: () => import('../assets/pets/animal-fox.glb?inline').then((m) => m.default),
  panda: () => import('../assets/pets/animal-panda.glb?inline').then((m) => m.default),
  bunny: () => import('../assets/pets/animal-bunny.glb?inline').then((m) => m.default),
  koala: () => import('../assets/pets/animal-koala.glb?inline').then((m) => m.default),
  tiger: () => import('../assets/pets/animal-tiger.glb?inline').then((m) => m.default)
}

export function hasPetModel(id: PetId): boolean {
  return id in SOURCES
}

// Cube Pets 的贴图是**外链**的 `Textures/colormap.png`（不在 GLB 里）。
// 我们从 data URL 加载模型，相对路径无从解析，于是把这张调色板也内联进来，
// 用 LoadingManager 把该路径重定向到内联的 data URL。
const manager = new THREE.LoadingManager()
manager.setURLModifier((url) => (/colormap\.png$/i.test(url) ? colormapUrl : url))
const loader = new GLTFLoader(manager)
const cache = new Map<PetId, Promise<THREE.Group>>()

/** 加载原始模型（带缓存，返回模板；调用方自行 clone） */
export function loadPetTemplate(id: PetId): Promise<THREE.Group> {
  const hit = cache.get(id)
  if (hit) return hit
  const load = SOURCES[id]
  if (!load) return Promise.reject(new Error(`未内置该宠物的 3D 素材：${id}`))
  const task = load()
    .then(
      (dataUrl) =>
        new Promise<THREE.Group>((resolve, reject) => {
          loader.load(
            dataUrl,
            (gltf) => resolve(gltf.scene),
            undefined,
            (err) => reject(err instanceof Error ? err : new Error(String(err)))
          )
        })
    )
    .catch((e) => {
      cache.delete(id) // 失败不缓存，允许重试（例如素材损坏后重新打开）
      throw e
    })
  cache.set(id, task)
  return task
}

export interface NormalizedPet {
  /** 可直接挂进场景的实例（已克隆、已归一化） */
  group: THREE.Group
  /** 归一化后模型在 y 轴上的高度（世界单位） */
  height: number
  dispose: () => void
}

/**
 * 克隆一只宠物并把尺寸/朝向归一化到「脚踩 y=0、面朝 +Z、高度 = targetHeight」。
 * 说明：Cube Pets 无骨骼，clone() 足够；材质共享（clone 不复制材质），
 *       dispose 时只释放几何与克隆出来的材质副本。
 */
export async function instantiatePet(id: PetId, targetHeight: number): Promise<NormalizedPet> {
  const template = await loadPetTemplate(id)
  const group = template.clone(true)

  // 计算包围盒（模板与克隆一致，但 clone 后要重新算以确保世界矩阵正确）
  group.updateWorldMatrix(true, true)
  const box = new THREE.Box3().setFromObject(group)
  const size = box.getSize(new THREE.Vector3())
  const scale = targetHeight / Math.max(1e-6, size.y)

  // 外层容器承担归一化，内层保留模型自身变换
  const holder = new THREE.Group()
  group.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2)
  holder.add(group)
  holder.scale.setScalar(scale)

  const meshes: THREE.Mesh[] = []
  holder.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    meshes.push(m)
    m.castShadow = true
    m.receiveShadow = false
    const mat = m.material as THREE.MeshStandardMaterial
    if (mat && 'envMapIntensity' in mat) mat.envMapIntensity = 0.75
  })

  return {
    group: holder,
    height: size.y * scale,
    dispose: () => {
      // 几何由模板共享，不在此释放；材质也是共享的 —— 只清引用
      meshes.length = 0
      holder.clear()
    }
  }
}
