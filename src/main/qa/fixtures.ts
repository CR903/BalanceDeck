// 设计走查 / UI 自动化测试 —— 从 src/main/index.ts 搬出来的 QA 工具。
//
// 这里的代码**不参与产品运行**：只有带 --shots / --uitest / --ballshot 等参数启动时才走到。
// 搬出来的原因见架构评审候选 C6：入口模块的接口是「启动应用」，而它此前 95% 是实现细节 ——
// 运行模式、截图走查、750 行 UI 断言全挤在一起，改启动流程时要在测试代码里翻。
// 纪律：新增断言请放在 uitest.ts，不要在 index.ts 里长回来。

// 演示数据：让截图/走查里的用量环与数值有真实形态（拍出来才看得出设计）。
// 纯函数、不依赖 electron —— 因此可被单元测试直接调用。
export function demoSnapshot(): unknown[] {
  const iso = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString()
  const nowIso = new Date().toISOString()
  const base = { builtin: true, dataQuality: 'official', dataAt: nowIso, updatedAt: nowIso }
  return [
    {
      ...base,
      id: 'demo-opencode',
      name: 'OpenCode Go',
      kind: 'coding',
      mark: 'opencode',
      plan: 'Go 套餐',
      status: 'ok',
      source: '控制台（精确） + 官方 API',
      windows: [
        { name: '5 小时', used: 0.62, limit: 12, unit: 'usd', percent: 5.2, resetAt: iso(3.4) },
        { name: '本周', used: 9.9, limit: 30, unit: 'usd', percent: 33, resetAt: iso(52) },
        { name: '本月', used: 24.6, limit: 60, unit: 'usd', percent: 41, resetAt: iso(210) }
      ]
    },
    {
      ...base,
      id: 'demo-claude',
      name: 'Claude Code',
      kind: 'coding',
      mark: 'claude',
      plan: 'Max',
      status: 'ok',
      source: '本机统计',
      windows: [{ name: '5 小时', used: 3.42, limit: 25, unit: 'usd', percent: 13.7, resetAt: iso(2.1) }]
    },
    {
      ...base,
      id: 'demo-deepseek',
      name: 'DeepSeek',
      kind: 'balance',
      mark: 'deepseek',
      status: 'ok',
      source: '官方 API',
      windows: [{ name: '账户余额', used: 1288.5, unit: 'cny' }]
    }
  ]
}

/**
 * 温度计定量夹具（10-04-edge-sip-column）：单供应商单窗口 70%。
 * 单家无轮播（count<=1 不推进，idx 恒定），贴边隐藏后柱高确定可解码
 * （满管 70% ≈ 39px/78px@2x —— AC 逐值对拍的实机点位）。
 */
export function column70Snapshot(): unknown[] {
  const nowIso = new Date().toISOString()
  return [
    {
      builtin: true,
      dataQuality: 'official',
      dataAt: nowIso,
      updatedAt: nowIso,
      id: 'shot-column',
      name: 'Shot 柱',
      kind: 'coding',
      mark: 'opencode',
      plan: '柱套餐',
      status: 'ok',
      source: '走查固件',
      windows: [
        {
          name: '5 小时',
          used: 8.4,
          limit: 12,
          unit: 'usd',
          percent: 70,
          resetAt: new Date(Date.now() + 3.4 * 3_600_000).toISOString()
        }
      ]
    }
  ]
}

// —— UI 交互自动化测试 ——
