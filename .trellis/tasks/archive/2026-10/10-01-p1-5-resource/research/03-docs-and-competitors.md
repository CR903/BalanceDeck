# Research: 文档现状核对 + 竞品话术

- **Query**: README / FAQ 里现在关于「Electron」「体积」「3D 素材」是怎么说的？有没有夸大或过时的表述？竞品怎么宣传这一点的？
- **Scope**: mixed（内部文档逐条核对 + 外部竞品 README）
- **Date**: 2026-10-01

## 一、仓库里现在有哪些相关表述（逐条核对）

### 1.1 `README.md`

| 位置 | 原文 | 判定 |
|---|---|---|
| `README.md:13` | `[![Electron](https://img.shields.io/badge/Electron-37-47848F?style=flat-square…)]` | ✅ 事实（Electron 37.10.3），且**主动亮技术栈**是对的 |
| `README.md:45-46` | 「**这一形态完全不建 WebGL 上下文** —— 默认状态下**不加载 three.js**、不下载任何 3D 素材、不占显存。」 | ❌ **三句里有一句是错的**：「不加载 three.js」。实测 three.js（1,298,531 B）就在入口 chunk 里，每次启动都被解析。前两句（不建 WebGL 上下文 / 不下载任何 3D 素材）✅ 为真 |
| `README.md:48-50` | 「圆环形态（默认）：纯 2D，窗口 56×56，安静、省电、不抢镜」 | ✅ 与实测吻合（CPU 2.2 % 单核 vs 人物形态 25–29 %） |
| `README.md:58-59` | 「动作素材**按需加载**：只有出场要用的几条随模型加载，其余第一次被抽到才解析」 | ✅ 实测切到人物形态只请求 3 条 anims（`walk` / `idle` / `wave`，对应 `clips.ts:40 BASE_CLIPS`） |
| `README.md:60-62` | 「个性人物是 **three.js 真 3D**…**只在开启时才载入**；WebGL 不可用时自动退回 2D 小圆环」「默认的圆环形态**不下载、不解析**任何人物模型」 | ⚠ **半句不准**：「只在开启时才载入」对**场景与素材**成立（CDP：0 条 `bd-asset://`），对 **three.js 代码**不成立。末句 ✅ 为真 |
| `README.md:191` | 项目结构树末行 `└── (resources/human-pets 数字人素材，见第三方素材)` | ✅ 诚实（没藏 221 MB） |
| `README.md:203` | 「第三方素材：真人模型与动作 © Microsoft Rocketbox（MIT，**随包分发**，见 `resources/human-pets/*/meta.json`）」 | ✅ 诚实，但**没说这 237 MB 里有 158.9 MB 从不被读取**（`.tga` × 10 = 128 MB + `reyna-pilot/model.glb` = 30.9 MB） |
| `README.md:208` | Roadmap：「助理素材包（**外部 GLB 模型加载**：用户自备模型即可换一位）」 | ⚠ **过时**：GLB 路线已废弃（`src/shared/pet.ts:46-49` 只有 aria/ray，`clips.ts` 只认 `.fbx`），而 `reyna-pilot/model.glb`（31 MB）正是这条废弃路线的遗留物，且会进包 |

### 1.2 `DESIGN.md`

| 位置 | 原文 | 判定 |
|---|---|---|
| `DESIGN.md:303` | 「**球形态不加载人物素材**：默认形态既不下载 human 分包（`import('./human')`）也不解析 FBX」 | ✅ **逐字为真，且比 README 精确**（它只承诺「人物素材」，没承诺「three.js」）。**不要动。** |
| `DESIGN.md:270-271` | 「…于是球形态**整体退回首版的 2D 小圆环**，**不建场景、不加载任何 3D 资源**」 | ✅ 为真（「不建场景」「不加载任何 3D 资源」都不涉及 three.js 代码） |
| `DESIGN.md:278` | 形态表：「不建 WebGL 上下文」 | ✅ 为真（CDP：`<canvas>` 数 = 0） |
| `DESIGN.md:338-339` | 「`human.ts` 静态依赖 FBXLoader + SkeletonUtils（约 118KB → 独立 chunk），且**球形态根本不调用** —— 默认形态启动不下载分包、不解析任何 FBX」 | ✅ 118 KB vs 实测 120,740 B，一致 |
| `DESIGN.md:355` | 「设置页缩略图直接用采集期 `preview.png`（不占 WebGL 上下文）」 | ✅ 为真 |
| `DESIGN.md:367` | 「`human.ts` \| 素材加载与 action 生命周期（含懒加载）\| **唯一碰 three/FBX 的地方**」 | ❌ **已过时**：`PetBall.tsx:11` 静态 import 的 `pet3d/scene.ts:1-2` 也静态 import 了 three |

### 1.3 FAQ —— **仓库里没有**

```
$ find . -iname "*faq*" -not -path "./node_modules/*" -not -path "./.git/*"
（无结果）
$ grep -rn -i "FAQ\|常见问题" README.md docs/
（docs/ 下只有一张 PNG 命中，是二进制误匹配）
```

**PRD 里提到的「FAQ」目前不存在。** 若要新建，需先定：
- 放 `README.md` 末尾一节？还是独立 `docs/faq.md`？
- `.trellis/spec/frontend/directory-structure.md` 有没有规定文档布局？（我还没核这条，属于待确认）

### 1.4 其他文档

- `CONTEXT.md` / `TASKS.md` 里没有关于体积 / 内存的表述（`grep -i "内存\|显存\|体积\|three"` 无命中）。
- `.trellis/spec/**` 里没有资源占用的 spec。

---

## 二、建议的修正（**只列事实与依据，不代写文案**）

### 2.1 必改（唯一一处事实性错误）

`README.md:45-46`。当前三个短句里，只有「不加载 three.js」与实测冲突。

可选表述方向（**措辞交给 main agent / 用户定**）：
- 保守版：只保留能被证明的两句 —— 「不建 WebGL 上下文」「不下载任何 3D 素材」。
- 进攻版：把「默认形态**不占用 GPU 上下文**」说成可量化的事实（GPU 进程 `phys_footprint` 39–40 MB vs 人物形态 95–100 MB；CPU 2.2 % vs 25 % 单核）—— 这比「不加载 three.js」更硬，而且**做候选 #2 之后这句话还能顺势升级成真的**。
- 若候选 #2 落地（`PetBall.tsx:11` 改动态 import + `manualChunks`），「不加载 three.js」就变成真的，那时才建议把它写回 README。**顺序上：先改代码，后写卖点。**

### 2.2 建议顺手改（过时）

| 位置 | 改什么 |
|---|---|
| `README.md:60-62` | 「只在开启时才载入」限定成「**场景与人物素材**只在开启时才载入」 |
| `README.md:208` | 删掉 Roadmap 里已废弃的「外部 GLB 模型加载」（顺带解释掉 `reyna-pilot/` 的来历，见候选 #1） |
| `DESIGN.md:367` | 「唯一碰 three/FBX 的地方」→ 补上 `pet3d/scene.ts` 也静态 import 了 three（若候选 #2 落地，这行要重写） |
| `README.md:203` | 若候选 #1 落地，可补一句「素材仅在开启个性人物时才读取」 |

### 2.3 不建议改

- `DESIGN.md:303` / `:270-271` / `:278` / `:338` —— 已经写得比 README 精确且为真，改动只会引入风险。
- `README.md:45-46` 的「不建 WebGL 上下文」「不下载任何 3D 素材」「不占显存」三句 —— 实测为真。

---

## 三、竞品话术（外部检索）

### 3.1 `eeljoe/quota-viewer`（任务里点名的那一个）

- URL: https://github.com/eeljoe/quota-viewer（MIT，10 star，Windows 10+）
- **仓库简介逐字**：
  > "OpenCode Go 桌面悬浮球 AI 额度监控 / Lightweight desktop quota monitor for AI platforms — Kimi · 讯飞星辰 · OpenCode Go · MiMo · DeepSeek. **Minimal, low RAM & disk (Go + Wails, ~50MB vs Electron 200MB+).**"

**可借鉴的三点**
1. **它比的是「安装包 + 磁盘」，不是「内存」** —— 简介里 "low RAM & disk" 的落点是 `~50MB vs Electron 200MB+`，一个磁盘数字。**BalanceDeck 在这一项上其实有牌可打**（见 §3.4），现在 README 一个体积数字都没有。
2. **把对比写进简介第一屏**，而不是藏在 Features 里。
3. **"Lightweight" / "Minimal" 直接进 tagline**，不做「我们也很省」的间接表述。

### 3.2 其他竞品的真实定位（检索到的原文）

| 项目 | 技术栈 | 体积相关的原话 |
|---|---|---|
| `sabahattinkalan/QuotaBar` | **Tauri 2 + Rust**，Windows/macOS/Linux | "⚡ **Lightweight** — **~6 MB binary (Tauri 2 + Rust)**" |
| `wzk2025/OpenQuota` | **Tauri 2**，Node 22 / pnpm 11 | "OpenQuota runs locally and has **no account, cloud backend, analytics, or usage telemetry** of its own." |
| `silverlion2/quota-float` | **Tauri**（Rust + React） | "**Private by default:** no telemetry, analytics, account modification, prompt collection, or third-party tracking." |
| `pinkpixel-dev/quota` | **Tauri** 桌面壳 + VSCode/VSX 扩展 | "Only secure account & usage information are sent to the React frontend." |
| `cipherpine/quotapane` | **Rust / egui**，无安装包 | "**The entire value proposition is a small, auditable trust boundary.**" · "**There is no installer and nothing to uninstall**" |
| `finch-xu/cc-router` | Rust + egui | — |
| `CodexBar`（steipete，22.1k）/ `ClaudeBar`（tddworks，1.5k） | **原生 Swift**（macOS 14+/15+） | **不打体积牌** —— 原生二进制本来就小，不需要比较 |

**两个可以直接抄的句式**
1. QuotaBar：「⚡ **Lightweight** — ~6 MB binary」—— 一个 emoji + 一个形容词 + **一个具体到有说服力的数字**。
2. QuotaPane：「**The entire value proposition is a small, auditable trust boundary.**」—— 把「轻」升格成「可审计的信任边界」，把它从性能话题变成价值观话题。BalanceDeck 的对应资产是 `safeStorage` + 无遥测 + `export` 子命令（`README.md:201-203` 已经写了，但没和「轻」连起来）。

### 3.3 一个必须知道的结构性事实

**竞品里大多数根本不是 Electron，是 Tauri。** 也就是说「Electron 太重」这个赛道**大部分人已经换赛道了**，而 BalanceDeck 选择留在 Electron 并且要正面回应 —— 这意味着：

- **不要在「运行时内存」上和 Tauri 比**。Electron 的 4 个进程共享 Framework 是结构性的；本文实测的诚实口径 `phys_footprint` 是 **335–382 MB**，而 Tauri 用系统 WebView，理论上是几十 MB。**这一局比不过，也不该比。**
- **该比的是「装下来多少」和「不用的东西付不付代价」** —— 而这两项 BalanceDeck 现在都能改到很好（见下）。

### 3.4 BalanceDeck 在这一格里的实际位置（可量化）

实测的 `.app`（macOS x86_64 `--dir`，**520 MB**，`raw/10`）：

| 维度 | quota-viewer（Go + Wails） | BalanceDeck **现在** | **候选 #1 + #7 落地后** |
|---|---|---|---|
| 安装包总体积 | ~50 MB（对方自述） | **520 MB** | **~342 MB** |
| ├─ 「不用的功能也要付的代价」 | — | `Contents/Frameworks` **262 MB**（Electron 运行时，结构性） | 262 MB（**改不动**） |
| ├─ 3D 素材 | 无 | **237 MB**（其中 **158.9 MB 从不读取**） | **~78 MB**（且只有开了个性人物的用户会碰） |
| └─ asar 里的 npm 包 | — | 18.9 MB（主进程一个都不 require） | ~0 |
| 冷启动解析的 JS | Go 内嵌的 `frontend/` | **1,699,669 B**（含 three.js 1.30 MB） | **~514 kB**（候选 #2 后） |
| 不用 3D 时的常驻 `phys_footprint` | 声称 "low RAM"（无实测） | **335 – 382 MB / 2.2 % 单核** | 同（#2 不改内存，见 `raw/06`） |

### 3.5 一个必须接受的诚实结论（避免 marketing 反噬）

**在「安装包总体积」这一格，BalanceDeck 打不过 50 MB 的 Wails / 6 MB 的 Tauri，而且补不上。**
`Contents/Frameworks` 的 **262 MB 是 Electron 运行时本身**，不是本项目的代码 —— 清掉全部死重后仍有 ~342 MB。竞品那句 "**~50MB vs Electron 200MB+**" 打的正是这 262 MB。

→ **README 里不要写任何暗示「我们也很小」的整包数字。** 一旦有人 `du -sh BalanceDeck.app`，数字会直接反驳文案。

**能守住的、且已实测的三张牌**（每条都有可复验的取证脚本，见 `research/probe-renderer.mjs` / `measure-memory.mjs`）：

1. **不用 3D 的人，一个字节的 3D 素材都不会被下载或解析。**
   CDP 实测：球形态 `bd-asset://` 请求 **0 条**、`human-*.js` 分包 **未加载**、`<canvas>` **0 个**。切到个性人物的那一刻才出现 13 条 `bd-asset://`。
2. **不用 3D 的人，GPU 进程只有 39–40 MB，CPU 只有 2.2 % 单核；开了之后是 95–100 MB 与 25–29 % 单核**（`gpu` 与 `renderer` 各 ~10–15 %）。**同一个应用、开销差 15 倍 —— 这是「按需付费」最干净的证据。**
3. **把从不读取的 158.9 MB 清掉，并让 1.30 MB 的 three.js 不进首屏。**
   这是**工程诚实**而不是营销：它让上面两条从「设计如此」变成「量过如此」。

**唯一可以正面比的同类是 Electron 系的其它配额工具。** `README.md:13` 主动亮了 Electron 37 徽章 —— 与其藏着，不如把它变成「版本固定、行为可预期」的资产（`README.md:179` 已经解释了为什么必须钉在 37.x：更高版本在 macOS 12 上起不来）。

---

## External References

| 来源 | 用途 |
|---|---|
| https://github.com/eeljoe/quota-viewer | 任务点名的对比对象；简介原文含 "Go + Wails, ~50MB vs Electron 200MB+" |
| https://github.com/sabahattinkalan/QuotaBar | "~6 MB binary (Tauri 2 + Rust)" 的句式来源 |
| https://github.com/cipherpine/quotapane | "small, auditable trust boundary" / "no installer and nothing to uninstall" |
| https://github.com/wzk2025/OpenQuota · https://github.com/silverlion2/quota-float · https://github.com/pinkpixel-dev/quota | 三家 Tauri 的定位原文（本地优先 / 隐私优先） |
| `.trellis/tasks/archive/2026-09/09-30-similar-projects-research/research/report.md` | 仓库内已有的 23 个竞品全景（CodexBar / ClaudeBar / codenotch / TokenTracker …），本次检索与它一致 |

## Caveats

- 竞品 star 数与简介取自检索快照（2026-10-01），会变；引用到 README 前建议复核。
- 「Tauri 用系统 WebView 所以内存只要几十 MB」是**结构性推断，本次没有实测任何一家 Tauri 竞品**。若要对外用这个对比，需要先自己装一个跑同样的 `footprint` 口径 —— 否则只能写「Tauri 用系统 WebView」这种不含数字的定性表述。
- `ClaudeBar` / `CodexBar` 是原生 Swift，检索到的 README 里**没有体积相关的表述**；「不打体积牌」是基于它们的技术栈推断，不是它们明确说过的话。