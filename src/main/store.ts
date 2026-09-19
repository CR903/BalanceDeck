import { existsSync, readFileSync, writeFileSync } from 'fs'

// ═══════════════════════════════════════════════════════════════════════════════
// 凭据 / 偏好的落盘存储（**不依赖 electron**）
//
// electron 只在两处出现，都由调用方注入：
//   · 文件路径 —— 生产是 app.getPath('userData')，必须**惰性**求值：
//     BD_USER_DATA 在 app ready 前才 setPath，而模块导入早于模块体求值
//   · 加密 —— 生产是 safeStorage（macOS Keychain / Windows DPAPI），测试用明文替身
//
// 磁盘格式与旧实现逐字兼容（version 1）：
//   { version: 1, items: { <id>: base64 密文 | 'plain:<base64>' }, extras: { <key>: 明文 } }
// 安全约束：源码、示例、测试禁止出现可用凭据字面量。
// ═══════════════════════════════════════════════════════════════════════════════

export interface SecretCrypto {
  available(): boolean
  /** 明文 → base64 密文 */
  encrypt(plain: string): string
  /** base64 密文 → 明文 */
  decrypt(b64: string): string
}

interface SecretFile {
  version: 1
  items: Record<string, string>
  extras?: Record<string, string>
}

export interface Store {
  isEncryptionAvailable(): boolean
  getKey(providerId: string): Promise<string | null>
  setKey(providerId: string, plain: string): Promise<void>
  getExtra(key: string): Promise<string | null>
  setExtra(key: string, value: string): Promise<void>
}

export function createStore(opts: { filePath: () => string; crypto: SecretCrypto }): Store {
  const { filePath, crypto } = opts
  let cache: SecretFile | null = null

  function load(): SecretFile {
    if (cache) return cache
    try {
      const p = filePath()
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, 'utf-8')) as SecretFile
        if (raw?.version === 1) {
          cache = raw
          return cache
        }
      }
    } catch {
      // 损坏则重建
    }
    cache = { version: 1, items: {}, extras: {} }
    return cache
  }

  function persist(): void {
    if (!cache) return
    writeFileSync(filePath(), JSON.stringify(cache), 'utf-8')
  }

  return {
    isEncryptionAvailable: () => crypto.available(),

    async setKey(providerId: string, plain: string): Promise<void> {
      const f = load()
      if (!plain) {
        delete f.items[providerId]
      } else if (crypto.available()) {
        f.items[providerId] = crypto.encrypt(plain)
      } else {
        // 理论上 macOS/Windows 必可用；兜底标记前缀便于识别（仍为本地文件）
        f.items[providerId] = 'plain:' + Buffer.from(plain, 'utf-8').toString('base64')
      }
      persist()
    },

    async getKey(providerId: string): Promise<string | null> {
      const v = load().items[providerId]
      if (!v) return null
      try {
        if (v.startsWith('plain:')) return Buffer.from(v.slice(6), 'base64').toString('utf-8')
        return crypto.decrypt(v)
      } catch {
        return null
      }
    },

    async setExtra(key: string, value: string): Promise<void> {
      const f = load()
      if (!value) delete (f.extras ??= {})[key]
      else (f.extras ??= {})[key] = value
      persist()
    },

    async getExtra(key: string): Promise<string | null> {
      return load().extras?.[key] ?? null
    }
  }
}
