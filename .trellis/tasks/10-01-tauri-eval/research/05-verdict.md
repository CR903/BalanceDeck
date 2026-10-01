# Tauri 迁移评估 · 最终评估报告

> **任务**: `.trellis/tasks/10-01-tauri-eval` —— 纯调研，产出可决策的评估文档
> **日期**: 2026-10-01
> **调研基线**: Electron 37.10.3 / React 18 + Vite 7 / three.js 0.177 / macOS 12+ & Windows 10+
> **信息源**: 本仓代码实读 + 本机实测 + Tauri 2.x 官方文档 / docs.rs / GitHub issue（检索日期 2026-10-01）

---

## TL;DR — 结论先行

### 建议：**不迁移**（维持 Electron）

不是因为 Tauri 不好，而是三条**本项目特有的事实**决定了投入产出比不成立：

1. **体积收益的大头与框架无关。** 安装包 478 MB 里 **221 MB 是 `resources/human-pets` 素材**。去掉 Electron 的 255 MB Chromium 只能省 53%，而**先治素材能省更多，且不用重写任何代码**。
2. **Tauri 在本项目最关键的两项能力上没有对等方案，且都有官方已知缺陷。**
   - `safeStorage` → **无官方对等**（Stronghold 已宣布 v3 移除）
   - 内嵌 OAuth 依赖的**弹窗** → issue **#14263 仍 open**，报告者称 Tauri 2.2.0 之后（含 2.8.5）都坏
3. **本项目的测试体系与 Electron 深度耦合，重建成本 ≈ 全部 UI 重写。** `--uitest` **2,500 行 / 167 条断言 / 259 处 `executeJavaScript`**，靠真实 Chromium DOM + 主进程 debug 通道 + **猴补 `Menu.buildFromTemplate`** 驱动。Tauri 在 macOS 走 WKWebView，**没有可靠的自动化方案**。

**成本：116–156 人日（单人 ≈ 6–8 个月）｜ 收益：体积 -53%（其中 87% 与框架无关）、内存 -58%~-75%（外推未验证）、启动 -0.6s（用户感知弱）**

---

## 一、能力对等表（摘要）

完整版见 [`01-capability-parity.md`](./01-capability-parity.md)。

### ❌ 阻塞级缺口（4 项）

| 能力 | 本项目用法 | Tauri 2.x | 状态 |
|---|---|---|---|
| **`safeStorage` 加密存储** | `keystore.ts:16-18` Keychain/DPAPI | **无官方对等**。Stronghold 已被维护者宣布 v3 移除；第三方 `keyring` crate 是「按 key 取值」，与本项目「整文件 `secrets.bin` + `items`/`extras` 双 map」模型不兼容 → **落盘格式必改 + 老用户凭据迁移** | tauri-apps discussion #7846 |
| **内嵌 OAuth 弹窗** | `opencode-auth.ts:241-246` `setWindowOpenHandler` 放行 GitHub/Google | `on_new_window` 存在但 **#14263 open**：2.2.0+ 回归失效，且只暴露在 Rust 侧 | tauri#14263 |
| **穿透 + `forward:true`** | `overlay.ts:417` `setIgnoreMouseEvents(ignore, {forward:true})` | `set_ignore_cursor_events(ignore: bool)` **少一个参数**。悬停反馈链要重设计 | 签名差异 |
| **autoplay 开关** | `index.ts:72` `--autoplay-policy=no-user-gesture-required`（**必需项**，注释 51-72） | 无 `app.commandLine` 等价物。WKWebView 的 autoplay 策略不同 | 未验证 |

### ⚠️ 有条件 / 需重设计（13 项，摘要）

透明窗口（macOS 需 `macosPrivateApi`，本项目不在 App Store 所以不阻塞，但有 #13415/#8255 已知 bug）｜置顶**缺 level 参数**（`floating` 层级）｜窗口阴影 Windows 行为不同 ｜透明区点击穿透**官方明确不会实现**（#13070，本项目的光标轮询绕法正好是官方推荐）｜拖拽（`data-tauri-drag-region` 有 #11605/#10767 bug，建议继续主进程追踪）｜**托盘标题 ANSI 解析未验证**（`levels.ts:24` 的判据是 Electron 内部 `NSString+ANSI.mm`）｜托盘图标位图叠点要重写 ｜托盘左/右键分叉等价性未验证 ｜自定义 scheme **各平台 Origin 不同**（CSP 要改）｜`net.isOnline` 无对等 ｜**three.js 从 Chromium 换到 WKWebView/WebView2**（`ACESFilmicToneMapping`+`RoomEnvironment` PMREM+FBX 未验证）｜`cookies_for_url` **Windows 同步调用死锁**｜`node:sqlite` → `rusqlite`

### ✅ 对等（14 项）

无边框 ｜置顶（布尔）｜skipTaskbar ｜全工作区可见 ｜模板图标 ｜开机自启（**且比现状更好**：可删掉 `autostart.ts` 128 行手写 plist，Tauri 插件正是 LaunchAgent）｜系统通知 ｜`fs`/`path`/`os` ｜定时器 ｜托盘去重逻辑 ｜three.js 代码本身（但引擎换）

> **11 项重点核实项里，没有一个是「换个 API 就完事」的干净映射。**

---

## 二、成本人日表（摘要）

完整版（含每块理由）见 [`02-cost-estimate.md`](./02-cost-estimate.md)。

| 块 | 内容 | 人日 |
|---|---|---|
| **A. Rust 后端重写** | | **70**（区间 70–100） |
| ├ A2 适配器 | `adapters/` **3,050 行**，9 种协议 + 出网，`opencode.ts` 单文件 828 行 | 22 |
| ├ A7 悬浮窗 | `overlay.ts` **467 行**，90ms 光标轮询 + 命中框 + 16ms 拖拽 + 热插拔 | 6 |
| ├ A9 内嵌 OAuth | `opencode-auth.ts` **311 行** —— ⚠️ 不是重写是**重新设计** | 8 |
| ├ A11 IPC/注册表 | `ipc.ts` 528 + `providers.ts` 469 + 其余 ~480；**44 个 command 逐条定 capability** | 7 |
| ├ A6 托盘 | `tray.ts` 233 + `tray-badge.ts` 130，位图叠点重写 | 5 |
| ├ A4 密钥存储 | 存储模型变更 + 老数据迁移 | 5 |
| ├ A1 采集调度 | `scheduler.ts` 230 + `shared/types.ts` 246 转 serde | 4 |
| ├ A3 sqlite | 换 `rusqlite` + WAL 并发锁 | 2 |
| ├ A13 autoplay | 全新工作项（不是移植） | 2 |
| └ 其他 | 皮肤/自启/asset/CLI/入口 | 13 |
| **B. 前端改动** | `window.api` 44 方法 → invoke；81 处调用点；3D 跨引擎回归；构建链 | **11.5**（9–18） |
| **C. 测试体系** | | **31.5** |
| ├ **C2 `--uitest` ⚠️** | **2,500 行 / 167 断言 / 259 处 `executeJavaScript`** → async 化 **12–15** | |
| ├ C1 18 套 node 套件 | 8,940 行；15 个模块零改动 ✅，但 **adapters 8 个模块重写（8）** + `test-structure` 作废重写（3） | 14 |
| └ C3 shots/ballshot/smoke | | 4.5 |
| **D. 构建分发** | bundler/资源/签名；**维持现状（不签名、无 updater、无 CI）** | **3**（全面补齐 +13） |
| **合计** | | **116 人日**（现实区间 **116–156**） |

**另加**：Rust ramp-up 5–8 人日（若团队零经验）｜#14263 若未修，A9 变「不可估」。

### 折算
- 116 人日 ÷ 5 天/周 = **23 周 ≈ 5.7 个月单人**
- 156 人日 ≈ **31 周 ≈ 7.8 个月单人**

### 三项最易被低估的成本
1. **C2 uitest（12–15 人日）** —— 执行模型与 Electron 深度耦合，**≈ 全部 UI 重写的工作量**
2. **A2 适配器（22 人日）** —— 3,050 行 × 9 协议，`opencode.ts` 828 行含 SPA 抓取/cookie 轮换
3. **A4 密钥存储（5 人日）** —— 不是换加密函数，是**存储模型变更 + 老用户迁移**

---

## 三、收益量化（摘要）

完整版见 [`03-benefit-metrics.md`](./03-benefit-metrics.md)。

### 本机实测基线（Physical footprint，非 RSS —— macOS RSS 会重复计共享页）

| 进程 | footprint |
|---|---|
| main/browser | 278.9 MB |
| GPU | 44.6 MB |
| network service | 10.4 MB |
| renderer（含 three.js WebGL） | 51.6 MB |
| **合计** | **385.5 MB** |

**启动实测**：冷启动到 renderer 就绪 **~1.25 s**（3 次：1.22 / 1.33 / 1.24）

### 收益表

| 维度 | 收益 | 确定性 |
|---|---|---|
| **安装包体积** | 478 MB → **~225 MB 未压缩（-253 MB, -53%）** | **高**（结构必然） |
| 体积（压缩后 dmg） | ⚠️ **远小于 53%**（Chromium 本身压缩率高） | 未验证 |
| **常驻内存** | 乐观 -58%~-75%（385 → 96~162 MB） | **低** —— 无法可靠外推，**需 1 人日 spike** |
| **启动时间** | ~-0.6 s | 高，但**用户感知价值低**（常驻后台应用） |
| 安全 | capability ACL 更严（对比本项目 `sandbox:false`） | 中 |
| **开发效率** | ❌ **变慢**（Rust 编译 + 异步 IPC + 调试跨边界） | **高** |

### ⚠️ 体积收益的关键归因

**478 MB 构成**：221 MB 素材 + 255 MB Chromium/Node + 2.2 MB 自有代码。

去掉 Chromium 只省 255 MB。**剩下 221 MB 是 `resources/human-pets`（24 fbx + 10 tga + 12 png），与框架完全无关。**

> **推论（本次评估最有行动价值的一条）**：若目标是减小安装包，**先治素材**（按需下载 / 首启拉取 / 只打包 1 个角色 / 转 glTF+KTX2 压缩）能省 -150 MB 级，**且一行 Rust 都不用写**。这比迁移到 Tauri 的收益更大、成本低两个数量级。

### 迁移的代价

- **安全模型**：正向是 capability ACL 默认全禁；⚠️ 但 Rust 内存安全**只保护后端**，渲染层 XSS 面与 Electron 同（本项目已有严格 CSP，两框架同等）
- **供应链**：新增 crates.io 生态（tauri/wry/tao/muda/reqwest/tokio/rusqlite/serde），**两套 CVE 要盯**
- **团队技能**：Rust ramp-up + 长期「后端迭代慢于前端」的结构性摩擦
- **可调试性**：目前 `npm test` / `npm run uitest` **纯 JS/Node 跑全套断言**；Rust 化后前端逻辑调试要跨 `cargo` 边界
- **框架风险**：本项目两个最关键的能力恰好踩在 **Stronghold 弃用** 与 **#14263 open** 上

---

## 四、竞品对照（摘要）

完整版见 [`04-competitors.md`](./04-competitors.md)。

| 项目 | 体积 | 内存 | 可信度 |
|---|---|---|---|
| **Fluxzy**（调试代理，2026-05 五个月复盘） | Win 190 → **55 MB（-71%）** | 「noticeably」，无数字 | ⭐⭐⭐ **第一手，最高** |
| Hoppscotch | 165 → 8 MB | -70% | ⭐⭐ 二手转述 |
| Hopp（6 窗口实测） | 8.6 MiB vs 244 MiB | 172 vs 409 MB（-58%） | ⭐⭐ 有利益相关 |

### Fluxzy 的结论对本项目不利

> "Fluxzy had a clean split between the Angular frontend, the Electron main process, and a .NET sidecar doing the real work. **That is the easy mode of an Electron-to-Tauri migration.** If your Electron app **has business logic in the main process**, or a frontend that leans on **Chromium-specific behavior**, **your story will be harder than mine**."

⚠️ **本项目同时踩中这两条**：
- 业务逻辑全在 main（**10,573 行**）
- 前端依赖 WebGL（`ACESFilmicToneMapping` + `RoomEnvironment` PMREM + FBX 骨骼）

Fluxzy 还记录了 3 个具体坑：**dialog 缺三按钮**、**自动更新不兼容**（不得不发中间版本，几个月后仍有用户卡在 v1）、**Windows 签名顺序冲突**（minisign vs Authenticode）。

### ⚠️ 最重要的负面信息：找不到同类先例

| 没找到 | 含义 |
|---|---|
| 菜单栏/托盘类应用的 Electron→Tauri 公开复盘 | 本项目是菜单栏应用 —— **最大证据空白** |
| 3D/WebGL 重应用的迁移案例 | 本项目 three.js 组合**无已知先例** |
| Wails 的可信对照 | 未有效检索到（搜索被污染） |

**找不到同类型的成功先例，本身就是一个信号。**

---

## 五、明确建议

### 🔴 建议：**不迁移**（维持 Electron）

**理由落到本项目具体事实上：**

| # | 事实 | 推论 |
|---|---|---|
| 1 | 478 MB 里 **221 MB 是素材**；Tauri 只省掉 255 MB 的 Chromium | **87% 的体积收益与框架无关**。先治素材：收益更大（-150 MB 级）、成本低两个数量级 |
| 2 | `--uitest` **2,500 行 / 167 断言 / 259 处 `executeJavaScript`**，含猴补 `Menu.buildFromTemplate` | Tauri 在 macOS 走 WKWebView，**无可靠自动化**。重建 **12–15 人日 ≈ 全部 UI 重写** |
| 3 | `safeStorage` **无官方对等**（Stronghold v3 移除）；OAuth 弹窗 **#14263 open** | 本项目两个最关键的能力都在 Tauri 的已知缺口上 |
| 4 | 内存 385.5 MB → 96~162 MB 是**外推**，本项目是「单窗口 + WebGL 3D」，无先例 | 收益**未经验证**。启动 -0.6s 对常驻后台应用**用户感知极低** |
| 5 | 无自动更新、无 CI、不在 App Store、mac 未签名 | Tauri 迁移带来的签名/公证/updater 成本**对本项目净增**，而当前都不需要 |
| 6 | Fluxzy 明说「业务逻辑在 main」是**难模式**；本项目 10,573 行主进程全是业务逻辑 | **难模式的迁移，且找不到同类成功先例** |

**成本 116–156 人日（6–8 个月单人）换一个「省 253 MB 未压缩体积 + 可能省 200 MB 内存 + 0.6 秒启动」，而其中省体积的 87% 本来就能用另一种方式拿到。**

---

### 🟡 次选：**部分迁移**（若将来确有体积/内存硬压力）

**只把「无 UI 语义、可独立验证」的块搬到 Rust，UI 留 Electron：**

| 搬 | 不搬 | 理由 |
|---|---|---|
| 采集调度 `scheduler.ts` | **托盘** | 托盘的 ANSI 标题/位图叠点/左右键分叉是本项目最精细的 UI 语义（`tray.ts` 233 行 + `levels.ts` 的 Electron 内部依赖），搬过去风险 > 收益 |
| 适配器 `adapters/` | **悬浮窗** `overlay.ts` | 467 行含命中框/拖拽/DIP 坐标系，全是窗口语义 |
| `usageStore` / `providers` 持久化 | **`--uitest` 全部** | 保住测试体系 = 保住迭代速度 |
| `opencode-details` 抓取 | **内嵌 OAuth** | 换 crate 边界，非移植 |

**代价**：**36–50 人日**，且**长期维护两套运行时/IPC/构建/调试**（持续成本，非一次性）。
**收益**：**内存几乎不变**（渲染层与主进程的 Node 开销还在，只是换了实现）。

⚠️ **坦率说**：部分迁移的收益/代价比很差。若真要走这条路，**唯一说得通的理由是「先把采集与存储挪出去，为将来可能的整体迁移铺路」** —— 那是**期权**，不是当下的收益。

---

### ✅ 现在应该做的（不迁移的前提下）

1. **先量素材**：`node scripts/fetch-human-pets.mjs` 拉的是 221 MB FBX+TGA。评估转 **glTF + KTX2/Basis 压缩**能省多少（`three` 的 `FBXLoader` → `GLTFLoader` 即可接）。这是**与框架无关的最大体积杠杆**。
2. **做 1 人日 Tauri spike**（若还想保留选项）：只实现「透明窗口 + three.js 加载 1 个 FBX + 转 rAF」，测 `vmmap` footprint。**拿到这个数字，内存收益才从「外推」变成「实测」。** 若 3D 在 WKWebView 上有视觉回归，选项直接关闭。
3. **补 `.github/workflows`**：本项目**当前完全没有 CI**，`test-structure.mjs:15` 自己都写了「谁要把它接进 CI，得先补退出码」。这比框架迁移更值得先做。
4. **记下 Tauri 的两个 blocker 状态**：定期看 tauri#14263（OAuth 弹窗）与 stronghold 弃用进度。**若两者都解决且体积压力真实存在，再重开此评估。**

---

## 六、需要验证的技术点（本文档所有「未验证」项）

| # | 待验证 | 怎么验证 | 阻断性 |
|---|---|---|---|
| 1 | **托盘标题 ANSI 是否被 Tauri 解析**（`levels.ts:24` 依赖 Electron 的 `NSString+ANSI.mm`） | spike 里 `tray.set_title("\x1b[31m50%\x1b[0m")`，看 macOS 菜单栏是彩色还是字面量 | 🔴 高 |
| 2 | **#14263 是否已修** | 跟踪 tauri#14263；或自己写最小复现（Tauri 2.8.5 + Google OAuth 弹窗） | 🔴 **最高** |
| 3 | **WKWebView 上 `ACESFilmicToneMapping` + `RoomEnvironment` PMREM + FBX 骨骼**是否正常 | spike 里渲染同一 FBX，与 Chromium 截图对比 | 🔴 高 |
| 4 | **WKWebView 的 autoplay 策略**（本项目播报链路的**必需项**，`index.ts:72`） | spike 里无用户手势 `<audio>.play()` | 🔴 高 |
| 5 | **内存收益真值**（385.5 MB → ?） | spike 跑 5 分钟后 `vmmap -summary` 取 Physical footprint | 🟡 中 |
| 6 | **置顶 level 参数**（`floating`）是否有绕法 | 置顶后唤出输入法/通知中心看是否被盖住 | 🟡 中 |
| 7 | **`startDragging` / `data-tauri-drag-region`** 在本项目拖拽场景的行为（已知 #11605/#10767） | 实机拖拽收起态小球 | 🟡 中 |
| 8 | **`keyring` crate 能否承载 `secrets.bin` 整文件格式** | 读 `store.ts:24-28` 判断；判断上**很可能不能** | 🟡 中 |
| 9 | **素材在 dmg 内的压缩率** | 实际打一个 dmg 看 | 🟢 低 |

---

## 七、文档索引

| 文件 | 内容 |
|---|---|
| [`00-baseline.md`](./00-baseline.md) | Electron 能力清单（逐项 `file:line`）、代码规模、Node 专属 API、QA 形态、打包构成 |
| [`01-capability-parity.md`](./01-capability-parity.md) | **完整能力对等表**（37 行）+ OAuth/穿透两个专项 + 成熟度分级 |
| [`02-cost-estimate.md`](./02-cost-estimate.md) | **完整成本人日表**（A/B/C/D 四块逐项理由）+ 三项最易低估项 |
| [`03-benefit-metrics.md`](./03-benefit-metrics.md) | **本机实测基线** + 体积/内存/启动收益 + 迁移代价 |
| [`04-competitors.md`](./04-competitors.md) | 5 个迁移案例 + Fluxzy 逐条踩坑 + **证据空白清单** |

---

## 附：调研过程中的事实修正

| 任务清单里的说法 | 实测 |
|---|---|
| `qa/*` 测试形态 | 仓库根 `qa/` **为空**；实现在 `src/main/qa/`（5 文件 3,255 行） |
| 「重点核实 `globalShortcut`」 | **全仓 0 处使用**（grep 无结果）→ 不是迁移项 |
| 依赖 `10-01-p1-5-resource` 的内存基线 | 该任务 `research/` **为空**（2026-10-01 检查）→ 本任务自行实测 |