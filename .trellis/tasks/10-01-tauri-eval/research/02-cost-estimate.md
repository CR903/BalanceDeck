# Research: ② 迁移成本估算（人日）

- **Query**: Rust 后端、前端、测试体系、构建分发四块各要多少人日
- **Scope**: internal（行数/调用点实测）+ mixed（Rust crate 成熟度、CI/签名实操）
- **Date**: 2026-10-01

## 估算前提（必须先说清，否则数字没意义）

1. **一个人**（熟悉本仓库、**不熟 Rust**）全职投入。人日 = 1 个工作日 ≈ 7h 有效编码时间。
2. **不含**产品需求变更、不含新功能、不含 bug 修复（只做「跑起来且行为等价」）。
3. **不含**跨平台回归（只保证 macOS + Windows）。
4. 包含**所有回归验证与修复**时间 —— 这是最容易被低估的部分，下文每块都单列「回归/调试」。
5. Rust 学习曲线**不单独计**（已摊进各块）。若团队无人写过 Rust，另加 **5–8 人日**的 ramp-up（syntax/async/borrow checker/trait/serde）。

---

## A. Rust 后端重写（`src/main/**`）

| 块 | 现状规模 | 主要工作 | 人日 | 理由 / 风险 |
|---|---|---|---|---|
| **A1 采集调度 `scheduler.ts`** | 230 行 | 逻辑 1:1 翻成 Rust（tokio interval + 状态机）+ `serde` 类型定义（`AppState`/`ProviderSnapshot` 从 `shared/types.ts` 246 行搬过来） | **4** | 逻辑本身不难，但 `shared/types.ts` 要变成 serde derive，两个方向的类型定义得重做一次；「本轮失败沿用上次」策略（`scheduler.ts:26-27`）与 cache 语义要逐条对齐 |
| **A2 适配器（9 种协议 + 出网）** | `adapters/` **3,050 行**（17 文件），其中 `opencode.ts` 单文件 828 行 | 全部翻 Rust：`reqwest`/`hyper` 替 `fetch`，各家 API 的 JSON 解析换 `serde`，cookie 处理、SSR 解析、重试/降级逐个搬 | **22** | ⚠️ **最大块**。9 种协议各自有独立的字段映射与容错分支（`protocols.ts` 301 行 + `protocol-adapter.ts` 96 行 + `engine.ts` 111 行 是通用层，能省一些）。`opencode.ts` 828 行含 SPA 抓取/轮换 cookie/多源 id 发现，是最脏的一块。**估 22 人日已属乐观**，若边翻边发现边界 case，30+ 现实 |
| **A3 `node:sqlite` → `rusqlite`** | `opencode.ts:122,342` 两处 | 换 crate + 处理 WAL 并发锁 + 保持 `readOnly` 语义 | **2** | API 简单，但「读别人正在写的 SQLite」在 Rust 下的默认行为与 Node 不同，**必须实机验证**（这是易被漏的坑） |
| **A4 密钥存储 `store.ts`/`keystore.ts`** | 129 行 | ⚠️ **无 `safeStorage` 对等**。落盘格式必然重设计（`store.ts:24-28` 的 `items`/`extras` 双 map + 内存缓存 → keyring crate 的按 key 取值模型）+ 数据迁移（老用户的 `secrets.bin` 要能读出来） | **5** | 不只是「换个加密函数」，是**存储模型变了**。老用户凭据不能丢 → 需要一条「读旧格式 → 写新格式」的迁移路径 |
| **A5 皮肤加载 `skins.ts`** | 100 行 | 目录扫描 + 读 CSS + 右键菜单 | **1.5** | 逻辑简单。菜单部分与 A6 共用 |
| **A6 托盘 `tray.ts` + `tray-badge.ts`** | 363 行 | 图标去重逻辑直译 + **位图叠状态点**（`nativeImage.toBitmap`/`addRepresentation` → `image` crate 手写 BGRA）+ 菜单 + 左/右键分叉 | **5** | ⚠️ 含**未验证项**：托盘标题 ANSI 是否被解析（`levels.ts:24`）。若不解析，等级着色要改成「图标分层 + 数字」双通道（`tray.ts:16-18` 注释说 Windows 已是这个形态），属产品变更 |
| **A7 悬浮窗 `overlay.ts`** | **467 行**（最复杂单文件） | 窗口创建参数 + 90ms 光标轮询 + 命中框判定 + 16ms 拖拽追踪 + 显示器热插拔 + 位置持久化 | **6** | 逻辑可直译，但含**三个未验证项**：`set_ignore_cursor_events` 缺 `forward`（悬停反馈链要重设计）、置顶 level 参数消失、**DIP vs 物理像素**（`overlay.ts:392` 注释专门讲过坐标系，Tauri 返回 `PhysicalPosition` 必须除 `scale_factor`） |
| **A8 自启 `autostart.ts`** | 128 行 | **删掉手写 plist**，换 `tauri-plugin-autostart`（官方正是 LaunchAgent 方案）+ 处理测试隔离（`BALANCEDECK_AUTOSTART_DIR`） | **1.5** | 比现状简单。⚠️ 注意 `hasSystemLoginItem()`（旧登录项检测，`autostart.ts:76-83`）插件可能没对应，要自己实现或降级 |
| **A9 内嵌 OAuth `opencode-auth.ts`** | 311 行 | ⚠️ **不是重写，是重新设计**：`setWindowOpenHandler` → `on_new_window`（**#14263 open bug**）；`session.fromPartition` → 无等价物；`ses.cookies.get` → `cookies_for_url`（**Windows 死锁**，须 async + 独立线程） | **8** | 估 8 人日的前提是「#14263 已修」。**若未修，此块不可估** —— 可能需要改走「外部浏览器 + deep-link 回调」的产品级改造，那超出迁移范围 |
| **A10 `bd-asset://` `human-assets.ts`** | 75 行 | `register_uri_scheme_protocol` + 文件读取 + 路径穿越防护 + MIME | **1.5** | API 直接对等。但**渲染层 CSP 要按平台改**（`index.html` 现在写死 `bd-asset:`；Tauri 的 Origin 在 Windows 是 `http://bd-asset.localhost/`） |
| **A11 其他 `ipc.ts`/`providers.ts`/`net.ts`/`request.ts`/`usageStore.ts`/`scanner.ts`/`opencode-details.ts`/`tray-badge` 辅助** | `ipc.ts` 528 + `providers.ts` 469 + 其余 ~480 = **~1,477 行** | IPC handler → `#[tauri::command]`（44 个）；providers 注册表 → serde + store；`net.isOnline` → 换 crate | **7** | 机械但量大。**44 个 command 每一个都要定 capability 权限**（Tauri 默认全禁，`capabilities/*.json` 要逐条列） |
| **A12 CLI `cli/`** | 416 行 | `export --json` 子命令，依赖退出码与 argv 偏移（`index.ts:35`） | **1.5** | `process.argv` 在 Tauri 下仍可用（Rust 侧 `std::env::args`）。但 `app.isPackaged` 偏移量判据要重新验证 |
| **A13 WebGL / autoplay 开关** | `index.ts:45-72` | `--no-sandbox`/`--disable-gpu-sandbox`/`--enable-unsafe-swiftshader`/`--autoplay-policy` 无对等 | **2** | ⚠️ 全新工作项（不是移植）。**autoplay 是必需项**（注释 51-72：播报发生在用户不在电脑前）。WKWebView 的 autoplay 策略与 Chromium 不同，**可能要改产品实现**（如后端直解音频 + 静音播放），那是额外成本 |
| **A14 入口 `index.ts` 装配** | 177 行 | `tauri::Builder` 装配、生命周期迁移 | **2** | `app.whenReady` → `Builder::setup`；QA 模式分派要重排 |

### A 小计

| | 人日 |
|---|---|
| 纯移植（A1,A2,A5,A6,A7,A10,A11,A12,A14） | 51.5 |
| 有设计/未知风险（A3,A4,A8,A9,A13） | 18.5 |
| **A 合计** | **70 人日** |

**A 的区间判断**：**乐观 55（所有未验证项都顺利）/ 悲观 100+（A2 适配器踩坑 + A9 OAuth 无解）**。

---

## B. 前端改动（`src/preload` + `src/renderer`）

| 项 | 现状 | 工作 | 人日 |
|---|---|---|---|
| **B1 `window.api` → `invoke` 重写** | `preload/index.ts` 178 行，**44 个 API 方法**（33 `invoke` + 11 `send`）；`ipc.ts` 对应 44 个 handler | 把 44 个方法逐个改成 `invoke('cmd', args)` / `listen()` / `emit()`；**注意 11 个是 `send`（单向）**，Tauri 无 `send` 等价，得改成 `invoke` 或 `emit`，**这会改语义**（send 无返回值、invoke 有） | **4** | 机械。`api.d.ts` 已从 preload 推导类型（`api.d.ts:8` `import type { Api } from '../../preload'`），类型链要重建 |
| **B2 渲染层调用点适配** | 全仓 `api.*` 调用 **81 处**，分布：`App.tsx` 50 / `SettingsView.tsx` 21 / `PetBall.tsx` 4 / `CardView.tsx` 4 / `speechOut.ts` 3 | 改 import、改 `onX(cb)` → `listen()` 的返回值是 `Promise<unlisten>`（不是同步返回函数） | **2** | `setExtras` 一个方法就 27 处调用（集中在 `SettingsView.tsx`）。返回 Promise 化是系统性改动 |
| **B3 three.js 3D 适配** | `pet3d/` 6 文件 ~85 KB | ⚠️ 代码**大概率不用改**，但要**跨引擎回归**：Chromium → WKWebView（macOS）/ WebView2（Windows）。重点验 `ACESFilmicToneMapping` + `RoomEnvironment` PMREM（`scene.ts:137,167`）+ `powerPreference:'low-power'` + FBXLoader 骨骼 | **3** | 若发现渲染差异，**可能要引入非 WebGL 回落**（Tauri 官方对 Linux WebGL 就是这么建议的），那是额外 3-5 人日 |
| **B4 CSP 调整** | `index.html` 写死 `bd-asset:` | 按平台 Origin 差异调整 | **0.5** | |
| **B5 构建链** | `electron-vite` 三段构建（main/preload/renderer） | Tauri 只需前端一段（Vite）+ Rust 侧 `cargo`；`electron.vite.config.ts` 39 行可大幅简化 | **1** | Tauri 支持 `beforeDevCommand`/`beforeBuildCommand` 接 Vite。**preload 概念消失**是最大简化 |
| **B6 打包资源** | `extraResources` 手工配 | Tauri 用 `bundle.resources`；`human-pets` 221 MB 的放置策略要重新定（Tauri 资源进 `Contents/Resources`） | **1** | |

### B 小计：**11.5 人日**（区间 9–18，B3 若需加 WebGL 回落则 +3~5）

---

## C. 测试体系重写 ⚠️ **最容易被低估**

这是本次评估中**成本最集中、最容易被拍脑袋低估**的部分。

### C1 18 套 node 断言套件（`scripts/test-*.mjs`，8,940 行）

**好消息**：`load-ts.mjs` 的机制（esbuild 打成内存 ESM 再 import）与 Electron 无关。
**坏消息**：它加载的 42 个模块里，**20 个在 `src/main`**（含 adapters 全部 8 个、providers、store、cli 三个、usageStore、opencode-cookie、opencode-console-api 等）。

| 情形 | 数量 | 处理 | 人日 |
|---|---|---|---|
| **加载 `src/shared` + `src/renderer` 的模块**（22 次调用） | 15 个模块 | ✅ **零改动**（`levels.ts:8-9` 注释：「本模块刻意不 import electron、不碰 DOM：单元测试用 loadTs 在纯 node 里加载它，三档边界断言必须打到真源码」） | **0** |
| **加载 `src/main` 但纯逻辑的模块**（`store.ts`/`tray-badge.ts`/`cli/*`） | 5 个 | ✅ 逻辑留 TS 侧即可，或 Rust 侧重写时同步补 Rust 单测 | **1** |
| **加载 `src/main/adapters/*` 的 8 个模块**（13 次 `loadTs`，`test-adapters.mjs` 59 KB） | 8 | 🔴 **全部重写为 Rust 单测**（`cargo test`）。`test-adapters.mjs` 是最大单套件 | **8** |
| **`test-structure.mjs`（静态读源码断言）** | 1 套 | 🔴 **全部作废重写**。它守的结构契约（A1 入口 ≤500 行、B4 `qa/` 只放五个文件、C 组「qa 不被产品代码引用」、E/F 组「播报链路主进程前提」）在 Rust 仓库里**全部指向不存在的文件** | **3** |
| **`test-system-notify.mjs`（含 `H6` 静态比对 `appId`）** | 1 | 🔴 比对目标从 `electron-builder.yml` 变 `tauri.conf.json`，重写 | **1** |
| `electron-stub.mjs` 替身 | 1 | 废弃（Rust 无 electron） | **0** |
| **其余 TS 侧套件在新架构下的定位** | 10 个 | 决定哪些留（纯函数继续 TS 测试）、哪些搬（走 Rust 的） | **1** |

**C1 小计：14 人日**

> ⚠️ 若选择「采集逻辑留在 TS、只把窗口/托盘/存储搬到 Rust」的**部分迁移**，C1 会显著降到 3–5 人日 —— 因为 adapters 不动。见 §D。

### C2 `--uitest` UI 自动化（`qa/uitest.ts`，**2,500 行**）

**这是最贵的一块，且没有捷径。**

| 事实 | 证据 |
|---|---|
| 167 个唯一断言键、194 处赋值、251 个 `fail:` 哨兵 | grep 实测 |
| 259 处 `exec()`，全部是 `win.webContents.executeJavaScript(js, true)`（`uitest.ts:31`） | grep + `uitest.ts:31` |
| 跑在**真实窗口的渲染层 DOM** 上：`document.querySelector` / `getComputedStyle` / `getBoundingClientRect` / `dispatchEvent(PointerEvent/WheelEvent)` | `uitest.ts:47-62, 156-215` |
| 探针走 `window.__bd_ball?.()` 观测点 | `uitest.ts:190` |
| 夹具经 `window.api.debugPush`（**依赖 preload 的 debug 通道**） | `uitest.ts:133` |
| **猴补 Electron 内部**：临时替换 `Menu.buildFromTemplate` 截获菜单项 | `uitest.ts:247-260` |
| 窗口/托盘状态断言（穿透、阴影、标题、图标等级） | `petIgnoreState()`/`trayBadgeInfo()` 等 6 个 debug 通道（`preload/index.ts:114-125, 155-167`） |

**Tauri 下的三种可能路径**：

| 方案 | 可行性 | 人日 | 代价 |
|---|---|---|---|
| **A. 保留 Tauri 窗口 + `eval()` 重写** | ⚠️ Tauri 有 `webview.eval()`，但**异步且无 `userGesture` 参数等价**，且部分内容（如 `window.__bd_ball` 观测点）仍要在前端埋 | **12–15** | 259 处 `exec` 要逐个改成 async/await 并处理错误；`runPetMenu` 那种猴补 Electron 的手法在 Tauri 下**无对应物**（菜单在 Rust 侧，只能改成「菜单项由测试注入」的重设计） |
| **B. 改用 Playwright 驱动 WebView** | ⚠️ 理论上 Tauri 支持 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` / WebKit 远程调试，但 **macOS WKWebView 的自动化支持远弱于 Chromium** | **15–20** | macOS 上大概率**不可行**；等于要放弃一半 UI 测试 |
| **C. 只保留能在 DOM 层跑的断言，其余删掉** | ✅ 可行 | **4** | ⚠️ **但这是产品决策不是工程决策** —— 会丢掉 167 条断言里相当一部分（窗口阴影、托盘标题、图标等级、穿透状态这些**只存在于主进程侧的断言**，本来就没法在 DOM 层验证） |

**C2 小计（方案 A）：12–15 人日**；若走 C 则 4 人日但**覆盖度下降**。

### C3 `--shots` / `--ballshot` / `--smoke`

| 形态 | 现状 | 人日 |
|---|---|---|
| `--smoke`（`modes.ts:49`，`executeJavaScript` 查 `#root` 子节点数 + tray 状态 JSON） | 简单 | **0.5** |
| `--shots`（291 行，2 处 `capturePage`） | Tauri 有 `Webview::capture()` 但**异步 + 返回格式不同** | **2** |
| `--ballshot`（265 行，34 处 `executeJavaScript`） | 同 uitest 的 async 化问题 | **2** |

### C 小计：**14 + 13 + 4.5 ≈ 31.5 人日**（方案 A）

---

## D. 构建与分发

| 项 | 现状 | Tauri 侧 | 人日 |
|---|---|---|---|
| **bundler** | `electron-builder.yml` 37 行 | `tauri.conf.json` + Tauri bundler（内置 cargo-bundle/dmg-bundle/wix）。`asar: true` → 无对应（单二进制），是简化 | **2** |
| **资源配置** | `extraResources` 把 221 MB `human-pets` 放 `Contents/Resources` | `bundle.resources`，**需重新确认大资源放置与代码签名顺序** | **1** |
| **macOS 签名** | `identity: null`（**当前未签名**） | 若要签名：`macosPrivateApi` + Developer ID + **公证（notarization）**。⚠️ 当前没签名 = **这块是净增成本，但也可维持不签** | **0**（维持现状）/ **3**（新增签名） |
| **Windows 签名** | 未配 | Authenticode。⚠️ Fluxzy 实录：Tauri 的 minisign 更新签名与 Authenticode **顺序冲突**（Authenticode 会改写二进制 → minisign 失效），必须「先 Authenticode，再用 `tauri signer` 重签」 | **0**（维持现状）/ **2** |
| **自动更新** | ⚠️ **项目当前没有**（grep `autoUpdater` 0 处） | Tauri updater 插件成熟，但 **Electron 与 Tauri 的 updater 不通用** —— Fluxzy 被此咬过：不得不发一个中间版本通知用户手动下载 | **0**（不引入）/ **4**（若要引入） |
| **CI** | ⚠️ **项目当前没有** `.github/` | 若引入 CI：Tauri 三平台矩阵 + Rust toolchain + WebView 依赖（Linux 还要 `webkit2gtk` 系统包）。Fluxzy 实录：自托管 Windows runner 会因 `rustup` 默认 host 漂移而构建失败，需显式 pin | **0**（不引入）/ **5**（引入） |
| **Rust 构建时长** | `electron-vite build` 秒级 | 首次全量 `cargo build` **数分钟到十几分钟**（release + LTO 更久）。开发者日常迭代体验会明显变差 | **0**（不可控，但影响体验） |
| **Linux 系统依赖** | N/A（项目不发 Linux） | 若未来发 Linux：需 `webkit2gtk` 系统包 → 破坏「一条命令跑起来」 | **0**（当前不发） |

### D 小计（维持现状：mac/win 不签名、无 updater、无 CI）：**3 人日**
**若全面补齐（签名 + 公证 + updater + CI）：16 人日**

---

## E. 总计

| 方案 | A 后端 | B 前端 | C 测试 | D 构建 | **合计** |
|---|---|---|---|---|---|
| **全量迁移（乐观）** | 70 | 11.5 | 31.5 | 3 | **116 人日** |
| **全量迁移（现实，区间）** | 70–100 | 11.5–18 | 31.5–35 | 3 | **116–156 人日** |
| 全量迁移 + 签名/updater/CI | +13 | — | — | +13 | **129–169 人日** |
| **部分迁移（见结论文档）** | 25–35 | 6–8 | **3–5** | 2 | **36–50 人日** |

**折算**：116 人日 ÷ 5 天/周 ≈ **23 周 ≈ 5.7 个月单人**。
156 人日 ≈ **31 周 ≈ 7.8 个月单人**。
若两人并行（不线性），乐观 3–3.5 个月。

**另加**：Rust ramp-up 5–8 人日（若团队零 Rust 经验）；#14263 若未修，A9 变成「不可估」需产品级改造。

## 成本里最容易被低估的三项（本评估明确指出）

1. **C2 `--uitest` 2,500 行 / 167 条断言** —— 它的执行模型（`executeJavaScript` 驱动真实 Chromium DOM + 主进程 debug 通道 + 猴补 `Menu.buildFromTemplate`）**与 Electron 深度耦合**。Tauri 下 macOS WKWebView 无可靠自动化方案，走方案 A 也要 12–15 人日，走方案 C 则覆盖度下降。**这 ≈ 全部 UI 重写的工作量。**
2. **A2 适配器 3,050 行** —— 9 种协议 × JSON 解析 × 容错分支，且 `opencode.ts` 单文件 828 行含 SPA 抓取与 cookie 轮换。22 人日是乐观值。
3. **A4 密钥存储** —— 不是「换个加密函数」，是**存储模型从「整文件读写」变成「按 key 取值」**，还带老用户数据迁移。5 人日。

## 缓解因素（必须一并说，否则也是空谈）

- `src/shared/` 9 个文件 917 行**刻意不 import electron**（`levels.ts:8-9` 把「纯」写成可执行前提），且有 7 次 `loadTs` 直接打真源码 → **这部分测试零成本保留**
- 渲染层 400 KB JS/TSX 里，**81 处 `api.*` 调用是收敛的**（`api.d.ts` 从 preload 推导类型，注释明说「preload 没实现的方法，渲染层连类型都没有」）→ API 面窄且有类型保护，B1/B2 成本低于直觉
- Tauri 的 capability 模型默认比 `sandbox: false`（`overlay.ts:159`）**更安全**，A11 里 44 个 command 的权限声明是**净收益**
- `autostart.ts` 128 行手写 plist 可**直接删除**（Tauri 插件正是 LaunchAgent 方案）

## Caveats

- 人日为**估算**，基于代码规模与能力对等表推断，非实测。
- 未考虑「迁移中途发现新的 Electron 特性依赖」的返工。真实迁移中此项通常 +20%。
- A9（OAuth）的 8 人日**建立在 #14263 已修复的假设上**，当前该 issue 状态为 **open**。
- 「部分迁移」方案的 36–50 人日**未包含**「长期维护两套技术栈」的持续成本（见 `03-benefit-metrics.md` 的代价段）。