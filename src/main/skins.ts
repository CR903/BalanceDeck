import { app, Menu, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { getExtra, setExtra } from './keystore'

// 皮肤系统：
// - 内置皮肤 = 渲染层 CSS 变量组（data-skin=<id>），零加载成本；
// - 外部皮肤 = userData/skins/<目录名>/*.css，主进程读文本经 IPC 注入 <style>，零代码新增。

export interface SkinInfo {
  id: string // 内置: 'aero'…；外部: 'ext:<dirname>'
  name: string
  builtin: boolean
}

export const BUILTIN_SKINS: SkinInfo[] = [
  { id: 'aero', name: '原生毛玻璃（跟随系统）', builtin: true },
  { id: 'dark', name: '深色科技', builtin: true },
  { id: 'minimal', name: '极简白', builtin: true },
  { id: 'candy', name: '渐变彩', builtin: true },
  { id: 'ink', name: '墨纸', builtin: true }
]

export function skinsDir(): string {
  return join(app.getPath('userData'), 'skins')
}

export function listSkins(): SkinInfo[] {
  const out: SkinInfo[] = [...BUILTIN_SKINS]
  try {
    const dir = skinsDir()
    if (existsSync(dir)) {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        const sub = join(dir, e.name)
        const hasCss = readdirSync(sub).some((f) => f.endsWith('.css'))
        if (hasCss) out.push({ id: `ext:${e.name}`, name: `${e.name}（外部）`, builtin: false })
      }
    }
  } catch {
    // 目录不可读则只返回内置
  }
  return out
}

/** 外部皮肤 CSS 文本（内置皮肤由渲染层 CSS 变量承担，返回 null） */
export function readSkinCss(id: string): string | null {
  if (!id.startsWith('ext:')) return null
  const name = id.slice(4).replace(/[/\\]/g, '') // 防目录穿越
  const dir = join(skinsDir(), name)
  if (!existsSync(dir)) return null
  const cssFile = readdirSync(dir).find((f) => f === 'skin.css' || f.endsWith('.css'))
  if (!cssFile) return null
  try {
    return readFileSync(join(dir, cssFile), 'utf-8')
  } catch {
    return null
  }
}

export async function currentSkinId(): Promise<string> {
  return (await getExtra('skin')) || 'aero'
}

export async function setSkin(id: string): Promise<void> {
  await setExtra('skin', id)
  const win = BrowserWindow.getAllWindows()[0]
  win?.webContents.send('ui:skin', id)
}

/** 悬浮卡片右键菜单：换肤（即时生效） */
export function openSkinMenu(): void {
  void (async () => {
    const current = await currentSkinId()
    const items: Electron.MenuItemConstructorOptions[] = [
      { label: '皮肤', enabled: false },
      ...listSkins().map((s) => ({
        label: s.name,
        type: 'radio' as const,
        checked: s.id === current,
        click: (): void => {
          void setSkin(s.id)
        }
      })),
      { type: 'separator' },
      {
        label: '打开皮肤目录…',
        click: (): void => {
          try {
            mkdirSync(skinsDir(), { recursive: true })
          } catch {
            // 忽略
          }
          void shell.openPath(skinsDir())
        }
      }
    ]
    Menu.buildFromTemplate(items).popup({ window: BrowserWindow.getAllWindows()[0] })
  })()
}
