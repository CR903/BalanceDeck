# Research: ③ 收益量化（含本项目实测基线）

- **Query**: 安装包体积 / 常驻内存 / 启动时间的具体数字，以及迁移的代价
- **Scope**: mixed（本机实测 + 官方/第三方数据）
- **Date**: 2026-10-01

## 0. 实测基线（本机，2026-10-01，非引用）

> ⚠️ `10-01-p1-5-resource` 任务的 `research/` 目录当时为空，本节数据由本任务自行实测采集。
> 环境：macOS（Darwin），Electron 37.10.3，`node_modules/electron/dist`。
> 方法：直接启动 `Electron .`（非 `--smoke`，走完整产品路径：overlay + tray + scheduler），
> 稳定后用 `vmmap -summary` 取 **Physical footprint**（RSS 在 macOS 会重复计共享页，不可用）。

### 内存实测

| 进程 | Physical footprint | 峰值 |
|---|---|---|
| main / browser | **278.9 MB** | 306.6 MB |
| GPU process | 44.6 MB | 46.3 MB |
| network service (utility) | 10.4 MB | 11.4 MB |
| renderer（悬浮窗，含 three.js WebGL） | 51.6 MB | 56.5 MB |
| **合计（4 进程）** | **385.5 MB** | — |

对照：`ps` RSS 口径为 **568.3 MB**（明显高估，因共享页重复计数）。对外引用请用 **385 MB**。

**注意 278.9 MB 的 main 进程异常高** —— 一个 262 KB 的 `out/main/index.js` 常驻 279 MB 不正常。这与 Electron 37 + Node 的基线开销一致（第三方实测 Electron「Hello World」idle 168 MB，Tauri 42 MB；本项目因 Node 主进程 + electron-builder 打包的 Chromium 完整运行时而更高）。

### 启动实测

方法：直接跑 Electron 二进制 + `--smoke`，`SMOKE_WAIT_MS=1000`，总时长减去 1s settle ≈ 冷启动到 renderer 就绪。

| 次 | 推算冷启动 |
|---|---|
| 1 | 1.22 s |
| 2 | 1.33 s |
| 3 | 1.24 s |
| **中位数** | **~1.25 s** |

### 体积实测（`du -sh`）

| 组成 | 大小 |
|---|---|
| **resources/human-pets** | **221 MB** |
| node_modules/electron/dist/Electron.app | 255 MB |
| out/（自有 main+preload+renderer） | 2.2 MB |
| build/（图标） | 320 KB |
| 自有代码 gzip 后（renderer js 343K + css 22K + main 69K） | ~434 KB |

---

## 1. 安装包体积

### 本项目的特殊性：素材压倒一切

| 场景 | 打包后估算 | 说明 |
|---|---|---|
| **现状（Electron）** | **~478 MB 未压缩** | dmg 内含 255 MB Chromium+Node + 221 MB 素材 + 2.2 MB 自有代码 |
| **迁 Tauri（理论下界）** | **~225 MB 未压缩** | 省掉 255 MB 的 Chromium+Node，剩 221 MB 素材 + ~4 MB（Rust 二进制 + 前端） |
| **省下的绝对值** | **~253 MB** | |
| **省下的比例** | **~53%** | |

⚠️ **但压缩后的 dmg 比例会小得多**：221 MB 素材里 24 个 `.fbx` + 10 个 `.tga` 是**已压缩/已压缩格式**（FBX 内嵌压缩纹理，TGA 部分未压缩），gzip/dmg 收益有限。**Electron 的 Chromium 二进制本身压缩率较高**。

**实测 gzip 参照**：自有 JS/CSS 压缩比约 4–5×。素材压缩比未测。

**⚠️ 结论口径**：「安装包从 478 MB 降到 225 MB，**省 53%**」成立，但**「省 400 MB」是错的**（那是把 Electron 基线当成本项目特有）。

**更重要的观察**：**221 MB 素材是本项目体积的真正大头，与 Electron/Tauri 无关**。若未来要减体积，先问「素材要不要全量打进包」（按需下载 / 首启拉取 / 只打包 1 个角色）—— 那是一次**与框架无关**的优化，收益（-150 MB 级）**大于迁移到 Tauri**。

### 官方与第三方数据（用于对照）

| 来源 | 数据 | 检索日期 |
|---|---|---|
| Tauri 官网 [App Size](https://v2.tauri.app/concept/size/) / [What is Tauri](https://v2.tauri.app/start) | 「minimal Tauri app can be less than **600KB**」 | 2026-10-01 |
| Fluxzy（真实迁移） | Windows installer **190 MB → 55 MB**（-71%） | 2026-10-01 |
| Hoppscotch | 165 MB → **8 MB**，内存 -70% | 2026-10-01 |
| tech-insider 综述 | Hello World：Tauri **3.2 MB** vs Electron **85 MB**（-96%）；启动 380ms vs 1420ms；idle 42MB vs 168MB | 2026-10-01 |
| deepwiki（Wikipedia 交叉） | 「~2-10 MB (minimal) vs ~100-200 MB」 | 2026-10-01 |

⚠️ 上表除 Fluxzy 外多为**二手汇总/营销数据**。本项目素材占比极高，套用「-96%」是误导。

---

## 2. 常驻内存

| 口径 | Electron 实测 | Tauri 预估 | 省 |
|---|---|---|---|
| **本项目** | **385.5 MB**（Physical footprint，4 进程） | ⚠️ **无法可靠预估** | — |

**为什么无法预估**：
1. Tauri 在 macOS 用 **WKWebView**，而 WKWebView 的内存由系统 `com.apple.WebKit.WebContent` 进程承载，**这部分是共享的**，不同应用间会互相影响 —— 第三方实测 6 窗口场景 Tauri 172 MB vs Electron 409 MB（`-58%`）
2. 本项目的 renderer 跑 **three.js WebGL + FBX 骨骼 + PMREM 环境光照**，这部分在 WKWebView 上的内存曲线**未验证**
3. `10-01-p1-5-resource` 的实测调研未完成，无项目自有基线可比

**可用的外部区间**：
- idle（无 3D）：第三方实测 Tauri 42 MB vs Electron 168 MB → **-75%**
- 6 窗口复杂应用：Tauri 172 MB vs Electron 409 MB → **-58%**
- Fluxzy：macOS/Linux「dropped noticeably」，无具体数字
- 反例：Tauri issue #5889「Tauri might consume more RAM than Electron」（Linux）

**对本项目的合理预期**：若按 -58% ~ -75% 外推 → **385 MB → 96 ~ 162 MB**。**但这个外推对本项目特别不可靠**，因为：
- 本项目是 **单窗口常驻 + WebGL 3D**，不是 idle 空应用，WKWebView 的 WebGL 上下文开销未知
- 素材有 221 MB 在磁盘上（不在内存），但 FBX 解压后的顶点/纹理数据**未测量**

⚠️ **建议的验证方法**（比外推可靠）：做一个 **1 人日的 Tauri spike**，只实现「透明窗口 + three.js 加载一个人物 FBX + 转 rAF」，在同一台机器上跑 5 分钟后取 `vmmap` footprint。这个数字出来，③ 的收益判断才成立。**在拿到这个数字之前，任何内存收益都是猜的。**

---

## 3. 启动时间

| 口径 | Electron 实测 | Tauri |
|---|---|---|
| **本项目冷启动（到 renderer 就绪）** | **~1.25 s** | ⚠️ 未测 |
| 第三方 Hello World | 1,420 ms | 380 ms（-73%） |
| Fluxzy | 「dramatically better」，无干净 benchmark | |

**本项目的 1.25 s 其实已经很快** —— 因为 Electron 37 的启动优化 + 窗口极小（384×600）+ 素材走 `bd-asset://` 流式加载。

**预期收益**：即便 Tauri 快 50%，绝对收益是 **~0.6 s**。对一个**常驻后台、用户几乎不主动启动**的应用，**启动时间的用户感知价值极低**。

⚠️ 反向成本：Rust release 构建首次 `cargo build` 需数分钟，**开发者日常迭代体验会变差**。

---

## 4. 迁移的代价（不可忽略）

| 代价 | 具体内容 |
|---|---|
| **安全模型变化** | 正向：Tauri capability/ACL 默认全禁（对比本项目 `overlay.ts:159` 用了 `sandbox: false`）。反向：**Rust 的内存安全只保护后端** —— 本项目的 `src/renderer` 仍是同源 Web 代码，Tauri 的隔离模型下渲染层的 XSS 面**不比 Electron 小**（本项目已有严格 CSP，`index.html` `script-src 'self'`，这一层两框架同等） |
| **供应链面扩大** | 现有依赖：electron / electron-builder / vite / react / three（**JS 生态**）。迁移后新增：`tauri` / `wry` / `tao` / `tao`/`muda` / `reqwest`/`tokio` / `rusqlite` / `serde` + 插件 —— **Rust crates.io 生态**。两套供应链要各自盯 CVE |
| **团队技能** | 需要能写 Rust 的人。估算已含 5–8 人日 ramp-up，但**长期**的「遇到 Rust 编译错误/生命周期问题」是持续的税。本仓库 400 KB 渲染层 + 10.5K 行主进程 TS，若未来加功能，**TS 部分快、验证快；Rust 部分慢** —— 会形成「前端迭代快、后端迭代慢」的结构性摩擦 |
| **两个运行时** | 若走**部分迁移**，则长期同时维护 Electron + Rust 两套工具链、两条 IPC 通路、两套构建分发、两套调试方式。对单人项目这是**持续的认知负担**，不是一次性成本 |
| **可调试性下降** | 本项目 `npm run smoke` / `npm run uitest` 目前**纯 JS/Node 就能跑全套断言**（`load-ts.mjs` + `qa/`）。Rust 化后前端逻辑的调试要跨 `cargo` 边界，`uitest` 要重写成 async eval（见 `02-cost-estimate.md` §C2） |
| **框架风险** | `stronghold`（官方安全存储）**已宣布 v3 移除**；`#14263`（OAuth 弹窗）**open**。本项目两个最关键的能力正好踩在这两处 —— **Tauri 在本项目所需的能力上，成熟度低于其文档给人的印象** |

---

## 5. 收益-成本汇总

| 维度 | 收益 | 确定性 |
|---|---|---|
| 安装包体积 | -253 MB 未压缩（-53%） | **高**（结构上必然） |
| 安装包体积（压缩后） | ⚠️ 远小于 53%（Chromium 本身压缩率高） | **未验证** |
| 常驻内存 | 乐观 -58%~-75%（385 MB → 96~162 MB） | **低**（无可靠外推，需 spike） |
| 启动时间 | ~-0.6 s | **高**（但用户感知价值低） |
| 安全 | capability ACL 更严 | **中** |
| 开发效率 | ❌ 变慢（Rust 编译 + 异步 IPC + 调试跨边界） | **高** |
| **一次性成本** | **116–156 人日** | 中 |

**关键判断**：体积收益（-253 MB）是**结构性的、必然的**，但**其中 221 MB 是素材造成的、与框架无关**。内存与启动收益**用户感知弱**（常驻后台应用），而**成本是 116–156 人日 ≈ 6 个月**。

## External References

- [Tauri App Size](https://v2.tauri.app/concept/size/)（官方，2026-10-01 检索）
- [Fluxzy: Five months after switching from Electron to Tauri](https://www.fluxzy.io/resources/blogs/electron-to-tauri-migration-fluxzy-desktop)（2026-05-09 发布，2026-10-01 检索）—— 唯一找到的**第一手真实迁移复盘**，数据可信度最高
- [Tauri vs Electron: performance, bundle size...](https://www.gethopp.app/blog/tauri-vs-electron)（Hopp 官方，6 窗口实测）
- [Tauri might consume more RAM than Electron #5889](https://github.com/tauri-apps/tauri/issues/5889)（反例）
- [Tauri Linux Graphics](https://v2.tauri.app/develop/debug/linux-graphics)（官方 WebGL 回落建议）

## Caveats

- 内存/启动的 Electron 数字是**本机实测**；Tauri 数字**全部是外推或第三方**，不可当作本项目的承诺。
- 打包体积是 `du` 原始大小之和，**未实测真实 dmg/nsis 安装包**。
- 未测素材（FBX/TGA）在 dmg 内的压缩率。
- 若 `10-01-p1-5-resource` 后续完成并给出不同的内存基线，**以那份为准**，本文件需更新。