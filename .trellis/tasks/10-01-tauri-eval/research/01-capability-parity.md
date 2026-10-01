# Research: ① Tauri 2.x 能力对等表

- **Query**: 本项目每一项 Electron 能力在 Tauri 2.x 的对等方案、成熟度与缺口
- **Scope**: mixed（内部证据 + Tauri 官方文档 / docs.rs / GitHub issue）
- **Date**: 2026-10-01
- **检索版本**: Tauri `2.x`（docs.rs `tauri` latest；核对到 `tauri 2.8.5` / `2.6.0` release notes；插件版本 autostart `2.5.1`、store `2.4.5`、updater `2.12.0`）
- **平台前提**：本项目**只发 macOS + Windows**（`electron-builder.yml` 无 linux 段），因此 Linux/Wayland 的限制对本项目**不是阻塞项**，但仍在表中标注。

---

## 总表

| # | 能力（本项目用法） | Tauri 2.x 对等 | 成熟度 | 缺口 / 风险 |
|---|---|---|---|---|
| 1 | 无边框窗口 | `WindowBuilder::decorations(false)` / `core:window` | ✅ 完全对等 | 无 |
| 2 | 透明窗口 | `transparent: true` | ⚠️ **有条件** | **macOS 必须开 `macosPrivateApi`**（官方原文：*"Using private APIs on macOS prevents your application from being accepted to the App Store"*）。本项目**不在 App Store**（只 dmg+zip），所以**不阻塞**。已知 macOS 透明窗口 bug：#13415（打包后丢透明）、#8255（Sonoma 14 焦点切换后透明失效）。Windows 需 `noRedirectionBitmap` 防白闪 |
| 3 | 常驻置顶（**带 level 参数**） | `Window::set_always_on_top(bool)` | ⚠️ **降级** | Electron 的 `setAlwaysOnTop(on, 'floating')` 第二参（`floating`/`normal` 层级）**Tauri 无对应**。只能开/关置顶，**不能选「floating 但低于系统面板」这一层级**。⚠️ **未验证**：tao 是否暴露了 level；需实测置顶后是否被输入法/通知面板盖住 |
| 4 | 不进任务栏 | `skipTaskbar: true` | ✅ 对等 | 无 |
| 5 | 窗口阴影运行时开关 | `Window::set_shadow(bool)` | ⚠️ **有平台差异** | 官方文档：Windows `false` 对 decorated 窗口无效（阴影恒开）；`true` 会给 undecorated 窗口加 1px 白边 + Win11 圆角；**Linux Unsupported**。本项目靠 `hasShadow` 控制「收起态不露方框」（`overlay.ts:151,300`），Windows 上这条可能失效 |
| 6 | macOS 全工作区可见 | `set_visible_on_all_workspaces(bool)` | ⚠️ 部分 | 官方：Windows/iOS/Android Unsupported。本项目 `overlay.ts:171` 也只在 darwin 分支调用，**等价** |
| 7 | **鼠标穿透 + `forward:true`** | `set_ignore_cursor_events(ignore: bool)` | ❌ **签名缺参** | ⚠️ **Electron 是 `setIgnoreMouseEvents(ignore, {forward:true})`（2 参），Tauri 只有 `set_ignore_cursor_events(ignore: bool)`（1 参），无 `forward`。** 本项目 `overlay.ts:417` 明确依赖 `forward: true`（注释 416：「穿透时仍把 move 事件转给本窗口，便于悬停判断与悬停反馈」）。**需要重新设计悬停反馈通路**（见下方专项） |
| 8 | **透明区点击穿透（按像素/命中框）** | **官方明确「不会实现」** | ❌ **无对等** | Tauri issue **#13070**（2025-03-25 提交，2025-07-09 closed）标题即「Transparent Window Support Click-Through」，维护者 FabianLars 回复：*"This won't be implemented"*，指向 #2090 / #6164。本项目 `overlay.ts:402-425` 的**光标轮询 + 命中框 + 切换 ignore** 正是官方推荐绕法 → **逻辑可 1:1 移植**，但底层换成了 Tauri 的 ignore 开关 |
| 9 | 拖拽窗口 | `Window::start_dragging()` 或继续主进程 `set_position` 追踪 | ⚠️ 需注意 | 本项目用「主进程 16ms 轮询 `screen.getCursorScreenPoint()` + `setPosition`」（`overlay.ts:315-353`），注释 307 说「CSS drag-region 会吞掉 click，不可用」。Tauri 有 `data-tauri-drag-region` 属性，但已知 bug **#11605**（窗口未聚焦时 drag region 失效）、**#10767**（拖拽引起焦点抖动 + 吞 mouseup）。**建议继续用主进程追踪**，移植成本低 |
| 10 | 托盘模板图标 | `TrayIconBuilder::icon_as_template(bool)`（macOS only） | ✅ 对等 | 无 |
| 11 | **托盘动态标题** | `TrayIcon::set_title(Option<S>)` | ⚠️ **行为需实测** | 官方 `TrayIconBuilder::title` 文档：**Linux**「无 icon 时不显示」；**Windows Unsupported**。本项目本来就只在 darwin 设标题（`tray.ts:168-171`），**平台对等**。⚠️ **未验证**：标题里的 ANSI 转义（`levels.ts:35-43`）在 Tauri/muda 的 macOS 实现下是否被解析 —— `levels.ts:24` 注释明确说判据是 **Electron 37 内部 `NSString+ANSI.mm` 的 switch**，Tauri 走 `NSStatusItem.button.title`，**极可能不解析 ANSI → 标题会露出 `\x1b[31m` 字面量**。**必须实测** |
| 12 | 托盘图标去重（防闪烁） | 应用层自行实现 | ✅ 可自实现 | `tray.ts:121` `appliedIconKey` 是纯 JS 逻辑，可原样搬到 Rust |
| 13 | 托盘多分辨率 + 位图叠点 | 应用层自行实现（`Image::from_bytes` / `from_rgba`） | ⚠️ 需重写 | `nativeImage.addRepresentation` / `toBitmap` / `paintBadge`（`tray.ts:105-163`）是 Electron API。Rust 侧可用 `image` crate 重写，但**去重语义与「走 2x 那份缩下来会糊」的经验（`tray.ts:116-117`）要手动保住** |
| 14 | **托盘左键 click vs 右键菜单分叉** | `set_show_menu_on_left_click(bool)` + `on_tray_icon_event` | ⚠️ **需实测等价性** | 本项目 `tray.ts:53-59` 的核心是「macOS 上**不能**用 `setContextMenu`，否则左键被菜单吃掉」，因此只用 `tray.on('right-click')` + `popUpContextMenu`。Tauri 的 `show_menu_on_left_click(false)` 是配置项，语义上对应，但**「macOS 右键弹菜单」是否有等价 API 未验证** |
| 15 | 原生右键菜单（皮肤 / 宠物） | `Menu` / `MenuItem` + `Window::popup_menu` | ⚠️ 部分 | `Window::popup_menu(&menu)` 存在（"Shows the specified menu as a context menu at the cursor position"）。但 `Menu::set_context_menu` 类的「窗���绑定菜单」在 macOS 上 `Window::set_menu` **Unsupported**（官方注：macOS 菜单是 app-wide）。⚠️ **未验证**：跨平台右键弹窗的一致性 |
| 16 | `bd-asset://` 自定义特权 scheme | `Builder::register_uri_scheme_protocol` / `register_asynchronous_uri_scheme_protocol` | ⚠️ **有语义差异** | API 存在且跨三平台（macOS `setURLSchemeHandler` / Windows `AddWebResourceRequestedFilter` / Linux `webkit-web-context-register-uri-scheme`）。⚠️ **两个坑**：① 官方 Warning：自定义协议页面的 **Origin 各平台不同**（macOS/Linux `<scheme>://localhost/`，Windows/Android `http://<scheme>.localhost/`）—— 本项目渲染层 CSP 有 `connect-src 'self' data: blob: bd-asset:`（`index.html`），迁到 Windows 会**需要改 CSP**；② Electron 的 `registerSchemesAsPrivileged({standard, secure, supportFetchAPI, corsEnabled})` 在 Tauri **没有等价的前置特权声明**，标准性要靠协议 handler 本身保证 |
| 17 | `net.fetch('file://...')` | `std::fs::read` + `http::Response` | ✅ 可替代 | `human-assets.ts:65` 换成直接读文件即可 |
| 18 | macOS 开机自启（**手写 LaunchAgent plist**） | `tauri-plugin-autostart`（`MacosLauncher::LaunchAgent`） | ✅ **比现状更对等** | 官方支持 windows/linux/macos/android/ios 全平台。本项目**手写 plist**（`autostart.ts:44-63`）正是因为 Electron API 在 macOS 12 失效（注释 11-17）。Tauri 插件正是 LaunchAgent 方案 → **可直接删掉 128 行手写代码**。⚠️ 需验证 `BALANCEDECK_AUTOSTART_DIR` 那套测试隔离（`autostart.ts:31`）如何替代 |
| 19 | Windows LoginItem | 同上（autostart 插件） | ✅ 对等 | |
| 20 | **`safeStorage` 加密（Keychain / DPAPI）** | ❌ **无官方对等** | ❌ **缺口** | Tauri **没有 `safeStorage`**。官方插件 `stronghold` **已被标记弃用**（维护者原话：*"stronghold is no longer recommended and will be deprecated and therefore removed in v3"*，见 tauri-apps discussion #7846）。可选第三方：`keyring` crate（macOS Keychain / Windows Credential Manager）、`tauri-plugin-keyring-store`。⚠️ **未验证**：这些 crate 与本项目「单个 secrets.bin 文件 + `items`/`extras` 双 map + 内存缓存」的格式兼容性 —— keyring 是**按 key 取值**而非整文件读写，**落盘格式必然要改**（`store.ts:24-28`） |
| 21 | 内嵌 OAuth 窗口（**独立持久分区**） | `WebviewWindowBuilder` + `cookies_for_url` | ⚠️ **严重风险** | 见下方专项 §A |
| 22 | **OAuth 弹窗（`setWindowOpenHandler` 放行）** | `WebviewWindowBuilder::on_new_window` | ❌ **有已知回归 bug** | Tauri issue **#14263**（2025-10-08，**open**，label `type: bug` / `status: needs triage`）：**「Pop-up window creation is blocked in webviews no matter what permissions are set」**，直接点名 *"it blocks many authentication flows (Google, Apple)"*。维护者回复：该能力被 **PR #13876 / wry #1601** 改成「总是注册 newWindowRequested 监听器 → 默认不允许创建窗口」，**且只暴露在 Rust 侧，不在 JS API**。报告者称 **Tauri 2.2.0 之后（含 2.6.0、2.8.5）都坏**，必须降到 2.2.0。本项目 `opencode-auth.ts:241-246` 正是靠弹窗支持 GitHub/Google OAuth |
| 23 | 读分区 cookie（含 HttpOnly） | `Webview::cookies_for_url(url)` | ⚠️ **有已知坑** | API 存在（含 HTTP-only 与 secure）。⚠️ 官方 Known issues：**Windows 上在同步 command / event handler 里调用会死锁**，必须用 `async` command + 独立线程。⚠️ 只返回 `http`/`https` scheme 的 cookie（对本项目 OK，opencode.ai 是 https） |
| 24 | 网络可达性 `net.isOnline()` | `tauri-plugin-os` / `network` crate | ⚠️ 需替换 | Electron 的 `net.isOnline()`（macOS 走 SCNetworkReachability）**无直接对等** |
| 25 | 自定义协议右键菜单 `Menu.buildFromTemplate` | `Menu` / `MenuItem` | ⚠️ 部分 | 同 #15 |
| 26 | 系统通知（macOS 通知中心 / Windows Toast） | `tauri-plugin-notification` | ✅ 对等 | 本项目 `Notification.isSupported()` 1 处 + `app.setAppUserModelId`（`index.ts:127`）。Windows Toast 的 AppUserModelId 需在 `tauri.conf.json` 配 |
| 27 | 定时采集 | 应用层 `tokio` timer | ✅ 对等 | `scheduler.ts` 的逻辑是纯 TS，重写机械 |
| 28 | **`node:sqlite`** | `rusqlite` / `sqlx` | ⚠️ 换 crate | `opencode.ts:122,342` `new DatabaseSync(path,{readOnly:true})`。⚠️ **额外风险**：要处理 opencode 自身 DB 的 WAL 并发锁（Rust 默认行为与 Node 不同） |
| 29 | `fs`/`path`/`os` | `std::fs`/`std::path`/`dirs` | ✅ 对等 | 26 处 import，机械替换 |
| 30 | three.js 3D（WebGL + FBX + PBR） | 复用系统 WebView | ⚠️ **引擎换了** | macOS 从 Chromium → **WKWebView**、Windows 从 Chromium → **WebView2**。三者都是 Chromium/WebKit 系，但 `pet3d/scene.ts:127-138` 的 `ACESFilmicToneMapping` + `RoomEnvironment` PMREM + `powerPreference:'low-power'` + `FBXLoader` 在 **WKWebView** 上表现**未验证**。⚠️ Tauri 官方自己警告：*"If your app has a WebGL rendering path, give it a non WebGL fallback on Linux"*（Linux 本项目不发，但 macOS WKWebView 同类风险） |
| 31 | `backgroundThrottling: false` | ❌ 无对应 | ⚠️ **需实测** | ⚠️ 本项目**必需项**（`overlay.ts:160-166` 注释：Chromium 对隐藏/非聚焦窗口的 `setTimeout` 做 intensive throttling，1 分钟以上定时器被降到最低频率 → **「到点播报」静默失效**）。Tauri 走系统 WebView，无此开关。⚠️ **未验证**：WKWebView/WebView2 对后台 `setTimeout` 的节流策略 |
| 32 | `sandbox: false` | ❌ 无对应（Tauri 默认就是能力式 ACL） | ✅ 更优 | Tauri 的 capability 模型默认比 Electron 的 `sandbox:false` 更严 |
| 33 | **Chromium command-line 开关** | ❌ 无对等 | ⚠️ **缺口** | `index.ts:72` `--autoplay-policy=no-user-gesture-required`（**必需项**，注释 51-72：播报发生在用户不在电脑前，autoplay 被拒后只是静默 rejection）；`:46-48` `--no-sandbox`/`--disable-gpu-sandbox`/`--enable-unsafe-swiftshader`。Tauri 无 `app.commandLine` 等价物。⚠️ **未验证**：`tauri.conf.json` 是否有 WebKit 侧等价配置；WKWebView 的 autoplay 策略与 Chromium 不同，可能需要用户手势或静音播放绕法 |
| 34 | `app.dock.hide()` | `ActivationPolicy::Accessory` | ✅ 对等 | macOS 菜单栏应用标准做法 |
| 35 | `app.exit(code)` / `app.quit()` | `app.exit()` / `app.run()` 返回码 | ✅ 对等 | CLI 依赖退出码（`index.ts:109-119`） |
| 36 | **`globalShortcut`** | `tauri-plugin-global-shortcut` | ✅ 插件存在 | ⚠️ **但本项目全仓 0 处使用**（grep `globalShortcut` 无结果）→ **不是迁移项**。仅记录：Linux/Wayland 下不支持（维护者确认） |
| 37 | Tauri 无对应 → `webPreferences.sandbox:false` / `nodeIntegration` | — | — | Tauri's capability/ACL 模型是替代品 |

---

## 专项 A：内嵌 OAuth 窗口（本项目最高风险）

本项目 `opencode-auth.ts` 依赖三件套，Tauri 侧**每一件都有问题**：

| Electron 用法 | Tauri 现状 | 风险等级 |
|---|---|---|
| `session.fromPartition('persist:opencode-auth')`（`:39,163,187`） | 无 partition 概念。Tauri 的 `cookies_for_url` 读的是**该 webview 所在运行时 cookie store** | 🔴 高 |
| `setWindowOpenHandler` 放行 OAuth 弹窗（`:241-246`） | `on_new_window` 存在但 **Tauri ≥2.2.0 回归失效**（#14263, open）；且只暴露在 Rust 侧 | 🔴 **最高** |
| 900ms 轮询 cookie（`:304`） | `cookies_for_url` 可用，但 **Windows 同步调用会死锁**，须改 async command + 独立线程 | 🟡 中 |

**额外的第三方风险（未验证但需记录）**：Tauri 官方 maintainer 在 discussion #5251 明确指出 **Google 禁止在非浏览器环境做 OAuth**，即使用 UA 伪装也会弹屏警告。本项目 opencode-auth 支持 Google/GitHub（`:242` 正则含 `accounts.google.com`）。

**规模对照**：`opencode-auth.ts` **311 行**，其中注释约 90 行（`:12-37` 是 2026-09-26 SPA 改版的适配记录，`:27-36` 三处必改点），实际代码 ~220 行。这不是「重写一遍」的量级，而是**「在三个都可能不 work 的原语上重新设计一遍」**的量级。

---

## 专项 B：`set_ignore_cursor_events` 缺 `forward` 参数的影响

本项目 `overlay.ts:402-425` 的完整机制：
1. 渲染层送入命中框（`setPetHitbox`）
2. 主进程 **90ms 轮询** `screen.getCursorScreenPoint()`
3. 命中 → `setIgnoreMouseEvents(false, {forward:true})`
4. 未命中 → `setIgnoreMouseEvents(true, {forward:true})` + `webContents.send('pet:cursor', over)`
5. `forward: true` 让**穿透态下仍能收到 move 事件**，用于悬停高亮（`overlay.ts:416` 注释）

**Tauri 侧缺 `forward` 的后果**：穿透态下窗口收不到 `mousemove`，悬停反馈（`pet:cursor` 事件 → 渲染层高亮）这条链要改由**主进程光标轮询结果**直接推（这也是 Tauri 社区方案 #13070 里 Xinyu-Li-123 给的做法：用 udev 采集设备级光标位置 → emit 给前端）。**主进程已经有 `tickCursorWatch` 与 `screen.getCursorScreenPoint` 的等价物**（Tauri 是 `Window::cursor_position()`），所以改造量集中在「悬停反馈的数据来源」，不是机制重写。

⚠️ **未验证**：Tauri `cursor_position()` 的坐标系（文档说「relative to the top-left hand corner of the desktop」，多显示器下 macOS 取主屏、Windows 也取主屏）vs 本项目 `overlay.ts:392` 注释强调的「Electron 的 getBounds/光标点与渲染层 CSS 像素同为 DIP，直接相减即可」。**macOS Retina 下 Tauri 返回 `PhysicalPosition<f64>`（物理像素），CSS 像素要除 scale_factor —— 移植时必然踩这个坑。**

---

## 能力对等小结（给决策用）

| 分类 | 数量 | 明细 |
|---|---|---|
| ✅ 完全对等 | ~14 | 无边框/置顶(布尔)/skipTaskbar/全工作区/模板图标/自启/通知/fs/path/定时/托盘去重/插件 globalShortcut(未用) |
| ⚠️ 有条件或需重设计 | ~13 | 透明窗口(macOS privateApi)/置顶层级/阴影/命中框穿透/拖拽/托盘标题 ANSI/托盘弹窗点阵/自定义 scheme Origin/`isOnline`/3D 引擎/cookie 死锁/autoplay 开关 |
| ❌ 无对等或已知 bug | **4** | **`safeStorage`（stronghold 已弃用）**、**OAuth 弹窗（#14263 open）**、**`set_ignore_cursor_events` 缺 forward**、**Chromium command-line 开关（autoplay-policy）** |

**结论**：11 项 Electron 能力中，**没有一个是「直接换个 API 就完事」的干净映射**；其中 4 项存在官方已知缺陷或无对等方案。

## External References（检索日期 2026-10-01）

- [Tauri App Size](https://v2.tauri.app/concept/size/) — 「minimal Tauri app can be less than 600KB」；`opt-level="s"`/`lto`/`strip` 配方
- [Tauri What is Tauri](https://v2.tauri.app/start) — 不捆绑浏览器引擎
- [`tauri::Window` docs.rs](https://docs.rs/tauri/latest/tauri/window/struct.Window.html) — `set_ignore_cursor_events`/`set_shadow`/`set_always_on_top`/`set_visible_on_all_workspaces`/`cursor_position` 全部签名与 Platform-specific 注记
- [`tauri::TrayIcon` docs.rs](https://docs.rs/tauri/latest/tauri/tray/struct.TrayIcon.html) — `set_icon`/`set_menu`/`set_show_menu_on_left_click`/`on_tray_icon_event`
- [`tauri::TrayIconBuilder` docs.rs](https://docs.rs/tauri/latest/tauri/tray/struct.TrayIconBuilder.html) — `title()` 的 Linux/Windows 注记、`icon_as_template()`（macOS only）
- [`tauri::Webview` docs.rs](https://docs.rs/tauri/latest/tauri/webview/struct.Webview.html) — `cookies_for_url`/`cookies`/`clear_all_browsing_data`，含 **Windows 死锁** Known issue
- [`tauri::Builder` docs.rs](https://docs.rs/tauri/latest/tauri/struct/Builder.html) — `register_uri_scheme_protocol` + **各平台 Origin 不同的 Warning**
- [Tauri Autostart plugin](https://v2.tauri.app/plugin/autostart/) — `MacosLauncher::LaunchAgent` 全平台支持
- [Tauri Stronghold plugin](https://v2.tauri.app/plugin/stronghold/) + [discussion #7846](https://github.com/orgs/tauri-apps/discussions/7846) — **stronghold 将于 v3 移除**
- [Tauri issue #14263](https://github.com/tauri-apps/tauri/issues/14263) — 弹窗被阻断，**open**，2.2.0+ 回归
- [Tauri issue #13070](https://github.com/tauri-apps/tauri/issues/13070) — 透明区点击穿透，**closed，明确不会实现**，附社区绕法代码
- [Tauri discussion #5251](https://github.com/orgs/tauri-apps/discussions/5251) — Google 禁止非浏览器环境 OAuth
- [Tauri Linux Graphics](https://v2.tauri.app/develop/debug/linux-graphics) — 官方建议 WebGL 路径要有非 WebGL 回落
- [Tauri Window Customization](https://v2.tauri.app/learn/window-customization) — `transparent` 的 macOS private-api 警告原文

## Caveats / Not Found

- **托盘标题 ANSI 是否被 Tauri 解析：未验证**。这是本项目托盘等级着色（P1-3 交付物）的关键路径，必须在 spike 里实机验证。验证方法：`tray.set_title("\x1b[31m50%\x1b[0m")`，看 macOS 菜单栏是显示彩色文字还是字面量。
- **`setAlwaysOnTop` 的 level 参数（floating）是否有 tao 层绕法：未验证**。验证方法：Tauri 窗口置顶后唤出输入法/通知中心，看是否被盖住。
- **`autoplay-policy` 在 Tauri 侧如何替代：未验证**。验证方法：WKWebView 下无用户手势 `<audio>.play()` 是否被拒。
- **macOS WKWebView 上 `ACESFilmicToneMapping` + `RoomEnvironment` PMREM 的渲染结果：未验证**。
- **`keyring` crate 能否承载 `secrets.bin` 的整文件格式：未验证**（判断上很可能不能，需改格式）。