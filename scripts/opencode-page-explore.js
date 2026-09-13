// 探索：控制台用量页里的每模型明细结构（用授权分区的实时 cookie）
// 只输出结构信息，不打印 cookie 明文。
// 用法：npx electron scripts/opencode-page-explore.js
const { app, session } = require('electron')
const fs = require('fs')
const { join } = require('path')

app.setName('balancedeck')

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:opencode-auth')
  const cookies = (await ses.cookies.get({ domain: 'opencode.ai' })).filter(
    (c) => (c.domain || '').replace(/^\./, '') === 'opencode.ai' && c.value
  )
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
  const file = join(app.getPath('userData'), 'secrets.bin')
  const wid = JSON.parse(fs.readFileSync(file, 'utf-8')).extras?.opencodeWorkspaceId
  const url = `https://opencode.ai/workspace/${wid}/go`

  const res = await fetch(url, { headers: { Cookie: cookie, Accept: 'text/html' } })
  const html = await res.text()
  console.log('HTTP', res.status, '| HTML', html.length, '字符\n')

  // 1) 所有 data-slot 名称
  const slots = [...new Set([...html.matchAll(/data-slot="([^"]+)"/g)].map((m) => m[1]))]
  console.log('data-slot 名称（' + slots.length + '）:')
  console.log(' ', slots.join(', '))

  // 2) 找模型相关关键词
  for (const kw of ['model', 'Detail', 'detail', 'quota', 'Quota', 'limit', 'Limit', 'quota', 'per-model', 'usage-value', 'usage-item']) {
    const n = (html.match(new RegExp(kw, 'g')) || []).length
    if (n) console.log(`\n关键词 "${kw}": ${n} 次`)
  }

  // 3) 找内嵌 JSON（SolidStart 常把数据序列化进脚本）
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  console.log('\n内嵌 script 块:', scripts.length)
  scripts.forEach((s, i) => {
    const hasModel = /model|quota|usd|USD/i.test(s)
    if (hasModel && s.length > 80) {
      console.log(`  [${i}] 长度 ${s.length}，含 model/quota/USD 关键词：`)
      console.log('     ', s.slice(0, 400).replace(/\s+/g, ' '))
    }
  })

  // 4) 若存在模型表，打印其周围 HTML
  const idx = html.search(/每月配额|月配额|Monthly quota|monthly quota/i)
  if (idx >= 0) {
    console.log('\n找到"每月配额"关键词，上下文：')
    console.log(html.slice(Math.max(0, idx - 1200), idx + 1200).replace(/\s+/g, ' '))
  } else {
    console.log('\n未找到"每月配额"关键词 —— 明细可能是打开折叠后才由客户端请求/渲染')
  }

  // 5) 保存整页供离线分析
  const out = '/tmp/opencode-console.html'
  fs.writeFileSync(out, html)
  console.log('\n完整 HTML 已保存到', out)

  app.quit()
})
