import { app, safeStorage } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'

// 凭据存储：safeStorage（macOS Keychain / Windows DPAPI）加密后落盘，
// 磁盘上无明文。安全约束：源码/示例/测试禁止出现可用凭据字面量。

interface SecretFile {
  version: 1
  items: Record<string, string> // providerId -> base64 密文
  extras?: Record<string, string> // 非敏感附加项（如 minimaxGroupId）明文存放
}

let cache: SecretFile | null = null

function filePath(): string {
  return join(app.getPath('userData'), 'secrets.bin')
}

function load(): SecretFile {
  if (cache) return cache
  try {
    if (existsSync(filePath())) {
      const raw = JSON.parse(readFileSync(filePath(), 'utf-8')) as SecretFile
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

export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

export async function setKey(providerId: string, plain: string): Promise<void> {
  const f = load()
  if (!plain) {
    delete f.items[providerId]
  } else if (isEncryptionAvailable()) {
    f.items[providerId] = safeStorage.encryptString(plain).toString('base64')
  } else {
    // 理论上 macOS/Windows 必可用；兜底标记前缀便于识别（仍为本地文件）
    f.items[providerId] = 'plain:' + Buffer.from(plain, 'utf-8').toString('base64')
  }
  persist()
}

export async function getKey(providerId: string): Promise<string | null> {
  const f = load()
  const v = f.items[providerId]
  if (!v) return null
  try {
    if (v.startsWith('plain:')) return Buffer.from(v.slice(6), 'base64').toString('utf-8')
    return safeStorage.decryptString(Buffer.from(v, 'base64'))
  } catch {
    return null
  }
}

export async function setExtra(key: string, value: string): Promise<void> {
  const f = load()
  if (!value) delete (f.extras ??= {})[key]
  else (f.extras ??= {})[key] = value
  persist()
}

export async function getExtra(key: string): Promise<string | null> {
  const f = load()
  return f.extras?.[key] ?? null
}
