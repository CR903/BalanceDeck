import type { BalanceDeckApi } from '../../shared/types'

declare global {
  interface Window {
    api: BalanceDeckApi & {
      onCollapsed(cb: (c: boolean) => void): () => void
    }
  }
}

export {}
