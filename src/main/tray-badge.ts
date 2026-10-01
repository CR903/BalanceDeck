import type { ProviderSnapshot } from '../shared/types'
import { windowPercent } from '../shared/percent'
import { primarySnapshot } from '../shared/tray-text'
import { levelOfPercent, type Level } from '../shared/levels'

// ═══════════════════════════════════════════════════════════════════════════════
// 托盘图标上的状态点（等级的第二载体，三平台通用）
//
// 为什么是灰度而不是彩色：macOS 的托盘图标是 **template image**（tray.ts 的
// setTemplateImage(true)），Apple 规则要求纯黑 + alpha，系统**丢弃 RGB** ——
// 「红点/橙点/绿点」在 macOS 上物理上不存在。改用 alpha + 直径分层，
// 这也正是 Apple 自己表达状态的做法（不同不透明度表示不同状态）。
//
// 顺带的好处：Windows 根本没有 setTitle（整条 API 是 @platform darwin），
// 颜色只能落在图标上 —— 于是这套分层是 Windows 的**唯一**信号载体。
//
// 纯函数、无 electron：几何与像素都是纯计算，单元测试直接在纯 node 里跑
// （scripts/test-tray.mjs 用 loadTs 加载本文件）。
// ═══════════════════════════════════════════════════════════════════════════════

/** 状态点形状。ok = 不画（不给正常状态加噪点，也保证 ok 档与改动前逐字节相同） */
export type BadgeShape = 'none' | 'solid-large' | 'translucent' | 'hollow-small'

/** 等级 → 状态点形状。形状表在 design.md D3：实心大点 / 半透明中点 / 空心小点 */
export function badgeOf(level: Level): BadgeShape {
  if (level === 'danger') return 'solid-large'
  if (level === 'warn') return 'translucent'
  if (level === 'muted') return 'hollow-small'
  return 'none'
}

/**
 * 托盘等级 = 标题里那个供应商的等级。
 *
 * ⚠ 判的是**标题正在展示的那个数**，不是全局最严重的那个：标题与状态点判同一个数，
 *   才不会出现「标题绿、点红」这种自相矛盾（这正是本任务要消灭的那类矛盾）。
 * ⚠ 没有可展示的数字时回到 'ok'（无点）：此时标题是空串或 ✓，没有需要分级的东西，
 *   加点就成了凭空制造的噪点。
 */
export function trayLevel(snapshots: ProviderSnapshot[]): Level {
  const s = primarySnapshot(snapshots)
  if (!s || s.status !== 'ok' || s.windows.length === 0) return 'ok'
  const pcts = s.windows
    .map((w) => windowPercent(w))
    .filter((p): p is number => p != null)
  // 百分比算不出来时 levelOfPercent(null) → muted（空心点）—— 不填 0
  return levelOfPercent(pcts.length > 0 ? Math.max(...pcts) : null, s.status)
}

// ─── 去重键 ──────────────────────────────────────────────────────────────────

/**
 * 托盘图标的去重键 = 原始 mark + 状态点形状。
 *
 * ⚠ **形状必须在里面**（`tray.ts` 的 `applyTrayIcon` 拿它当「要不要重设图标」的判据）：
 *   等级变了但 logo 还是同一个 mark 时，只按原始 key 去重会把换级后的图标**整个吞掉** ——
 *   状态点永远停在旧等级，而界面看起来一切正常（不抛、不红、用户只看到「点没变」）。
 *   这条失败形态在别处都测得到，只有把它做成纯函数才有单测入口：
 *   `tray.ts` 本身 import electron，loadTs 加载不了。
 *
 * 单独抽出来的另一个理由：观测点 `trayBadgeInfo()` 报的是 `currentBadge`（**意图**），
 * 键报的是 `appliedIconKey`（**真正落到托盘上的那份**）。意图会先于实际更新，
 * 所以只有后者能证明去重没有把新图标吃掉。
 */
export function trayIconKey(mark: string, shape: BadgeShape): string {
  return `${mark}#${shape}`
}

// ─── 像素 ────────────────────────────────────────────────────────────────────

/**
 * 状态点几何。全部按**图标边长的比例**给，而不是绝对 px ——
 * 1x 是 22×22、2x 是 44×44，两份必须长得一样，否则高分屏上点会大一圈。
 */
interface BadgeGeom {
  /** 圆心到边缘的半径（相对边长） */
  r: number
  /** 不透明度（0–1）；template 图标只有 alpha 生效，这是唯一的「浓淡」旋钮 */
  alpha: number
  /** 环宽（相对边长）；0 = 实心 */
  stroke: number
}

const GEOM: Record<Exclude<BadgeShape, 'none'>, BadgeGeom> = {
  'solid-large': { r: 0.095, alpha: 1, stroke: 0 },
  translucent: { r: 0.07, alpha: 0.6, stroke: 0 },
  'hollow-small': { r: 0.1, alpha: 1, stroke: 0.05 }
}

/**
 * 把状态点画进一块 BGRA 位图（`NativeImage.toBitmap()` 的格式），**原地修改**。
 *
 * 返回是否真的画了东西 —— 调用方据此判断「这次要不要重设托盘图标」。
 * shape 为 'none' 时一个字节都不碰：ok 档必须是**同一个对象、同一份字节**，
 * 否则每个用量正常的用户都会看到图标闪一下。
 *
 * 两条刻意的取舍：
 *   · 与已有像素取 alpha 的**较大者** —— 状态点必须看得见，不能被 logo 的笔画吃掉；
 *   · 外缘 1px 过渡（按到圆心的距离线性收 alpha），22px 上纯硬边会锯齿得很难看。
 */
export function paintBadge(bgra: Uint8Array, size: number, shape: BadgeShape): boolean {
  if (shape === 'none' || size <= 0) return false
  const g = GEOM[shape]
  const r = g.r * size
  const inner = g.stroke > 0 ? Math.max(0, r - g.stroke * size) : 0
  const margin = Math.max(1, Math.round(size * 0.045))
  const cx = size - margin - r
  const cy = size - margin - r
  const x0 = Math.max(0, Math.floor(cx - r - 1))
  const x1 = Math.min(size - 1, Math.ceil(cx + r + 1))
  const y0 = Math.max(0, Math.floor(cy - r - 1))
  const y1 = Math.min(size - 1, Math.ceil(cy + r + 1))
  let painted = false
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      let cover = Math.min(1, Math.max(0, r + 0.5 - d))
      if (g.stroke > 0) cover *= Math.min(1, Math.max(0, d - inner))
      const a = Math.round(cover * g.alpha * 255)
      if (a <= 0) continue
      const i = (y * size + x) * 4
      if (i + 3 >= bgra.length) continue
      if (a > bgra[i + 3]) {
        bgra[i + 3] = a
        painted = true
      }
    }
  }
  return painted
}
