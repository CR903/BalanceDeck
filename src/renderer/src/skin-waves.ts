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
