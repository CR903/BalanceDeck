// 各皮肤波形表（10-04-skin-fluid-redesign 返工 R1）：三层波逐皮肤的振幅/波长。
//
// renderer 本地纯函数模块（无 electron / 无 React / 无 DOM），node 单测经 loadTs
// 直接加载（scripts/test-fluid.mjs 用例 9）。不在 shared —— 皮肤 id 是渲染层概念，
// 主进程/托盘不消费它（水色锚点那种跨进程语义才进 shared，见 water-color.ts）。
//
// 约束（单测跨钉，不靠注释自觉）：
//   · 每皮肤 A/B/C 振幅递减（能量向大层集中，视觉不打架）；
//   · CSS 的 `--wave-len-*` 必须与表中 L 逐值相等（漂移距离恒 = 波长整数倍，
//     无缝循环不断裂 —— test-fluid 用例 9 读 skins.css 逐皮肤对拍）；
//   · 未知皮肤（含 ext:*）回 DEFAULT（aero 值），不断裂。

export interface WaveLayer {
  /** 振幅（viewBox 单位 px） */
  A: number
  /** 波长（viewBox 单位 px；漂移循环距离取它的整数倍） */
  L: number
}

export interface SkinWaves {
  a: WaveLayer
  b: WaveLayer
  c: WaveLayer
}

const DEFAULT_WAVES: SkinWaves = {
  a: { A: 2.2, L: 28 },
  b: { A: 1.6, L: 36 },
  c: { A: 0.9, L: 18 }
}

/** 皮肤 id → 波形（id 取自 .app 的 data-skin；ext 外部皮肤不在表里，走回退） */
const TABLE: Record<string, SkinWaves> = {
  aero: DEFAULT_WAVES,
  // dark 霓虹深海：长而缓的涌浪
  dark: {
    a: { A: 3.0, L: 44 },
    b: { A: 2.2, L: 56 },
    c: { A: 1.0, L: 28 }
  },
  // minimal 微澜：几乎平，只剩呼吸感
  minimal: {
    a: { A: 0.8, L: 28 },
    b: { A: 0.6, L: 36 },
    c: { A: 0.4, L: 18 }
  },
  // candy 果冻大浪：短而弹
  candy: {
    a: { A: 3.4, L: 24 },
    b: { A: 2.4, L: 32 },
    c: { A: 1.5, L: 16 }
  },
  // ink 宽墨：阔而平（C 层另由 CSS display:none 藏掉，这里照给合法值，不断裂）
  ink: {
    a: { A: 1.6, L: 40 },
    b: { A: 1.2, L: 48 },
    c: { A: 0.8, L: 24 }
  }
}

export function skinWaves(skinId: string): SkinWaves {
  return TABLE[skinId] ?? DEFAULT_WAVES
}

/** 缺省波形（回退与单测锚点共用一处，不手写第二份数字） */
export function defaultWaves(): SkinWaves {
  return DEFAULT_WAVES
}

/**
 * 雨滴表（R4-1）：倒水入场的 7 滴固定落位（确定性可测，不用 Math.random ——
 * 快照/取帧每次同形，单测 pin 分布）。
 *
 *   · `left` —— 球内横向 %（20..80，圆内；近壁滴靠 clip 圆自然裁出"砸中穹顶"感）；
 *   · `delay` —— 相对 pour 起播的延迟 ms（错峰，不齐发）；
 *   · `dur` —— 相对 POUR_FILL_MS 的时长系数（壁滴慢一档）；
 *   · `kind` —— center 触水溅 splash；wall 触水转 trickle（沿内壁流下，不挂 splash）。
 *
 * 顺序即重要度：每皮按 nth-child 藏尾巴（minimal 只留前 3，见 skins.css），
 * 所以前 3 必须是中间滴。
 */
export interface PourDrop {
  left: number
  delay: number
  dur: number
  kind: 'center' | 'wall'
}

export const POUR_DROPS: PourDrop[] = [
  { left: 50, delay: 0, dur: 1, kind: 'center' },
  { left: 38, delay: 120, dur: 1, kind: 'center' },
  { left: 62, delay: 60, dur: 1, kind: 'center' },
  { left: 30, delay: 200, dur: 1.25, kind: 'wall' },
  { left: 70, delay: 140, dur: 1.25, kind: 'wall' },
  { left: 45, delay: 260, dur: 1, kind: 'center' },
  { left: 55, delay: 320, dur: 1, kind: 'center' }
]
