// 渲染层的 window.api 类型**从 preload 实现推导**（typeof api），不再手工镜像。
//
// 为什么：此前这里与 src/shared/types.ts 的 BalanceDeckApi 各写一份，结果双向漂移 ——
// 接口声明了 openSettings / closeSettings / onSettingsChanged 而 preload 从未实现
// （App.tsx 用 ?. 调用，于是静默失效），preload 提供的 onCollapsed 又不在接口里，
// 只能在这里打补丁。现在少写一份就不可能漂移：preload 没实现的方法，
// 渲染层连类型都没有。
import type { Api } from '../../preload'

declare global {
  interface Window {
    api: Api
  }
}

export {}
