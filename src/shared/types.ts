// 主进程与渲染进程共享的类型定义

export type Unit = 'usd' | 'cny' | 'token' | 'request' | 'percent'

/**
 * 供应商类别：
 *   balance — 直连查余额（按量付费平台）
 *   coding  — Coding plan（订阅制，看用量/限额/重置时间/tokens）
 *   token   — Token plan（按 token 计费的套餐）
 */
export type ProviderKind = 'balance' | 'coding' | 'token'

export interface ProviderWindow {
  /** 周期名：5 小时 / 本周 / 本月 / 账户余额… */
  name: string
  /** 绝对用量（USD/token/request）；percent 单位时 used=百分比值 */
  used: number
  /** 0 或缺省 = 限额未知，只展示用量 */
  limit?: number
  unit: Unit
  resetAt?: string // ISO
  note?: string
  /** 该窗口内的 token 消耗（若可统计） */
  tokens?: number
  /**
   * 官方 API 直报使用比例 (0–100)。有值时 UI 优先用它做环形进度图，
   * 比 used/limit 推算更精确（避免本地估算误差）。可选。
   */
  percent?: number
}

/** 每模型用量明细 */
export interface ProviderModelRow {
  model: string
  /** 花费（USD；控制台口径时为控制台给出的真实用量） */
  cost: number
  tokens: number
  /** 配额（USD，控制台口径才有） */
  quota?: number
  /** 官方百分比（控制台口径才有） */
  percent?: number
  /** 数据来源：console=控制台官方明细，local=本机统计 */
  source?: 'console' | 'local'
}

export type ProviderStatus = 'ok' | 'nodata' | 'error' | 'skipped'

/**
 * 数据质量（诚实原则：宁可标注，不可混淆）：
 *   official — 来自官方/权威源（API、控制台、本机工具记录）
 *   local    — 官方不可达，退回本机估算（口径不同，必须显式标注）
 *   cached   — 本轮刷新失败，展示上次官方数据（已过期，必须显式标注）
 */
export type DataQuality = 'official' | 'local' | 'cached'

export interface ProviderSnapshot {
  id: string
  name: string
  kind: ProviderKind
  builtin: boolean
  /** 供应商图标 id（内置预设 id / 协议 id），渲染层与托盘据此显示 logo */
  mark?: string
  /** 套餐名，如 "Go 套餐" */
  plan?: string
  status: ProviderStatus
  detail?: string
  windows: ProviderWindow[]
  /** 每模型明细（默认视角：控制台口径为月度，本机口径为 30 天） */
  models?: ProviderModelRow[]
  /**
   * 分窗口的每模型明细（控制台官方口径），key = 窗口名（'5 小时'/'本周'/'本月'）。
   * 有值时详情页在每个窗口下展示可展开的模型表。
   */
  modelsByWindow?: Record<string, ProviderModelRow[]>
  /** 数据来源标注，如 "官方 API" / "本机统计" */
  source?: string
  /** 数据质量，缺省 official */
  dataQuality?: DataQuality
  /** 数据实际对应的时间（ISO）。cached 时 = 上次成功采集时间 */
  dataAt?: string
  /** 降级原因（离线 / 超时 / 鉴权失败…），UI 以此提示用户 */
  degradedReason?: string
  /** 本轮失败的具体原因（缓存展示时用来说明"为什么没更新"） */
  failureReason?: string
  updatedAt: string // ISO
}

/** 供应商注册表条目（设置页与卡片渲染用） */
export interface ProviderInfo {
  id: string
  name: string
  kind: ProviderKind
  builtin: boolean
  enabled: boolean
  /** 凭据来源：settings=设置中已存 / env=环境变量 / file=工具配置文件 / none=未配置 */
  credentialSource: 'saved' | 'env' | 'file' | 'none'
  /** 协议 id（决定采集逻辑） */
  protocol: string
  /** 当前生效的 base URL */
  baseUrl: string
  /** 内置预设 id（内置实例）；空串 = 自定义 */
  presetId: string
  createdAt: number
  /** 是否为多行凭据（如 AK:SK 对） */
  keyHint?: string
  /** 协议支持控制台 cookie（用于更精确的百分比） */
  supportsCookie?: boolean
  /** 控制台 cookie 是否已配置（仅回显尾 4 位） */
  cookieHint?: string
}

/**
 * 用户添加的供应商实例（可重复添加同一预设，各自独立凭据）。
 * 持久化于 extras.providerInstances。
 */
export interface ProviderInstance {
  id: string
  name: string
  /** 内置预设 id；空串 = 自定义实例 */
  presetId: string
  /** 协议 id（决定采集逻辑） */
  protocol: string
  kind: ProviderKind
  baseUrl: string
  builtin: boolean
  enabled: boolean
  createdAt: number
}

/** 可添加项（「添加提供方」选择列表 = 内置预设 + 自定义协议） */
export interface CatalogEntry {
  /** 唯一键 */
  key: string
  label: string
  kind: ProviderKind
  protocol: string
  defaultBaseUrl: string
  /** 内置预设 id；null = 自定义协议（需填名称/地址/key） */
  presetId: string | null
  hint?: string
  keyHint?: string
  /** 仅可添加一次（本机文件型数据源，重复无意义） */
  singleton?: boolean
}

export interface AppState {
  snapshots: ProviderSnapshot[]
  lastSync: string | null
  scanning: boolean
  /** 网络不可用（系统级断网，或本轮所有网络源均失败）—— UI 据此提示"数据可能过期" */
  offline?: boolean
}

/** 环境变量扫描命中项 */
export interface ScanHit {
  providerId: string
  source: string
}

export interface SkinInfo {
  id: string
  name: string
  builtin: boolean
}

export interface ProvidersPayload {
  providers: ProviderInfo[]
  scanHits: ScanHit[]
}

export interface ProviderPatch {
  id: string
  name?: string
  enabled?: boolean
  baseUrl?: string
  /** 新凭据（空字符串忽略） */
  key?: string
  /** 显式清除凭据 */
  clearKey?: boolean
  /** OpenCode 控制台 cookie（可选，用于获取与控制台一致的小数精度） */
  cookie?: string
  /** OpenCode Workspace ID */
  workspaceId?: string
}

export interface AddProviderPayload {
  /** 内置预设（与 protocol 二选一） */
  presetId?: string
  /** 自定义协议（与 presetId 二选一） */
  protocol?: string
  name?: string
  baseUrl?: string
  key?: string
}

/** OpenCode 网页授权结果 */
export interface OpencodeAuthResponse {
  ok: boolean
  /** 失败原因（用户可见，不含 cookie 内容） */
  error?: string
  /** 成功时回传最新供应商列表（凭据已保存） */
  providers?: ProvidersPayload
  /** 成功时回传抓取到的 workspace id（用于提示） */
  workspaceId?: string
}

/** 宠物数据迁移（导出/导入本地 JSON 文件）结果 */
export interface PetTransferResponse {
  ok: boolean
  /** 用户取消选择文件 */
  canceled?: boolean
  /** 导出成功后的落盘路径 */
  path?: string
  /** 导入读到的文件内容（渲染层用 shared/pet 校验） */
  text?: string
  error?: string
}

export interface BalanceDeckApi {
  getState(): Promise<AppState>
  onState(cb: (s: AppState) => void): () => void
  collapse(): void
  expand(): void
  dragStart(): void
  dragEnd(): void
  refreshNow(): Promise<void>
  openSettings(): void
  closeSettings(): void
  onSettingsChanged(cb: () => void): () => void
  /** 供应商实例管理 */
  listProviders(): Promise<ProvidersPayload>
  /** 可添加项（内置预设 + 自定义协议） */
  listCatalog(): Promise<CatalogEntry[]>
  updateProvider(patch: ProviderPatch): Promise<ProvidersPayload>
  addProvider(p: AddProviderPayload): Promise<ProvidersPayload>
  removeProvider(id: string): Promise<ProvidersPayload>
  /** 拖拽排序：按给定 id 顺序重排实例（同时决定卡片与托盘的展示顺序） */
  reorderProviders(ids: string[]): Promise<ProvidersPayload>
  /** 托盘图标：渲染层 canvas 栅格化的供应商 logo（template PNG，1x/2x）；key 为图标 id（去重用） */
  setTrayIcon(key: string, png1x: string, png2x: string): void
  /** OpenCode 网页授权：内嵌浏览器登录后自动抓取 cookie + workspace id */
  startOpencodeAuth(): Promise<OpencodeAuthResponse>
  cancelOpencodeAuth(): void
  /** 在系统默认浏览器打开控制台用量页（手动复制 cookie 用） */
  openOpencodeConsole(): Promise<void>
  /** 通用偏好（皮肤 / 刷新频率等） */
  getExtras(keys: string[]): Promise<Record<string, string>>
  setExtras(patch: Record<string, string>): Promise<void>
  listSkins(): Promise<SkinInfo[]>
  getSkinCss(id: string): Promise<string | null>
  currentSkin(): Promise<string>
  openSkinMenu(): void
  setSkin(id: string): void
  onSkin(cb: (id: string) => void): () => void
  getAutostart(): Promise<boolean>
  setAutostart(open: boolean): Promise<boolean>
  /** 系统登录项里是否残留本应用（不受本开关控制，需手动清理） */
  hasForeignLoginItem(): Promise<boolean>
  /** 宠物数据迁移：导出为本地 JSON 文件 */
  exportPet(payload: string): Promise<PetTransferResponse>
  /** 宠物数据迁移：从本地 JSON 文件导入（返回文本，由渲染层校验） */
  importPet(): Promise<PetTransferResponse>
  /** 测试观测点：托盘交互模式（仅 --uitest） */
  debugTrayMode(): Promise<string>
}
