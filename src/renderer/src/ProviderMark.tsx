import type React from 'react'
import { PROVIDER_MARKS, providerMark, type ProviderMark as MarkDef } from './provider-icons'

// 供应商图标：单色 mask + CSS 着色。
// 好处：同一份 SVG 既能随主题/品牌色着色（UI），又能栅格化成托盘 template 图（主进程）。

const urlCache = new Map<string, string>()

/** 生成 mask 用的 SVG data URL（fill=currentColor → 作为 mask 只用 alpha） */
export function markDataUrl(mark?: string): string {
  const id = mark ?? ''
  const hit = urlCache.get(id)
  if (hit) return hit
  const m: MarkDef = providerMark(mark)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${m.viewBox}">${m.body}</svg>`
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  urlCache.set(id, url)
  return url
}

export function markColor(mark?: string): string {
  return providerMark(mark).color
}

/**
 * 供应商图标芯片：圆角底 + 品牌色 logo。
 * size=外框尺寸，glyph=图形尺寸（默认按 0.58 比例，视觉重心更稳）。
 */
export function ProviderMark({
  mark,
  size = 26,
  glyph,
  className = ''
}: {
  mark?: string
  size?: number
  glyph?: number
  className?: string
}): React.JSX.Element {
  const g = glyph ?? Math.round(size * 0.58)
  const color = markColor(mark)
  return (
    <span className={`pmark ${className}`} style={{ width: size, height: size }} aria-hidden="true">
      <span
        className="pmark-glyph"
        style={{
          width: g,
          height: g,
          backgroundColor: color || 'currentColor',
          WebkitMaskImage: `url("${markDataUrl(mark)}")`,
          maskImage: `url("${markDataUrl(mark)}")`
        }}
      />
    </span>
  )
}

/** 把图标栅格化成 PNG（托盘用）；黑 + alpha → macOS template image */
export async function renderMarkPng(mark: string | undefined, size: number): Promise<string> {
  const url = markDataUrl(mark)
  const img = new Image()
  img.src = url
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const m = providerMark(mark)
  // 保持宽高比居中（部分图标 viewBox 不是正方形）
  const [vx, vy, vw, vh] = m.viewBox.split(/[\s,]+/).map(Number)
  const pad = size * 0.12
  const box = size - pad * 2
  const scale = Math.min(box / (vw || 1), box / (vh || 1))
  const w = (vw || 1) * scale
  const h = (vh || 1) * scale
  ctx.drawImage(img, (size - w) / 2 - (vx || 0) * scale, (size - h) / 2 - (vy || 0) * scale, (vw || 1) * scale, (vh || 1) * scale)
  return canvas.toDataURL('image/png')
}

/** 托盘图标：1x/2x 两个尺寸（macOS 状态栏 22pt） */
export async function renderTrayIcon(mark: string | undefined): Promise<{ png1x: string; png2x: string }> {
  const [png1x, png2x] = await Promise.all([renderMarkPng(mark, 22), renderMarkPng(mark, 44)])
  return { png1x, png2x }
}

export { PROVIDER_MARKS }
