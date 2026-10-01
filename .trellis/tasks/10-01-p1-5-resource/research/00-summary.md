# Research: 资源占用优化（实现前调研）

- **Query**: 「资源占用优化」实现前调研 —— ① 常驻内存实测基线 ② 低风险优化候选（带 file:line） ③ 文档现状与修正建议 ④ 竞品话术
- **Scope**: internal（主）+ external（竞品 README）
- **Date**: 2026-10-01
- **Task**: `.trellis/tasks/10-01-p1-5-resource`
- **边界**: 本轮**没有改动任何产品代码**。只新增了 `research/` 下的脚本、Markdown 与原始输出。

## 交付物

| 文件 | 内容 |
|---|---|
| `00-summary.md` | 本文。主报告：结论 + 四个卖点的真伪判定 |
| `01-baseline-measurements.md` | 实测基线数字（命令 + 环境 + 原始输出摘录 + 复现步骤） |
| `02-optimization-candidates.md` | 优化候选清单（file:line、风险等级、预估收益、是否碰共享文件） |
| `03-docs-and-competitors.md` | README/DESIGN 现状逐条核对 + 竞品（quota-viewer / QuotaBar / CodexBar / ClaudeBar…）话术 |
| `04-open-questions.md` | 需要用户确认的问题 |
| `measure-memory.mjs` | 进程级内存 + CPU 实测脚本（`ps` + `footprint`，零代码改动） |
| `probe-renderer.mjs` | CDP 取证脚本：默认形态到底加载了哪些 chunk / 3D 素材 / 建了几个 WebGL 上下文 |
| `sourcemap-attrib.py` | 按 sourcemap 把 bundle 字节归因到源文件 |
| `raw/*.txt` | 8 份原始输出（命令的逐字 stdout） |

---

## 一句话结论

**「默认形态不加载 three.js」这句话是错的，必须改。** 其余三句（不建 WebGL 上下文 / 不下载 3D 素材 / CPU 只占 2% 单核）经实测为真。
三处改动就能让它变成真的，且最大的一处收益根本不在内存上，而在**安装包体积**：包里现在躺着 **159 MB 从来不会被读取的 3D 素材**。

---

## ① 实测基线（macOS 12.7.6 x86_64 / Electron 37.10.3 / Node 22.23.2）

`phys_footprint` 是 macOS 把 Chromium 各进程共享的 Framework 页按比例摊开后的物理内存，是诚实口径；`sum-of-RSS` 会把同一份共享页在每个进程里各记一次，仅作对照。

| 形态 | 窗口 | 进程数 | **phys_footprint（常驻）** | sum-of-RSS | V8 堆（渲染层） | **CPU（46s 稳态段）** |
|---|---|---|---|---|---|---|
| **ball（默认 2D 小圆环）** | 收起 56×56 | 4 | **335 – 382 MB** | 558 MB | 5.4 MB used / 7.5 MB total | **2.0 – 2.2 % 单核** |
| ball（默认 2D 小圆环） | 展开 384×600 | 4 | 389 – 394 MB | 570 MB | — | 0.3 – 0.5 % 单核 |
| **figure（个性人物 / three.js）** | 收起 213×293 | 4 | **485 – 568 MB** | 793 – 858 MB | 16.4 MB（首屏）→ 26.1 MB（满载） | **25 – 29 % 单核** |
| **差值 figure − ball** | | | **+150 – 230 MB** | +235 – 300 MB | +11 – 21 MB | **+23 – 27 个百分点** |

峰值（球形态，60 s 窗口）：`sum-of-RSS` 稳态中位 558.5 MB / 峰值 560.9 MB；`phys_footprint` 峰值 380.0 MB。**采集那一轮没有可辨识的尖峰** —— 采集在 t≈0–2 s 完成，落在启动爬坡里。

跑够 160 s（≈3 轮采集）后有一个台阶：主进程 `phys_footprint` 在 **t≈62–65 s（正好是第一轮 60 s 采集）从 282 MB 跳到 353 MB（+71 MB）**，之后第 2、3 轮只 +0 / +11 MB 并停在 414–428 MB。**是一次性预热（JIT + 采集路径上的惰性模块 + 网络缓冲），不是逐轮泄漏。**

命令、环境、逐桶原始输出见 `01-baseline-measurements.md` 与 `raw/01,02,03,09`。

---

## ② 四个对外卖点，逐条判定

| 卖点 | 判定 | 证据 |
|---|---|---|
| 「默认形态**不加载 three.js**」（`README.md:45-46`） | ❌ **不成立** | `PetBall.tsx:11` 静态 `import … from './pet3d/scene'`，`scene.ts:1` 静态 `import * as THREE from 'three'`。CDP 首屏快照：`document.querySelectorAll('script[type=module]')` 只有一个 `index-CnTfnHRm.js`，而该 chunk **1,699,669 B 里有 1,298,574 B（76%）是 three.js**。球形态渲染层照样把它解析了。 |
| 「默认形态**不建 WebGL 上下文**」 | ✅ 成立 | CDP：球形态 `<canvas>` 数 = **0**、`.pet3d-canvas` = `null`；`__bd_ball()` = `{petReady:false, rect:null, dumpLen:0}`。`PetBall.tsx:188` 的 `if (!figure) return` 是结构性的（不是"建了空场景"）。 |
| 「默认形态**不下载任何 3D 素材**」 | ✅ 成立 | CDP `Network.requestWillBeSent` 全量：球形态首屏只有 `index.html` / `index-*.js` / `index-*.css` / `voice-*.js`，**`human-*.js` 分包与 `bd-asset://` 请求均为 0 条**。切到个性人物的那一刻才出现 `human-EpA39Kp9.js` + **13 条** `bd-asset://`（model.fbx / 3 条基础动作 / 7 张贴图 / 2 张 preview.png）。 |
| 「3D 效果拖慢启动不会落在不用它的人身上」 | ✅ 成立（但理由要改写） | 球形态 CPU 2.0–2.2 % 单核、GPU 进程 footprint 39–40 MB。慢的是**人物形态**：GPU 进程 95–100 MB、renderer 77–131 MB、CPU 25–29 % 单核。 |

> ⚠ `README.md:45-46` 这句是 commit `89d5f3b`（"球形态回到 2D 小圆环"）加的；`git show 89d5f3b:src/renderer/src/PetBall.tsx` 显示**那一次提交里静态 import 就已经存在**，所以这句从写下起就不准确，不是后来退化的。

---

## ③ 优化候选（详见 `02-optimization-candidates.md`）

按「收益 ÷ 风险」排序，全部**不碰** `src/shared/**` 的契约型文件（唯一例外已单独标注）：

| # | 候选 | file:line | 风险 | 预估收益 |
|---|---|---|---|---|
| 1 | **打包时排除 `.tga` 与 `reyna-pilot/`** —— 两者运行时**从不被读取** | `electron-builder.yml:9-14` | **极低** | **`.app` −158.9 MB**（520 → 361 MB） |
| 7 | **`three` / `react` / `react-dom` 移到 `devDependencies`** —— 主进程一个都不 require | `package.json:57-61` | 低 | **`app.asar` −18.9 MB**（20.79 → ~1.9 MB） |
| 2 | `PetBall` 的 `./pet3d/scene` 静态 import → 动态 import（仓库已有先例） | `src/renderer/src/PetBall.tsx:11` | 低 | 首屏 JS **1.70 MB → 486–514 kB（−71 %）**；之后「不加载 three.js」才成立 |
| 3 | 主进程 QA 模块（`uitest.ts` 等）改动态 import | `src/main/index.ts:17-18` | 低 | 主进程 bundle **262 kB → 13 kB（−95 %）** |
| 4 | 两条 90 ms 轮询合并（**不改频率**，只去掉一个） | `src/main/overlay.ts:433` + `src/renderer/src/PetBall.tsx:332` | **中**（碰命中判定） | 收起态 CPU **−1.9 个百分点单核**（2.2% → 0.3%） |
| 5 | 设置页 / 详情页视图改 `React.lazy` | `src/renderer/src/App.tsx:4-6` | 低–中 | 首屏 JS 再减 ~38 % 的自有代码（**总量 −11 %**，因为 react-dom 占 53 %） |
| 6 | 设置页不再预取**未选中**角色的 `preview.png` | `src/renderer/src/PetSection.tsx:51-60` | 低 | 设置页打开时少 454 kB 网络 + 一张解码位图 |

**实测的 `.app` 总体积 = 520 MB**（macOS x86_64 `--dir`，未压缩未签名，`raw/10`）：

| 构成 | 大小 | 占比 |
|---|---|---|
| `Contents/Frameworks`（Electron 37 运行时，**结构性、改不动**） | **262 MB** | 50.4 % |
| `Contents/Resources/human-pets/` | **237 MB** | 45.6 % |
| ├─ `.tga` × 10 —— **从不读** | 128.0 MB | 24.6 % |
| ├─ `.fbx` × 24 | 49.9 MB | 9.6 % |
| ├─ `reyna-pilot/model.glb` —— **零引用** | 30.9 MB | 5.9 % |
| └─ `.png` × 12 | 12.2 MB | 2.3 % |
| `Contents/Resources/app.asar` | 20.79 MB | 4.0 % |
| └─ 其中 `node_modules`（**主进程一个都不 require**） | 18.9 MB | 3.6 % |
| 其他（build / icon / lproj / MacOS） | ~0.5 MB | 0.1 % |

**#1 + #7 落地后：520 MB → ~342 MB**，其中 262 MB 是 Electron 运行时本身。

---

## ④ 文档现状（详见 `03-docs-and-competitors.md`）

- **`README.md:45-46` 必须改**：唯一一处**事实性错误**（"默认状态下不加载 three.js"）。其余表述（不建 WebGL 上下文 / 不下载 3D 素材 / 不占显存）实测为真。
- `DESIGN.md:303`「球形态不加载人物素材：默认形态既不下载 human 分包也不解析 FBX」—— 逐字为真，**不要动**，它比 README 精确。
- `DESIGN.md:338`「`human.ts` … 约 118KB → 独立 chunk」—— 实测 120,740 B，一致。
- **仓库里没有 FAQ 文档**（`find . -iname "*faq*"` 无结果；README 里也没有「常见问题」章节）。PRD 提到的「FAQ」若要新建，需要先定位置。
- 竞品的真实话术：竞品里**大多数根本不是 Electron，是 Tauri**，主打「~6 MB 二进制」（`sabahattinkalan/QuotaBar` 原话 "⚡ Lightweight — ~6 MB binary (Tauri 2 + Rust)"）；`eeljoe/quota-viewer` 打的是 "Minimal, low RAM & disk (Go + Wails, ~50MB vs Electron 200MB+)"。**没人在比内存，都在比安装包** —— 这正好是本仓库最强的一处（见候选 #1）。

---

## ⑤ 与任务描述不一致之处（已核实，供 main agent 判断）

1. `resources/human-pets/` 实测 **221 MB**（aria 94 M + ray 96 M + reyna-pilot 31 M）—— 数字对；打进 `.app` 后是 **237 MB**（块对齐）。
2. 但「确认它**不在**打包产物里」的前提不成立：**它就在包里**。`electron-builder.yml:12-14` 明确 `extraResources: from: resources/human-pets → to: human-pets`，而 `src/main/human-assets.ts:31-32` 的 `assetRoot()` 第一优先就是 `join(process.resourcesPath, 'human-pets')` —— 打包后的读点。两者互为证据。实测 `.app` = **520 MB**，其中 `human-pets/` **237 MB**。
3. **实测 `.app` 总体积 = 520 MB**（`npx electron-builder --mac --dir`，未压缩未签名，`raw/10`）：`Contents/Frameworks` **262 MB**（Electron 运行时，**结构性、改不动**）+ `human-pets/` 237 MB + `app.asar` 20.79 MB + 其余 0.5 MB。
4. 候选 #1 指出 `human-pets/` 里 **158.9 MB 是死重**：`.tga` × 10 = **128.0 MB**（`human.ts:33` 把 `.tga` 重定向到 `textures/*.png`；`human-assets.ts:39-44` 的 MIME 表里根本没有 `.tga`；`fetch-human-pets.mjs:111-119` 转完不删源文件）＋ `reyna-pilot/model.glb` **30.9 MB**（`src/shared/pet.ts:46-49` 只有 aria/ray；全仓库零引用）。
5. 候选 #7（新增）：`app.asar` 的 20.79 MB 里 **18.9 MB（91 %）是运行时没有任何代码 require 的 npm 包** —— `out/main/index.js` 只 require `crypto` / `electron` / `fs` / `os` / `path`。`three` 一个包就占 14 MB / 714 个文件（含 5.4 MB 的 `three/src` 与从未使用的 `three.webgpu*.js`）。

## 未完成 / 不确定

- **只测了 macOS x86_64**。`dist:win`（nsis）与 dmg/zip 的**压缩后体积没测**；`footprint` 这个口径在 Windows 上也跑不了（见 `04-open-questions.md` Q8）。
- **本机测量用的是一次性空 userData（没有任何供应商凭据）**：GitHub Copilot 返回 HTTP 404、其余走本机估算。**配了 cookie 的真实用户更高**（会多走 `opencode.ts:721` 的控制台明细抓取）。
- 内存数字的 **run-to-run 方差达 47 MB**（主进程 `phys_footprint` 242 ↔ 283 MB）。所以本文给的是**区间**，单点数字不可引用。
- **同目录下的 `measure-memory.mjs` / `probe-renderer.mjs` 被并发会话提前 commit 过**（commit `6c81361`）。工作区里的版本才是产出 `raw/` 的最终版（多出 CPU 采样、`collapsed` 参数、CDP 超时与 session 重连修复）。**若之后有人 checkout 那个 commit，会拿到不能用的中间版本。**
- **「在安装包总体积上能不能打赢竞品」这一格答不了**：`Contents/Frameworks` 的 262 MB 是 Electron 运行时本身，清掉全部死重后仍有 ~342 MB，而 quota-viewer 自述 50 MB。详见 `03-docs-and-competitors.md` §3.5。