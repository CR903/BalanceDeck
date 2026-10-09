// macOS 构建入口：签名 + 公证的凭据探测（electron-builder 的包装）
// 用法：npm run dist:mac [-- 透传给 electron-builder 的额外参数]
//
// 设计前提是**缺任何凭据都照常出包**，不能让构建失败：
//   · 无 Developer ID Application 证书 → 不签名，仍产出 dmg/zip（与历史行为一致）；
//   · 无公证凭据 → 不加 notarize，跳过公证。
// 两者只影响「能不能分发到别的 Mac」，不影响本机运行 —— 所以缺就跳过 + 打印
// 还差什么，而不是 forceCodeSigning 把构建卡死。
//
// 公证凭据二选一（与 electron-builder 内置 notarization 的读取口径一致）：
//   A. APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
//   B. APPLE_KEY_ID + APPLE_KEY_ISSUER_ID + APPLE_KEY_PATH（App Store Connect API .p8）

import { spawnSync, spawn } from 'node:child_process'

/** 本机是否装了可用于分发的证书（Developer ID Application，不是 Apple Development） */
function hasDeveloperIdCert() {
  const r = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
  if (r.status !== 0) return false
  return /Developer ID Application:/i.test(r.stdout ?? '')
}

/** 公证凭据：返回齐了的那组的键名，缺哪个也一并列出来 */
function notaryCreds() {
  const password = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
  const apiKey = ['APPLE_KEY_ID', 'APPLE_KEY_ISSUER_ID', 'APPLE_KEY_PATH']
  const missing = (keys) => keys.filter((k) => !process.env[k])
  for (const [kind, keys] of [
    ['password', password],
    ['apikey', apiKey]
  ]) {
    const miss = missing(keys)
    if (miss.length === 0) return { mode: kind, missing: [] }
    if (miss.length < keys.length) return { mode: null, missing: miss }
  }
  // 两组一组都没开始配：默认报 A 组的缺口（对人更友好，A 是常见路径）
  return { mode: null, missing: missing(password) }
}

const certified = hasDeveloperIdCert()
const notary = notaryCreds()

const args = ['--mac', ...process.argv.slice(2)]

console.log('── dist-mac 环境检查 ──────────────────────────────')
if (certified) {
  console.log('签名：发现 Developer ID Application 证书 → 将自动签名')
} else {
  console.log('签名：未发现 Developer ID Application 证书 → 跳过签名（本机可用，分发会被 Gatekeeper 拦）')
  console.log('       申请入口：developer.apple.com → Certificates → Developer ID Application')
}
if (notary.mode) {
  args.push('--mac.notarize=true')
  console.log(`公证：凭据齐全（${notary.mode}）→ 将提交 Apple 公证`)
} else {
  console.log(`公证：跳过，还缺 ${notary.missing.join('、')}`)
  console.log('       （A 组 APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID；B 组 APPLE_KEY_ID + APPLE_KEY_ISSUER_ID + APPLE_KEY_PATH）')
}
console.log('──────────────────────────────────────────────────')

const child = spawn('electron-builder', args, { stdio: 'inherit', shell: true })
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
