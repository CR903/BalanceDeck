// 出网「可达性记账」探针 —— 仅供单元测试把 `src/main/net.ts` 换成记录调用的替身。
//
// 为什么需要：`loadTs` 把模块**打包**成一份内存 ESM，`request.ts` 内联的是 net.ts 的
// 私有副本，测试侧拿不到它的 failStreak —— 于是「超时判负之后，迟到的成功不得再清零
// 记账」这条断言就无从下手，而那正是 2026-10-18 加固（R3 的 `decided` 标志）要守的东西。
// 换成一个会把调用记进全局的替身，就能正面观测到「有没有多记一次成功」。
//
// 纪律（与 electron-stub.mjs 同）：这里**只实现被 request.ts 用到的成员**，
// 不要顺手补全 net 的 API —— 补全了会让测试静默走别的分支。
//
// 记录落在 `globalThis.__bd_net_probe`（数组），因为替身被内联进 request 的包，
// 测试无法 import 到同一个模块实例。
const g = globalThis
if (!Array.isArray(g.__bd_net_probe)) g.__bd_net_probe = []

export function assertNetAvailable() {
  // 测试环境一律视为联网：离线路径由 net.ts 自己的 BALANCEDECK_FORCE_OFFLINE 覆盖
}

export function markNetResult(ok, err) {
  g.__bd_net_probe.push({ ok: !!ok, name: (err && err.name) || null })
}
