// 用法：node scripts/lib/png-probe.mjs <png> [--rows]
//
// 为什么需要：本机 `screencapture` 无 Screen Recording 权限（只输出桌面、略过窗口），
// 而 electron 的 capturePage 出的是透明 PNG。要判断「窗口四角的 alpha 轮廓是不是方的」
// 只能逐像素解码 —— 而仓里没有任何图像库可用（本任务不引入新依赖）。
//
// 这里只做一件事：把 PNG 解成 RGBA 像素。够用即可（8 位、非隔行），
// 不是通用解码器，也不做颜色管理。
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

/** 解出 { width, height, px(x,y) -> [r,g,b,a] } */
export function decodePng(path) {
  const buf = readFileSync(path)
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new TypeError(`${path} 不是 PNG`)
  let off = 8
  let width = 0
  let height = 0
  let depth = 0
  let color = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      color = data[9]
      if (data[12] !== 0) throw new TypeError('隔行 PNG 不支持')
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len
  }
  if (depth !== 8) throw new TypeError(`只支持 8 位，实际 ${depth}`)
  const chan = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color]
  if (!chan) throw new TypeError(`不支持的颜色类型 ${color}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * chan
  const out = Buffer.alloc(width * height * 4)
  const line = Buffer.alloc(stride)
  const prev = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]
    raw.copy(line, 0, p, p + stride)
    p += stride
    for (let i = 0; i < stride; i++) {
      const a = i >= chan ? line[i - chan] : 0
      const b = prev[i]
      const c = i >= chan ? prev[i - chan] : 0
      if (filter === 1) line[i] = (line[i] + a) & 255
      else if (filter === 2) line[i] = (line[i] + b) & 255
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a)
        const pb = Math.abs(pp - b)
        const pc = Math.abs(pp - c)
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
    }
    line.copy(prev)
    for (let x = 0; x < width; x++) {
      const s = x * chan
      const d = (y * width + x) * 4
      if (chan === 4) {
        out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = line[s + 3]
      } else if (chan === 3) {
        out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = 255
      } else if (chan === 2) {
        out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = line[s + 1]
      } else {
        out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = 255
      }
    }
  }
  return {
    width,
    height,
    px: (x, y) => [out[(y * width + x) * 4], out[(y * width + x) * 4 + 1], out[(y * width + x) * 4 + 2], out[(y * width + x) * 4 + 3]]
  }
}

if (import.meta.filename === process.argv[1]) {
  const file = process.argv[2]
  const img = decodePng(file)
  console.log(`${file}: ${img.width}×${img.height}`)
  const rows = process.argv.includes('--rows')
  const step = Math.max(1, Math.round(Math.min(img.width, img.height) / 56))
  for (let y = 0; y < img.height; y += step) {
    let lineStr = String(y).padStart(3, ' ') + ' |'
    for (let x = 0; x < img.width; x += step) {
      const [r, g, b, a] = img.px(x, y)
      lineStr += a === 0 ? '  . ' : ` ${String(a).padStart(3)} `
    }
    console.log(lineStr)
  }
  if (!rows) {
    let maxA = 0
    let minA = 255
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const a = img.px(x, y)[3]
        if (a > maxA) maxA = a
        if (a < minA) minA = a
      }
    }
    console.log(`alpha 范围 ${minA}..${maxA}`)
  }
}
