import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ProviderInfo, ProviderSnapshot } from '../../src/shared/types'
import { IslandView } from '../../src/renderer/src/IslandView'

// ── HARNESS（throwaway）：真 IslandView + 真 island.css/skins.css，只 mock window.api ──
const calls: Array<{ name: string; args: unknown }> = []
const w = window as unknown as Record<string, unknown>
w.__calls = calls
// 测试钩子：?x=0..1 预置 ui:islandX（走真实加载钳制路径；10-10-island-clip-fix AC1 用）
const harnessX = new URLSearchParams(location.search).get('x')
w.api = {
  getExtras: (keys: string[]) =>
    Promise.resolve(
      Object.fromEntries(keys.map((k) => [k, k === 'ui:islandX' && harnessX != null ? harnessX : '']))
    ),
  setExtras: (patch: Record<string, string>) => {
    calls.push({ name: 'setExtras', args: patch })
    return Promise.resolve()
  },
  setPetHitbox: (rect: unknown) => calls.push({ name: 'setPetHitbox', args: rect }),
  dragStart: (pt: unknown) => calls.push({ name: 'dragStart', args: pt }),
  dragEnd: () => calls.push({ name: 'dragEnd', args: null }),
  dockReveal: () => calls.push({ name: 'dockReveal', args: null })
}

const NOW = new Date().toISOString()
function snap(
  id: string,
  name: string,
  kind: 'plan' | 'balance',
  mark: string,
  status: 'ok' | 'nodata' | 'error',
  windows: ProviderSnapshot['windows']
): ProviderSnapshot {
  return { id, name, kind: kind as ProviderSnapshot['kind'], builtin: true, mark, status, windows, updatedAt: NOW }
}
function info(id: string, name: string, kind: 'plan' | 'balance'): ProviderInfo {
  return {
    id, name, kind: kind as ProviderInfo['kind'], builtin: true, enabled: true,
    credentialSource: 'saved', protocol: 'p', baseUrl: 'https://x', presetId: id,
    createdAt: 0
  }
}
const W = (name: string, pct: number, reset: string) => ({
  name, used: pct, limit: 100, unit: 'percent' as const, percent: pct, resetAt: reset
})

const SNAPS: ProviderSnapshot[] = [
  snap('claude', 'Claude 公司', 'plan', 'claude', 'ok', [W('5小时', 73, ''), W('本周', 41, '')]),
  snap('gpt', 'GPT 个人', 'plan', 'codex', 'ok', [W('本月', 42, '')]),
  snap('gemini', 'Gemini', 'plan', 'gemini', 'ok', [W('5小时', 91, ''), W('每日', 65, ''), W('Token', 30, '')]),
  {
    ...snap('openai', 'OpenAI 余额', 'balance', 'openai-billing', 'ok', []),
    windows: [{ name: '账户余额', used: 128.5, limit: 200, unit: 'cny' as const }]
  },
  snap('qwen', 'Qwen', 'plan', 'qwen', 'nodata', [])
]
const INFOS: ProviderInfo[] = [
  info('claude', 'Claude 公司', 'plan'), info('gpt', 'GPT 个人', 'plan'),
  info('gemini', 'Gemini', 'plan'), info('openai', 'OpenAI 余额', 'balance'),
  info('qwen', 'Qwen', 'plan')
]
const SKINS = ['dark', 'aero', 'minimal', 'candy', 'ink']

function Harness(): React.JSX.Element {
  const [dockHidden, setDockHidden] = useState(false)
  const [hideBalance, setHideBalance] = useState(false)
  const [skin, setSkin] = useState('dark')
  const [onlyOne, setOnlyOne] = useState(false)
  const list = onlyOne ? SNAPS.slice(0, 1) : SNAPS
  const infos = onlyOne ? INFOS.slice(0, 1) : INFOS
  return (
    <div className="app" data-skin={skin} style={{ background: '#101014', padding: 0 }}>
      <div className="harness-bar">
        <button onClick={() => setDockHidden((v) => !v)}>hidden:{dockHidden ? 'on' : 'off'}</button>
        <button onClick={() => setHideBalance((v) => !v)}>mask:{hideBalance ? 'on' : 'off'}</button>
        <button onClick={() => setSkin(SKINS[(SKINS.indexOf(skin) + 1) % SKINS.length])}>skin:{skin}</button>
        <button onClick={() => setOnlyOne((v) => !v)}>count:{onlyOne ? '1' : '5'}</button>
        <button onClick={() => { calls.length = 0 }}>clear-calls</button>
      </div>
      <div className="harness-window">
        <IslandView
          snapshots={list}
          instanceInfo={infos}
          hideBalance={hideBalance}
          dockHidden={dockHidden}
          fluidPhase="edge-visible"
          fluidEdge={null}
          onExpand={() => calls.push({ name: 'onExpand', args: null })}
          onMenu={() => Promise.resolve(null)}
        />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Harness />)
