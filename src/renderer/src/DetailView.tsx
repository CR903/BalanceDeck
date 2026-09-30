import { primaryWindow, snapshotLevel, windowLevel } from './read-model'
import { useEffect, useMemo, useState } from 'react'
import type { ProviderSnapshot, ProviderWindow, ProviderModelRow } from '../../shared/types'
import type { UsagePoint } from '../../shared/usage-predict'
import {
  buildPredictionText,
  predictAll,
  type Prediction,
  type PredictConfig
} from './usagePredict'
import { isPlan } from '../../shared/quality'
import { Ring, Icon, IconButton, Bar, StatusDot } from './components'
import { ProviderMark } from './ProviderMark'
import {
  fmtAmount,
  fmtPercent,
  windowPercent,
  levelOfPercent,
  humanDur,
  timeAgo,
  dataTime,
  staleLabel,
  type Level
} from './format'

// 详情页：单个供应商的完整用量统计（窗口 / 重置 / 剩余 / tokens / 模型明细 / 数据来源）

/** 「这家还没有历史」用的空对象。模块级常量：每次渲染新建会让下面的 useMemo 依赖永远变。 */
const EMPTY_POINTS: Record<string, UsagePoint[]> = {}

/**
 * 取这家供应商的用量预测（分窗口）。
 *
 * 分工：**本 hook 只取数据**，算的全在 `usagePredict.ts` 的纯函数里（design.md D1）——
 * 所以「什么时候该显示一条预测」是可单测的判据，而不是埋在组件生命周期里的 if。
 *
 * 三个刻意的空态（都是「不显示」而不是「显示一个错的数」）：
 *   · 非套餐类 → 不请求（调用方已经挡掉，这里再挡一层防误用）
 *   · now <= 0 → 不请求（同上；防 `Date.now()` 之外的时钟被误传）
 *   · 请求失败 / 组件已卸载 → 保持空数组
 *
 * ⚠ `now` 变化**不重新请求**历史：快照文件每 15 分钟才动一次，而依赖数组里挂 `now`
 *   会让 30s 的倒计时钟每转一圈就重发一次 IPC。历史按窗口名缓存，只有换供应商
 *   （或用户改了回看天数）才重新取 —— 这是「数据源变了才重取」而不是「时间变了就重取」。
 *
 * ⚠⚠ 已取回的历史**必须连着它属于哪家一起存**。只存 `{ 窗口名: 点[] }` 的话，
 *   换供应商后新请求在飞的那一瞬间（以及请求**失败**时的那一整段时间），
 *   详情页会拿**上一家的斜率**配**这一家的窗口**算出一行预测 —— 数字看着完全合理，
 *   没有任何报错，只是把 A 家的预计耗尽时间挂在 B 家名下。窗口名（'本周'/'本月'）
 *   在各家之间是重名的，所以这个错配不会被任何判据挡下。
 */
function usePredictions(
  s: ProviderSnapshot | undefined,
  now: number,
  on: boolean,
  cfg: PredictConfig
): Prediction[] {
  /** 取回时打上 providerId；id 对不上就当没有（而不是沿用上一家的） */
  const [loaded, setLoaded] = useState<{ id: string; points: Record<string, UsagePoint[]> }>({
    id: '',
    points: {}
  })
  const providerId = s?.id
  const days = cfg.windowDays

  useEffect(() => {
    if (!providerId || !on || now <= 0 || !s) return
    let live = true
    void window.api
      .usagePredict(providerId, days, Date.now())
      .then((r) => {
        if (live && r && typeof r === 'object') setLoaded({ id: providerId, points: r })
      })
      .catch(() => {
        /* 没有历史 / 读失败 → 归空态，详情页什么都不显示（不是「预测失败」）。
           ⚠ 这里必须**清空**而不是「保持原状」：保持原状 = 换供应商后继续显示上一家
           的预测（见上面那条错配说明）。 */
        if (live) setLoaded({ id: providerId, points: {} })
      })
    return () => {
      live = false
    }
    // ⚠ 刻意不挂 `now`（见上面注释：30s 钟会让它每圈重发一次 IPC）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, on, days])

  // 纯函数重算：快照文件变了但组件没重挂时（用户开着详情页过了 15 分钟），
  // 依赖 points 变化即可重新算。文案里的「距现在多久」用 now 重算 —— 那是倒计时，
  // 由 30s 钟驱动，不重新请求任何数据。
  const points = loaded.id === providerId ? loaded.points : EMPTY_POINTS
  return useMemo(
    () => (s && now > 0 ? predictAll(s, points, now, cfg) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s, points, now, cfg.windowDays, cfg.retentionDays]
  )
}

/** 数据可信度提示条：缓存 / 本机估算时必须显式告知，并可一键重试 */
function QualityBanner({ s, onRefresh }: { s: ProviderSnapshot; onRefresh: () => void }): React.JSX.Element | null {
  const label = staleLabel(s)
  if (!label) return null
  const cached = s.dataQuality === 'cached'
  return (
    <div className={`qbanner ${s.dataQuality}`}>
      <span className="qbanner-icon">
        <Icon name={cached ? 'history' : 'flask'} size={15} />
      </span>
      <span className="qbanner-text">
        <b>{cached ? `${label}数据 · ${timeAgo(dataTime(s), Date.now())}` : label + '估算'}</b>
        <span>{s.degradedReason ?? (cached ? '本次刷新失败，展示的是最后一次成功获取的数据' : '官方数据不可用')}</span>
      </span>
      <button type="button" className="qbanner-retry" onClick={onRefresh}>
        重试
      </button>
    </div>
  )
}

/** 单个窗口的模型明细（可展开） */
/**
 * token 数字的来源标签 —— **跟着数据的实际来源走，不写死"本机"**。
 *
 * 2026-09-26 控制台改版后踩过：控制台接口自己就给 tokens（`totalInputTokens` 等），
 * 之前只能取本机 db。标签没跟着改，于是界面上出现「控制台每月」标题配「本机 880.1M」
 * 这种自相矛盾的表述（`CONTEXT.md`：数据来路必须如实标出）。
 * 混合来源（有 console 行也有 local 行）时明确说"混合"，不猜。
 */
function tokenProvenanceLabel(rows: ProviderModelRow[]): string {
  const consoleRows = rows.filter((m) => m.source === 'console').length
  if (consoleRows === 0) return '本机'
  if (consoleRows === rows.length) return '服务端'
  return '服务端 + 本机'
}

function WindowModels({ rows }: { rows: ProviderModelRow[] }): React.JSX.Element {
  return (
    <div className="wmodels">
      <div className="wmodels-head">
        <span>模型</span>
        <span className="wmodels-quota">用量 / 配额</span>
        <span className="wmodels-pct">%</span>
      </div>
      {rows.map((m) => (
        <div className="wmodels-row" key={`${m.model}-${m.cost}`}>
          <span className="wmodels-name" title={m.model}>
            {m.model}
          </span>
          <span className="wmodels-amount">
            {fmtAmount(m.cost, 'usd')}
            {m.quota != null && m.quota > 0 && <span className="wmodels-q"> / {fmtAmount(m.quota, 'usd')}</span>}
          </span>
          <span className="wmodels-pctv">{m.percent != null ? fmtPercent(m.percent) : '—'}</span>
        </div>
      ))}
      {rows.some((m) => m.tokens > 0) && (
        <div className="wmodels-note">
          {tokenProvenanceLabel(rows)} tokens：
          {rows
            .filter((m) => m.tokens > 0)
            .slice(0, 3)
            .map((m) => `${m.model} ${fmtAmount(m.tokens, 'token')}`)
            .join(' · ')}
        </div>
      )}
    </div>
  )
}

function WindowRow({ w, lvl, now, models }: { w: ProviderWindow; lvl: Level; now: number; models?: ProviderModelRow[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const pct = windowPercent(w)
  const hasLimit = w.limit != null && w.limit > 0
  const remaining = hasLimit ? w.limit! - w.used : null

  return (
    <div className="dwin">
      <div className="dwin-head">
        <span className="dwin-name">{w.name}</span>
        <span className="dwin-value">
          {pct != null && <b>{fmtPercent(pct)}</b>}
          {hasLimit ? (
            <span className="dwin-amount">
              {pct != null ? ' · ' : ''}
              {fmtAmount(w.used, w.unit)} / {fmtAmount(w.limit!, w.unit)}
            </span>
          ) : (
            <span className="dwin-amount">
              {pct != null ? ' · ' : ''}
              {fmtAmount(w.used, w.unit)}
            </span>
          )}
        </span>
      </div>
      {pct != null && <Bar pct={pct} lvl={lvl} />}
      <div className="dwin-foot">
        <span className="dwin-facts">
          {w.resetAt && <span>{humanDur(new Date(w.resetAt).getTime() - now)}后重置</span>}
          {remaining != null && remaining > 0 && (
            <span>
              {w.resetAt ? ' · ' : ''}剩余 {fmtAmount(remaining, w.unit)}
            </span>
          )}
          {w.tokens != null && w.tokens > 0 && <span> · 本机 {fmtAmount(w.tokens, 'token')} tok</span>}
        </span>
        {w.note && <span className="dwin-note">{w.note}</span>}
      </div>
      {models && models.length > 0 && (
        <div className="dwin-details">
          <button type="button" className={'dwin-toggle' + (open ? ' open' : '')} onClick={() => setOpen((v) => !v)}>
            <span>{open ? '隐藏详情' : '显示详情'}</span>
            <span className="chev">
              <Icon name="chevron" size={12} />
            </span>
          </button>
          {open && <WindowModels rows={models} />}
        </div>
      )}
    </div>
  )
}

export function DetailView({
  s,
  onBack,
  onRefresh,
  predictOn,
  predictConfig
}: {
  s: ProviderSnapshot | undefined
  onBack: () => void
  onRefresh: () => void
  /** 用量预测总开关（ui:predictOn，默认开）。关掉时详情页连历史都不取 */
  predictOn: boolean
  /** 预测配置（ui:predictConfig）：回看天数 / 保留天数 */
  predictConfig: PredictConfig
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  // 余额类**不请求**：它没有窗口也没有限额，速率估算的整个前提不成立（design.md D5），
  // 而发一次 IPC 换回一个必然为空的结果只是白费一次往返。
  const planish = !!s && isPlan(s)
  const predictions = usePredictions(s, planish ? now : 0, predictOn, predictConfig)

  if (!s) {
    return (
      <div className="card">
        <header className="titlebar">
          <IconButton name="back" title="返回" onClick={onBack} />
          <span className="title-text">
            <span className="brand">供应商</span>
          </span>
        </header>
        <div className="body-scroll">
          <div className="empty-state">
            <span className="empty-title">该供应商暂无数据</span>
          </div>
        </div>
      </div>
    )
  }

  const lvl = snapshotLevel(s)
  const hero = primaryWindow(s)
  const heroPct = hero ? windowPercent(hero) : null
  // 套餐 / 余额的判据取 shared/quality 的 isPlan 独家（本文件原来有一份
  // `s.kind !== 'balance'` 的局部副本，被上面 hook 里的导入遮住了 —— 同一判断两个家）
  const plan = isPlan(s)
  const hasModels = !!s.models && s.models.length > 0

  return (
    <div className="card detail">
      <header className="titlebar">
        <IconButton name="back" title="返回" onClick={onBack} />
        <ProviderMark mark={s.mark} size={26} />
        <span className="title-text">
          <span className="brand">{s.name}</span>
          <span className="status-line dim">
            <StatusDot lvl={lvl} />
            <span className="kind-tag">{plan ? (s.kind === 'coding' ? 'Coding Plan' : 'Token Plan') : '余额'}</span>
            {s.plan && <span> · {s.plan}</span>}
            <span> · {timeAgo(dataTime(s), now)}</span>
          </span>
        </span>
        <IconButton name="refresh" title="立即刷新" onClick={onRefresh} />
      </header>

      <div className="body-scroll">
        <QualityBanner s={s} onRefresh={onRefresh} />
        {s.status === 'ok' && hero ? (
          <>
            <section className={`hero lvl-${lvl}`}>
              {heroPct != null && <Ring pct={heroPct} lvl={lvl} size={78} stroke={7} />}
              <div className="hero-meta">
                <div className="hero-label">{hero.name}</div>
                <div className="hero-amount">
                  {fmtAmount(hero.used, hero.unit)}
                  {hero.limit != null && hero.limit > 0 && (
                    <span className="hero-limit"> / {fmtAmount(hero.limit, hero.unit)}</span>
                  )}
                </div>
                {hero.resetAt && (
                  <div className="hero-sub">{humanDur(new Date(hero.resetAt).getTime() - now)}后重置</div>
                )}
                {hero.limit != null && hero.limit > 0 && (
                  <div className="hero-sub">
                    剩余 {fmtAmount(Math.max(0, hero.limit - hero.used), hero.unit)}
                  </div>
                )}
              </div>
            </section>

            {/* ── 用量预测（P0-2）─────────────────────────────────────────
                放在 hero 环形仪表之后、窗口列表之前：环形仪表答「现在用了多少」，
                这一行答「按现在的速度还够用多久」，两个问题挨着答最省用户的心智切换。
                逐窗口各一条（5H / W / M 的速率不同，混成一条是错的 —— design.md D5），
                文案由 buildPredictionText 独家生成（含「估算」字样，AC3）。 */}
            {predictions.length > 0 && (
              <section className="section">
                <div className="section-title">
                  预计耗尽
                  <em className="tag env">本机历史估算</em>
                </div>
                <div className="predict-list">
                  {predictions.map((p) => (
                    <div key={p.windowName} className="predict-row" data-window={p.windowName}>
                      <span className="predict-win">{p.windowName}</span>
                      <span className="predict-text">{buildPredictionText(p, predictConfig.windowDays)}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {s.windows.length > 0 && (
              <section className="section">
                <div className="section-title">用量窗口</div>
                <div className="dwin-list">
                  {s.windows.map((w, i) => (
                    <WindowRow
                      key={i}
                      w={w}
                      lvl={windowLevel(w)}
                      now={now}
                      models={s.modelsByWindow?.[w.name]}
                    />
                  ))}
                </div>
              </section>
            )}

            {hasModels && (
              <section className="section">
                <div className="section-title">
                  {s.models![0]?.source === 'console' ? '模型明细 · 控制台每月' : '模型明细 · 本机 30 天'}
                </div>
                <div className="model-list">
                  {s.models!.map((m) => (
                    <div className={`model-row${m.source === 'console' ? ' console' : ''}`} key={`${m.model}-${m.cost}`}>
                      <span className="model-name" title={m.model}>
                        {m.model}
                      </span>
                      <span className="model-amount">
                        {fmtAmount(m.cost, 'usd')}
                        {m.quota != null && m.quota > 0 && (
                          <span className="model-quota"> / {fmtAmount(m.quota, 'usd')}</span>
                        )}
                      </span>
                      {m.percent != null && <span className="model-pct">{fmtPercent(m.percent)}</span>}
                      {m.tokens > 0 && (
                        <span className="model-tokens">
                          {m.source === 'console' ? '服务端' : '本机'} {fmtAmount(m.tokens, 'token')}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="section meta">
              {s.source && <div className="meta-line">数据来源 · {s.source}</div>}
              {s.detail && <div className="meta-line detail-text">{s.detail}</div>}
            </section>
          </>
        ) : (
          <div className="empty-state">
            <span className="empty-icon">
              <Icon name={s.status === 'error' ? 'wifiOff' : 'plus'} size={22} />
            </span>
            <span className="empty-title">
              {s.status === 'nodata' ? '未配置' : s.status === 'error' ? '获取失败' : '暂无数据'}
            </span>
            {s.detail && <span className="empty-sub">{s.detail}</span>}
            <button type="button" className="btn-primary sm empty-cta" onClick={onRefresh}>
              重试
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
