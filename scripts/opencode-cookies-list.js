// 诊断：列出 opencode-auth 分区里 opencode.ai 的全部 cookie（只打印名称与长度，不打印值）
// 用法：npx electron scripts/opencode-cookies-list.js
const { app, session } = require('electron')

app.setName('balancedeck')

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:opencode-auth')
  const all = await ses.cookies.get({})
  const oc = all.filter((c) => (c.domain || '').includes('opencode'))
  console.log(`分区内 cookie 共 ${all.length} 条，其中 opencode 相关 ${oc.length} 条：\n`)
  for (const c of oc) {
    console.log(
      `  ${c.name.padEnd(24)} domain=${(c.domain || '').padEnd(16)} ` +
        `len=${String(c.value.length).padStart(4)} httpOnly=${c.httpOnly} secure=${c.secure} ` +
        `sameSite=${c.sameSite || '-'} session=${c.session}`
    )
  }
  if (oc.length === 0) {
    console.log('  （没有 opencode 相关 cookie —— 授权窗口的会话可能未被持久化）')
  }
  // 其它域名的 cookie（登录过程中可能产生）
  const others = [...new Set(all.map((c) => c.domain))].filter((d) => d && !d.includes('opencode'))
  if (others.length) console.log('\n其它域名:', others.join(', '))
  app.quit()
})
