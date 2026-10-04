// 水色连续插值（10-04-water-color-by-usage）：用量百分比 → 水体填充色。
//
// 跨进程纯函数模块（无 electron / 无 React / 无 DOM，与 levels.ts 同例 ——
// 它是**跨进程的语义**，渲染层与主进程 uitest 都只当消费者），因此三处共用同一实现：
// 渲染层 PetBall 内联消费、node 单测经 loadTs 直接加载（scripts/test-fluid.mjs）、
// 主进程 uitest 用它算期望值（src/main/qa/uitest.ts 的 waterColorWhy ——
// 期望与实现同源，不手写第二份公式）。读皮肤令牌的 DOM 胶水归调用方
// （PetBall 本地的 readWaterAnchors），不进 shared —— shared 不碰 DOM。
//
// 锚点与 shared/levels.levelOfPercent 的 60/85 阈值同源：阈值处精确命中等级色，
// 段间 RGB 线性插值。阈值本身不归这里管（levels.ts 仍是唯一真相源）。

export type RGB = readonly [number, number, number]

export interface WaterAnchors {
  ok: RGB
  warn: RGB
  danger: RGB
  dangerDeep: RGB
}

/** aero 缺省三色（读不到皮肤令牌时的回退，与 skins.css :root 同值） */
const FALLBACK_OK: RGB = [48, 209, 88]
const FALLBACK_WARN: RGB = [255, 159, 10]
const FALLBACK_DANGER: RGB = [255, 69, 58]
/** 100% 端的加深系数：danger 再压暗一档，"烫到底"仍有变化 */
const DEEP_FACTOR = 0.72

/**
 * 解析 CSS 颜色（#rgb / #rrggbb / rgb() / rgba()，alpha 忽略 —— 水体恒不透明）。
 * 解析失败回 null（调用方整套回退，不返回"半套锚点"）。
 */
export function parseCssColor(s: string): RGB | null {
  const t = s.trim().toLowerCase()
  const hex3 = t.match(/^#([0-9a-f]{3})$/)
  if (hex3) {
    const n = hex3[1]
    return [parseInt(n[0] + n[0], 16), parseInt(n[1] + n[1], 16), parseInt(n[2] + n[2], 16)]
  }
  const hex6 = t.match(/^#([0-9a-f]{6})$/)
  if (hex6) {
    const n = parseInt(hex6[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const rgb = t.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/)
  if (rgb) {
    const c: RGB = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
    return c.every((v) => v >= 0 && v <= 255) ? c : null
  }
  return null
}

/** 按系数压暗（dangerDeep 的唯一来源；f=1 时恒等） */
export function shade(c: RGB, f: number): RGB {
  return [Math.round(c[0] * f), Math.round(c[1] * f), Math.round(c[2] * f)]
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ]
}

export function rgbStr(c: RGB): string {
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

/**
 * 用量百分比（0–100）→ 水色。分段锚点 0→ok / 60→warn / 85→danger / 100→dangerDeep，
 * 段间线性插值；端点（0/60/85/100）精确命中锚点色（mix 的 t=0/1 不引入舍入）。
 *
 * 非法输入（NaN / 非数字）与越界钳制到 [0,100]：显示层不替上游撒谎，只夹住
 * （与 shared/fluid.level 同纪律）；"未知"由调用方不渲染表达，不返回透明色。
 */
export function waterColor(pct: unknown, a: WaterAnchors): string {
  const c = typeof pct === 'number' && Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0
  if (c <= 60) return rgbStr(mix(a.ok, a.warn, c / 60))
  if (c <= 85) return rgbStr(mix(a.warn, a.danger, (c - 60) / 25))
  return rgbStr(mix(a.danger, a.dangerDeep, (c - 85) / 15))
}

/** 缺省锚点（无 DOM 环境或解析失败时的整套回退） */
export function defaultWaterAnchors(): WaterAnchors {
  return {
    ok: FALLBACK_OK,
    warn: FALLBACK_WARN,
    danger: FALLBACK_DANGER,
    dangerDeep: shade(FALLBACK_DANGER, DEEP_FACTOR)
  }
}

/**
 * 从取值函数解析三锚点（调用方传 `(n) => getComputedStyle(appEl).getPropertyValue(n)`，
 * 单测传普通对象查找 —— 不直接依赖 DOM，可纯测）。
 * 任一锚点缺失/解析失败即回 null：半套插值会在阈值处断裂，不如整套回退。
 */
export function resolveWaterAnchors(get: (name: string) => string): WaterAnchors | null {
  const ok = parseCssColor(get('--ok'))
  const warn = parseCssColor(get('--warn'))
  const danger = parseCssColor(get('--danger'))
  if (!ok || !warn || !danger) return null
  return { ok, warn, danger, dangerDeep: shade(danger, DEEP_FACTOR) }
}
