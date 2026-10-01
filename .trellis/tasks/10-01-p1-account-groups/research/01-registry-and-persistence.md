# Research: 供应商实例注册表与持久化（问题 1 / 2 / 8）

- **Query**: ProviderInstance / ProviderInfo 完整字段；同名供应商重复添加怎么存；排序字段是什么；注册表存在哪；加「分组」字段要动哪里；迁移怎么办；规模与 setExtra 全量重写
- **Scope**: internal
- **Date**: 2026-10-01

---

## 1. `ProviderInstance` 完整字段

`src/shared/types.ts:116-128`

```ts
export interface ProviderInstance {
  id: string          // 实例 id
  name: string        // 显示名（用户可改）
  presetId: string    // 内置预设 id；空串 = 自定义实例
  protocol: string    // 协议 id（决定采集逻辑）
  kind: ProviderKind
  baseUrl: string
  builtin: boolean
  enabled: boolean
  createdAt: number
}
```

共 9 个字段，全部必填。**没有 `sort` / `rank` / `order` 字段** —— 见第 3 节。

## 2. `ProviderInfo` 完整字段

`src/shared/types.ts:89-110`（设置页与卡片渲染用）

```ts
export interface ProviderInfo {
  id: string
  name: string
  kind: ProviderKind
  builtin: boolean
  enabled: boolean
  credentialSource: 'saved' | 'env' | 'file' | 'none'
  protocol: string
  baseUrl: string
  presetId: string
  createdAt: number
  keyHint?: string
  supportsCookie?: boolean
  cookieHint?: string
}
```

与 `ProviderInstance` 的差集：`+credentialSource/+keyHint/+supportsCookie/+cookieHint`。
**`ProviderInfo` 有 `baseUrl` 与 `presetId`，而 `ProviderSnapshot`（卡片视图的数据源）两者都没有** —— 这是同名账号区分的关键约束，见 `03-same-name-and-tests.md`。

组装处：`src/main/providers.ts:355-403`（`instanceInfo()`）。

## 3. 同名供应商重复添加怎么存 · 排序字段

### id 生成

`src/main/providers.ts:279`

```ts
id: `inst:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
```

形如 `inst:mfk3a2-x9q1b`。`ipc.ts:65` 的注释也确认了这个形状：

```
// 校验后 id 内无冒号，拼出的键恒为 `tts:secret:` + 安全字符，与其它命名空间不可能相撞。
// ...（而不是与别的条目（实例 id 形如 `inst:xxx-yyy`）撞车的键名）。
```

**但存在第二种 id 形状**：旧模型迁移产出的实例 id 是裸预设 id，不是 `inst:` 前缀 ——
`src/main/providers.ts:251-252`

```ts
out.push({
  id: p.id,          // ← 'deepseek' / 'claude' / ...，不是 inst:xxx
  name: p.name,
```

所以磁盘上可能同时有两类 id。任何按前缀解析 id 的逻辑都要容忍这两种。

### 同名：完全允许，无任何唯一性约束

`src/main/providers.ts:278-288`（`addInstance`）

```ts
const instance: ProviderInstance = {
  id: `inst:${Date.now().toString(36)}-...`,
  name: (payload.name ?? '').trim() || preset?.name || custom?.label || '自定义供应商',
  presetId: preset?.id ?? '',
  ...
}
```

`name` 缺省直接取 `preset.name`。**同一预设添加两次且都不填自定义名 → 两条实例 `name` 完全相同**，
`presetId` / `protocol` / `kind` / `baseUrl` / `mark` 也全部相同，只有 `id` 与 `createdAt` 不同。

唯一阻止重复的是 `singleton` 预设，且它只在**目录里**挡（`src/main/providers.ts:171-172`）：

```ts
for (const p of BUILTIN_PRESETS) {
  if (p.singleton && usedPresets.has(p.id)) continue
```

`BUILTIN_PRESETS` 中标了 `singleton: true` 的只有 3 个：`claude` / `codex` / `copilot`
（`providers.ts:74, 83, 92`，且都是 `localCredential: true` 的本机文件型数据源）。
其余 8 个预设（opencode / deepseek / kimi / zhipu / siliconflow / minimax / qwen / volc）可无限重复添加。

`instances-debug.mjs:26-42` 有一个 `--dedupe` 模式，去重键是 `${i.presetId}|${i.name}` —— 说明
「同名同预设」是已知的、会实际发生的脏数据形态。

### 排序字段：**没有。顺序 = 数组下标**

排序的唯一载体是 `extras.providerInstances` 这个 JSON 数组的**物理顺序**。
`src/main/providers.ts:337-351`：

```ts
export async function reorderInstances(ids: string[]): Promise<boolean> {
  const list = await listInstances()
  const rank = new Map(ids.map((id, i) => [id, i]))
  const next = [...list].sort((a, b) => { ... })
  if (next.every((x, i) => x.id === list[i]?.id)) return false   // 无变化则不写盘
  await saveInstances(next)
  return true
}
```

未出现在 `ids` 里的实例被排到末尾（`providers.ts:343-345`，注释说明是「防御：渲染层可能拿到过期列表」）。

## 4. 持久化落点

### 文件与结构

`src/main/store.ts:24-28`

```ts
interface SecretFile {
  version: 1
  items: Record<string, string>    // <providerId>: base64 密文 | 'plain:<base64>'
  extras?: Record<string, string>  // <key>: 明文
}
```

路径 `src/main/keystore.ts:14`：`join(app.getPath('userData'), 'secrets.bin')`（惰性求值）。

### 注册表相关的完整键空间

`src/main/providers.ts:17-21`（文件头注释即契约）

```
//   extras.providerInstances        → JSON 数组（ProviderInstance[]）
//   extras.provider:<id>:baseUrl    → 覆盖默认 API 地址
//   extras.provider:<id>:name       → 覆盖显示名（历史兼容，实例内已有 name）
//   keys[<id>]                      → 凭据（safeStorage 加密）
```

读写实现：

| 操作 | 位置 |
|---|---|
| 读注册表 | `providers.ts:212` `await db().getExtra('providerInstances')` |
| 写注册表 | `providers.ts:228` `await db().setExtra('providerInstances', JSON.stringify(list))` |
| 读凭据 | `providers.ts:361` / `store.ts:81-90`（`items[providerId]`，密文） |
| 删实例时清理 | `providers.ts:300-302`（清 `provider:<id>:baseUrl` / `provider:<id>:name` / `items[<id>]`） |

**两个存储命名空间互不相通**（`ipc.ts:53-66` 的长注释）：`setKey/getKey` → `items`（加密）；
`setExtra/getExtra` → `extras`（明文）。混用是静默失败。

### 加一个「分组」字段要动哪里（现状清单）

| # | 位置 | 现状 |
|---|---|---|
| 1 | `src/shared/types.ts:116-128` | `ProviderInstance` 加字段。`ProviderInfo`（`:89-110`）是否也加，取决于卡片视图走哪条路 |
| 2 | `src/main/providers.ts:251-261`（`migrateLegacy`） | 迁移产出的实例要带该字段的缺省值 |
| 3 | `src/main/providers.ts:278-288`（`addInstance`） | 新实例的初始值 |
| 4 | `src/main/providers.ts:221`（`listInstances` 的 `.map`） | **读侧归一化的既有落点** —— 见下 |
| 5 | `src/main/providers.ts:383-402`（`instanceInfo` 的返回体） | 若分组要过 `providers:list` 通道 |
| 6 | `src/main/adapters/bind-instance.ts:21-28` + `engine.ts:37`（`identityOf`） | 若分组要进 `ProviderSnapshot`（即卡片视图的数据源） |

### 迁移：既有先例就在 `listInstances` 的 `.map` 里

`src/main/providers.ts:211-225`

```ts
export async function listInstances(): Promise<ProviderInstance[]> {
  const raw = await db().getExtra('providerInstances')
  if (raw === null) {
    const migrated = await migrateLegacy()
    await saveInstances(migrated)
    return migrated
  }
  try {
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr.filter(isInstance).map((i) => ({ ...i, enabled: i.enabled !== false }))
  } catch {
    return []
  }
}
```

**`.map((i) => ({ ...i, enabled: i.enabled !== false }))` 就是「新字段缺省值」的既有范式** ——
旧记录没有 `enabled` 时被补成 `true`，而且**不回写磁盘**（只在下一次 `saveInstances` 时才落盘）。
新字段照抄这一行即可，无需单独的迁移流程。

配套的类型守卫 `src/main/providers.ts:200-208`：

```ts
function isInstance(x: unknown): x is ProviderInstance {
  return !!x && typeof x === 'object' &&
    typeof (x as ProviderInstance).id === 'string' &&
    typeof (x as ProviderInstance).name === 'string' &&
    typeof (x as ProviderInstance).protocol === 'string'
}
```

⚠ 只校验 3 个字段。新增的可选字段会**原样穿透**到 `.map`，脏值不会被挡。若新字段是字符串/数组，
需要在 `.map` 或守卫里补一次逐字段校验 —— spec 里的既有要求见
`.trellis/spec/frontend/state-management.md:197-199`「On read, re-validate」。

## 5. 规模与性能（问题 8）

### 读：每次采集走两遍，但磁盘读被 memoize

`src/main/scheduler.ts:60-90`（`collect`）每轮调 2 次：

```ts
const adapters = buildAdapters(await listInstances())   // :69
...
const registry = await listProviders()                  // :80
const activeIds = registry.filter((p) => p.enabled).map((p) => p.id)
```

`listProviders()`（`providers.ts:405-409`）内部又调一次 `listInstances()`。
`listInstances` 第一件事是 `db().getExtra('providerInstances')`。

`store.ts:42-58` 的 `load()` 把整个文件缓存进 `cache`，所以：

- **磁盘读**：只有进程首次 / 每次 `persist()` 后失效 → 每轮采集 0 次磁盘读
- **`JSON.parse(raw)`**：`providers.ts:219` 每次调用都重新 parse，**没有 parse 缓存** → 每轮 2 次
- **`instanceInfo` 逐实例 `await db().getKey(inst.id)`**（`providers.ts:361`）：内存 map 命中

20 条实例的注册表约 3 KB JSON —— 每轮 2 次 parse 在 60s 周期里可忽略。**加一个字符串/短数组字段
不会让这个数字变差（量级不变）。**

### 真正的热点不在注册表读，而在 `probeCredential`

`src/main/providers.ts:365-371`

```ts
else if (preset?.probeCredential) {
  try {
    if (await preset.probeCredential()) credentialSource = 'file'
  } catch { /* 探测失败按未配置处理 */ }
}
```

`opencode` 预设的 `probeCredential`（`providers.ts:62-65`）会读本机 `auth.json` 或查 db：

```ts
probeCredential: async () => {
  const { readGoKey, hasDbCredentialKey } = await import('./adapters/opencode')
  return !!readGoKey() || (await hasDbCredentialKey())
}
```

它在**每轮 `listProviders()` 里对每个 opencode 实例跑一次**。相比之下注册表读是廉价的。

### 写：`setExtra` 全量重写整个文件

`src/main/store.ts:60-63` + `:92-97`

```ts
function persist(): void {
  if (!cache) return
  writeFileSync(filePath(), JSON.stringify(cache), 'utf-8')
}
...
async setExtra(key: string, value: string): Promise<void> {
  const f = load()
  if (!value) delete (f.extras ??= {})[key]
  else (f.extras ??= {})[key] = value
  persist()          // ← 无条件整文件重写
}
```

**`setExtra` 没有增量写、没有节流** —— 任何一次 `setExtra` 都是整份 `secrets.bin` 同步重写。
这是父任务 PRD 已点名的硬约束（`.trellis/tasks/10-01-p1-batch/prd.md:24-25`）：

> **`setExtra` 每次全量重写整个文件** → 时序数据不得走 `extras`

对分组的含义：

- 分组配置是**几百字节量级的偏好**，不是时序数据 → 走 `extras` 不违反该契约
- 但每次切分组显隐 / 拖一次组内顺序 = 一次全文件重写。现有 `reorderInstances` 已经用
  「无变化就不写」短路过一次（`providers.ts:348`），分组写入可以照抄这个守卫
- **不要把分组塞进 `items`** —— 那是加密命名空间，且 `getKey` 按实例 id 索引，放不进去

一个现有的规模事实：`extras` 里已经有一个**按实例 id 展开的键族**
（`provider:<id>:baseUrl` / `provider:<id>:name`，各实例 2 个键），
`ui:cardWindow:<id>` 也是同类（`.trellis/spec/frontend/state-management.md:170`）。
再加一族 `ui:group:*` 是同一量级。

---

## Caveats / Not Found

- **`ProviderInfo` 与 `ProviderSnapshot` 的字段差集没有单一权威文档**，是从 `types.ts:56-110`
  与 `providers.ts:383-402` / `bind-instance.ts:21-28` 逐字比对得出。分组要过哪一侧，
  取决于 CardView 的数据来源选择（见 `02-render-pipeline.md`）。
- 没有找到任何现存的「标签 / tag / 分组」实现（`grep -rn "group" src/` 只命中
  MiniMax 的 `groupId` API 参数与无关注释）。这是全新能力，不是扩展既有抽象。
- `instances-debug.mjs` 是手工排障脚本，不在 `npm test` 链里（`package.json:33`），
  改注册表结构时它也需要同步（它直接 `JSON.parse(store.extras?.providerInstances)`，
  见 `instances-debug.mjs:21`）。

## 相关 spec

- `.trellis/spec/frontend/state-management.md:134-216` — `extras` 键表全文 + `ui:` 前缀规则
  + 「`extras:get` 对缺失键返回 `''` 不是 `undefined`」+ 「读侧重新校验」
- `.trellis/spec/frontend/state-management.md:300-312` — 两个命名空间不相通；`extras` 是明文
- `.trellis/spec/frontend/type-safety.md:366-404` — `window.api` 从 preload 推导，无镜像
- `.trellis/spec/frontend/type-safety.md:188-237` — 五种手写校验惯用法（无 zod/yup）
