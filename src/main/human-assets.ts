import { protocol, net } from 'electron'
import { join, normalize } from 'path'
import { existsSync } from 'fs'
import { app } from 'electron'

// ═══════════════════════════════════════════════════════════════════════════════
// bd-asset:// 协议：给 file:// 渲染层提供真人系宠物素材（Rocketbox FBX/PNG）。
//
// 为什么不用 data URL：单只纹理转换后仍有 ~15MB，base64 内联会炸内存；
// 为什么不用 file:// 直读：file:// 页面的 fetch 会被 Chromium 拦掉；
// 为什么不用 webSecurity:false：会整体削弱应用安全。
//
// 服务根目录（按优先级取第一个存在的）：
//   1. process.resourcesPath/human-pets（打包后，extraResources 落点）
//   2. <appPath>/resources/human-pets（electron-vite dev）
// 缺失时返回 404，渲染层按「素材缺失」回落到上一只宠物，绝不崩溃。
// ═══════════════════════════════════════════════════════════════════════════════

export const HUMAN_ASSET_SCHEME = 'bd-asset'

/** 必须在 app ready 之前调用（Electron 要求特权 scheme 提前注册） */
export function registerHumanAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: HUMAN_ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
    }
  ])
}

function assetRoot(): string | null {
  const candidates = [
    join(process.resourcesPath, 'human-pets'),
    join(app.getAppPath(), 'resources', 'human-pets')
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

const MIME: Record<string, string> = {
  '.fbx': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json'
}

/** 在 app.whenReady() 里调用 */
export function setupHumanAssetProtocol(): void {
  const root = assetRoot()
  protocol.handle(HUMAN_ASSET_SCHEME, (req) => {
    try {
      if (!root) return new Response('human-pets missing', { status: 404 })
      const u = new URL(req.url)
      // bd-asset://<petId>/<rel> → <root>/<petId>/<rel>
      const rel = decodeURIComponent(`${u.host}${u.pathname}`).replace(/^\/+/, '')
      const full = normalize(join(root, rel))
      // 路径穿越防护：归一化后必须仍在服务根内
      if (full !== root && !full.startsWith(root + '/')) {
        return new Response('forbidden', { status: 403 })
      }
      if (!existsSync(full)) return new Response('not found', { status: 404 })
      const ext = full.slice(full.lastIndexOf('.')).toLowerCase()
      const headers: Record<string, string> = {}
      if (MIME[ext]) headers['Content-Type'] = MIME[ext]
      return net.fetch('file://' + full, { headers })
    } catch {
      return new Response('asset error', { status: 500 })
    }
  })
}

/** 渲染层用： pet id + 相对路径 → bd-asset:// URL */
export function humanAssetUrl(id: string, rel: string): string {
  return `${HUMAN_ASSET_SCHEME}://${id}/${rel.replace(/^\/+/, '')}`
}
