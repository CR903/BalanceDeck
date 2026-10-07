import { primaryWindow, snapshotLevel, windowLevel } from './read-model'
import { useEffect, useMemo, useState } from 'react'
import type { ProviderSnapshot, ProviderWindow, ProviderModelRow } from '../../shared/types'
import type { UsagePoint } from '../../shared/usage-predict'
import { isPlan } from '../../shared/quality'
import { TREND_MAX_DAYS } from './usageHistory'
import { TrendPanel } from './TrendChart'
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
 * 取这家供应商的**原始**用量历史（`Record<窗口名, UsagePoint[]>`，未做任何加工）。
 *
 * 算的全在 `usageHistory.ts` 的纯函数里（按天聚合 / 日均 / 热力档位），本 hook 只取数据
 * —— 这样「哪天该显示什么」是可单测的判据，而不是埋在组件生命周期里的 if。
 *
 * 三个刻意的空态（都是「不显示」而不是「显示一个错的数」）：
 *   · 非套餐类 → 不请求（调用方已经挡掉，这里再挡一层防误用）
 *   · 请求失败 / 组件已卸载 → 归空态
 *
 * ⚠ **一次取 `TREND_MAX_DAYS`(30) 天**：7 / 30 天两个视图共用同一份数组，切换纯前端。
 *   快照文件每 15 分钟才动一次，而切换会频繁发生。
 *
 * ⚠ 非套餐类（余额）**不请求**：`windowPercent` 对余额窗口实测**恒 null**（'账户余额'）
 *   或**恒 0**（'账户额度'）—— 前者画不出来，后者画出来是贴底平线，比 null 更危险
 *   （看起来像有数据）。
 *
 * ⚠ 依赖数组里**不含 `now`**：30s 倒计时钟每圈重发一次 IPC 是纯浪费（快照每 15 分钟才动一次）。
 *   `s` 只在 effect body 里读、不进依赖，换供应商由 `providerId` 触发重取。
 *
 * ⚠⚠ 已取回的历史**必须连着它属于哪家一起存**。只存 `{ 窗口名: 点[] }` 的话，
 *   换供应商后新请求在飞的那一瞬间（以及请求**失败**时的那一整段时间），
 *   详情页会拿**上一家的采样**配**这一家的窗口**画出一张热力图 —— 数字看着完全合理，
 *   没有任何报错，只是把 A 家的历史挂在 B 家名下。窗口名（'本周'/'本月'）在各家之间
 *   是重名的，所以这个错配不会被任何判据挡下。
 */
function useUsageHistory(
  s: ProviderSnapshot | undefined,
  on: boolean
): Record<string, UsagePoint[]> {
  /** 取回时打上 providerId；id 对不上就当没有（而不是沿用上一家的） */
  const [loaded, setLoaded] = useState<{ id: string; points: Record<string, UsagePoint[]> }>({
    id: '',
    points: {}
  })
  const providerId = s?.id

  useEffect(() => {
    if (!providerId || !on || !s || !isPlan(s)) return
    let live = true
    void window.api
      .usagePredict(providerId, TREND_MAX_DAYS, Date.now())
      .then((r) => {
        if (live && r && typeof r === 'object') setLoaded({ id: providerId, points: r })
      })
      .catch(() => {
        /* 读失败 → 归空态：不显示用量趋势，而不是「加载失败」（同一条纪律）。
           ⚠ 必须**清空**而不是「保持原状」：保持原状 = 换供应商后继续显示上一家的历史，
           见上面那条错配说明。 */
        if (live) setLoaded({ id: providerId, points: {} })
      })
    return () => {
      live = false
    }
    // ⚠ 刻意不挂 `now` / `on`（见上面注释）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, on])

  return loaded.id === providerId ? loaded.points : EMPTY_POINTS
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
  onRefresh
}: {
  s: ProviderSnapshot | undefined
  onBack: () => void
  onRefresh: () => void
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  // 余额类**不请求**：它没有窗口也没有限额，按天聚合的整个前提不成立，
  // 而发一次 IPC 换回一个必然为空的结果只是白费一次往返。
  const planish = !!s && isPlan(s)
  const history = useUsageHistory(s, planish)

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

            {/* ── 用量热力图（P1-1）─────────────────────────────────────────
                位置：「每模型用量表」**上方**。它答的是「这 30 天每天都在用」，
                与上方 hero / 用量窗口同一批问题，所以挨着放。

                2026-10-07 由「每天一根柱」换成 GitHub 式日历网格 + streak 头：柱状图只给
                形状不给数值，用户读不出趋势；日历网格的颜色深浅是当天**日增量**（末值强度
                在高位用量下整张图全深，看不出哪天用得多），悬停再给末值%，双数齐下。

                ⚠ 刻意**并列**而不是塞进 `{hasModels && …}` 里：热力图不需要 `s.models`
                存在，而塞进模型明细会让「这家没有模型数据」连带让热力图消失。
                没有历史时 TrendPanel 返回 null —— 界面什么都不显示（不是「加载失败」）。 */}
            {plan && (
              <TrendPanel pointsByWindow={history} primaryWindowName={hero?.name} now={now} />
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
