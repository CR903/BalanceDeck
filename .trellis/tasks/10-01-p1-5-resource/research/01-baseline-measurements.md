# Research: 实测基线（内存 / CPU / 加载面）

- **Query**: ① 默认形态（2D 圆环）的常驻内存 ② 开「个性人物」（three.js）时的常驻内存 ③ 峰值内存（采集一轮时）④ 区分「代码没加载 three.js」与「加载了但空闲」
- **Scope**: internal（真跑）
- **Date**: 2026-10-01

## 0. 复现方式（零代码改动）

```bash
# 前置：npm run build（out/ 是 gitignored，产物即被测对象）
npm run build

# A. 进程级内存 + CPU（球形态 / 收起态，60 s 窗口）
node .trellis/tasks/10-01-p1-5-resource/research/measure-memory.mjs ball 60 1

# B. 同上，人物形态
node .trellis/tasks/10-01-p1-5-resource/research/measure-memory.mjs figure 60 1

# C. 同上，展开态（不起 90 ms 轮询，作为 CPU 对照组）
node .trellis/tasks/10-01-p1-5-resource/research/measure-memory.mjs ball 60 0

# D. 3 轮采集（160 s）看有没有逐轮泄漏
node .trellis/tasks/10-01-p1-5-resource/research/measure-memory.mjs ball 160 1

# E. CDP 取证：渲染层真加载了哪些 chunk / 建了几个 WebGL 上下文 / 建了几个 canvas
node .trellis/tasks/10-01-p1-5-resource/research/probe-renderer.mjs ball 70
node .trellis/tasks/10-01-p1-5-resource/research/probe-renderer.mjs figure 70
```

脚本靠**两个已有的产品机制**切换形态，**没有改任何代码**：

- `BD_USER_DATA=<临时目录>`（`src/main/index.ts:43`）+ 在里面 seed
  - `secrets.bin = {"version":1,"items":{},"extras":{"ui:pet":"0"|"1"}}`
    —— `store.ts:12` 的磁盘格式里 `extras` 是**明文**，`overlay.ts:34 primePrefs` 直接 `getExtra('ui:pet')` 决定形态。
  - `state.json = {"collapsed":true}`
    —— `overlay.ts:92 loadPersisted` 读它决定建窗尺寸。不写 `collapsed` 就建 384×600 展开态，**展开态里根本没有 `PetBall`**，测不到收起态。
- `SMOKE_WAIT_MS`（`qa/modes.ts:51`）控制跑多久后自动 `app.quit()`。

**为什么不用 `--uitest`**：已知 flake（`petFigureUnchanged` 因 DPR=1 报红、进程常打完 JSON 不自行退出），采样窗口长度会变得不确定。`--smoke` 干净且自带退出（`qa/modes.ts:49-76`）。

**为什么不用 `--ballshot` 测内存**：它会 `capturePage()`（`ballshot.ts:91`）—— 截图本身是巨大的内存事件，会污染读数。它只用来取场景诊断。

### 环境

```
date  = 2026-10-01T08:50 ~ 09:30 UTC
host  = macOS 12.7.6  x86_64  (iMac / iMacPro1,1)
node  = v22.23.2
electron = 37.10.3   (node_modules/electron)
electron-vite = ^5.0.0 · vite 7.3.6
```

### 两个口径的区别（必须先说清，否则数字会被误读）

| 口径 | 命令 | 含义 | 问题 |
|---|---|---|---|
| `sum-of-RSS` | `ps -o rss` | 各进程 RSS 相加 | Chromium 的 Electron Framework 在 4 个进程间共享，**同一份物理页被计 4 次**。所以球形态出现「558 MB」而真实占用只有 ~340 MB。 |
| **`phys_footprint`** | `footprint -p <pid>` | macOS 把共享页按比例摊给各进程 | **诚实口径，本文所有"常驻内存"都用它。** `footprint` 会短暂挂起进程，单点读数有 ±5 MB 抖动 → 取 5 个采样点、末 3 点中位数。 |

---

## 1. 常驻内存基线

### 1.1 球形态（默认 2D 小圆环），收起态 56×56

命令输出（`raw/01-memory-ball-60s.txt`，逐字）：

```
### mode=ball (ui:pet=0)   SMOKE_WAIT_MS=30000 … host=macOS 12.7.6 x86_64 … electron=37.10.3
electron exit=0  wall=30.9s  采样条数=464

─── A. sum-of-RSS（ps 口径；会重复计入各进程共享的 Electron Framework）──────────
进程数  峰值 4 · 稳态中位 4 · 收尾 3
全树 RSS  稳态中位 558.5 MB   p90 559.0 MB   全程峰值 559.3 MB

─── B. phys_footprint（footprint -p；共享页按比例摊开，诚实口径）────────────
t=+ 10s  合计   379.0 MB   [74941:283  74962:40  74963:11  74984:45]
t=+ 20s  合计   380.0 MB   [74941:283  74962:40  74963:11  74984:46]
t=+ 36s  合计   378.0 MB   [74941:283  74962:40  74963:11  74984:44]
t=+ 48s  合计   378.0 MB   [74941:283  74962:40  74963:11  74984:44]
t=+ 56s  合计   378.0 MB   [74941:283  74962:40  74963:11  74984:44]
→ 全程峰值 footprint: 380.0 MB
→ 常驻口径（末 3 点中位）: 378.0 MB    末 2 点: 378.0 / 378.0 MB
```

同一形态换一次窗口（`raw/09` 第 [1] 组）：**335–336 MB**，主进程 242 MB。
→ **三次运行落在 335 / 377 / 382 MB**。**给区间，单点不可引用。**

分进程（`raw/01` 末桶 / `raw/09` 第 [1] 组）：

| 进程 | phys_footprint | sum-of-RSS | 说明 |
|---|---|---|---|
| main（Electron 浏览器进程） | 242 – 283 MB | 374.7 MB | 含 262 kB 的主进程 bundle + Node + Electron 自身 |
| renderer（唯一窗口） | 43 – 46 MB | 98 – 102 MB | 渲染层 V8 堆只用 5.4 MB，其余是 Blink/合成 |
| gpu | 39 – 40 MB | 51.8 MB | **即使不建 WebGL 上下文，Chromium 也照样起 GPU 进程**（合成需要） |
| utility（network service） | 10 – 11 MB | 30.3 MB | |
| **合计** | **335 – 382 MB** | **558 MB** | 4 个进程 |

### 1.2 人物形态（个性人物 / three.js），收起态 213×293

`raw/02-memory-figure-60s.txt`：

```
─── A. sum-of-RSS ─────────────────────────────────────────────────────────
进程数  峰值 4 · 稳态中位 4 · 收尾 3
全树 RSS  稳态中位 858.5 MB   p90 900.2 MB   全程峰值 900.3 MB

─── B. phys_footprint ────────────────────────────────────────────────────
t=+ 10s  合计   549.0 MB   [80290:303  80362:100  80363:10  80386:136]
t=+ 20s  合计   598.0 MB   [80290:307  80362:100  80363:10  80386:181]
t=+ 36s  合计   575.0 MB   [80290:311  80362:96  80363:10  80386:158]
t=+ 48s  合计   537.0 MB   [80290:315  80362:95  80363:10  80386:117]
t=+ 56s  合计   532.0 MB   [80290:318  80362:95  80363:10  80386:109]
→ 全程峰值 footprint: 598.0 MB
→ 常驻口径（末 3 点中位）: 537.0 MB    末 2 点: 537.0 / 532.0 MB
```

`raw/09` 第 [3] 组：**485 – 486 MB**（主进程 304 MB、GPU 95 MB、renderer 75–77 MB）。
→ **三次运行落在 485 / 532 / 537 MB**。

### 1.3 差值 = three.js + 3D 素材的真实代价

| 指标 | ball | figure | **差值** |
|---|---|---|---|
| `phys_footprint` 合计 | 335 – 382 MB | 485 – 568 MB | **+150 – 230 MB** |
| 其中 renderer | 43 – 46 MB | 75 – 131 MB | +32 – 85 MB |
| 其中 **gpu** | 39 – 40 MB | **95 – 100 MB** | **+56 – 60 MB**（纹理 + ACES + 软阴影） |
| 其中 main | 242 – 283 MB | 304 – 318 MB | +30 – 60 MB |
| `sum-of-RSS` 合计 | 558 MB | 793 – 858 MB | +235 – 300 MB |
| 渲染层 V8 堆 `usedSize`（CDP `Runtime.getHeapUsage`） | **5.4 MB** | **16.4 MB**（首屏）→ **26.1 MB**（模型+贴图就位后） | **+11 – 21 MB** |
| **CPU（46 s 稳态段）** | **2.0 – 2.2 % 单核** | **25 – 29 % 单核** | **+23 – 27 个百分点** |

`raw/09-cpu-wakeups-3-modes.txt` 的 CPU 分解：

```
### [3] figure + collapsed=1
   ── 稳定段 t=+10s → +56s（46s）内的 CPU 增量 ──
      main      +   0.3s   = 0.7% of one core
      gpu       +   6.9s   = 14.9% of one core      ← WebGL 每帧重绘
      renderer  +   4.3s   = 9.4% of one core      ← three.js 场景图 + 动画
      合计        +  11.5s   = 25.0% of one core
```

**GPU 进程与 renderer 各占 ~10–15 % 单核，这就是「3D 拖慢」的真实来源** —— 不是内存，是持续的每帧绘制。

---

## 2. 峰值内存（采集一轮时）

- **球形态 60 s 窗口**：`sum-of-RSS` 稳态中位 558.5 MB / 全程峰值 559.3 MB；`phys_footprint` 峰值 380.0 MB vs 稳态 378.0 MB。**采集那一轮没有可辨识的尖峰** —— 它在 t≈0–2 s 就完成了，落在启动爬坡（t=0.3 s 18.8 MB → t=4.3 s 357 MB）里，无法与爬坡分离。
- **跑够 160 s（≈3 轮采集，`raw/03`）**，时间线出现一个台阶：

```
+ 57.5s main= 358.5 rend= 102.6 gpu= 51.8 util= 30.1 ΣRSS= 543.1 n=4
+ 61.5s main= 358.6 rend= 102.7 gpu= 51.9 util= 30.1 ΣRSS= 543.2 n=4
+ 65.5s main= 434.9 rend= 103.3 gpu= 52.2 util= 30.1 ΣRSS= 620.5 n=4   ← +76 MB
+ 69.5s main= 428.6 rend= 105.1 gpu= 50.0 util= 30.1 ΣRSS= 613.8 n=4
...
+ 98.0s main= 420.9 rend=  99.2 gpu= 41.5 util= 19.8 ΣRSS= 581.5 n=4   ← 部分回落
+122.0s main= 414.5 rend=  81.3 gpu= 40.1 util= 19.5 ΣRSS= 555.5 n=4
+130.3s main= 425.4 rend=  81.6 gpu= 40.1 util= 19.5 ΣRSS= 566.8 n=4   ← +11 MB
+159.0s main= 425.5 rend=  81.8 gpu= 40.1 util= 19.5 ΣRSS= 567.0 n=4   ← 稳住
```

**结论**：主进程在**第一轮 60 s 采集**处跳 +71 MB（`phys_footprint` 282 → 353 MB），第 2 轮 +0 MB、第 3 轮 +11 MB，之后停在 414–428 MB。
**是一次性预热**（V8 JIT + 采集路径上的惰性模块 + 网络/解密缓冲），**不是逐轮泄漏**。但对外若要给"峰值"，应写 **~620 MB（sum-of-RSS）/ ~447 MB（phys_footprint，跑满 3 轮后）**。

---

## 3. 区分「没加载 three.js」与「加载了但空闲」

### 3.1 试过并**排除**的两条路（省得后来人再踩）

| 方法 | 结果 |
|---|---|
| `--log-net-log=<file>` | netlog 里 **0 条 `file://` URL**（file scheme 走 file:// handler，不进 netlog 的 network stack）。人物形态下还会把 network service 搞崩重启（`ERROR:network_service_instance_impl.cc:597] Network service crashed, restarting service.`）。**不可用。** |
| `performance.getEntriesByType('resource')` | `file://` 的 `<script type=module>` **不产生 Resource Timing 条目**，实测返回空数组。**不可用。** |
| `Page.reload` 后再看 | `App.tsx:101` 的 `collapsed` 默认 `false`，重载后不再从主进程拿 → 页面变**展开态**、`PetBall` 根本没挂上。两种形态重载后都是 `canvas=0` / `__bd_ball=null`。**只能用来抓冷加载的静态资源，抓不到形态切换。** |

**剩下可用的是 CDP**：`--remote-debugging-port=0` → Chromium 把端口写进 `<BD_USER_DATA>/DevToolsActivePort` → WebSocket 打 `Runtime.evaluate` / `Network.*` / `Runtime.getHeapUsage`。全程零代码改动。

### 3.2 静态面：three.js 就在入口 chunk 里（`raw/07`）

```
out/renderer/assets/
  index-CnTfnHRm.js   1,699,669 B   ← 唯一的 <script type=module>
  human-EpA39Kp9.js     120,740 B   ← 动态 import
  index-gJteAiOs.css     83,209 B
  voice-CCQ2qdzT.js        2,747 B   ← 动态 import
```

对 `index-CnTfnHRm.js` 逐个特征串 grep：

```
$ node -e "…"
index chunk bytes: 1699669
has WebGLRenderer: true
has ACESFilmic: true
has RoomEnvironment: true
has PMREMGenerator: true
has SkinnedMesh: true
has GLTFLoader: false
has AnimationMixer: true
```

导入链（全部静态）：
- `src/renderer/src/App.tsx:7` → `import { PetBall } from './PetBall'`
- `src/renderer/src/PetBall.tsx:11` → `import { createPet3dScene, type Pet3dHandle } from './pet3d/scene'`
- `src/renderer/src/pet3d/scene.ts:1` → `import * as THREE from 'three'`
- `src/renderer/src/pet3d/scene.ts:2` → `import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'`

**three.js 有多大？** 用一份一次性 vite 配置（写在仓库外，`outDir` 也指到临时目录，不改仓库任何文件）把 `node_modules/three` 拆成独立 chunk：

```
$ npx electron-vite build --config <tmp>/three-split.config.mjs
out/renderer/assets/index-DjBmP0Qp.js     514.47 kB   ← 只剩应用自己的代码
out/renderer/assets/three-DGAWYAdk.js   1,298.53 kB   ← three.js 本体
out/renderer/assets/human-CvAKuNJi.js       8.41 kB
```

| chunk | 现在 | three 拆出后 |
|---|---|---|
| 入口 `index-*.js` | **1,699,669 B** | **514,469 B** |
| `three-*.js` | （不存在） | **1,298,531 B** |
| `human-*.js` | 120,740 B | 8,408 B（FBXLoader/SkeletonUtils 挪进了 three chunk） |
| CSS | 83,209 B | 83,209 B（不变） |

→ **three.js = 入口 chunk 的 76 %（1.30 MB / 1.70 MB）。**

**验证「拆 chunk 本身不省内存」**：把 three 拆出来后再跑一次球形态 CDP 探针（`raw/06`），`Runtime.getHeapUsage` = **usedSize 5.7 MB**，与不拆时的 **5.4 MB** 基本相同。
→ **光拆 chunk 不够；必须让 import 变动态，three 才会真的不被加载。** 光拆 chunk 的收益只在解析时序与磁盘。

### 3.3 运行时面：球形态到底加载了什么（`raw/04-probe-ball-cdp.txt`，逐字）

```
① 首屏（生产启动后，**未** reload）
   <script> 标签          : [{"type":"module","src":"file:///…/out/renderer/assets/index-CnTfnHRm.js"}]
   <canvas> 数            : 0
   .pet3d-canvas         : null
   .petball data-figure   : 0
   window.__bd_ball 类型  : function
   __bd_ball()            : {"petReady":false,"rect":null,"clipParseMs":0,"dumpLen":0}
   Runtime.getHeapUsage   : usedSize=5.4 MB  totalSize=7.5 MB

② Page.reload 冷加载 —— Network.requestWillBeSent 全量（只列渲染层相关）
   assets/index-CnTfnHRm.js
   assets/index-gJteAiOs.css
   assets/voice-CCQ2qdzT.js
   index.html
   总请求数 8，其中渲染层相关 4

   判定:
      入口 chunk index-*.js（含 three.js 本体）: true
      human-*.js（FBX/骨骼/材质，**动态** import）: false
      voice-*.js（speechOut **动态** import）      : true
      bd-asset:// 3D 素材                        : false

③ UI 驱动切到「个性人物」（ballshot.ts:41-49 那套 JS；Network 全程开着）
   驱动日志 : {"switch":"clicked","petReadyAtSec":"1.0"}
   bd-asset://aria/anims/f_idle_breathe_01.fbx
   bd-asset://aria/anims/f_walk_neutral.fbx
   bd-asset://aria/anims/f_wave_01.fbx
   bd-asset://aria/model.fbx
   bd-asset://aria/preview.png
   bd-asset://aria/textures/f014_body_color.png
   bd-asset://aria/textures/f014_body_normal.png
   bd-asset://aria/textures/f014_body_specular.png
   bd-asset://aria/textures/f014_head_color.png
   bd-asset://aria/textures/f014_head_normal.png
   bd-asset://aria/textures/f014_head_specular.png
   bd-asset://aria/textures/f014_opacity_color.png
   bd-asset://ray/preview.png
   assets/human-EpA39Kp9.js
   → human-*.js（FBX/骨骼/材质）: **已加载**
   → bd-asset:// 3D 素材         : 13 个请求
   <canvas> 数=1  .pet3d-canvas=[213,293,213,293]  data-figure=1
   __bd_ball()          : {"petReady":true,"rect":{"x":26.88,…,"height":212.83},"clipParseMs":317,"dumpLen":3}
   Runtime.getHeapUsage : usedSize=26.1 MB  totalSize=62.7 MB

④ SystemInfo.getProcessInfo（browser 端点）
   type=browser   pid=69598 cpuTime=2.444
   type=renderer  pid=69601 cpuTime=3.074
   type=GPU       pid=69599 cpuTime=2.833
   type=network…  pid=69600 cpuTime=0.222
```

（`data:image/svg+xml` 那条被 grep 过滤掉了，是 `ProviderMark` 的品牌标记内联 SVG，不是 3D 素材。）

### 3.4 判定矩阵

| | 球形态（默认） | 人物形态 |
|---|---|---|
| `<script type=module>` 数量 | 1（`index-CnTfnHRm.js`，**内含 three.js 1.30 MB**） | 1 + 动态 `human-EpA39Kp9.js` |
| `human-*.js`（FBXLoader / SkeletonUtils / SkinnedMesh） | **未加载** | 已加载 |
| `bd-asset://` 3D 素材请求数 | **0** | **13** |
| `<canvas>` 数 | **0** | 1（213×293） |
| WebGL 上下文 | **未创建**（`PetBall.tsx:188 if (!figure) return`） | 已创建 |
| GPU 进程 | **仍然存在**（39–40 MB，Chromium 合成需要） | 95–100 MB |
| 渲染层 V8 `usedSize` | 5.4 MB | 16.4 → 26.1 MB |
| **three.js 本体（代码）** | **已加载** ❌ | 已加载 |

**唯一不成立的一句是「默认形态不加载 three.js」。** 其余（不建 WebGL 上下文 / 不下载 3D 素材 / 不解析 FBX / 不占显存）全部为真，且可用上面这套 CDP 流程随时复验。

---

## 4. `resources/human-pets/` 核对

```
$ du -sh resources/human-pets/*
 94M  resources/human-pets/aria
 96M  resources/human-pets/ray
 31M  resources/human-pets/reyna-pilot
 221M  resources/human-pets  （49 个文件）

按扩展名：
  24 fbx   49.9 MB   ← 运行时真正读的（模型 + 动作）
  10 tga  128.0 MB   ← **运行时从不读**（见下）
   1 glb   31.0 MB   ← **全仓库零引用**（reyna-pilot/model.glb）
  12 png   12.2 MB   ← 贴图 + preview.png
   2 json   0.0 MB
```

### 4.1 `.tga` 为什么是死重（128 MB）

- `src/renderer/src/pet3d/human.ts:27-33`：FBX 里记的是 `xxx.tga`，加载时按 basename 重定向到 `textures/<base>.png`
  ```ts
  if (/\.tga$/i.test(base)) return asset(id, `textures/${base.replace(/\.tga$/i, '.png')}`)
  ```
- `scripts/fetch-human-pets.mjs:111-119`：采集期把 `.tga` 用 `sips` 转成 `textures/*.png`，**但从不删掉源 `.tga`**（`:145` 只是把它排除在体积统计之外，`:149` 打印 "converted, tga excluded"）。
- `src/main/human-assets.ts:39-44` 的 `MIME` 表里**没有 `.tga`**，进一步说明这条路径设计时就没打算服务 `.tga`。
- CDP 探针抓到的 7 张贴图请求**全是 `.png`**（`f014_body_color.png` 等），0 条 `.tga`。

### 4.2 `reyna-pilot/` 为什么是死重（31 MB）

- `src/shared/pet.ts:46-49` 的 `PETS` 只有 `aria` / `ray`。
- `scripts/fetch-human-pets.mjs:26-44` 的 `PETS` 也只有 `aria` / `ray` —— **`reyna-pilot` 不是这个脚本产出的**，是更早的 GLB 原型遗留（README.md:208 的 Roadmap 还留着「外部 GLB 模型加载」）。
- 全仓库 `grep -rn "reyna" src/ scripts/ electron-builder.yml README.md` → **0 命中**。
- `MIME` 表也没有 `.glb`。

### 4.3 它在不在打包产物里 —— 在，而且实测了 `.app` 总体积

`electron-builder.yml:9-14`：

```yaml
extraResources:
  - from: build
    to: build
  # 真人系宠物素材（MIT，gitignored，dist 前由 predist 钩子拉取；缺失则构建失败并提示）
  - from: resources/human-pets
    to: human-pets
```

`src/main/human-assets.ts:29-34`：

```ts
const candidates = [
  join(process.resourcesPath, 'human-pets'),   // ← 打包后的落点
  join(app.getAppPath(), 'resources', 'human-pets')
]
```

两者互为证据：这 221 MB 必然随包分发到 `<App>/Contents/Resources/human-pets`（`.app` 里是未压缩裸文件，不是 asar）。

**实测（`npx electron-builder --mac --dir`，2026-10-01，本机网络受限跑了两次才成功；`raw/10`）**

```
=== .app 总体积 ===
520M	dist/mac/BalanceDeck.app

=== Contents 顶层 ===
262M	…/Contents/Frameworks          ← Electron 37 运行时（结构性，改不动）
258M	…/Contents/Resources
 20K	…/Contents/MacOS

=== Resources 内 ===
237M	…/Resources/human-pets        ← 3D 素材（裸文件，未压缩）
 20M	…/Resources/app.asar
372K	…/Resources/build

=== human-pets 按扩展名（真实字节）===
  fbx       49.9 MB  (24 个)
  tga      128.0 MB  (10 个)      ← 从不读
  png       12.2 MB  (12 个)
  glb       30.9 MB  ( 1 个)      ← 全仓库零引用
  json       0.0 MB  ( 2 个)
```

| `.app` 构成 | 大小 | 占比 |
|---|---|---|
| `Contents/Frameworks`（Electron 37 运行时） | **262 MB** | 50.4 % |
| `Contents/Resources/human-pets/` | **237 MB** | 45.6 % |
| `Contents/Resources/app.asar` | **20.79 MB** | 4.0 % |
| 其他（build / icon / lproj） | ~0.5 MB | 0.1 % |
| **合计** | **520 MB** | |

→ **其中 158.9 MB（`.tga` 128.0 + `reyna-pilot/model.glb` 30.9）是运行时从不被读取的死重，占 `.app` 的 30.6 %。**

---

## 5. 顺带量到的：CPU（= 定时器唤醒的总账）

`raw/09-cpu-wakeups-3-modes.txt`，口径 = `ps -o time` 的累计 CPU 时间在稳定段（t=+10 s → +56 s，46 s）的增量：

| 形态 | main | gpu | renderer | **合计** |
|---|---|---|---|---|
| ball + **收起**（56×56，两条 90 ms 轮询在跑） | 0.7 % | 0.6 % | 0.8 % | **2.2 % 单核** |
| ball + **展开**（384×600，两条 90 ms 轮询不起） | 0.0 % | 0.2 % | 0.1 % | **0.3 % 单核** |
| figure + 收起 | 0.7 % | 14.9 % | 9.4 % | **25.0 % 单核** |
| figure + 收起（另一次运行） | 0.8 % | 14.2 % | 14.2 % | **29.1 % 单核** |

**两条 90 ms 轮询（`src/main/overlay.ts:433` 主进程光标轮询 + `src/renderer/src/PetBall.tsx:332` 命中区上报）值 1.7–1.9 个百分点单核。** 它们只在收起态存在（`overlay.ts:276 setPetCursorWatch(collapsed)`、`overlay.ts:204` 冷启动补上），而收起态是这个应用的常态。

---

## Caveats / 未量到

1. **测量用的是一次性空 userData，没有任何供应商凭据。** GitHub Copilot 返回 `HTTP 404`、其余走本机估算。**配了 OpenCode Go cookie 的真实用户会更高** —— 会多走 `src/main/adapters/opencode.ts:721` 的 `fetchConsoleDetails` 与 `opencode-details.ts` 的网络请求。
2. **run-to-run 方差**：同一形态 3 次运行，`phys_footprint` 相差最多 47 MB（主进程 242 ↔ 283 MB）。所有数字都给区间。
3. **只测了 macOS x86_64 的 `--dir`（未压缩未签名）**。`dist:mac` 的 dmg / zip 与 `dist:win` 的 nsis / zip **压缩后的体积没有测**（zip 会把 `.fbx`/`.png` 这类已压缩格式进一步压得很小，但 `.tga` 本身接近未压缩，收益不同）。Windows 的 nsis 体积同理未测。
4. **`sum-of-RSS` 不可单独对外引用** —— 它把 4 个进程共享的 Framework 页计了 4 次（球形态 558 MB vs 真实 ~340 MB）。对外沟通请用 `phys_footprint`。
5. `footprint -p` 会短暂挂起进程；单点读数有 ±5 MB 抖动，本文取末 3 点中位数。
6. **`Process` 数量恒为 4**（main / renderer / gpu / network service）。**球形态也会起 GPU 进程** —— 「不用 3D 就不占 GPU」是错的，只能说「GPU 进程的 footprint 从 95–100 MB 降到 39–40 MB」。
7. **`.app` 是 520 MB，其中 262 MB 是 Electron 运行时本身**（`Contents/Frameworks`，结构性）。这意味着**即使把 159 MB 死重全清掉，BalanceDeck 的下限也在 ~360 MB** —— 见 `03-docs-and-competitors.md` §3.4 对「能不能打赢 50 MB 的 Wails / 6 MB 的 Tauri」的诚实结论。