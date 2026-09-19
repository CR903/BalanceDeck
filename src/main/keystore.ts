import { app, safeStorage } from 'electron'
import { join } from 'path'
import { createStore } from './store'

// 凭据存储的生产装配：safeStorage（macOS Keychain / Windows DPAPI）加密后落盘，
// 磁盘上无明文。安全约束：源码/示例/测试禁止出现可用凭据字面量。
//
// 纯逻辑（格式、缓存、'plain:' 兜底、损坏重建）都在 ./store，可被单元测试加载；
// 这里只注入 electron 的两样东西，并保持原有的导出名，调用方无需改动。

export const keystoreStore = createStore({
  // 必须惰性求值：BD_USER_DATA 在 app ready 前才 setPath，
  // 而静态导入先于模块体求值 —— 提前算会把路径钉在默认 userData 上。
  filePath: () => join(app.getPath('userData'), 'secrets.bin'),
  crypto: {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64'))
  }
})

export const isEncryptionAvailable = keystoreStore.isEncryptionAvailable
export const getKey = keystoreStore.getKey
export const setKey = keystoreStore.setKey
export const getExtra = keystoreStore.getExtra
export const setExtra = keystoreStore.setExtra
