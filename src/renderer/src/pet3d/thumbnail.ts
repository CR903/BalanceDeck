import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { PetId } from '../../../shared/pet'
import { instantiatePet } from './models'

// ═══════════════════════════════════════════════════════════════════════════════
// 宠物缩略图：把 3D 素材渲成一张 PNG data URL（设置页的角色选择用）
//
// 为什么要这么做：设置页要展示 8 只角色，如果每只都起一个 WebGL 上下文，
// 浏览器上下文额度会被瞬间吃满。这里用一个临时渲染器渲染一帧、导出图片、
// 立刻释放上下文（forceContextLoss），结果按尺寸缓存，后续直接用 <img> 显示。
// ═══════════════════════════════════════════════════════════════════════════════

const cache = new Map<string, Promise<string>>()

/** 生成（并缓存）某只宠物的缩略图 data URL */
export function petThumbnail(id: PetId, size = 128): Promise<string> {
  const key = `${id}:${size}`
  const hit = cache.get(key)
  if (hit) return hit
  const task = render(id, size).catch((e) => {
    cache.delete(key) // 失败不缓存，允许下次重试
    throw e
  })
  cache.set(key, task)
  return task
}

async function render(id: PetId, size: number): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = size * 2
  canvas.height = size * 2
  // file:// 页面下 canvas 不会被跨源污染（贴图来自内联 data URL），toDataURL 可用
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true })
  renderer.setPixelRatio(1)
  renderer.setClearAlpha(0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05

  const scene = new THREE.Scene()
  const pmrem = new THREE.PMREMGenerator(renderer)
  let envRT: THREE.WebGLRenderTarget | null = null
  try {
    envRT = pmrem.fromScene(new RoomEnvironment(), 0.04)
    scene.environment = envRT.texture
    scene.environmentIntensity = 0.6
  } catch {
    // 忽略：退回纯灯光
  }

  const key = new THREE.DirectionalLight(0xffffff, 2.6)
  key.position.set(40, 80, 56)
  const fill = new THREE.DirectionalLight(0xffffff, 0.6)
  fill.position.set(-52, 26, 40)
  const rim = new THREE.DirectionalLight(0xffffff, 1.1)
  rim.position.set(-14, 24, -58)
  scene.add(key, fill, rim, new THREE.AmbientLight(0xffffff, 0.3))

  const inst = await instantiatePet(id, 2)
  scene.add(inst.group)

  // 3/4 视角：能同时看到脸和侧面，比正视图更有体积感
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100)
  camera.position.set(1.55, 1.5, 3.1)
  camera.lookAt(0, 1, 0)
  renderer.render(scene, camera)
  const url = canvas.toDataURL('image/png')

  inst.dispose()
  envRT?.dispose()
  pmrem.dispose()
  renderer.dispose()
  // 主动释放 GPU 上下文：缩略图是"用完即弃"的，不能占着浏览器上下文额度
  try {
    renderer.forceContextLoss()
  } catch {
    // 忽略
  }
  return url
}
