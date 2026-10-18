// ═══════════════════════════════════════════════════════════════════════════════
// 目录递归遍历的 mtime 短路（claude.ts / codex.ts 共用）
//
// 为什么需要：这两个适配器**每轮采集**都要递归扫会话目录。旧写法是
// `readdirSync` + 对每个子项 `statSync` —— 会话目录里混着大量非目标文件，
// 这些 stat 每轮都白做，而且全在**主进程同步**执行（E13：同型隐患）。
//
// 短路规则（每一项都与旧写法逐字等价，不是"顺手加"的）：
//   · 目录不存在 / 无权限 → 不产出（等价于旧的 `!existsSync(dir) return` + try/catch）；
//   · 深度上限：根为 0，`depth > maxDepth` 即停（claude 4 / codex 5）；
//   · 符号链接**跟随**（旧的 `statSync` 会跟进链接目录；dirent 的 `isDirectory()`
//     对链接是 false，所以链接项退回 stat —— 行为不变）；
//   · 目录 mtime 未变 ⇒ 复用上次的条目列表：**不 readdir、不逐项 stat**。
//     ⚠ 不能连"文件列表"一起缓存：子目录里新增文件**不会**改父目录的 mtime，
//     缓存最终路径列表就会漏掉新会话。所以缓存的是**条目**，子目录照样走进去。
//     文件内容变化也不改目录 mtime —— 那由 parseFile 的 per-file mtime 缓存负责。
// ═══════════════════════════════════════════════════════════════════════════════

import { readdirSync, statSync } from 'fs'
import { join } from 'path'

type ItemKind = 'dir' | 'file' | 'other'

interface DirItem {
  name: string
  kind: ItemKind
}

interface CachedDir {
  mtimeMs: number
  items: DirItem[]
}

/** 目录 → 上次读到的条目（按目录 mtime 判定是否可复用） */
const dirCache = new Map<string, CachedDir>()

/** 读目录条目；未变则复用缓存（0 次 readdir）。目录不可读返回 null */
function itemsOf(dir: string): CachedDir | null {
  let mtimeMs: number
  try {
    const s = statSync(dir)
    if (!s.isDirectory()) return null
    mtimeMs = s.mtimeMs
  } catch {
    return null
  }
  const hit = dirCache.get(dir)
  if (hit && hit.mtimeMs === mtimeMs) return hit
  let items: DirItem[]
  try {
    items = readdirSync(dir, { withFileTypes: true }).map((d) => ({
      name: d.name,
      kind: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other'
    }))
  } catch {
    return null
  }
  const rec: CachedDir = { mtimeMs, items }
  dirCache.set(dir, rec)
  return rec
}

/**
 * 递归收集匹配的文件绝对路径（顺序 = readdir 顺序，与旧实现同）。
 * `maxDepth`：根为 0；claude 用 4、codex 用 5（与各自旧写法一致）。
 */
export function collectFiles(root: string, opts: { maxDepth?: number; match: (name: string) => boolean }): string[] {
  const out: string[] = []
  const maxDepth = opts.maxDepth ?? 4
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return
    const rec = itemsOf(dir)
    if (!rec) return
    for (const it of rec.items) {
      const p = join(dir, it.name)
      let kind: ItemKind = it.kind
      if (kind === 'other') {
        // 符号链接等：退回 stat（跟随链接），与旧实现的 statSync 判定一致
        try {
          kind = statSync(p).isDirectory() ? 'dir' : 'file'
        } catch {
          continue
        }
      }
      if (kind === 'dir') walk(p, depth + 1)
      else if (opts.match(it.name)) out.push(p)
    }
  }
  walk(root, 0)
  return out
}
