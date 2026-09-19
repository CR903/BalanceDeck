// electron 的最小替身 —— 仅供纯 node 测试加载「间接依赖 electron」的模块使用。
//
// 为什么需要：`src/main/adapters/types.ts` 为了网络可达性记账 import 了 `../net`，
// 而 `net.ts` import 了 electron。electron 的入口会 require('fs')，esbuild 打包成
// ESM 后报 `Dynamic require of "fs" is not supported`，于是整个 adapters/ 目录在
// 单元测试里无法导入（这正是适配器此前零测试的原因）。
//
// 纪律：这里**只实现被用到的成员**，不要顺手补全 electron 的 API。
// 如果产品代码开始依赖更多 electron 能力，应当在测试里显式补上，
// 而不是让测试因为拿不到而静默走别的分支。

export const net = {
  /** 测试环境一律视为联网：离线路径由 net.ts 的 BALANCEDECK_FORCE_OFFLINE 开关覆盖 */
  isOnline: () => true
}
