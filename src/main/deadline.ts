// ═══════════════════════════════════════════════════════════════════════════════
// 给 promise 加上时间上界 —— 把「永不 settle」变成「有界失败」
//
// 为什么需要它：`AbortController` 只对**已经进入 fetch 状态机**的请求有效。
// 卡在建连前阶段（DNS 解析 / TCP connect）的 socket 实测不受 abort 约束
// （2026-10-18 真机取证：`lsof -p <pid>` 零 TCP 连接，`sample` 里线程 99.4%
// 采样陷在 `select()`）—— 于是「一轮采集」可以永远不返回，调度权再也回不来。
// 调用方真正需要的不是「取消」，而是「无论如何都会返回」。
//
// ⚠ 本模块**不负责取消**原 promise（JS 里没有这个能力）。超时只是把控制权还给
//   调用方；原 promise 仍在后台跑，它的迟到结果必须由调用方自己丢弃 —— 轮次号
//   （epoch）失效那套机制见 `collect-loop.ts`。
//
// 纯逻辑（不 import electron），主进程与 scripts/test-deadline.mjs 共用同一实现。
// ═══════════════════════════════════════════════════════════════════════════════

export type DeadlineOutcome<T> = { ok: true; value: T } | { ok: false; reason: 'timeout' }

/**
 * 给 `p` 加时间上界 `ms`，**不 reject**：调用方不需要 try/catch 就能拿到结果。
 *
 * 纪律：**不吞异常** —— `p` 在预算内 reject 时本函数原样抛出该错误（交由既有
 * catch 路径处理），只有超时才转成 `{ ok: false }`。若把两者都压成 `{ok:false}`，
 * 「超时」与「真失败」在调用方就不可区分了，采集失败的原因会就此丢失。
 */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<DeadlineOutcome<T>> {
  return new Promise<DeadlineOutcome<T>>((resolve, reject) => {
    const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), ms)
    // 两个回调都必须挂上：超时之后原 promise 仍会 settle，而那时本 promise
    // 已经结束 —— 迟到 reject 若无人接收会变成 unhandled rejection（进程级告警），
    // 恰恰出现在「我们已经超时并继续往下走」的正常路径上。
    p.then(
      (value) => {
        clearTimeout(timer)
        resolve({ ok: true, value })
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}
