// 全息球原型场景：点云球壳 + wireframe 反转球壳 + 双粒子轨道 + 数据流字符带。
// 纯原型代码（可丢弃），禁止 import 主干 pet3d/。
import * as THREE from 'three'

const qs = new URLSearchParams(location.search)
const SKINS = {
  abyss: { primary: '#38bdf8', glow: 'rgba(56,189,248,0.55)' },
  ember: { primary: '#fb923c', glow: 'rgba(251,146,60,0.55)' },
}
const skinParam = qs.get('skin') ?? ''
let skinName = skinParam in SKINS ? skinParam : 'abyss'
const STILL = qs.get('still') === '1' || matchMedia('(prefers-reduced-motion: reduce)').matches
const AUTORUN = qs.get('autorun') === '1' // 测量模式：10s 自动采集 + 上报 + 存图
const MEASURE_MS = 10000

document.documentElement.dataset.skin = skinName

const canvas = document.getElementById('gl')
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true })
renderer.setClearColor(0x000000, 0)
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2))
renderer.setSize(232, 200, false)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(38, 232 / 200, 0.1, 20)
camera.position.set(0, 0.15, 4.4)
camera.lookAt(0, 0, 0)

const world = new THREE.Group()
scene.add(world)

// ─── 光晕底（径向渐变 sprite，便宜的全息辉光）───
function glowTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64)
  grad.addColorStop(0, 'rgba(255,255,255,0.85)')
  grad.addColorStop(0.35, 'rgba(255,255,255,0.22)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c)
  return t
}
const glowMat = new THREE.SpriteMaterial({
  map: glowTexture(), transparent: true, opacity: 0.22,
  blending: THREE.AdditiveBlending, depthWrite: false,
})
glowMat.color.set(SKINS[skinName].primary)
const glow = new THREE.Sprite(glowMat)
glow.scale.set(3.1, 3.1, 1)
world.add(glow)

// ─── 点云球壳（1500 点）───
function shellPoints(n, r) {
  const pos = new Float32Array(n * 3)
  const col = new Float32Array(n * 3)
  const v = new THREE.Vector3()
  const c = new THREE.Color()
  for (let i = 0; i < n; i++) {
    v.randomDirection().multiplyScalar(r * (0.97 + Math.random() * 0.06))
    pos.set([v.x, v.y, v.z], i * 3)
    c.set(skinColor()).multiplyScalar(0.55 + Math.random() * 0.45)
    col.set([c.r, c.g, c.b], i * 3)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return g
}
function skinColor() { return SKINS[skinName].primary }

const shellGeo = shellPoints(1500, 1.0)
const shellMat = new THREE.PointsMaterial({
  size: 0.022, vertexColors: true, transparent: true, opacity: 0.75,
  blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
})
const shell = new THREE.Points(shellGeo, shellMat)
world.add(shell)

// ─── wireframe 球壳（反向慢转）───
const wireMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.32 })
wireMat.color.set(skinColor())
const wire = new THREE.LineSegments(new THREE.IcosahedronGeometry(1.03, 2), wireMat)
world.add(wire)

// ─── 粒子轨道 ×2 ───
function orbit(n, r, tilt) {
  const pos = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    pos.set([Math.cos(a) * r, 0, Math.sin(a) * r], i * 3)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const m = new THREE.PointsMaterial({
    size: 0.03, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  })
  m.color.set(skinColor())
  const p = new THREE.Points(g, m)
  p.rotation.x = tilt
  world.add(p)
  return { obj: p, mat: m }
}
const orbitA = orbit(350, 1.35, 0.5)
const orbitB = orbit(300, 1.62, -0.35)

// ─── 数据流字符带（CanvasTexture 贴于开口圆柱带，滚动 offset）───
function streamTexture() {
  const c = document.createElement('canvas')
  c.width = 1024
  c.height = 48
  const g = c.getContext('2d')
  g.clearRect(0, 0, 1024, 48)
  g.font = '28px monospace'
  g.fillStyle = '#ffffff'
  const chars = '0101TOK<>+={}#$01余额01PLAN'
  let x = 8
  while (x < 1024) {
    const ch = chars[(Math.random() * chars.length) | 0]
    g.fillText(ch, x, 34)
    x += 30 + Math.random() * 26
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = THREE.RepeatWrapping
  return t
}
const streamTex = streamTexture()
const streamMat = new THREE.MeshBasicMaterial({
  map: streamTex, transparent: true, opacity: 0.75, side: THREE.DoubleSide,
  blending: THREE.AdditiveBlending, depthWrite: false,
})
streamMat.color.set(skinColor())
const stream = new THREE.Mesh(new THREE.CylinderGeometry(1.48, 1.48, 0.16, 64, 1, true), streamMat)
stream.rotation.x = Math.PI / 2 - 0.28
world.add(stream)

// ─── 皮肤切换：粒子色/光晕/线框/HUD 变量一起变 ───
function applySkin(name) {
  skinName = name
  document.documentElement.dataset.skin = name
  const c = new THREE.Color(SKINS[name].primary)
  glowMat.color.copy(c)
  wireMat.color.copy(c)
  orbitA.mat.color.copy(c)
  orbitB.mat.color.copy(c)
  streamMat.color.copy(c)
  const col = shellGeo.getAttribute('color')
  const tmp = new THREE.Color()
  for (let i = 0; i < col.count; i++) {
    tmp.set(SKINS[name].primary).multiplyScalar(0.55 + Math.random() * 0.45)
    col.setXYZ(i, tmp.r, tmp.g, tmp.b)
  }
  col.needsUpdate = true
  syncSkinButtons()
}
function syncSkinButtons() {
  document.getElementById('skin-abyss').setAttribute('aria-pressed', String(skinName === 'abyss'))
  document.getElementById('skin-ember').setAttribute('aria-pressed', String(skinName === 'ember'))
}
document.getElementById('skin-abyss').onclick = () => applySkin('abyss')
document.getElementById('skin-ember').onclick = () => applySkin('ember')
syncSkinButtons()

// ─── HUD 数字滚动（播一次；reduced-motion 直接落终值）───
const TARGETS = { token: 15.4, code: 65, charge: 1230.5 }
function countUp() {
  const dur = STILL ? 0 : 1200
  const t0 = performance.now()
  const ringC = 87.96
  const ring = document.getElementById('ring-code')
  function frame(t) {
    const k = dur === 0 ? 1 : Math.min((t - t0) / dur, 1)
    const e = 1 - Math.pow(1 - k, 3)
    document.getElementById('num-token').textContent = (TARGETS.token * e).toFixed(1) + 'M'
    document.getElementById('num-code').textContent = Math.round(TARGETS.code * e)
    document.getElementById('num-charge').textContent = (TARGETS.charge * e).toLocaleString('zh-CN', { minimumFractionDigits: 2 })
    document.getElementById('bar-token').style.width = `${(TARGETS.token / 50) * 100 * e}%`
    ring.style.strokeDashoffset = String(ringC * (1 - (TARGETS.code / 100) * e))
    if (k < 1) requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

// ─── WCAG 对比度（卡片文字 vs 卡片底；透明窗按最坏底黑计算）───
function lum(r, g, b) {
  const f = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
function parseCss(c) {
  const m = c.match(/[\d.]+/g).map(Number)
  return m.length >= 4 ? m : [...m, 1]
}
function contrast() {
  const cs = getComputedStyle(document.querySelector('.card'))
  const [fr, fg, fb] = parseCss(cs.color).map((v, i) => (i < 3 ? v / 255 : v))
  let [br, bg, bb, ba] = parseCss(cs.backgroundColor)
  br /= 255; bg /= 255; bb /= 255
  // 卡片底 alpha 混合到黑色（透明窗最坏情况）
  const er = br * ba, eg = bg * ba, eb = bb * ba
  const L1 = lum(fr, fg, fb), L2 = lum(er, eg, eb)
  const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1]
  return (hi + 0.05) / (lo + 0.05)
}

// ─── 主循环 + 10s 测量 ───
const deltas = []
let last = -1
let rafId = 0
let measured = false

function renderFrame(t) {
  if (last >= 0) deltas.push(t - last)
  last = t
  const s = t / 1000
  shell.rotation.y = s * 0.05
  shell.rotation.x = Math.sin(s * 0.1) * 0.08
  wire.rotation.y = -s * 0.03
  orbitA.obj.rotation.y = s * 0.35
  orbitB.obj.rotation.y = -s * 0.22
  streamTex.offset.x = (s * 0.06) % 1
  world.position.y = Math.sin(s * 0.8) * 0.06
  renderer.render(scene, camera)
}

function tick(t) {
  renderFrame(t)
  if (!STILL) rafId = requestAnimationFrame(tick)
  else if (!measured) { measured = true; finishMeasure(true) }
}

function stats() {
  // 丢弃前 10 帧热身（纹理上传/着色器编译的首帧毛刺不计入稳态）
  const steady = deltas.slice(10)
  const fps = steady.map((d) => 1000 / d).sort((a, b) => a - b)
  if (!fps.length) return { frames: deltas.length, fpsAvg: null, fpsP50: null, fpsP95: null, fpsMin: null }
  const q = (p) => fps[Math.min(fps.length - 1, Math.floor(p * fps.length))]
  const avg = fps.reduce((a, b) => a + b, 0) / Math.max(fps.length, 1)
  return {
    frames: deltas.length,
    fpsAvg: +avg.toFixed(1),
    fpsP50: +q(0.5).toFixed(1),
    fpsP95: +q(0.95).toFixed(1),
    fpsMin: +Math.min(...fps).toFixed(1),
  }
}

async function snapshotPng(name) {
  renderer.render(scene, camera)
  const url = canvas.toDataURL('image/png')
  if (window.holoBridge) return window.holoBridge.savePng(name, url)
  // 浏览器直开降级：下载链接
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  return { ok: true, path: name }
}

async function finishMeasure(stillFrame = false) {
  const mem = renderer.info.memory
  const heap = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null
  const ratio = +contrast().toFixed(2)
  const payload = {
    skin: skinName,
    still: STILL || stillFrame,
    window: { w: 232, h: 444, transparent: true },
    particles: { shell: 1500, orbitA: 350, orbitB: 300 },
    ...stats(),
    geometries: mem.geometries,
    textures: mem.textures,
    jsHeapMB: heap,
    contrastRatio: ratio,
    dpr: devicePixelRatio || 1,
    gpu: 'see report (about:gpu / UA)',
    ua: navigator.userAgent,
    summary: {},
  }
  payload.summary = {
    fpsP50: payload.fpsP50, fpsP95: payload.fpsP95, fpsMin: payload.fpsMin,
    geometries: payload.geometries, textures: payload.textures,
    jsHeapMB: payload.jsHeapMB, contrastRatio: payload.contrastRatio,
  }
  const el = document.getElementById('perf')
  el.textContent =
    `skin=${payload.skin}${payload.still ? ' still' : ''}  frames=${payload.frames}\n` +
    `fps avg=${payload.fpsAvg} p50=${payload.fpsP50} p95=${payload.fpsP95} min=${payload.fpsMin}\n` +
    `geo=${payload.geometries} tex=${payload.textures} heap=${payload.jsHeapMB ?? '?'}MB\n` +
    `contrast=${payload.contrastRatio}:1  dpr=${payload.dpr}`
  console.log(`HOLO_MEASURE ${JSON.stringify(payload.summary)}`)
  if (AUTORUN) {
    const shot = await snapshotPng(`holo-${skinName}${payload.still ? '-still' : ''}.png`)
    console.log(`HOLO_SHOT ${JSON.stringify(shot)}`)
    if (window.holoBridge) window.holoBridge.measureDone(payload)
  }
  return payload
}

window.__holo = {
  get ready() { return deltas.length > 0 },
  setSkin: applySkin,
  report: finishMeasure,
  snapshot: snapshotPng,
  contrast,
}

countUp()
if (AUTORUN && STILL) {
  // 静态取证：单帧 + 结算（无 fps 窗口）
  renderFrame(performance.now())
  finishMeasure(true)
} else if (AUTORUN) {
  // 测量模式：跑满 10s 窗口再结算（单调度，无双重计数）
  rafId = requestAnimationFrame(function begin(t0) {
    last = t0
    const loop = (t) => {
      renderFrame(t)
      if (t - t0 < MEASURE_MS) rafId = requestAnimationFrame(loop)
      else finishMeasure(false)
    }
    rafId = requestAnimationFrame(loop)
  })
} else if (STILL) {
  renderFrame(performance.now())
} else {
  rafId = requestAnimationFrame((t) => { last = t; tick(t) })
}
