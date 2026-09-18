// Fetches 2 Rocketbox business avatars + anim clips into resources/human-pets/.
// MIT-licensed third-party素材 (same category as Kenney CC0): redistribution allowed,
// attribution goes to README. Output dir is gitignored; run before dev/dist.
// Usage: node scripts/fetch-human-pets.mjs [--out <dir>]
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync, statSync, readdirSync, existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const outFlag = args.indexOf('--out')
const OUT = outFlag >= 0 ? args[outFlag + 1] : join(ROOT, 'resources', 'human-pets')
const REV = 'master'
const RAW = `https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/${REV}`
const API = `https://api.github.com/repos/microsoft/Microsoft-Rocketbox/contents`

const PETS = [
  {
    id: 'aria',
    dir: 'Assets/Avatars/Professions/Business_Female_01',
    name: 'Business_Female_01',
    clips: ['f_walk_neutral', 'f_idle_breathe_01', 'f_wave_01', 'f_gestic_talk_neutral_01'],
  },
  {
    id: 'ray',
    dir: 'Assets/Avatars/Professions/Business_Male_02',
    name: 'Business_Male_02',
    clips: ['m_walk_neutral', 'm_idle_breathe_01', 'm_wave_01', 'm_gestic_talk_neutral_01'],
  },
]
const ANIM_DIRS = ['all_animations_max_motextr_xy', 'all_animations_max_motextr_static']
const MAX_PET_BYTES = 40 * 1024 * 1024

async function dl(url, dest) {
  const r = await fetch(url, { headers: { 'User-Agent': 'BalanceDeck-fetch' } })
  if (!r.ok) throw new Error(`download failed ${r.status}: ${url}`)
  writeFileSync(dest, Buffer.from(await r.arrayBuffer()))
}

async function ghDir(apiPath) {
  const r = await fetch(`${API}/${apiPath}?ref=${REV}`, {
    headers: { 'User-Agent': 'BalanceDeck-fetch' },
  })
  if (!r.ok) throw new Error(`github api failed ${r.status}: ${apiPath}`)
  return r.json()
}

async function main() {
  // 幂等：两只模型都在就跳过（dist 前的 predist 钩子每次都会跑，不能重复下载 100MB+）
  const cached = PETS.every((p) => existsSync(join(OUT, p.id, 'model.fbx')))
  if (cached) {
    console.log('human-pets cached →', OUT)
    return
  }
  // Resolve clip file locations once (xy vs static dirs).
  const clipIndex = new Map()
  for (const d of ANIM_DIRS) {
    for (const e of await ghDir(`Assets/Animations/${d}`)) {
      if (e.type === 'file' && e.name.endsWith('.max.fbx'))
        clipIndex.set(e.name.replace(/\.max\.fbx$/, ''), `Assets/Animations/${d}/${e.name}`)
    }
  }
  for (const pet of PETS) {
    const pd = join(OUT, pet.id)
    mkdirSync(join(pd, 'textures'), { recursive: true })
    mkdirSync(join(pd, 'anims'), { recursive: true })
    await dl(`${RAW}/${pet.dir}/Export/${pet.name}.fbx`, join(pd, 'model.fbx'))
    await dl(`${RAW}/${pet.dir}/${pet.name}.png`, join(pd, 'preview.png'))
    const texEntries = (await ghDir(`${pet.dir}/Textures`)).filter(
      (e) => e.type === 'file' && e.name.endsWith('.tga') && !/specular|wrinkle/i.test(e.name)
    )
    for (const t of texEntries) {
      const tmp = join(pd, 'textures', t.name)
      await dl(`${RAW}/${pet.dir}/Textures/${t.name}`, tmp)
      const out = tmp.replace(/\.tga$/i, '.png')
      // sips: macOS built-in TGA→PNG + downscale (verified in spike; zero installs).
      await execFileAsync('sips', ['-Z', '1024', '-s', 'format', 'png', tmp, '--out', out])
    }
    for (const c of pet.clips) {
      const loc = clipIndex.get(c)
      if (!loc) throw new Error(`clip not found: ${c}`)
      await dl(`${RAW}/${loc}`, join(pd, 'anims', `${c}.fbx`))
    }
    writeFileSync(
      join(pd, 'meta.json'),
      JSON.stringify(
        {
          id: pet.id,
          source: `https://github.com/microsoft/Microsoft-Rocketbox/tree/${REV}/${pet.dir}`,
          license: 'MIT (microsoft/Microsoft-Rocketbox)',
          files: readdirSync(pd),
        },
        null,
        2
      )
    )
    let total = 0
    const walk = (d) => {
      for (const f of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, f.name)
        if (f.isDirectory()) walk(p)
        else if (!p.endsWith('.tga')) total += statSync(p).size
      }
    }
    walk(pd)
    console.log(`${pet.id}: ${(total / 1048576).toFixed(1)}MB (converted, tga excluded)`)
    if (total > MAX_PET_BYTES) throw new Error(`${pet.id} exceeds 40MB guard`)
    if (!existsSync(join(ROOT, '.gitignore'))) throw new Error('no .gitignore')
  }
  console.log('done →', OUT)
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
