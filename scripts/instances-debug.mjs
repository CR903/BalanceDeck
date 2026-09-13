// 供应商实例排障工具（直接读写 userData/secrets.bin，不启动应用）
//
//   node scripts/instances-debug.mjs            # 列出实例
//   node scripts/instances-debug.mjs --dedupe   # 删除重复实例（同名同预设保留最早）
//   node scripts/instances-debug.mjs --order id1 id2 ...
//
// 用途：uitest 反复增删实例后清理残留 / 核对拖拽排序是否落盘。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const FILE = process.env.BALANCEDECK_USERDATA
  ? join(process.env.BALANCEDECK_USERDATA, 'secrets.bin')
  : join(homedir(), 'Library', 'Application Support', 'balancedeck', 'secrets.bin')

if (!existsSync(FILE)) {
  console.error('未找到', FILE)
  process.exit(1)
}
const store = JSON.parse(readFileSync(FILE, 'utf-8'))
let list = JSON.parse(store.extras?.providerInstances ?? '[]')

console.log(`实例（${list.length}）：`)
for (const i of list) console.log(`  ${i.id.padEnd(26)} ${i.name} | preset=${i.presetId || '-'} | ${i.kind}`)

if (process.argv.includes('--dedupe')) {
  const seen = new Set()
  const kept = []
  for (const i of list) {
    const key = `${i.presetId}|${i.name}`
    if (i.presetId && seen.has(key)) {
      console.log(`  删除重复: ${i.id} (${i.name})`)
      continue
    }
    seen.add(key)
    kept.push(i)
  }
  list = kept
  store.extras.providerInstances = JSON.stringify(list)
  writeFileSync(FILE, JSON.stringify(store), 'utf-8')
  console.log(`已清理，剩余 ${list.length} 个`)
}

const oi = process.argv.indexOf('--order')
if (oi !== -1) {
  const ids = process.argv.slice(oi + 1).filter((x) => !x.startsWith('--'))
  const rank = new Map(ids.map((id, i) => [id, i]))
  list = [...list].sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999))
  store.extras.providerInstances = JSON.stringify(list)
  writeFileSync(FILE, JSON.stringify(store), 'utf-8')
  console.log('已排序：', list.map((i) => i.name).join(' → '))
}
