// 语音模块测试（src/renderer/src/voice.ts）
// 用法：node scripts/test-voice.mjs
//
// ⚠ 加载的是**真实源码**（esbuild 打包 src 下的 .ts），不在这里抄一份 voiceGender /
// pickVoice。抄出来的那份已经漂移过一次：voice.ts 加了「tian / 婷婷 / yu / shu」几个
// 关键词时，测试里的副本没跟着改，套件照样全绿 —— 绿灯证明不了任何东西
// （quality-guidelines 明确禁止内联实现副本，test-percent.mjs 因此漂移过）。
//
// 外部依赖只有一个：window.speechSynthesis（voiceGender / pickVoice 都在**调用时**读它），
// 所以替身可以随时换。

import { loadTs } from './lib/load-ts.mjs'

const { voiceGender, pickVoice, stopVoice } = await loadTs('src/renderer/src/voice.ts')

let pass = 0
let fail = 0
function eq(actual, expected, label) {
  if (Object.is(actual, expected)) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}`)
    console.log(`    期望: ${JSON.stringify(expected)}`)
    console.log(`    实际: ${JSON.stringify(actual)}`)
  }
}

/** 装一个假的 window.speechSynthesis；返回 restore */
function withVoices(voices) {
  let cancels = 0
  const prevWin = globalThis.window
  globalThis.window = {
    speechSynthesis: {
      getVoices: () => voices,
      cancel: () => {
        cancels++
      }
    }
  }
  return {
    cancelCount: () => cancels,
    restore: () => {
      if (prevWin === undefined) delete globalThis.window
      else globalThis.window = prevWin
    }
  }
}

// 真实存在的 macOS 中文音色。⚠ 性别是**查出来的**，不是猜的：
//   · `say -v '?'` 在真机上列出实际安装的音色（本机只有 Mei-Jia / Sin-ji / Ting-Ting，全女声）
//   · 拿不准的看苹果的音色包标识：Yu-shu = com.apple.ttsbundle.siri_**female**_zh-CN_compact
//     Li-mu  = com.apple.ttsbundle.siri_**male**_zh-CN_compact
// 2026-09-29 复核发现：本文件与 voice.ts 曾**一起**把 Yu-Shu 记成男声（错），
// 于是「加载真实源码」也照样全绿 —— 事实错了，护栏和被护的东西一起错。
// 这次修正的证据写在这里，免得下一个改关键词表的人把它改回去。
const MACOS_VOICES = [
  { name: 'Ting-Ting', lang: 'zh-CN' },      // 女
  { name: 'Li-Mu', lang: 'zh-CN' },           // 男（siri_male_zh-CN）
  { name: 'Sin-Ji', lang: 'zh-CN' },          // 女
  { name: 'Mei-Jia', lang: 'zh-CN' },         // 女
  { name: 'Tian-Tian', lang: 'zh-CN' },       // 女
  { name: 'Yu-Shu', lang: 'zh-CN' },          // 女（siri_**female**_zh-CN）—— 不是男声
  { name: 'Yu-Shu (Enhanced)', lang: 'zh-CN' },
  { name: 'Li-Mu (Enhanced)', lang: 'zh-CN' }
]
// Windows 的中文音色：三个男声 + Yunxia（女声，前缀相近，最容易被误判的那一个）
const WINDOWS_VOICES = [
  { name: 'Microsoft Kangkang', lang: 'zh-CN' },
  { name: 'Microsoft Yunxi', lang: 'zh-CN' },
  { name: 'Microsoft Yunjian', lang: 'zh-CN' },
  { name: 'Microsoft Yunyang', lang: 'zh-CN' },
  { name: 'Microsoft Yunxia', lang: 'zh-CN' },
  { name: 'Microsoft Xiaoxiao', lang: 'zh-CN' }
]
const FEMALE_ONLY = [
  { name: 'Ting-Ting', lang: 'zh-CN' },
  { name: 'Mei-Jia', lang: 'zh-CN' }
]
const UNKNOWN_ONLY = [
  { name: 'Unknown Voice', lang: 'zh-CN' },
  { name: 'Another Voice', lang: 'zh-CN' }
]
/** 男声 + 识别不出来的混在一起：请求男声时必须跳过 female 直接命中 unknown */
const FEMALE_PLUS_UNKNOWN = [...FEMALE_ONLY, ...UNKNOWN_ONLY]
const WITH_ENGLISH = [
  { name: 'Alex', lang: 'en-US' },
  { name: 'Ting-Ting', lang: 'zh-CN' },
  { name: 'Li-Mu', lang: 'zh-CN' }
]

console.log('A. voiceGender 性别识别（macOS 中文音色命名规律）')
{
  const v = withVoices([])
  try {
    eq(voiceGender({ name: 'Ting-Ting', lang: 'zh-CN' }), 'female', 'Ting-Ting → female')
    eq(voiceGender({ name: 'Li-Mu', lang: 'zh-CN' }), 'male', 'Li-Mu → male（siri_male_zh-CN）')
    eq(voiceGender({ name: 'Sin-Ji', lang: 'zh-CN' }), 'female', 'Sin-Ji → female')
    eq(voiceGender({ name: 'Mei-Jia', lang: 'zh-CN' }), 'female', 'Mei-Jia → female')
    eq(voiceGender({ name: 'Tian-Tian', lang: 'zh-CN' }), 'female', 'Tian-Tian → female')
    // ↓ 本组的重点：Yu-shu 曾被错判成 male，害得选「男声」的用户在 macOS 上拿女声念播报。
    //   判据来自苹果自己的音色包标识，不是记忆。
    eq(voiceGender({ name: 'Yu-Shu', lang: 'zh-CN' }), 'female', 'Yu-Shu → female（siri_FEMALE_zh-CN；曾错判成 male）')
    eq(voiceGender({ name: 'Yu-Shu (Enhanced)', lang: 'zh-CN' }), 'female', 'Yu-Shu (Enhanced) → female')
    eq(voiceGender({ name: 'Li-Mu (Enhanced)', lang: 'zh-CN' }), 'male', 'Li-Mu (Enhanced) → male')
    eq(voiceGender({ name: '婷婷', lang: 'zh-CN' }), 'female', '中文名「婷婷」→ female')
    eq(voiceGender({ name: 'Siri 声音 1', lang: 'zh-CN' }), 'male', '「siri 1」→ male')
    eq(voiceGender({ name: 'Chinese Female', lang: 'zh-CN' }), 'female', '英文 female 关键词')
    eq(voiceGender({ name: 'Unknown Voice', lang: 'zh-CN' }), 'unknown', '认不出来 → unknown')
  } finally {
    v.restore()
  }
}

// Windows 中文音色：'yun' 不能当男声关键词 —— Yunxia（晓晓）是女声，男声只有另三个。
// 这组把上面那条注释变成可执行断言：把 'yunyang' 换成 'yun' 就该红。
{
  const v = withVoices([])
  try {
    eq(voiceGender({ name: 'Microsoft Kangkang', lang: 'zh-CN' }), 'male', 'Kangkang → male')
    eq(voiceGender({ name: 'Microsoft Yunxi', lang: 'zh-CN' }), 'male', 'Yunxi → male')
    eq(voiceGender({ name: 'Microsoft Yunjian', lang: 'zh-CN' }), 'male', 'Yunjian → male')
    eq(voiceGender({ name: 'Microsoft Yunyang', lang: 'zh-CN' }), 'male', 'Yunyang → male')
    eq(voiceGender({ name: 'Microsoft Yunxia', lang: 'zh-CN' }), 'unknown', 'Yunxia → 认不出（不能因 "yun" 判成男声）')
    eq(voiceGender({ name: 'Microsoft Xiaoxiao', lang: 'zh-CN' }), 'unknown', 'Xiaoxiao → 认不出（无关键词即沉默，不猜）')
  } finally {
    v.restore()
  }
}

console.log('\nB. pickVoice：请求男声')
{
  const v = withVoices(MACOS_VOICES)
  try {
    eq(pickVoice('zh-CN', 'male')?.name, 'Li-Mu', '有男声时返回男声（不是列表里第一个）')
  } finally {
    v.restore()
  }
}
{
  // 上面那份 MACOS_VOICES 里 Li-Mu 排在 Yu-Shu 前面，所以**列表顺序**救了它 ——
  // 那不是修复。真实 macOS 上 Yu-shu 完全可能排在 Li-mu 前面（安装顺序 / 音序），
  // 一旦排在前面，被错判成 male 的 Yu-shu 就会顶掉 Li-mu。这条把顺序反过来钉住。
  const v = withVoices([...MACOS_VOICES].reverse())
  try {
    eq(pickVoice('zh-CN', 'male')?.name, 'Li-Mu (Enhanced)', '列表倒序时仍命中真男声（Yu-shu 不再冒充男声）')
  } finally {
    v.restore()
  }
}
{
  // Windows：Yunxia 排在最前，也不能被 'yun' 之类的宽泛关键词拖去当男声
  const reordered = [WINDOWS_VOICES[4], ...WINDOWS_VOICES.filter((_, i) => i !== 4)]
  const v = withVoices(reordered)
  try {
    eq(pickVoice('zh-CN', 'male')?.name, 'Microsoft Kangkang', 'Windows 列表里 Yunxia 在前，请求男声仍返回 Kangkang')
  } finally {
    v.restore()
  }
}
{
  const v = withVoices(FEMALE_ONLY)
  try {
    eq(pickVoice('zh-CN', 'male')?.name, 'Ting-Ting', '只有女声时回退到第一个中文音色（宁可错也不静音）')
  } finally {
    v.restore()
  }
}
{
  const v = withVoices(UNKNOWN_ONLY)
  try {
    eq(pickVoice('zh-CN', 'male')?.name, 'Unknown Voice', '只有 unknown 时返回 unknown')
  } finally {
    v.restore()
  }
}
{
  // 这条是「请求男声时优先选 unknown」那条分支存在的理由：宁可给一个没说死的音色，
  // 也不要一个女声顶着「男声」的标签念出来
  const v = withVoices(FEMALE_PLUS_UNKNOWN)
  try {
    eq(pickVoice('zh-CN', 'male')?.name, 'Unknown Voice', '女声 + unknown 混排时跳过女声，命中 unknown')
  } finally {
    v.restore()
  }
}

console.log('\nC. pickVoice：请求女声 / 不限')
{
  const v = withVoices(MACOS_VOICES)
  try {
    eq(pickVoice('zh-CN', 'female')?.name, 'Ting-Ting', '有女声时返回女声')
    eq(pickVoice('zh-CN', 'any')?.name, 'Ting-Ting', "gender='any' → 第一个中文音色")
  } finally {
    v.restore()
  }
}
{
  const v = withVoices(UNKNOWN_ONLY)
  try {
    eq(pickVoice('zh-CN', 'female')?.name, 'Unknown Voice', '只有 unknown 时返回 unknown')
  } finally {
    v.restore()
  }
}

console.log('\nD. pickVoice：退化路径')
{
  const v = withVoices(WITH_ENGLISH)
  try {
    eq(pickVoice('zh-CN', 'any')?.name, 'Ting-Ting', '列表里有英文音色 → 仍只挑中文')
  } finally {
    v.restore()
  }
}
{
  const v = withVoices([])
  try {
    eq(pickVoice('zh-CN', 'any'), null, '系统还没给音色（voices 未就绪）→ null，不抛')
  } finally {
    v.restore()
  }
}
{
  const prevWin = globalThis.window
  delete globalThis.window
  try {
    eq(pickVoice('zh-CN', 'any'), null, '没有 window（SSR / 早期启动）→ null')
  } finally {
    if (prevWin !== undefined) globalThis.window = prevWin
  }
}

console.log('\nE. stopVoice：两个通道的停法由 speechOut 兜着，这里只保证它真的 cancel')
{
  const v = withVoices(MACOS_VOICES)
  try {
    stopVoice()
    eq(v.cancelCount(), 1, 'stopVoice 调了 speechSynthesis.cancel()')
  } finally {
    v.restore()
  }
}
{
  const prevWin = globalThis.window
  delete globalThis.window
  try {
    stopVoice()
    pass++
    console.log('  ✓ 没有 window 时 stopVoice 不抛（收起态卸载路径会走到）')
  } catch (e) {
    fail++
    console.log(`  ✗ 没有 window 时 stopVoice 抛了：${e.message}`)
  } finally {
    if (prevWin !== undefined) globalThis.window = prevWin
  }
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail === 0 ? 0 : 1)
