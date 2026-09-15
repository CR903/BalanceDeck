// ═══════════════════════════════════════════════════════════════════════════════
// 皮肤令牌 → 3D 材质颜色
//
// 3D 场景不消费 CSS，但必须跟随皮肤：所有颜色都从 document 上的 CSS 变量读取
// （见 skins.css 的 :root / [data-skin='…']），因此新增皮肤零代码生效。
// ═══════════════════════════════════════════════════════════════════════════════

export interface Rgb {
  r: number
  g: number
  b: number
}

/** CSS 颜色 → 0–1 的 RGB（支持 #rgb / #rrggbb / rgb() / rgba()；解析失败返回兜底色） */
export function cssColor(raw: string | null | undefined, fallback: Rgb): Rgb {
  const s = (raw ?? '').trim()
  if (!s) return fallback
  if (s.startsWith('#')) {
    const h = s.slice(1)
    const hex = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6)
    if (hex.length !== 6) return fallback
    const n = Number.parseInt(hex, 16)
    if (!Number.isFinite(n)) return fallback
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }
  }
  const m = s.match(/rgba?\(([^)]+)\)/i)
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
    if (parts.length >= 3 && parts.every((v) => Number.isFinite(v))) {
      return { r: parts[0] / 255, g: parts[1] / 255, b: parts[2] / 255 }
    }
  }
  return fallback
}

/** rgba() 的 alpha（解析失败返回 fallback） */
export function cssAlpha(raw: string | null | undefined, fallback = 1): number {
  const m = (raw ?? '').match(/rgba?\(([^)]+)\)/i)
  if (!m) return fallback
  const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number)
  return parts.length >= 4 && Number.isFinite(parts[3]) ? parts[3] : fallback
}

/** 亮度提亮/压暗（k > 0 提亮，k < 0 压暗，范围 -1..1） */
export function shade(c: Rgb, k: number): Rgb {
  const t = k >= 0 ? 1 : 0
  const a = Math.abs(k)
  return { r: c.r + (t - c.r) * a, g: c.g + (t - c.g) * a, b: c.b + (t - c.b) * a }
}

/** 皮肤令牌快照（每次皮肤变化后重读） */
export interface SkinTokens {
  /** 球体外壳色调 */
  shell: Rgb
  /** 球面高光强度 0–1 */
  gloss: number
  /** 接触阴影浓度 0–1 */
  shadow: number
  ok: Rgb
  warn: Rgb
  danger: Rgb
  muted: Rgb
  track: Rgb
  fg: Rgb
  /** 深/浅皮肤（决定高光与描边的方向） */
  dark: boolean
}

const FALLBACK: SkinTokens = {
  shell: { r: 0.85, g: 0.88, b: 0.95 },
  gloss: 0.55,
  shadow: 0.28,
  ok: { r: 0.19, g: 0.82, b: 0.35 },
  warn: { r: 1, g: 0.62, b: 0.04 },
  danger: { r: 1, g: 0.27, b: 0.23 },
  muted: { r: 0.6, g: 0.6, b: 0.62 },
  track: { r: 0.47, g: 0.47, b: 0.5 },
  fg: { r: 0.11, g: 0.11, b: 0.12 },
  dark: false
}

/**
 * 读取当前皮肤令牌。
 * el 传入渲染层根节点（带 data-skin），保证拿到的是该皮肤解析后的值。
 */
export function readSkinTokens(el: HTMLElement): SkinTokens {
  try {
    const cs = getComputedStyle(el)
    const v = (name: string): string => cs.getPropertyValue(name)
    const bg = v('--bg-solid') || v('--bg')
    const fg = cssColor(v('--fg'), FALLBACK.fg)
    // 深色皮肤判定：背景亮度低于前景亮度
    const bgRgb = cssColor(bg, { r: 1, g: 1, b: 1 })
    const lum = (c: Rgb): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
    const dark = lum(bgRgb) < lum(fg)
    const shellMix = dark ? 0.34 : 0.8
    return {
      shell: shade(bgRgb, shellMix),
      gloss: dark ? 0.42 : 0.6,
      shadow: dark ? 0.42 : 0.24,
      ok: cssColor(v('--ok'), FALLBACK.ok),
      warn: cssColor(v('--warn'), FALLBACK.warn),
      danger: cssColor(v('--danger'), FALLBACK.danger),
      muted: cssColor(v('--fg-faint'), FALLBACK.muted),
      track: cssColor(v('--track'), FALLBACK.track),
      fg,
      dark
    }
  } catch {
    return FALLBACK
  }
}

