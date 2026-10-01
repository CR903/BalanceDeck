// 百分比分级（主进程托盘与渲染层共用，保证同一屏只有一套阈值）
//
// 为什么从 renderer/format.ts 搬到这里：阈值判据原来是渲染层的私有事实，主进程拿不到。
// 托盘若自己写一份，同一用量会得到两个颜色（卡片橙、托盘绿）—— 那是用户解释不了的
// 矛盾，而且没有任何一层代码能同时看到两处。搬进 `src/shared/` 与 percent.ts 同一理由：
// 它是**跨进程的语义**，两侧都只当消费者。
//
// ⚠ 本模块刻意**不 import electron、不碰 DOM**：单元测试用 loadTs 在纯 node 里加载它，
//   三档边界断言必须打到真源码（scripts/test-tray.mjs），所以「纯」是可执行的前提而非风格。

export type Level = 'ok' | 'warn' | 'danger' | 'muted'

/** 阈值分级：≥85% 危险，≥60% 警告（唯一一处；把判定搬回第二处即红） */
export function levelOfPercent(pct: number | null, status: string): Level {
  if (status !== 'ok') return 'muted'
  if (pct == null) return 'muted'
  if (pct >= 85) return 'danger'
  if (pct >= 60) return 'warn'
  return 'ok'
}

// ─── 托盘标题的 ANSI 上色 ──────────────────────────────────────────────────
//
// 只用 Electron **实际实现过**的码。判据是 `NSString+ANSI.mm`（v37.10.3）的 switch，
// 不是「ANSI 规范里有的」—— 两者不等价，见下面 90 那条。
//   30 黑 / 31 红 / 32 绿 / 33 黄 / 39 复位，颜色值逐个写死在那个文件里。
//
// ⚠ 常写的 `90`（亮黑/灰）**不在这张表里**：落到 default 分支，什么都不发生，
//   于是 muted 与 ok 渲染得一模一样 —— 而「无数据」正是最需要被看见的一档。
//   灰用 `1;30`：那个文件里 bold 只参与选色（不加粗字体），把 30 从 #000000 换成 #7f7f7f。
// ⚠ 没有橙色：33 是纯黄（bold 变体是 #cdcd00 暗黄）。可接受 —— 颜色是**冗余信号**，
//   真正的等级载体是「图标分层 + 标题里的数字」，少一个橙不丢信息。
// ⚠ ok 返回**空串**（跟随系统色）：正常用量的用户不该看到任何视觉变化。

export const ANSI_RESET = '\x1b[0m'

/** 按等级取 ANSI 前景色包裹码；ok 返回空串 = 跟随系统色 */
export function ansiColor(level: Level): string {
  if (level === 'danger') return '\x1b[31m'
  if (level === 'warn') return '\x1b[33m'
  if (level === 'muted') return '\x1b[1;30m'
  return ''
}

/**
 * 剥掉 ANSI 转义，得到纯文案。
 * 测试与 `--uitest` 拿它比对「加色前后措辞逐字不变」—— 这是本仓的既有纪律：
 * 上色只能是**包裹**，不许顺手改一个字。
 */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}
