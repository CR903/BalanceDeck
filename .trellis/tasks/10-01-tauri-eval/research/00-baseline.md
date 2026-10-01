# Research: 本项目 Electron 能力清单（家底摸底）

- **Query**: 逐个确认 BalanceDeck 实际用到哪些 Electron 能力，每项给 `file:line` 证据
- **Scope**: internal
- **Date**: 2026-10-01

## Findings

### 代码规模（本仓库实际数字）

| 层 | 文件数 | LOC |
|---|---|---|
| `src/main/*.ts`（顶层） | 20 | ~3,930 |
| `src/main/adapters/*.ts` | 17 | ~3,050 |
| `src/main/cli/*.ts` | 3 | 416 |
| `src/main/qa/*.ts` | 5 | 3,255 |
| `src/preload/index.ts` | 1 | 178 |
| `src/shared/*.ts` | 9 | 917 |
| `src/renderer/src/**` | 29 文件 | ~400,000 字节 JS/TSX |
| `scripts/test-*.mjs` | 18 套件 | **8,940** |
| **合计（主进程+共享+preload+CLI+QA）** | 55 | **11,488** |

### 能力清单（逐项证据）

#### 1. 透明置顶悬浮窗 / 鼠标穿透 / 无边框 / 窗口置顶
`src/main/overlay.ts`（467 行，本项目最复杂的单文件）

| 能力 | 证据 | 备注 |
|---|---|---|
| 无边框 | `overlay.ts:133` `frame: false` | |
| 透明 | `overlay.ts:138-139` `transparent: true, backgroundColor: '#00000000'` | 注释 134-137 说明曾试过 macOS vibrancy，因露白线改为 CSS backdrop-filter |
| 常驻置顶 | `overlay.ts:140` `alwaysOnTop: true` + `:62` `setAlwaysOnTop(on, 'floating')` | **带 level 参数**（`floating` / `normal`），非布尔 |
| 不进任务栏 | `overlay.ts:141` `skipTaskbar: true` | |
| 原生阴影开关 | `overlay.ts:151` `hasShadow: !state.collapsed`；运行时 `overlay.ts:300` `win.setHasShadow(!collapsed)` | 收起态必须关，否则 macOS 按**窗口矩形**投方框阴影 |
| macOS 全工作区可见 | `overlay.ts:171` `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })` | 带 options |
| **鼠标穿透（带 forward）** | `overlay.ts:417` `win.setIgnoreMouseEvents(ignore, { forward: true })` | ⚠ **关键**：Electron 有 `forward` 选项，穿透时仍把 move 事件转回本窗口，用于悬停判断 |
| 光标轮询穿透 | `overlay.ts:402-425` `tickCursorWatch()`，`overlay.ts:433` `setInterval(..., 90)` | 90ms 轮询 + 命中框 `overlay.ts:390-400` `cursorInsideHit`（pad=3） |
| 命中框由渲染层送入 | `overlay.ts:385` `setPetHitbox(rect)`；IPC `ipc.ts:494` | |
| 拖拽（主进程追光标） | `overlay.ts:315-353` `dragStart/dragStop`，16ms `setInterval` + `setPosition` | 注释 307 说明「CSS drag-region 会吞掉 click，不可用」 |
| 显示器热插拔 | `overlay.ts:229-230` `screen.on('display-removed' / 'display-metrics-changed')` | |
| 尺寸异步缩放 | `overlay.ts:294-298` `setResizable(true)` → `setBounds` → `setResizable(false)` | |
| 位置持久化 | `overlay.ts:98-116` 写 `userData/state.json` | |
| **后台节流必须关** | `overlay.ts:166` `backgroundThrottling: false` | ⚠ 注释 160-165：**必需项**，否则 setTimeout 被降到最低频率，「到点播报」静默失效 |
| `sandbox: false` | `overlay.ts:159` | 主窗口用了 sandbox:false（Rust 侧无此概念） |

#### 2. 系统托盘（菜单 + 动态标题 + 模板图标）
`src/main/tray.ts`（233 行）+ `src/main/tray-badge.ts`（130 行）

| 能力 | 证据 | 备注 |
|---|---|---|
| 模板图标 | `tray.ts:47` `icon.setTemplateImage(true)`；运行时 `tray.ts:158` | macOS 模板图 RGB 被系统丢弃 |
| **左键直接切换显隐** | `tray.ts:52` `tray.on('click', () => toggleFn())` | ⚠ 注释 53-59：**macOS 上 `setContextMenu` 会让菜单抢占左键**，所以只在右键弹菜单（`tray.ts:57` `tray.on('right-click')` + `popUpContextMenu`） |
| 平台分叉 | `tray.ts:78` `if (process.platform !== 'darwin') tray.setContextMenu(...)` | |
| **动态标题** | `tray.ts:170` `tray.setTitle(lastTitle, { fontType: 'monospacedDigit' })` | ⚠ 带 `fontType` options；标题内容含 **ANSI 转义** |
| 标题 ANSI 上色 | `src/shared/levels.ts:35-43`，只认 Electron `NSString+ANSI.mm` 的 8 色 | ⚠ `levels.ts:24` 注释：判据是 **Electron 37.10.3 内部文件 `NSString+ANSI.mm` 的 switch**，不是 ANSI 规范 |
| 多分辨率图标 | `tray.ts:133-136` `addRepresentation({scaleFactor:1/2, width:22/44, dataURL})` | 渲染层 canvas 出 PNG → IPC `ipc.ts:415` `tray:icon` |
| 位图叠状态点 | `tray.ts:108` `nativeImage.resize(...).toBitmap()` → `paintBadge` | BGRA 手写像素 |
| 图标去重（防闪烁） | `tray.ts:121` `appliedIconKey`（原始 key + 形状并进去） | 注释 90-92 说明为什么不能用原始 key 去重 |
| Tooltip 多行 | `tray.ts:205` `tray.setToolTip(...)` | |

#### 3. 自定义皮肤（读 css 文件）
`src/main/skins.ts`（100 行）

| 能力 | 证据 |
|---|---|
| 目录扫描 | `skins.ts:32-39` `readdirSync(userData/skins)` |
| 读 CSS 文本 | `skins.ts:55` `readFileSync(join(dir, cssFile), 'utf-8')` |
| 目录穿越防护 | `skins.ts:49` `id.slice(4).replace(/[/\\]/g, '')` |
| 原生右键菜单（radio + 打开目录） | `skins.ts:75-98` `Menu.buildFromTemplate(...).popup({window})` + `shell.openPath`（`:94`） |

#### 4. `bd-asset://` 自定义特权 scheme
`src/main/human-assets.ts`（75 行）

| 能力 | 证据 | 备注 |
|---|---|---|
| 特权 scheme 提前注册 | `human-assets.ts:23-28` `registerSchemesAsPrivileged([{standard, secure, supportFetchAPI, corsEnabled}])` | 注释 21：必须在 app ready 前 |
| 请求处理 | `human-assets.ts:50` `protocol.handle(scheme, (req) => Response)` | |
| 走 `net.fetch('file://...')` | `human-assets.ts:65` `net.fetch('file://' + full, {headers})` | Electron 专属 API |
| 路径穿越防护 | `human-assets.ts:57-60` normalize 后必须仍在 root 内 |
| MIME 映射 | `human-assets.ts:39-45` fbx/png/jpg/json |
| 驱动方 | 渲染层 CSP `out/renderer/index.html`：`img-src ... bd-asset:; connect-src ... bd-asset:` | |

**素材规模**：`resources/human-pets` = **221 MB**（ray 96M / aria 94M / reyna-pilot 31M，49 个文件：24 fbx + 12 png + 10 tga + 2 json + 1 glb）

#### 5. 开机自启
`src/main/autostart.ts`（128 行）

| 能力 | 证据 | 备注 |
|---|---|---|
| **macOS 手写 LaunchAgent plist** | `autostart.ts:44-63` `plistXml()`；`:122-123` `mkdirSync` + `writeFileSync(agentPath())` | ⚠ 注释 11-17：Electron `app.setLoginItemSettings` 在 macOS 12 上**完全不写入 BTM 数据库**，故弃用 |
| Windows LoginItem | `autostart.ts:97` `app.setLoginItemSettings({openAtLogin})` | |
| 状态以文件存在为准 | `autostart.ts:68` `existsSync(agentPath())` | |
| 旧登录项兜底清理 | `autostart.ts:103` `setLoginItemSettings({openAtLogin:false})` | |
| 移动后自愈 | `autostart.ts:89-92` `syncAutostart()` | |
| 测试隔离 | `autostart.ts:31` `BALANCEDECK_AUTOSTART_DIR` 环境变量 | |
| UI 提示手动清理 | `autostart.ts:76-83` `hasSystemLoginItem()` | |

#### 6. `safeStorage` 加密存储
`src/main/keystore.ts`（26 行）+ `src/main/store.ts`（103 行，**不依赖 electron**）

| 能力 | 证据 |
|---|---|
| 三件套 | `keystore.ts:16-18` `safeStorage.isEncryptionAvailable()` / `encryptString(...).toString('base64')` / `decryptString(Buffer.from(b64,'base64'))` |
| 落盘格式 | `store.ts:24-28` `{version:1, items:{<id>: base64密文 \| 'plain:<base64>'}, extras:{...}}` |
| 损坏重建 | `store.ts:49-57` try/catch → 重建 |
| 明文兜底前缀 | `store.ts:76` `'plain:' + base64` |
| 惰性路径 | `keystore.ts:14` `filePath: () => join(app.getPath('userData'), 'secrets.bin')`（注释：必须惰性，BD_USER_DATA 在 ready 前才 setPath） |

#### 7. 内嵌浏览器 OAuth 登录
`src/main/opencode-auth.ts`（311 行）—— **本项目技术风险最高的一块**

| 能力 | 证据 | 备注 |
|---|---|---|
| **持久分区** | `opencode-auth.ts:39` `const PARTITION = 'persist:opencode-auth'`；`:163` `session.fromPartition(PARTITION)` | |
| 读 cookie | `opencode-auth.ts:265` `ses.cookies.get({domain:'opencode.ai'})` | 含 HttpOnly |
| **OAuth 弹窗放行 + 白名单** | `opencode-auth.ts:241-246` `setWindowOpenHandler`，正则放行 `opencode.ai\|github.com\|accounts.google.com\|google.com` | ⚠ **弹窗**是本块的核心 |
| 弹窗尺寸覆盖 | `opencode-auth.ts:243` `overrideBrowserWindowOptions: {width:520,height:720}` | |
| 900ms 轮询 + 5min 超时 | `opencode-auth.ts:41-42, 304-305` | |
| 三源发现 workspace id | URL(`:253-254`) → 页面 HTML(`:279` `executeJavaScript`) → `/console/api/orgs`(`:121`) | |
| cookie 验证判据 | `opencode-auth.ts:96` 打 `/console/api/usage/summary` 看是否 200 | 注释 27-36：SPA 改版后旧判据永远不成立 |
| 会话轮换应对 | `:157-160` 注释：服务端每次响应轮换 session cookie，分区是唯一可靠来源 | |

#### 8. 文件持久化 + CLI
- `providers.ts`（469 行）：实例注册表，`:231` `saveInstances` / `:236` `migrateLegacy`
- `usageStore.ts`（193 行）/`usage-history.ts`（17 行）：快照落盘 + 保留期裁剪
- `cli/export-command.ts`（226 行）+ `export-writer.ts`（84 行）+ `export-snapshot.ts`（106 行）
- **CLI argv 位置敏感**：`index.ts:35` `process.argv.slice(app.isPackaged ? 1 : 2)`，注释 32-34 记录 `app.argv` 在 Electron 37 实测为 `undefined`

#### 9. three.js 3D 渲染
`src/renderer/src/pet3d/`（6 文件，~85 KB）

| 点 | 证据 |
|---|---|
| WebGLRenderer | `pet3d/scene.ts:127-132` `{antialias: dpr<=1.5, powerPreference:'low-power'}` |
| PBR 环境光照 | `scene.ts:137-138` ACESFilmicToneMapping；`:167` `pmrem.fromScene(new RoomEnvironment())` |
| FBXLoader + SkeletonUtils | `pet3d/human.ts:2-3` |
| GLB 以 base64 data URL 内联 | `index.html` CSP 注释：「3D 宠物素材（GLB）以 base64 data URL 内联」 |
| 软件渲染回落 | `scene.ts:117` 注释：「本函数无条件 `new THREE.WebGLRenderer`」；`:398` `softRenderer` 降 pixelRatio |

#### 10. 定时采集
`src/main/scheduler.ts`（230 行）
- `:30-32` 间隔 10s–300s，默认 60s；`:41` `setInterval`
- `:58-` `collect()` 一轮并行
- 离线判定 `net.ts:60-68`：系统 `net.isOnline()` + 连续 2 次网络错误

#### 11. 其他 Electron API（全局统计）
`grep` 全仓统计（`src/main` + `src/preload`）：
- `ipcMain.handle` × 33 / `ipcMain.on` × 11 / `ipcRenderer.invoke` × 33 / `ipcRenderer.send` × 11
- `app.getPath` × 13 / `app.quit` × 8 / `Menu.buildFromTemplate` × 5
- `screen.getDisplayNearestPoint` × 4 / `screen.getCursorScreenPoint` × 4 / `screen.getAllDisplays` × 1 / `screen.on` × 2
- `BrowserWindow.getAllWindows` × 4 / `nativeImage.*` × 5 / `session.*` × 3
- `safeStorage.*` × 3 / `protocol.*` × 2 / `shell.*` × 2
- **`globalShortcut`：全仓 0 处使用**（任务清单提到，实测未用）

### Node 专属 API（Rust 侧无对应，必须换 crate）

| API | 证据 | Rust 替代 |
|---|---|---|
| **`node:sqlite`** | `opencode.ts:122` 和 `:342` `await import('node:sqlite')` + `new DatabaseSync(path, {readOnly:true})` | `rusqlite` / `sqlx`。⚠ 还要处理 opencode 自己 DB 文件的 WAL 并发锁 |
| `fs` / `path` / `os` | 14 / 12 / 4 处 import | `std::fs` / `std::path` / `dirs` |
| `crypto` | `store.ts` 间接（实为 keystore 注入） | — |
| `child_process` | **0 处** | 无需 |

### QA / 测试形态（4 种运行模式 + 18 套件）

| 形态 | 入口 | 规模 |
|---|---|---|
| `--smoke` | `index.ts:20` → `qa/modes.ts:49` `runSmoke` | 采集一轮 → stdout JSON → 自动退出 |
| `--uitest` | `index.ts:22` → `modes.ts:79` → `qa/uitest.ts` | **2,500 行，167 个唯一断言键，194 处赋值，251 个 `fail:` 哨兵，259 处 `exec()`** |
| `--shots` | `index.ts:24` → `qa/shots.ts`（291 行） | 截图走查，2 处 `capturePage` |
| `--ballshot` | `index.ts:141` → `qa/ballshot.ts`（265 行） | 只拍收起态，34 处 `executeJavaScript` |

**uitest 的执行模型**（决定了迁移成本）：
- `uitest.ts:31` `const exec = async (js) => win.webContents.executeJavaScript(js, true)`
- 断言跑在**真实 Electron 窗口的渲染层 DOM 上**，靠 `document.querySelector` + `getComputedStyle` + `getBoundingClientRect` + `dispatchEvent(new PointerEvent/WheelEvent)`
- 探针走 `window.__bd_ball?.()`（`uitest.ts:190`）观测点
- 夹具经 `window.api.debugPush` 推入（`uitest.ts:133`）—— **依赖 preload 的 debug 通道**
- 还会**猴补 Electron 内部**：`uitest.ts:247-260` 临时替换 `Menu.buildFromTemplate` 截获菜单项

**18 套 node 套件的模型**：
- `scripts/lib/load-ts.mjs`（40 行）：用 esbuild 把 `src/**` 真源码打成内存 ESM 后 `import(data:text/javascript;base64,...)`
- 16 个套件用 `loadTs`，共 75 次调用
- 加载目标分布：`src/main` 20 次 / `src/renderer` 15 次 / `src/shared` 7 次
- `scripts/lib/electron-stub.mjs`（15 行）：**只实现 `net.isOnline()`** 一个成员来让 adapters 能被纯 node 加载（注释 8-10 明确纪律：「只实现被用到的成员，不要顺手补全」）
- `scripts/test-structure.mjs`：**纯静态读源码断言**（`readFileSync`），守 11 个文件路径的结构契约（如 `B4 src/main/qa/ 只放这五样`）

### 构建与分发现状

| 项 | 现状 | 证据 |
|---|---|---|
| bundler | `electron-builder.yml`（37 行） | `files: out/** + package.json`；`extraResources`: `build` → `build`，`resources/human-pets` → `human-pets`；`asar: true` |
| mac 目标 | `dmg` + `zip`，`identity: null`（**未签名**） | `electron-builder.yml:14-19` |
| win 目标 | `nsis` + `zip` | `:20-23` |
| Linux | **无目标** | grep 无 `linux` 段 |
| **自动更新** | **无** | grep `autoUpdater`/`electron-updater` 全仓 0 处 |
| **CI** | **无** | 无 `.github/` 目录 |
| 签名 | mac 未配 identity；win 无证书段 | |
| App Store | **不在**（只 dmg+zip） | 无 masbuild |

### 打包体积构成（实测 `du`）

| 组成 | 大小 | 占比 |
|---|---|---|
| **resources/human-pets** | **221 MB** | 46% |
| Electron.app（Chromium + Node） | 255 MB | 53% |
| out/（自有代码 main+preload+renderer） | 2.2 MB | 0.5% |
| build/（图标等） | 320 KB | 0.1% |
| **合计（未压缩）** | **~478 MB** | |

自有代码 gzip 后：renderer JS 343 KB + renderer CSS 22 KB + main 69 KB = **~434 KB**

## Caveats / Not Found

- `qa/`（仓库根目录）**为空**；QA 实现在 `src/main/qa/`。任务清单里的 `qa/*` 路径需更正为 `src/main/qa/*`。
- `10-01-p1-5-resource` 任务的 `research/` 目录**为空**（2026-10-01 检查），内存实测基线由本任务自行完成（见 `03-benefit-metrics.md`）。
- 未测量**打包后**（asar + dmg）的真实体积，仅测了 `node_modules/electron/dist` 与资源目录的原始大小。
- `Notification.isSupported()` 用了 1 次（`ipc.ts` 系统通知路径），Windows Toast 依赖 `app.setAppUserModelId`（`index.ts:127`）。