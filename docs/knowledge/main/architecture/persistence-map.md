# 持久化数据模型（main）

适用：找「某个设置/凭据/用量历史存在哪、谁读谁写」；改存储结构、排查数据丢失。
本仓**没有 sqlite**：全部是 userData 目录下的 JSON + 全量重写纯逻辑模块（写盘前想到写放大）。

## 三份磁盘文件（全在 `app.getPath('userData')`）

| 文件 | 模块 | 内容 |
|---|---|---|
| `secrets.bin`（keystore.ts:14，名字叫 .bin 实为 JSON） | `store.ts`（纯逻辑）+ `keystore.ts`（装配） | 凭据与偏好 |
| `usage-history.json`（usage-history.ts:16） | `usageStore.ts`（纯逻辑）+ `usage-history.ts`（装配） | 用量历史采样 |
| （无第三份文件；其余状态都是常驻内存或分区文件） | | |

格式（store.ts:12, 24-28）：`{ version: 1, items: { <providerId>: base64密文 }, extras: { <key>: 明文 } }`。
usage-history 格式（usageStore.ts:17-18, 50-63）：`{ version: 1, days: { 'YYYY-MM-DD': { <providerId>: DayPoint[] } } }`，`DayPoint = { window, t, pct | null, used?, unit? }`——`used/unit` 是可选对（2026-10-07 加），读回 undefined **不许补 0**，保持 version 1 兼容旧文件。

## 写路径纪律

- **惰性路径求值**：文件路径必须写成 `() => join(app.getPath('userData'), …)`。因为 `BD_USER_DATA` 在 app ready 前才 setPath，静态导入先于模块体求值（keystore.ts:12-14、usage-history.ts:10-12、store.ts:7-9）。**静态 join 会在测试/自测模式下写错目录。**
- **损坏静默重建空文件**：`readFileSync` JSON 解析失败 → 空对象重建（store.ts:40-63、usageStore.ts:109-132），不弹错。
- **usage-history 绝不走 extras**（usageStore.ts:25-29 有完整推演）：extras 每次 `setExtra` 都 whole-file 重写；30 天 × 60s × N 供应商 ≈ 8-12MB，每 60s 全量重写 ≈ 每日 200GB 写盘。独立文件 + 独立键空间让该问题结构性不存在；`npm run test:usage-store` 有**负向断言**守着（不得 import extras/keystore）。
- 两个 store 的 persist 都是「修改 → 整个 JSON 重写」；`appendBatch` 只在 `added > 0` 时 `dropExpired + persist`（usageStore.ts:143-172）。

## keystore：items（加密）与 extras（明文）的两个世界

- **items = 加密凭据**：`safeStorage`（macOS Keychain / Windows DPAPI，keystore.ts:16-18）；加密不可用兜底 `'plain:' + base64` 前缀标记（store.ts:76），读侧两种都兼容（store.ts:85-86）。存各 provider 的 API key（`getKey/setKey` 按 providerId）与 **TTS 自定义 token**——token 是凭据**必须落 items**，⛔ 禁止写 extras（ipc.ts:270-281，键名 `ttsSecretKey(id)`，channel `tts:setSecret` / `tts:hasSecret`）。
- **extras = 明文偏好**：刷新频率 `refreshInterval`、workspaceId `opencodeWorkspaceId`、保留期 `sample:usageHistoryDays`、皮肤等 `ui:*` 键。
- **访问面：main 独占**。renderer 只能经 preload 的 `extras:get/set` 间接改 extras（ipc.ts:250-258）；token 只能走 `tts:setSecret`；scheduler 轮中以 `getKey/getExtra` 注入 `collectAll`（scheduler.ts:114-116），叠加环境变量兜底 `envValueFor`/`envExtraFor`（scanner.ts）。
- `keystore.ts` 导出 `keystoreStore` 与五个转发别名（keystore.ts:22-26）：消费方一律 import keystore 的导出名；`store.ts` 的 `createStore` 接受 `{ filePath, crypto }` 注入，与 `usage-history.ts` 的装配形状同构。

## usage history 谁写谁读

- **写**：只有 main 进程——scheduler 收尾 `sampleUsageHistory()` → `appendBatch`（scheduler.ts:150, 283）。
- **读**：只有一条路——renderer 经 preload `usage.predict`（preload/index.ts:122）→ `ipc.handle('usage:predict')`（ipc.ts:410-416）→ `loadUsageHistory`，逐字段复验 providerId/days/now 后失败静默返回空对象。回归/展示全部是渲染层纯函数的事（ipc.ts:405 注释）。

## 时区与保留期的小陷阱

- **切天用本地时区日**（usageStore.ts:78-85）：跨时区用 UTC 日会把早晨 8 小时采样记到「昨天」。
- 裁剪用**日历减法** `cutoffDayKey`（usageStore.ts:94-97）跨夏令时不出错；保留期脏值一律落向默认而非「不裁」（`keepDaysOf`，:99-103）。
- `DEFAULT_RETENTION_DAYS = 30`、`MAX_RETENTION_DAYS = 365`（shared/usage-predict.ts:27）、键名 `PREDICT_KEYS.retention = 'sample:usageHistoryDays'`——主进程写、渲染层读**共用同一常量**（usage-predict.ts:114-127）。

## 参考

- 谁写它（调度收尾）见 [scheduler-lifecycle](scheduler-lifecycle.md)。
- 验证：`npm run test:usage-store`、`npm run test:usage-history`。
