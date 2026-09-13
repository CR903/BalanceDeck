// 纯 JS 生成 PNG 图标（无外部依赖）：
//  - build/icon.png        512x512 应用图标（圆角方块 + 白色柱状图）
//  - build/trayTemplate.png / trayTemplate@2x.png  macOS 模板托盘图标（黑色+alpha）
//  - build/tray.ico        Windows 托盘图标（简单 BMP-in-ICO 包装）
// 用法：node scripts/gen-icons.js

const { writeFileSync, mkdirSync } = require('fs')
const { join } = require('path')
const zlib = require('zlib')

function crc32(buf) {
  let c, table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** pixels: Uint8Array RGBA, w x h */
function pngEncode(pixels, w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0 // filter none
    pixels.copy ? pixels.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4) : null
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

function roundedRectMask(x, y, size, radius) {
  // 点 (x,y) 是否在圆角矩形内
  const r = radius
  if (x < r && y < r && (x - r) * (x - r) + (y - r) * (y - r) > r * r) return false
  if (x >= size - r && y < r && (x - (size - r - 1)) * (x - (size - r - 1)) + (y - r) * (y - r) > r * r) return false
  if (x < r && y >= size - r && (x - r) * (x - r) + (y - (size - r - 1)) * (y - (size - r - 1)) > r * r) return false
  if (x >= size - r && y >= size - r && (x - (size - r - 1)) * (x - (size - r - 1)) + (y - (size - r - 1)) * (y - (size - r - 1)) > r * r)
    return false
  return true
}

/** 应用图标：渐变蓝紫圆角方块 + 白色三柱状图 */
function genAppIcon(size) {
  const px = Buffer.alloc(size * size * 4)
  const r = Math.round(size * 0.22)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      if (!roundedRectMask(x, y, size, r)) continue
      const t = (x + y) / (2 * size)
      px[i] = Math.round(58 + (124 - 58) * t) // R: #3a7bd5 -> #7c3aed
      px[i + 1] = Math.round(123 + (58 - 123) * t)
      px[i + 2] = Math.round(213 + (237 - 213) * t)
      px[i + 3] = 255
    }
  }
  // 三根柱子（柱状图，从左到右升高）
  const barW = Math.round(size * 0.11)
  const barDefs = [
    [Math.round(size * 0.27), Math.round(size * 0.62), Math.round(size * 0.28)],
    [Math.round(size * 0.445), Math.round(size * 0.45), Math.round(size * 0.55)],
    [Math.round(size * 0.62), Math.round(size * 0.28), Math.round(size * 0.72)]
  ]
  for (const [x0, y0, yEnd] of barDefs) {
    for (let y = y0; y < size * yEnd / size + y0 && y < Math.round(size * 0.78); y++) {
      for (let x = x0; x < x0 + barW; x++) {
        const i = (y * size + x) * 4
        px[i] = 255
        px[i + 1] = 255
        px[i + 2] = 255
        px[i + 3] = 255
      }
    }
  }
  return px
}

/** 托盘模板图标：三根黑柱 + alpha，白色描边保证亮背景可读 */
function genTrayIcon(size) {
  const px = Buffer.alloc(size * size * 4)
  const barW = Math.max(2, Math.round(size * 0.16))
  const barDefs = [
    [Math.round(size * 0.12), size],
    [Math.round(size * 0.42), Math.round(size * 0.72)],
    [Math.round(size * 0.72), Math.round(size * 0.45)]
  ]
  for (const [x0, hRatio] of barDefs) {
    const y0 = size - Math.round(size * (hRatio / size) * 0.8) - Math.round(size * 0.12)
    const yTop = size - Math.round(size * 0.12) - Math.round(size * 0.8 * (hRatio / size))
    for (let y = Math.max(0, yTop); y < size - Math.round(size * 0.1); y++) {
      for (let x = x0; x < Math.min(x0 + barW, size); x++) {
        const i = (y * size + x) * 4
        px[i] = 0
        px[i + 1] = 0
        px[i + 2] = 0
        px[i + 3] = 255
      }
    }
  }
  return px
}

/** ICO 包装（单图 BMP 格式，32bpp BGRA） */
function icoEncode(px, size) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  const entry = Buffer.alloc(16)
  entry[0] = size % 256
  entry[1] = size % 256
  entry[2] = 0
  entry[3] = 0
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  const dib = Buffer.alloc(40)
  dib.writeUInt32LE(40, 0)
  dib.writeInt32LE(size, 4)
  dib.writeInt32LE(size * 2, 8)
  dib.writeUInt16LE(1, 12)
  dib.writeUInt16LE(32, 14)
  const pix = Buffer.alloc(size * size * 4)
  const mask = Buffer.alloc(size * size / 8)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const si = ((size - 1 - y) * size + x) * 4
      const di = (y * size + x) * 4
      pix[di] = px[si + 2]
      pix[di + 1] = px[si + 1]
      pix[di + 2] = px[si]
      pix[di + 3] = px[si + 3]
    }
  }
  entry.writeUInt32LE(40 + pix.length + mask.length, 8)
  entry.writeUInt32LE(22, 12)
  return Buffer.concat([header, entry, dib, pix, mask])
}

const buildDir = join(__dirname, '..', 'build')
mkdirSync(buildDir, { recursive: true })
writeFileSync(join(buildDir, 'icon.png'), pngEncode(genAppIcon(512), 512, 512))
writeFileSync(join(buildDir, 'icon.ico'), icoEncode(genAppIcon(256), 256))
writeFileSync(join(buildDir, 'trayTemplate.png'), pngEncode(genTrayIcon(16), 16, 16))
writeFileSync(join(buildDir, 'trayTemplate@2x.png'), pngEncode(genTrayIcon(32), 32, 32))
writeFileSync(join(buildDir, 'tray.ico'), icoEncode(genTrayIcon(24), 24))
console.log('icons written to', buildDir)
