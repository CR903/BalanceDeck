# Research: ④ 竞品对照（谁迁了，迁完拿到什么）

- **Query**: 有哪些产品从 Electron 迁到 Tauri / Wails / 原生？迁移后收益的具体数字？
- **Scope**: external
- **Date**: 2026-10-01

## 已确认的真实迁移案例

### 1. Fluxzy（HTTPS 调试代理，Fiddler/Charles 同类）—— **最相关的对照**

| 项 | 内容 |
|---|---|
| 背景 | 2023-02 Electron 发版；2025-12 v2 迁 Tauri；复盘发布 2026-05-09（**五个月后**） |
| 架构 | Angular 前端（保留）+ Electron main（换 Rust）+ **.NET sidecar 引擎（保留）** |
| **体积收益** | Windows installer **190 MB → 55 MB（-71%）** |
| 内存收益 | macOS / Linux「dropped noticeably」（无具体数字），原因：改用 WKWebView / WebKitGTK 而非自带 Chromium |
| 启动收益 | 「dramatically better」，**明确拒绝给 benchmark**：「I don't have a clean benchmark to drop here so I won't pretend I do」 |
| 视觉回归 | 「I expected visual regressions going from Chromium to three different webviews. Got **essentially none**」（因为 Angular 构建管线已处理 polyfill/前缀） |

**Fluxzy 明确记录的痛点**（对本项目有直接参考价值）：

| 痛点 | 内容 |
|---|---|
| **IPC 迁移** | 「wasn't a nightmare，**because the Electron version already had a clean split between renderer and main**」。⚠️ 原文警告：*"If your Electron app has business logic smeared into the renderer, this part will hurt."* |
| **对话框能力缺口** | Tauri dialog 只有 Yes/No、Ok/Cancel，**没有 Yes/No/Cancel**。Fluxzy 自己引 `rfd` crate 包了 20 行 Rust |
| **自动更新不兼容** | ⚠️ **咬得最狠的一条**：「The pain isn't writing this. The pain is that v1 users on Electron's autoUpdater will **never see it**」。不得不**额外发一个中间版本**通知用户手动下载，且「Months later I still have users sitting on v1」 |
| **Windows 签名顺序冲突** | Tauri updater 的 minisign 签名 → Authenticode 改写二进制 → minisign 失效 → updater 静默拒绝所有更新。必须「先 Authenticode，再 `tauri signer` 重签」，官方文档没写这个组合 |
| **Wayland** | WebKitGTK 在 Nvidia/Wayland 有问题；需在 `Builder::default()` **之前**设 5 个环境变量（`GTK_THEME`/`ADW_DISABLE_PORTAL`/`UBUNTU_MENUPROXY`/`GTK_MODULES`/`APPMENU_DISPLAY_BOTH`），否则会出现「2014 风格的 Adwaita 标题栏 + 幽灵 Ubuntu 菜单」 |
| **自托管 CI 漂移** | Windows runner 因 `rustup` 默认 host 漂到 GNU triple → `dlltool.exe not found`。GitHub 托管 runner 不会出现，自托管会 |

**Fluxzy 的总结原话**（决定性）：
> "Fluxzy had a clean split between the Angular frontend, the Electron main process, and a .NET sidecar doing the real work. **That is the easy mode of an Electron-to-Tauri migration.** If your Electron app **has business logic in the main process**, or a frontend that leans on Chromium-specific behavior, **your story will be harder than mine**."

⚠️ **本项目同时踩中这两条**：
- 「business logic in the main process」→ 本项目主进程 10,573 行（其中 adapters 3,050 行、scheduler 230 行、providers 469 行）**全是业务逻辑**
- 「frontend that leans on Chromium-specific behavior」→ 本项目 three.js WebGL + `RoomEnvironment` PMREM + `powerPreference:'low-power'` + FBX 骨骼 + 严格 CSP 下的 `bd-asset://`

### 2. Hoppscotch（前 Postwoman，API 开发平台）

| 项 | 内容 |
|---|---|
| 体积 | **165 MB → 8 MB** |
| 内存 | **-70%** |
| 动机 | 官方称「Tauri 的安全模型 + Rust 后端性能」 |

⚠️ 数据经 tech-insider.org 转述，**未见 Hoppscotch 一手原文**，可信度中等。

### 3. Hopp（远程结对编程，`gethopp.app` 官方博客）

6 窗口对比实测：

| 指标 | Tauri | Electron |
|---|---|---|
| Bundle | **8.6 MiB** | 244 MiB |
| 内存（开 6 窗口后） | **~172 MB** | ~409 MB（-58%） |

Hopp 归因：① Electron main 的 Node runtime；② macOS 上 Electron 的 Chromium renderer 进程内存约为 Tauri WKWebView 的 **2 倍**。
⚠️ **有利益相关**（Hopp 是 Tauri 用户），但数字来自自己的 benchmark。

### 4. UMLBoard（白板，Electron → Tauri 记录）

| 项 | 内容 |
|---|---|
| 结论 | 「a compromise：platform-independence 的代价是比原生更大的二进制与更高的内存」 |
| 反例数字 | macOS universal 包 **250 MB** —— **一个轻量绘图工具** |
| 有用信息 | Electron → Tauri 的 IPC 迁移是 Part 1 级别的独立议题 |

⚠️ 250 MB 的 universal（x86_64 + arm64 双架构）说明 **macOS universal 包会翻倍** —— 本项目只发 dmg（当前未配 universal），若将来加 universal，Tauri 的体积优势会被削弱一半。

### 5. 未找到的对照（重要的负面信息）

| 没找到 | 说明 |
|---|---|
| **菜单栏/托盘类应用从 Electron 迁 Tauri 的公开复盘** | 搜到一篇《Tauri vs Electron for Tray Apps》，但内容是泛论 + 营销（称 Electron「500 MB RAM 起步」、Tauri「8 MB 体积、峰值 150-200 MB」），**无可信数据，且「8MB」与它自己说的「150-200MB 内存」自相矛盾**。⚠️ **本项目是菜单栏应用，这是最大的证据空白** |
| **3D / WebGL 重应用从 Electron 迁 Tauri 的案例** | 未找到。本项目的 three.js + FBX + PMREM 组合**没有已知先例** |
| **有活跃 Electron 托盘 + 3D + OAuth 项目的迁移复盘** | 未找到 |
| **Wails 的对照案例** | 搜索结果被无关内容污染，未找到有说服力的迁移复盘 |

---

## 对照本项目的关键判断

| 维度 | Fluxzy（成功案例） | BalanceDeck（本项目） | 差距 |
|---|---|---|---|
| 业务逻辑位置 | 在 .NET sidecar，main 只是胶水 | **全在 Electron main（10,573 行）** | ⚠️ 最难的那种 |
| 前端引擎依赖 | Angular 保守，**零视觉回归** | **three.js WebGL + FBX + PMREM**（WebKit 未验证） | ⚠️ 未验证路径 |
| 自动更新 | 有，且被不兼容咬到 | **无**（grep 0 处） | ✅ **本项目无此成本** |
| UI 测试 | 未提及 | **167 条断言 / 2,500 行 uitest** | ⚠️ 本项目独有成本 |
| 自定义 scheme | 未提及 | `bd-asset://`（221 MB 素材） | ⚠️ 本项目独有 |
| 内嵌 OAuth | 未提及 | **311 行，依赖弹窗（#14263 open）** | ⚠️ 本项目独有且有已知 bug |
| 内置凭据存储 | 未提及 | `safeStorage`（Tauri **无对等**，stronghold 已弃用） | ⚠️ 本项目独有且有已知缺口 |
| 签名 | Authenticode + minisign 顺序坑 | **当前不签名** | ✅ 本项目可跳过 |

**综合**：Fluxzy 是**最好情况**（easy mode），而本项目同时具备「业务逻辑在 main」「前端依赖 WebGL」「大量 UI 测试」三个让迁移变难的特征。**找不到同类型的成功先例，本身就是一个信号。**

## External References（2026-10-01 检索）

- [Fluxzy: Five months after switching from Electron to Tauri](https://www.fluxzy.io/resources/blogs/electron-to-tauri-migration-fluxzy-desktop) — 第一手复盘，2026-05-09，**可信度最高**
- [Hopp: Tauri vs Electron: performance, bundle size, and the real trade-offs](https://www.gethopp.app/blog/tauri-vs-electron) — 6 窗口实测，有利益相关
- [tech-insider.org: Tauri vs Electron [2026]](https://tech-insider.org/tauri-vs-electron-2026) — Hoppscotch 数据转述，二手
- [UMLBoard: Moving from Electron to Tauri](https://www.umlboard.com/blog/moving-from-electron-to-tauri-1) — universal 包 250 MB 反例
- [betterprogramming.pub: Tauri vs. Electron for Tray Apps](https://betterprogramming.pub/tauri-vs-electron-for-tray-apps-ed15974f35ce) — ⚠️ **数据自相矛盾，仅作「托盘类迁移复盘缺失」的证据**

## Caveats

- 未找到「托盘 + 3D + 内嵌 OAuth」类型的 Electron→Tauri 迁移案例。**这是本评估最大的证据空白**，也是为什么 §⑤ 的建议偏向保守。
- Hoppscotch 数据为二手转述，未找到一手来源。
- Wails 未做有效对照（搜索被污染），若要考虑 Wails 应单独调研 —— 但**从本项目需求看 Wails 更不匹配**（托盘/自定义 scheme/内嵌 OAuth 能力更弱），未展开。