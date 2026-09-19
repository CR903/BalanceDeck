/// <reference types="vite/client" />

/** 渲染层全局状态访问器（供语音播报等模块使用） */
interface Window {
  /** 当前应用状态（由 App.tsx 挂载） */
  __bd_state__?: () => AppState | null
}

// 注意：不要重复定义 AppState 等类型，直接引用 shared/types 中的定义
// 这里只需要声明 window 扩展
