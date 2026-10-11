#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// 供应商图标生成器（构建期执行一次，产物提交进仓库）
//
//   node scripts/gen-provider-icons.mjs
//
// 为什么是"构建期 + 内联"而不是运行时拉取：
//   这是离线可用的桌面常驻工具，不能因为网络/第三方 CDN 抖动而缺图标。
//
// 图标来源：Iconify（https://iconify.design）
//   · simple-icons / thesvg / lucide —— 单色（currentColor），可随品牌色/主题着色
//   · 生成后统一把 fill 归一为 currentColor：作为 CSS mask 时只用其 alpha，
//     作为 <img>/canvas 时解析为黑色（托盘 template image 需要）
// ═══════════════════════════════════════════════════════════════════════════════

import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src/renderer/src/provider-icons.ts')

/** markId → { icon: Iconify 名, color: 品牌色（'' = 跟随主题前景色） } */
const MARKS = {
  // 内置预设
  // opencode（R5 · B 方案）：官方只有双色像素 O（opencode.ai/brand，无品牌色；
  // simple-icons 标注色即 #000000），无官方实心版可换。原方环壁厚仅 5/24，
  // 在 15px 下显小偏灰 → 内孔收窄使壁厚 5→7（墨量 336→420，+25%），另定品牌绿。
  // 绿系此前无人用（深鲨蓝 #4D6BFE / Claude #D97757 / 智谱 #3859FF /
  // 硅基 #7C5CFF / MiniMax #E23B5C / 通义 #615CED / 火山 #1664FF 均已占）。
  opencode: {
    icon: 'simple-icons:opencode',
    color: '#12B76A',
    // 加粗补丁：from 必须命中，否则说明上游换了路径 —— 宁可失败也不静默产出细环
    patch: { from: 'M17 4.8H7v14.4h10z', to: 'M15 7H9v10h6z' },
  },
  claude: { icon: 'simple-icons:claude', color: '#D97757' },
  codex: { icon: 'simple-icons:openai', color: '' },
  copilot: { icon: 'simple-icons:githubcopilot', color: '' },
  cursor: { icon: 'simple-icons:cursor', color: '' },
  gemini: { icon: 'simple-icons:googlegemini', color: '' },
  antigravity: { icon: 'simple-icons:google', color: '' },
  deepseek: { icon: 'simple-icons:deepseek', color: '#4D6BFE' },
  kimi: { icon: 'simple-icons:moonshotai', color: '' },
  zhipu: { icon: 'thesvg:zhipu', color: '#3859FF' },
  siliconflow: { icon: 'thesvg:siliconcloud-siliconflow', color: '#7C5CFF' },
  minimax: { icon: 'simple-icons:minimax', color: '#E23B5C' },
  qwen: { icon: 'simple-icons:qwen', color: '#615CED' },
  volc: { icon: 'thesvg:volcengine', color: '#1664FF' },
  // 自定义协议
  'openrouter': { icon: 'simple-icons:openrouter', color: '' },
  'openai-billing': { icon: 'simple-icons:openai', color: '' },
  'siliconflow-intl': { icon: 'thesvg:siliconcloud-siliconflow', color: '#7C5CFF' },
  generic: { icon: 'lucide:plug', color: '' }
}

async function fetchIcon(name) {
  const url = `https://api.iconify.design/${name.replace(':', '/')}.svg?height=24`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${name} → HTTP ${res.status}`)
  const svg = await res.text()
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1]
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  if (!viewBox || !inner.trim()) throw new Error(`${name} → 无法解析 SVG`)
  // 归一化填充：作为 mask 用时只看 alpha；作为图片用时解析为黑色
  const body = inner
    .replace(/fill="(?!none|currentColor)[^"]*"/g, 'fill="currentColor"')
    .replace(/stroke="(?!none|currentColor)[^"]*"/g, 'stroke="currentColor"')
    .replace(/\s(?:width|height)="[^"]*"/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return { viewBox, body }
}

const out = {}
for (const [id, def] of Object.entries(MARKS)) {
  try {
    let { viewBox, body } = await fetchIcon(def.icon)
    if (def.patch) {
      if (!body.includes(def.patch.from)) throw new Error(`${def.icon} → 加粗补丁未命中，上游路径可能已变`)
      body = body.replace(def.patch.from, def.patch.to)
    }
    out[id] = { viewBox, body, color: def.color, src: def.icon }
    process.stdout.write(`✓ ${id.padEnd(18)} ${def.icon}\n`)
  } catch (e) {
    process.stderr.write(`✗ ${id}: ${e.message}\n`)
    process.exitCode = 1
  }
}

const header = `// ⚠️ 由 scripts/gen-provider-icons.mjs 生成，请勿手工编辑。
// 更新：node scripts/gen-provider-icons.mjs
//
// 图标来自 Iconify（simple-icons / thesvg / lucide），构建期内联 → 运行时零网络。
// body 内所有 fill/stroke 已归一为 currentColor：
//   · 作为 CSS mask 用时只看 alpha（颜色由 CSS 决定，可随主题/品牌色）
//   · 作为 <img>/canvas 用时解析为黑色（托盘 template image 用）
`

const ts = `${header}
export interface ProviderMark {
  /** SVG viewBox */
  viewBox: string
  /** SVG 内部标记（fill/stroke 均为 currentColor） */
  body: string
  /** 品牌色；空串 = 跟随主题前景色 */
  color: string
  /** 来源（排障/溯源用） */
  src: string
}

export const PROVIDER_MARKS: Record<string, ProviderMark> = ${JSON.stringify(out, null, 2)}

/** 取图标（未知 id 回退到通用图标） */
export function providerMark(id?: string): ProviderMark {
  return (id && PROVIDER_MARKS[id]) || PROVIDER_MARKS.generic
}
`

writeFileSync(OUT, ts)
process.stdout.write(`\n已写入 ${OUT}（${Object.keys(out).length} 个图标）\n`)
