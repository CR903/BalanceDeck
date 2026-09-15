/// <reference types="vite/client" />

declare module '*.png?inline' {
  const src: string
  export default src
}

declare module '*.glb?inline' {
  const src: string
  export default src
}
