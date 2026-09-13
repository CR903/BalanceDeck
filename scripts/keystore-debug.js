// 凭据诊断：解密本地密钥链存档，只打印掩码（前8+后4+长度），不输出明文。
// 用法：npx electron scripts/keystore-debug.js
const { app, safeStorage } = require('electron')
const { join } = require('path')
const os = require('os')
const fs = require('fs')

app.whenReady().then(() => {
  const candidates = ['balancedeck', 'BalanceDeck', 'Electron'].map((n) =>
    join(os.homedir(), 'Library', 'Application Support', n, 'secrets.bin')
  )
  let found = false
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue
    found = true
    console.log('==', p)
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'))
      for (const [id, enc] of Object.entries(data.items || {})) {
        try {
          const plain = enc.startsWith('plain:')
            ? Buffer.from(enc.slice(6), 'base64').toString('utf-8')
            : safeStorage.decryptString(Buffer.from(enc, 'base64'))
          const masked = plain.slice(0, 8) + '…' + plain.slice(-4) + `  (长度 ${plain.length})`
          const odd = /[^\x21-\x7e]/.test(plain) ? '  ⚠ 含非ASCII/空白字符!' : ''
          console.log(`  ${id}: ${masked}${odd}`)
        } catch (e) {
          console.log(`  ${id}: 解密失败 ${e.message}`)
        }
      }
      console.log('  extras:', JSON.stringify(data.extras || {}))
    } catch (e) {
      console.log('  读取失败:', e.message)
    }
  }
  if (!found) console.log('未找到任何 secrets.bin（候选：' + candidates.join(', ') + '）')
  app.quit()
})
