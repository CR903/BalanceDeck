// ═══════════════════════════════════════════════════════════════════════════════
// 收起态窗口尺寸：主进程用它定窗口大小，渲染层用它做首帧/兜底默认值。
//
// 为什么放 shared：窗口尺寸曾与人物形态机位同源（pet3d/rig.ts），兜底尺寸一旦与
// 主进程形态表漂移，首帧就会按错的画面算。人物形态已下线（10-03-remove-human），
// 10-10-dynamic-island 起收起态是灵动岛（ISLAND_VIEW）；BALL_VIEW 只剩旧分支与
// 单测过渡引用 —— 仍放 shared，口径不变（主进程 overlay.ts 与渲染层同源）。
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 收起态（唯一的形态）：**首版设计的 2D 小球**，窗口正好是那一个盘（`d5a028e` 的 56×56；外圈用量环已于 10-04 退役）。
 *
 * 2026-09-27 从 200×210（3D 玻璃球的包围盒）回到 56×56 —— 取的是首版（`d5a028e`）的
 * 窗口尺寸，SVG 的 `viewBox="0 0 56 56"` 也一直是这个数。收起态不建 3D 场景，
 * 所以窗口不再需要「把球体 + 留白装下」，方寸大小就是视觉大小。
 * 命中区按整块窗口上报，主进程再外扩 3px → 实际可点 62px。
 *
 * @deprecated 10-10-dynamic-island 起收起态改走 ISLAND_VIEW（顶部灵动岛）。
 * 保留供旧分支 PetBall 与单测过渡引用一个版本，新代码一律用 ISLAND_VIEW。
 */
export const BALL_VIEW = { width: 56, height: 56 }

/**
 * 收起态灵动岛窗口（10-10-dynamic-island，design 决策 1：固定尺寸，不跟随岛 resize）。
 *
 * 560 宽 = 岛收起 `fit-content` 上限（PRD：超长岛身 560 后横滑）+ 两侧辉光余量；
 * 480 高 = 展开态 430×~350 卡片区 + 顶部岛位 + 輝光余量。transparent + 穿透轮询
 * 复用既有 overlay.ts:619-672，渲染层按 setPetHitbox 上报岛/mini-pill rect。
 * 动态 setBounds 会与拖拽坐标、贴边持久化纠缠，否决 —— 窗口只在收起/展开切换时改尺寸。
 */
export const ISLAND_VIEW = { width: 560, height: 480 }

/**
 * 灵动岛宽度感知钳制（10-10-island-clip-fix R1/R2，纯函数，无 DOM，可单测）。
 *
 * 背景：岛宽随供应商数量变（fit-content，上限 528px），旧钳制只按中心比例
 * [0.08, 0.92]、不看岛宽 —— 靠边时 center ± islandW/2 伸出 560 窗口被透明
 * 窗口裁掉（harness 实测 posX=0.821 右溢 142px）。
 *
 * 约定：入参出参都是**中心比例**（`ui:islandX` 口径不变，仍按中心落盘）；
 * hostW 缺省 ISLAND_VIEW.width，调用方不要写字面 560。
 * 与 legacy 界取交（都要满足）：极窄岛（宽度界比 0.08/0.92 更松）退化为现行行为；
 * islandW 非正/非法 = 还没测到，同样走现行行为。非法 raw 回居中，不抛。
 */
export const ISLAND_EDGE_PX = 8
export const ISLAND_POS_MIN = 0.08
export const ISLAND_POS_MAX = 0.92

export function clampIslandPos(raw: number, islandW: number, hostW: number = ISLAND_VIEW.width): number {
  if (!Number.isFinite(raw)) return 0.5
  let lo = ISLAND_POS_MIN
  let hi = ISLAND_POS_MAX
  if (
    Number.isFinite(islandW) &&
    islandW > 0 &&
    Number.isFinite(hostW) &&
    hostW > 0
  ) {
    const wLo = (islandW / 2 + ISLAND_EDGE_PX) / hostW
    const wHi = (hostW - islandW / 2 - ISLAND_EDGE_PX) / hostW
    if (wLo <= wHi) {
      if (wLo > lo) lo = wLo
      if (wHi < hi) hi = wHi
    }
  }
  // wLo<=wHi 蕴含 islandW<=hostW-16，此时 lo<=0.5<=hi 恒成立（wLo<=0.5、wHi>=0.5）；
  // 分支只防后人改常量改出反转，反转时宁可居中也不落盘一个越界值。
  if (lo > hi) return 0.5
  return Math.min(hi, Math.max(lo, raw))
}
