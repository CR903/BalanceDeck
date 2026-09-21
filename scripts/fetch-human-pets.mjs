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

// 动作分两档（与 pet3d/human.ts 的 BASE_CLIPS / 动作目录对应）：
//   · BASE：静息与走动 —— instantiateHuman 当场就要，决定"人物多快出现"
//   · GESTURE：平时随机动作与交互反应 —— 按需懒加载（首次被抽到时才解析）
// 每位角色**各挑各的**（用户要求「每个人要设计独立的进出场动作和平时随机动作」）：
// 动作库有 f_/m_ 两套同构素材，但池子不是简单对称 —— aria 有拨头发/转脖子，ray 有耸肩/甩手。
const PETS = [
  {
    id: 'aria',
    dir: 'Assets/Avatars/Professions/Business_Female_01',
    name: 'Business_Female_01',
    clips: [
      'f_walk_neutral',
      'f_idle_breathe_01',
      'f_wave_01',
      'f_gestic_talk_neutral_01',
      'f_idle_look_around_01',
      'f_idle_stretch_arms_01',
      'f_gestic_thoughtful_01',
      'f_idle_touch_hair_01',
      'f_claphands_01',
      'f_idle_roll_head_01',
      'f_drink_drinking',
    ],
  },
  {
    id: 'ray',
    dir: 'Assets/Avatars/Professions/Business_Male_02',
    name: 'Business_Male_02',
    clips: [
      'm_walk_neutral',
      'm_idle_breathe_01',
      'm_wave_01',
      'm_gestic_talk_neutral_01',
      'm_idle_look_around_01',
      'm_idle_stretch_arms_01',
      'm_gestic_shrug_01',
      'm_gestic_thoughtful_01',
      'm_claphands_01',
      'm_idle_shake_arms_01',
      'm_drink_drinking',
    ],
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
  // 幂等：**逐个文件**判断，缺哪个补哪个。
  // 为什么不能只看 model.fbx 就整体跳过：动作目录会随功能增补（本次就一次加了 7 条/人），
  // 而 model.fbx 早就在了 —— 那会让所有人永远停在旧动作集上。反过来，重跑也不能退化成
  // "整包重下 160MB"：模型和贴图都按 existsSync 跳过，只有新增的 FBX 会被拉取。
  const missingOf = (p) =>
    p.clips.filter((c) => !existsSync(join(OUT, p.id, 'anims', `${c}.fbx`)))
  const needModel = (p) => !existsSync(join(OUT, p.id, 'model.fbx'))
  const todo = PETS.filter((p) => needModel(p) || missingOf(p).length > 0)
  if (todo.length === 0) {
    console.log('human-pets cached →', OUT)
    return
  }
  for (const p of todo) {
    const miss = missingOf(p)
    console.log(`${p.id}: 缺 ${needModel(p) ? '模型 ' : ''}${miss.length} 条动作${miss.length ? '（' + miss.join(', ') + '）' : ''}`)
  }
  // Resolve clip file locations once (xy vs static dirs).
  const clipIndex = new Map()
  for (const d of ANIM_DIRS) {
    for (const e of await ghDir(`Assets/Animations/${d}`)) {
      if (e.type === 'file' && e.name.endsWith('.max.fbx'))
        clipIndex.set(e.name.replace(/\.max\.fbx$/, ''), `Assets/Animations/${d}/${e.name}`)
    }
  }
  for (const pet of todo) {
    const pd = join(OUT, pet.id)
    mkdirSync(join(pd, 'textures'), { recursive: true })
    mkdirSync(join(pd, 'anims'), { recursive: true })
    if (needModel(pet)) {
      await dl(`${RAW}/${pet.dir}/Export/${pet.name}.fbx`, join(pd, 'model.fbx'))
      await dl(`${RAW}/${pet.dir}/${pet.name}.png`, join(pd, 'preview.png'))
      const texEntries = (await ghDir(`${pet.dir}/Textures`)).filter(
        (e) => e.type === 'file' && e.name.endsWith('.tga') && !/specular|wrinkle/i.test(e.name)
      )
      for (const t of texEntries) {
        const out = join(pd, 'textures', t.name.replace(/\.tga$/i, '.png'))
        if (existsSync(out)) continue
        const tmp = join(pd, 'textures', t.name)
        await dl(`${RAW}/${pet.dir}/Textures/${t.name}`, tmp)
        // sips: macOS built-in TGA→PNG + downscale (verified in spike; zero installs).
        await execFileAsync('sips', ['-Z', '1024', '-s', 'format', 'png', tmp, '--out', out])
      }
    }
    for (const c of missingOf(pet)) {
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
