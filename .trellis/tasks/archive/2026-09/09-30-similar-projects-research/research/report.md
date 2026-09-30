# BalanceDeck 竞品调研报告：相似项目对比与优化方案

> 调研日期：2026-09-30
> 调研方式：`sn-search-code`（GitHub 搜索）× 多组关键词 + GitHub API 元数据核验 + 网页搜索交叉验证
> 调研目标：找出与 BalanceDeck（macOS/Windows 桌面 AI 用量与余额仪表盘）功能相似的开源项目，逐项对比，输出可执行的优化方案

---

## 1. 调研概述

BalanceDeck 的定位是：**常驻桌面的 AI 用量与余额仪表盘** —— 聚合 Coding Plan 额度（OpenCode Go / Claude Code / Codex / GitHub Copilot）与 API 余额（DeepSeek / Kimi / 智谱 / 硅基流动 / 通义 / 火山方舟 / MiniMax），以**悬浮卡片 + 菜单栏 + 可收起 2D 圆环 / 3D 数字助理**的形态呈现，并强调**数据诚实**（official / cached / local 三级可信度）与**隐私优先**。

围绕这一形态，本次调研覆盖了 4 大类共 **23 个**相似项目：

| 类别 | 代表项目 |
|---|---|
| A. 菜单栏 / 系统托盘配额监控 | CodexBar、ClaudeBar、codenotch、Claude-Code-Usage-Monitor(CodeZeno)、Claude-God、claude-battery、oh-myusage、CostBar |
| B. 本地用量 / 成本仪表盘 | claude-usage(phuryn)、TokenTracker、token-monitor、sniffly、Claude-Code-Usage-Monitor(Maciek)、dsh-cost-meter、tokentap |
| C. Coding Plan 额度查询器（插件 / 移动端 / 桌面） | opencode-quota、CodingPlanQuota、AI_Usage_Dashboard、cc-router、quota-viewer、QuotaPanel |
| D. 桌面宠物 / 数字助理 | TermiPet、petto |

---

## 2. 竞品全景

### A. 菜单栏 / 系统托盘配额监控（与 BalanceDeck「菜单栏 / 托盘」形态最接近）

| 项目 | Star | 平台 / 技术栈 | 核心能力 |
|---|---|---|---|
| [CodexBar](https://github.com/steipete/CodexBar) | 22.1k | macOS 14+（Swift）；Linux Qt 6；Omarchy widget | 菜单栏展示 **87 家** AI 编程服务商限额；每家一个状态项或 Merge Icons 切换；5h/周/月窗口 + **重置倒计时**；Credits、Admin spend、billing 汇总；本地成本扫描；供应商状态徽章；动态菜单栏图标；无需登录态（复用 OAuth/device flow/API key/cookie/本地文件） |
| [ClaudeBar](https://github.com/tddworks/ClaudeBar) | 1.5k | macOS 15+（Swift 6.2） | 菜单栏监控 **15+ 家**（Claude / Codex / Gemini / Copilot / Cursor / Bedrock / Kiro / Kimi / DeepSeek / Mistral / MiniMax / Alibaba / Z.ai / Amp Code / OpenCode Go / …）；重置倒计时；**用完前系统通知**；Homebrew 安装 |
| [codenotch](https://github.com/vinzdg/codenotch) | 2.6k | macOS（Swift）+ Windows（Rust/Tauri 2） | 屏幕边缘「黑条」钉住各家限额消耗；环形 hover 显示窗口与重置时间；**会话状态**（working/done/waiting）；**手机 App（iOS/Android）局域网联动**；多显示器 |
| [Claude-Code-Usage-Monitor](https://github.com/CodeZeno/Claude-Code-Usage-Monitor) | 546 | Windows 10/11（Rust） | Windows 任务栏小部件；Claude Code / Codex / Antigravity / OpenCode Go / Cursor / Grok Build；**多账户**；主题 Studio；winget 安装；开机自启；多显示器 |
| [Claude-God](https://github.com/Lcharvol/Claude-God) | 86 | macOS 13+（Swift） | 菜单栏 + **桌面 widget**；配额进度条 + 动态图标变色；**burn rate 预测**；成本分析 / ROI / 项目拆分 / sparkline / 每日预算 / CSV 导出；**扩展插件系统** |
| [claude-battery](https://github.com/Reebz/claude-battery) | 37 | macOS（C#） | 菜单栏「电池」式剩余量可视化；Claude 周配额 |
| [oh-myusage](https://github.com/Four-JJJJ/oh-myusage) | 188 | macOS（Swift） | 菜单栏统一订阅额度、第三方中转余额、本地 Codex 账号状态与异常诊断 |
| [CostBar](https://github.com/LB21321610/CostBar) | 1 | macOS（Swift） | **悬浮窗 + 菜单栏**实时刷新 AI API 余额 |

### B. 本地用量 / 成本仪表盘（与 BalanceDeck「详情页 / 每模型用量」形态接近）

| 项目 | Star | 平台 / 技术栈 | 核心能力 |
|---|---|---|---|
| [claude-usage](https://github.com/phuryn/claude-usage) | 2.2k | 本地 Web（Python） | Claude Code token 用量 / 成本 / 会话历史本地仪表盘；Pro/Max 进度条 |
| [TokenTracker](https://github.com/xiufengsun/TokenTracker) | 1.9k | CLI（npm，macOS/Linux/Windows）+ macOS 菜单栏 App + Windows 托盘 App（JS） | 追踪 **42 款** AI 编码工具 token 与成本；**4 个原生桌面 widget**（用量 / 热力图 / 模型 / 限额）；**桌面宠物**；成就系统；本地优先，不读 prompt |
| [token-monitor](https://github.com/Javis603/token-monitor) | 2.5k | 桌面小部件（JS，macOS/Windows/Linux） | **43+** 工具 token 用量 / 成本 / 限额；**多设备同步**；历史使用分析 |
| [sniffly](https://github.com/chiphuyen/sniffly) | 1.3k | 本地 Web（Python） | Claude Code 用量统计、错误分析、可分享报告 |
| [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) | 8.7k | Python | Claude Code 实时用量监控 + **预测** + 警告 |
| [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter) | 351 | DeepSeek Harness 插件（JS） | 会话成本 / 每日总计；官方余额 + **自定义供应商余额**；预算进度条；Coding Plan 额度（Anthropic / Z.ai / MiniMax / Kimi / OpenRouter / SiliconFlow / CommandCode / 火山 / 通义 / 小米 MiMo）；**90+ 模型价格目录**；Codex 风格热力图；峰谷计费 |
| [tokentap](https://github.com/jmuncor/tokentap) | 814 | 终端（Python） | 代理拦截 LLM API 流量，实时终端仪表盘展示 token / 成本 / 上下文窗口 |

### C. Coding Plan 额度查询器（跨供应商，与 BalanceDeck「多供应商聚合」形态接近）

| 项目 | Star | 平台 / 技术栈 | 核心能力 |
|---|---|---|---|
| [opencode-quota](https://github.com/slkiser/opencode-quota) | 985 | OpenCode 插件（TS） | OpenCode 侧边栏 / 状态栏 / toast 展示额度；支持 OpenCode Go / Cursor / Copilot / OpenAI / Kimi Code / Alibaba / Chutes / Antigravity / Z.ai；**预计耗尽时间**；JSON/导出给状态栏脚本 |
| [CodingPlanQuota](https://github.com/MeIotCOM/CodingPlanQuota) | 106 | 移动端（uni-app x / TS，Android/iOS/HarmonyOS） | 手机随时查 GLM / Kimi / MiniMax / ZenMux / OpenCode Go / 火山 / DeepSeek / 中转额度；**离线优先**；7 种语言 |
| [AI_Usage_Dashboard](https://github.com/David-Lzy/AI_Usage_Dashboard) | 169 | Chrome 扩展（TS，AGPL-3.0） | 工具栏弹窗 / 侧边栏 / 全页 dashboard；配额、credits、重置时间、花费、历史；**sync health**（区分新鲜数据/保留上次成功/缺失访问/部分契约/不支持值）；**提醒**；**CSV 导出** |
| [cc-router](https://github.com/finch-xu/cc-router) | 263 | 桌面 GUI（Rust） | 本地大模型聚合网关，把多个 Coding Plan / API 额度合成「虚拟 Plan」，一键接入 Claude Code / OpenCode 等；自带 GUI 桌面端 |
| [quota-viewer](https://github.com/eeljoe/quota-viewer) | 10 | Windows 10+（Go + Wails，~50MB） | **桌面悬浮球** + 展开面板；Kimi / 讯飞星辰 / OpenCode Go / MiMo / DeepSeek / Ollama / Command Code；最多同时显示 3 家；**预算进度条**；玻璃拟态；托盘控制；智能避让屏幕边缘 |
| [QuotaPanel](https://github.com/open-tecmz/quotapanel) | 2 | 桌面（Go，Apache-2.0） | 桌面端 AI 额度面板，把各家订阅与 API 余额集中到一张界面 |

### D. 桌面宠物 / 数字助理（与 BalanceDeck「3D 数字助理」形态接近）

| 项目 | Star | 平台 / 技术栈 | 核心能力 |
|---|---|---|---|
| [TermiPet](https://github.com/bleeeet/TermiPet) | 84 | macOS 14+（Swift，Apache-2.0） | 桌面宠物 + 终端状态卡片（Claude Code Hook 状态同步）；快捷命令面板；AI 用量卡片（Claude Code / Codex / Copilot）；**本地/在线模型聊天**；番茄钟；多宠物资源包；多语言多皮肤 |
| [petto](https://github.com/funnycups/petto) | 119 | 跨平台（Dart，Live2D，GPL-3.0） | Live2D 桌面助理，智能化交互 |

---

## 3. 对比总表

### 3.1 基础信息对比

| 项目 | 形态 | 平台 | 技术栈 | 开源协议 | Star | 最近活跃 |
|---|---|---|---|---|---|---|
| **BalanceDeck** | 悬浮卡片 + 菜单栏 + 2D/3D 收起态 | macOS / Windows | Electron 37 + React + TS + three.js | MIT | — | 2026-09 |
| CodexBar | 菜单栏 | macOS / Linux | Swift / Qt | MIT | 22.1k | 2026-09 |
| ClaudeBar | 菜单栏 | macOS | Swift | 无 | 1.5k | 2026-09 |
| codenotch | 屏幕边缘黑条 | macOS / Windows | Swift / Tauri(Rust) | MIT | 2.6k | 2026-09 |
| Claude-Code-Usage-Monitor (CodeZeno) | 任务栏小部件 | Windows | Rust | MIT | 546 | 2026-09 |
| Claude-God | 菜单栏 + 桌面 widget | macOS | Swift | MIT | 86 | 2026-09 |
| claude-battery | 菜单栏 | macOS | C# | MIT | 37 | 2026-09 |
| oh-myusage | 菜单栏 | macOS | Swift | MIT | 188 | 2026-09 |
| CostBar | 悬浮窗 + 菜单栏 | macOS | Swift | — | 1 | 2026-05 |
| claude-usage (phuryn) | 本地 Web 仪表盘 | 跨平台（浏览器） | Python | MIT | 2.2k | 2026-07 |
| TokenTracker | CLI + 菜单栏/托盘 + 桌面 widget + 宠物 | macOS / Windows / Linux | JS | MIT | 1.9k | 2026-09 |
| token-monitor | 桌面小部件 | macOS / Windows / Linux | JS | MIT | 2.5k | 2026-09 |
| sniffly | 本地 Web 仪表盘 | 跨平台（浏览器） | Python | MIT | 1.3k | 2025-08 |
| Claude-Code-Usage-Monitor (Maciek) | 终端/仪表盘 | 跨平台 | Python | MIT | 8.7k | 2026-07 |
| dsh-cost-meter | DSH 插件 | 跨平台（浏览器插件） | JS | MIT | 351 | 2026-09 |
| tokentap | 终端仪表盘 | 跨平台 | Python | MIT | 814 | 2026-06 |
| opencode-quota | OpenCode 插件 | OpenCode 内 | TS | MIT | 985 | 2026-09 |
| CodingPlanQuota | 移动 App | Android / iOS / HarmonyOS | TS (uni-app x) | NOASSERTION | 106 | 2026-09 |
| AI_Usage_Dashboard | Chrome 扩展 | 浏览器 | TS | AGPL-3.0 | 169 | 2026-09 |
| cc-router | 桌面 GUI 网关 | macOS / Windows（桌面） | Rust | MIT | 263 | 2026-09 |
| quota-viewer | 桌面悬浮球 | Windows | Go + Wails | MIT | 10 | 2026-09 |
| QuotaPanel | 桌面面板 | 桌面 | Go | Apache-2.0 | 2 | 2026-09 |
| TermiPet | 桌面宠物 + 工具栏 | macOS | Swift | Apache-2.0 | 84 | 2026-09 |
| petto | 桌面宠物 | 跨平台 | Dart / Live2D | GPL-3.0 | 119 | 2025-12 |

### 3.2 功能维度对比（重点项）

| 维度 | BalanceDeck | 竞品中最强者 | 差距 |
|---|---|---|---|
| 供应商覆盖数 | 11 家内置 + 9 协议（约 20 种） | CodexBar **87 家**；TokenTracker/token-monitor **42/43 款工具** | 明显偏少，需扩展 |
| 悬浮卡片 / 悬浮球形态 | ✅ 悬浮卡片 + 2D 圆环 + 3D 数字助理 | quota-viewer（悬浮球）；CostBar（悬浮窗） | 形态领先，但竞品更轻量 |
| 菜单栏 / 托盘 | ✅ 百分比 + 右键菜单 | CodexBar（每 provider 一状态项 / Merge Icons）；ClaudeBar | 功能对齐，缺动态图标变色 |
| 重置倒计时 | ✅ 环形仪表显示 | CodexBar / ClaudeBar / CodeZeno / Claude-God 均有 | 对齐 |
| 用完前提醒 / 通知 | ⚠️ 仅有 TTS 语音播报；**无系统通知** | ClaudeBar / AI_Usage_Dashboard / Maciek / Claude-God 均有 | **缺失**（Roadmap 已列） |
| 用量预测（burn rate / 预计耗尽） | ❌ 无 | Claude-God / Maciek / CodeZeno / opencode-quota | **缺失** |
| 历史趋势 / 热力图 | ❌ 无 | Claude-God（sparkline 7/14/30 天）；TokenTracker / dsh-cost-meter（热力图） | **缺失** |
| 成本追踪 | ⚠️ 仅本机 tokens | claude-usage / TokenTracker / dsh-cost-meter / Claude-God / tokentap | **缺失** |
| 预算功能 | ❌ 无 | quota-viewer / dsh-cost-meter / Claude-God | 缺失（可做） |
| 数据可信度分级 | ✅ official / cached / local（独特） | AI_Usage_Dashboard 有 sync health；其余几乎没有 | **领先** |
| 隐私 / 本地优先 | ✅ 本地计算 + Keychain/DPAPI，无遥测 | TokenTracker / token-monitor / CodeZeno 同样本地优先 | 对齐 |
| 桌面宠物 / 数字助理 | ✅ 3D 真人数字人（Rocketbox） | TokenTracker（像素宠物 + 成就）；TermiPet（宠物 + 聊天）；petto（Live2D） | 各有特色，可借鉴互动 |
| 多账户 | ✅ 同预设可重复添加 | CodeZeno 多账户；CodexBar 多 session | 对齐 |
| 皮肤 / 主题 | ✅ 5 套内置 + 外部 CSS | CodeZeno（Theme Studio）；ClaudeBar / TermiPet（皮肤） | 对齐 |
| 数据导出 | ❌ 无 | Claude-God / AI_Usage_Dashboard（CSV） | 缺失 |
| 多语言 | ⚠️ 仅中文 | CodingPlanQuota（7 语）；TokenTracker（5 语）；TermiPet（5 语） | 缺失 |
| 手机联动 | ❌ 无 | codenotch（iOS/Android App 局域网联动） | 缺失（高成本） |
| 系统桌面 widget | ❌ 无 | Claude-God / CodexBar(Omarchy) / TokenTracker / CodeZeno | 缺失（可做 macOS WidgetKit） |
| 分发渠道 | GitHub Releases（dmg/exe） | CodexBar / ClaudeBar / TokenTracker（Homebrew）；CodeZeno（winget） | 可补充 |
| 安装体积 / 内存 | Electron（较重，~200MB 级） | quota-viewer 明确主打 Go+Wails ~50MB | 技术债 |

---

## 4. 重点竞品逐项分析

### 4.1 CodexBar（22.1k★）—— 菜单栏赛道的绝对头部

- **为什么强**：覆盖面极广（87 家供应商）、复用现有登录态（无需用户输密码）、每个 provider 独立状态项、动态图标、重置倒计时、Credits/spend 等高级指标、还有 Linux 桌面版 + Omarchy widget。
- **对我们的启示**：BalanceDeck 的菜单栏文案已做平铺窗口，但**没有动态图标变色**（>80% 变红等）、没有按 provider 多状态项。CodexBar 的「无登录态复用」思路也值得学习（BalanceDeck 已有一键授权，方向一致）。

### 4.2 ClaudeBar（1.5k★）—— 多供应商菜单栏，成熟分发

- **为什么强**：15+ 供应商、Homebrew 安装、用完前通知、CI/测试完善（有 codecov）。
- **对我们的启示**：**「用完前通知」是刚需**，BalanceDeck 只有 TTS 播报没有系统通知，应尽快补上（Roadmap 已有「>80% 系统通知」）。

### 4.3 codenotch（2.6k★）—— 屏幕边缘形态 + 手机联动

- **为什么强**：屏幕边缘黑条不遮挡桌面；会话状态（working/done/waiting）很实用；**手机 App 局域网联动**是独有卖点。
- **对我们的启示**：BalanceDeck 的悬浮球形态与 codenotch 互补。手机联动成本高，可作为远期方向。会话状态展示（Claude Code 是否在运行）值得借鉴 —— TermiPet 也做这件事。

### 4.4 TokenTracker / token-monitor（1.9k / 2.5k★）—— 用量追踪的极致

- **为什么强**：覆盖 42/43 款工具、本地优先、**4 个原生桌面 widget**、**桌面宠物 + 成就系统**、多语言、多平台（CLI + 菜单栏 + 托盘）。
- **对我们的启示**：BalanceDeck 的「详情页每模型用量」可以扩展为**历史趋势图 / 热力图**；桌面宠物可以加**成就/跟随/互动**（但 BalanceDeck 定位是数字助理，不搞养成，需谨慎）。**多语言**也是它做得很好的点。

### 4.5 dsh-cost-meter（351★）—— 余额 + 额度 + 成本的一体化插件

- **为什么强**：官方余额 + 自定义供应商余额 + 预算进度条 + Coding Plan 额度 + **90+ 模型价格目录** + 热力图 + 峰谷计费。
- **对我们的启示**：BalanceDeck 已有「余额 + 额度」双轨，缺的是**预算**与**成本估计**。可以给余额类供应商加「预算进度条」（quota-viewer 也有），并给套餐类加「按当前速率预计耗尽」。

### 4.6 opencode-quota（985★）—— 与 OpenCode 深度集成

- **为什么强**：直接嵌入 OpenCode 侧边栏 / 状态栏 / toast，还有 `npx` 命令行可在 OpenCode 外使用，输出 JSON 给状态栏脚本；支持预计耗尽时间。
- **对我们的启示**：BalanceDeck 也读 opencode.db，但它是**独立应用**。可以输出一个**轻量 CLI / JSON 快照**（如 `balancedeck export`），让用户集成到自己的状态栏（tmux / macOS iStat / 终端），扩大使用场景。

### 4.7 quota-viewer（10★）—— 最接近 BalanceDeck 悬浮球形态的竞品

- **为什么强**：Windows 悬浮球 + 展开面板，Go+Wails 只有 ~50MB，玻璃拟态，预算进度条，智能避让屏幕边缘，最多 3 家同时显示。
- **对我们的启示**：它用「体积小」作为差异化卖点直接对比 Electron。BalanceDeck 应正视**资源占用**问题：虽然 3D 已按需加载，但 Electron 基础开销仍在。可以做的：①文档明示「默认 2D 环不加载 three.js」；②优化启动与常驻内存；③长期评估 Tauri 迁移的可行性。

### 4.8 Claude-God（86★）—— 分析能力最强

- **为什么强**：burn rate 预测、ROI、项目拆分、sparkline、每日预算、CSV 导出、插件扩展。
- **对我们的启示**：**用量预测**是分析类功能里用户感知最强的，值得优先做。

### 4.9 TermiPet（84★）—— 数字助理的另一种形态

- **为什么强**：桌面宠物 + 终端状态卡片（Claude Code Hook）+ 快捷命令 + 本地模型聊天 + 番茄钟，定位是「工作流入口」。
- **对我们的启示**：BalanceDeck 数字助理目前只做余额播报与动作，可以借鉴**状态卡片**（显示当前 Claude Code/OpenCode 会话状态）与**快捷入口**（如点击直接打开某家控制台）。聊天与养成与其定位不符，可不做。

---

## 5. BalanceDeck 相对优势

1. **形态组合独特**：悬浮卡片 + 菜单栏 + 可收起 2D 圆环 / 3D 数字助理，同时覆盖「桌面常驻」与「菜单栏即看」两种场景；竞品要么只有菜单栏（CodexBar/ClaudeBar），要么只有悬浮球（quota-viewer）。
2. **数据可信度分级（official / cached / local）**：这是绝大多数竞品没有的「数据诚实」设计。竞品里只有 AI_Usage_Dashboard 的 sync health 概念接近。断网/缓存时明确标注，不伪装实时数据，是强有力的信任卖点。
3. **「Coding Plan 额度 + API 余额 + Token Plan」三合一**：多数竞品只做额度（CodexBar/ClaudeBar）或只做余额（CostBar），BalanceDeck 是国内厂商（DeepSeek/Kimi/智谱/硅基流动/通义/火山/MiniMax）覆盖最全的桌面端之一。
4. **隐私优先**：凭据进系统密钥链（Keychain/DPAPI）、无遥测、本地计算。与 TokenTracker 等头部项目对齐。
5. **测试与工程质量**：462 项单元断言 + 109 项 UI 断言、多显示器自愈、鼠标穿透、8px 拖拽阈值等细节打磨，显著优于多数小体量竞品。
6. **3D 数字助理差异化**：Rocketbox 真人模型 + 按需加载 + WebGL 兜底 2D 环，在同类工具里独树一帜（TokenTracker 是像素宠物、TermiPet 是 2D 卡通）。

---

## 6. BalanceDeck 可优化方案

> 优先级说明：**P0** = 用户感知强 / 竞品普遍具备 / 与现有 Roadmap 呼应，建议近期做；**P1** = 中等价值，能形成差异化；**P2** = 长期 / 成本高 / 锦上添花。
> 与 Roadmap 对照：R1 额度阈值提醒、R2 助理素材包、R3 动作扩展、R4 皮肤市场、R5 国内订阅套餐。
> 标注说明：**【已规划】** = 与现有 Roadmap 条目对应（标注对应 R 编号）；**【新增】** = Roadmap 未列，本次调研新增建议。

### P0（建议尽快做）

#### P0-1 额度阈值提醒 + 系统通知【已规划 · R1 落地】
- **竞品依据**：ClaudeBar（用完前通知）、AI_Usage_Dashboard（quota/reset 提醒）、Claude-God、Maciek monitor、CodexBar（重置倒计时）均具备。
- **方案**：在已有 TTS 语音播报基础上，增加**系统通知**（macOS Notification Center / Windows Toast）。阈值可配置（默认 >80% 提醒一次、>95% 强提醒、用完前 1 小时提醒重置临近）；每条通知带上供应商名、窗口（5H/W/M）、当前百分比与重置倒计时。
- **理由**：BalanceDeck 已有 trigger-engine / alert-orchestration / voice 测试套件，语音播报基础设施齐全，系统通知只是新增一个输出通道，改动可控、收益直观。

#### P0-2 用量预测 / 预计耗尽时间（burn rate）【新增】
- **竞品依据**：Claude-God（burn rate）、Maciek monitor（predictions）、CodeZeno（runs-out estimate）、opencode-quota（runs-out estimate）。
- **方案**：BalanceDeck 的 scheduler 已周期性采集，天然有历史数据。可以保存每日窗口用量快照（本地 SQLite/JSON），按最近 N 天斜率估算「按当前速率，5H 窗口 / 周 / 月额度何时用完」，在环形仪表下方或详情页展示一行文字：「预计 10-02 14:00 用完」。
- **理由**：这是「数据诚实」理念的自然延伸——不是只报当前百分比，而是基于真实采集数据做估算，并明确标注为「估算」。与竞品形成差异化。

### P1（中价值，形成差异化）

#### P1-1 历史趋势图 / 用量热力图【新增】
- **竞品依据**：Claude-God（sparkline 7/14/30 天）、TokenTracker（activity heatmap widget）、dsh-cost-meter（Codex 风格热力图）、token-monitor（历史使用）。
- **方案**：详情页在「每模型用量表」上方增加 7/30 天用量柱状图或热力图（轻量 SVG 即可，无需引入图表库）；数据来自 P0-2 的本地快照。
- **理由**：让「用量」从瞬时值变成趋势，帮助用户规划额度。

#### P1-2 供应商覆盖扩展【新增】
- **竞品依据**：CodexBar 87 家、ClaudeBar 15+、opencode-quota 支持 OpenAI/Alibaba/Chutes/Antigravity/Z.ai、token-monitor 43 款工具。
- **方案**：优先补齐高频供应商：**Google Antigravity、Gemini Code Assist、Cursor、OpenAI（ChatGPT 额度）**；协议层可借鉴竞品已开源的解析逻辑（注意各项目许可均为 MIT，可参考实现）。
- **理由**：覆盖更多供应商是「聚合仪表盘」类产品的第一竞争力。BalanceDeck 已有 9 种自定义协议，新增供应商主要成本在适配器与测试。

#### P1-3 菜单栏 / 托盘动态状态（颜色 / 图标）【新增】
- **竞品依据**：CodexBar（动态 bar icons）、ClaudeBar（动态图标）、Claude-God（菜单栏图标按最差配额变绿/橙/红）、CodeZeno（主题与百分比显示方向）。
- **方案**：托盘标题保留现有 `5H 5% W 52.9% M 68.5%` 平铺，但给百分比加**颜色阈值**（如 >80% 红、>50% 橙、正常绿）；macOS 菜单栏图标可随主供应商 logo 保持，但增加一个小的状态点或角标。
- **理由**：一眼识别风险，符合「一眼可见」的产品主张，改动小。

#### P1-4 多账户分组管理增强【新增】
- **竞品依据**：CodeZeno（多账户）、CodexBar（多 session）、oh-myusage（账号状态诊断）。
- **方案**：BalanceDeck 已支持同预设重复添加，可进一步提供**账户分组 / 标签**（如「公司 / 个人」）、每组独立显隐与排序；详情页区分「同名供应商多账号」的卡片展示。
- **理由**：多账号用户（多中转站、多订阅）是核心人群，管理体验值得加强。

#### P1-5 资源占用优化（应对「Electron 太重」的质疑）【新增】
- **竞品依据**：quota-viewer 直接以「Go+Wails ~50MB vs Electron 200MB+」做卖点。
- **方案**：
  1. 文档与 FAQ 明示：默认形态（2D 圆环）不加载 three.js、不下载 3D 素材；
  2. 实测并优化常驻内存（延迟加载非首屏模块、减少主进程定时器唤醒）；
  3. **长期**：评估 Tauri 迁移成本（Rust 后端 + Web 前端），或至少输出一份「轻量替代方案」作为远期路线。
- **理由**：资源占用是 Electron 工具的普遍短板，主动优化并透明沟通能消解竞品攻击点。

#### P1-6 轻量 CLI / JSON 快照导出（给状态栏脚本用）【新增】
- **竞品依据**：opencode-quota 提供 `npx ... show` + JSON 导出给外部状态栏脚本；Claude-God / AI_Usage_Dashboard 提供 CSV。
- **方案**：增加 `balancedeck export --json`（或 `--snapshot`）命令，输出各供应商当前用量 / 余额 / 可信度 / 重置时间到 stdout/文件，供用户接入 tmux、iStat、终端提示符。
- **理由**：低成本扩大小众但高粘性的使用场景，也强化「数据可编程访问」的工程师友好形象。

### P2（长期 / 锦上添花）

#### P2-1 macOS 桌面小组件（WidgetKit）【新增】
- **竞品依据**：Claude-God、TokenTracker、CodeZeno、CodexBar(Omarchy) 均提供桌面 widget。
- **方案**：用 WidgetKit 提供「用量环 / 百分比 / 重置倒计时」小组件。注意 WidgetKit 需要 Swift 原生代码，可在主 App 外另建 Extension 目标；或先用 Electron 的桌面小组件形态过渡。
- **理由**：桌面 widget 是系统级常驻入口，但开发与签名成本较高，放远期。

#### P2-2 数据导出 CSV / 历史记录导出【新增】
- **竞品依据**：Claude-God、AI_Usage_Dashboard（CSV 导出）。
- **方案**：详情页增加「导出 CSV」按钮，导出各窗口历史用量 / 每模型 tokens。
- **理由**：低成本，配合 P1-1 趋势数据即可实现。

#### P2-3 皮肤市场 / 主题包导入导出【已规划 · R4 落地】
- **竞品依据**：CodeZeno（Theme Studio）、ClaudeBar / TermiPet（多皮肤）。
- **方案**：在现有外部 CSS 皮肤基础上，增加「皮肤包」打包（zip + manifest），设置页一键导入导出；可规划社区目录。
- **理由**：Roadmap 已列，属于生态建设。

#### P2-4 多语言 i18n【新增】
- **竞品依据**：CodingPlanQuota（7 语）、TokenTracker（5 语）、TermiPet（5 语）、dsh-cost-meter（中英双语）。
- **方案**：引入 i18n 框架，先补英文，再补日/韩。
- **理由**：BalanceDeck 支持国外供应商（OpenCode Go / Claude / Codex / Copilot），英文界面能扩大受众；但重构涉及面广，放远期。

#### P2-5 移动端 / 局域网联动（对标 codenotch）【新增】
- **竞品依据**：codenotch 手机 App 显示同一份用量。
- **方案**：若未来有移动端，可让桌面端作为本地服务器（仅局域网），手机扫码查看同一份数据。
- **理由**：成本高（需要移动端工程），但差异化强，适合作为产品成熟后的方向。

#### P2-6 成本追踪（基于本机 tokens 的估算）【新增】
- **竞品依据**：claude-usage、TokenTracker、dsh-cost-meter、tokentap、Claude-God 都有成本统计。
- **方案**：在详情页的每模型用量表旁，按各厂商公开价格估算「今日 / 本周 / 本月成本」。
- **理由**：需要维护价格目录（dsh-cost-meter 有 90+ 模型价格目录可参考），维护成本较高，放远期。

---

## 7. 结论与后续建议

1. **BalanceDeck 的差异化定位仍然成立**：市面上没有第二个「同时聚合 Coding Plan 额度 + API 余额 + Token Plan、以悬浮卡片 + 菜单栏 + 3D 数字助理形态呈现、且带数据可信度分级」的桌面工具。
2. **最紧迫的差距集中在「分析 + 提醒」**：竞品普遍具备系统通知、用量预测、历史趋势，而 BalanceDeck 目前只有 TTS 播报与瞬时百分比。这三项（P0-1、P0-2、P1-1）应优先补齐，且都能复用现有采集与测试基建。
3. **供应商覆盖是长期竞争力**：应持续扩展（P1-2），尤其是海外高频供应商（Antigravity / Gemini / Cursor / OpenAI）。
4. **工程与分发可以更成熟**：Homebrew cask / winget、CLI 快照导出、资源占用优化，能显著提升开发者社区的接受度与口碑。
5. **建议下一步**：把 P0-1（额度阈值提醒 + 系统通知）与 P0-2（用量预测）拆成独立 Trellis 实现任务，先做用户感知最强、改动可控的两项。