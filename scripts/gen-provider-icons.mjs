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
  // R6（10-11-island-tri-fix）：9 个无色 mark 各定品牌色，贴官方优先、不撞现有 8 色
  // （#12B76A/#D97757/#4D6BFE/#3859FF/#7C5CFF/#E23B5C/#615CED/#1664FF）。
  // 官方黑标（OpenAI #000000 / GitHub #181717 / Cursor 黑）在 #0b0b0d 深黑盘上不可见，
  // 一律取其深色版（白 / Copilot 紫 / Cursor 橙）；蓝紫 Reds 拥挤处按下述距离选。
  // 全对最小距离 43（openrouter slate vs generic 灰，形态不同），现有蓝簇已有 28
  // （deepseek #4D6BFE vs 智谱 #3859FF）先例在先，此集实际更疏。
  // codex/openai-billing 同取 #FFFFFF：同一 OpenAI 结图标同源一致（siliconflow-intl
  // 同 #7C5CFF 先例），不算撞车。
  codex: { icon: 'simple-icons:openai', color: '#FFFFFF' }, // OpenAI 深色版白（官方黑 #000000 压深盘不可见；原型 openai-billing #fff 先例）
  copilot: { icon: 'simple-icons:githubcopilot', color: '#8534F3' }, // GitHub Copilot Purple 官方（brand.github.com；vs 硅基紫 43，形态不同）
  cursor: { icon: 'simple-icons:cursor', color: '#F54E00' }, // Cursor 橙官方（brandfetch cursor.com；与等级 warn #ff9f0a 不同通道，见 island.css）
  gemini: { icon: 'simple-icons:googlegemini', color: '#8AB4F8' }, // Google Material Blue 200（Gemini 蓝 #4285F4 的深色版；原型 #4e8df5 距 deepseek 仅 35，提亮拉开到 89+）
  antigravity: { icon: 'simple-icons:google', color: '#FBBC04' }, // Google G 黄（四色取黄：蓝撞 gemini/volc、红距 MiniMax 仅 40、绿距 opencode 仅 44）
  deepseek: { icon: 'simple-icons:deepseek', color: '#4D6BFE' },
  kimi: { icon: 'simple-icons:moonshotai', color: '#00A1FF' }, // Kimi 签名蓝（kimi.ai brand book；#007CFF 备选距火山 33，取浅一档拉到 65）
  zhipu: { icon: 'thesvg:zhipu', color: '#3859FF' },
  siliconflow: { icon: 'thesvg:siliconcloud-siliconflow', color: '#7C5CFF' },
  minimax: { icon: 'simple-icons:minimax', color: '#E23B5C' },
  qwen: { icon: 'simple-icons:qwen', color: '#615CED' },
  volc: { icon: 'thesvg:volcengine', color: '#1664FF' },
  // 自定义协议
  'openrouter': { icon: 'simple-icons:openrouter', color: '#94A3B8' }, // simple-icons 官方 slate（favicon 验证，issue #12846；vs generic 灰 43，形态不同）
  'openai-billing': { icon: 'simple-icons:openai', color: '#FFFFFF' }, // 与 codex 同源一致（同图标同色，不算撞车）
  'siliconflow-intl': { icon: 'thesvg:siliconcloud-siliconflow', color: '#7C5CFF' },
  generic: { icon: 'lucide:plug', color: '#8E8E93' }, // Apple 系统灰（无品牌 fallback；距缺失灰 #636366 有 76，不会误读成缺失）
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
