# 实测记录：资源占用优化（2026-10-01）

> 本文件是**实测原始输出的索引**。每个数字都能指到一份原始输出；
> 口径、命令与脚本一律复用调研留下的 `research/measure-memory.mjs` 与
> `research/probe-renderer.mjs`，没有另起一套。

## 环境

```
host   = macOS 12.7.6 x86_64 (iMacPro1,1)
node   = v22.23.2
electron = 37.10.3   electron-vite ^5.0.0   vite 7.3.6
load average（采集期间）= 7.7 – 8.4 ⚠ 见「CPU 口径的坑」
```

## 一、磁盘：`resources/human-pets`

| | 基线 | 优化后 |
|---|---|---|
| `resources/human-pets` | **221 MB** | **62 MB**（实测 62.2 MB） |
| `.tga` × 10 | 128.0 MB（134,218,168 B） | **0** |
| `reyna-pilot/model.glb` | 31.0 MB（32,406,104 B） | **0** |
| `.fbx` × 24 | 49.9 MB | 49.9 MB（未动） |
| `.png` × 12 | 12.2 MB | 12.2 MB（未动） |

删除前留档：`reyna-pilot/` = 31M / 32,406,104 B，`md5 = 0472a1174d9303ca8e5b7f3fa9c116bf`。

`npm run fetch:humans` 输���：

```
aria: 删掉 5 个已转换的 .tga，释放 64.0MB
ray: 删掉 5 个已转换的 .tga，释放 64.0MB
human-pets cached → …/resources/human-pets
```

**「构建钩子仍能重跑」的验证（确定性、非网络）**：把真实素材树复制到临时目录，
人为放回 11 个 `.tga`（其中 1 个没有同名 `.png`），跑 `node scripts/fetch-human-pets.mjs --out <tmp>`
（`todo` 为空 → 零网络）：

```
BEFORE 150M   tga 11 个
  aria: 删掉 5 个已转换的 .tga，释放 40.0MB
  aria: 保留 1 个 .tga（同名 .png 尚未就位）
  ray: 删掉 5 个已转换的 .tga，释放 40.0MB
  human-pets cached → …/bd-sweep-test2
AFTER  70M    tga 1 个（正是那个没转成 .png 的）  png 12 个  fbx 24 个
```

→ 转 PNG 的流程没被破坏，「只删已转换的」这条语义成立，且清理点确实在
`human-pets cached` 短路**之前**（否则这棵树不会变 70M）。

⚠ **本机网络下 `fetch:humans` 的「全新下载」路径无法完成**：拉 221 MB 时 fetch 被
中断（`terminated` / `fetch failed`，原始输出 `raw/18-fetch-fresh-network-control.txt`）。
**对照实验**：`git show HEAD:scripts/fetch-human-pets.mjs`（未改动的原版）跑同一个全新目录，
**同样** exit 1（`fetch failed`）—— 即这是本机网络限制，与本次改动无关。
功能等价的验证改由上面的零网络用例承担。

## 二、首屏 JS：构建产物实测

| chunk | 基线 | 优化后 |
|---|---|---|
| 入口 `index-*.js` | **1,699,669 B**（1699.67 kB） | **489,106 B**（477.64 kB）**−71.2 %** |
| `three-*.js` | （不存在） | **1,182,414 B** |
| `scene-*.js` | （不存在） | 30,025 B |
| `human-*.js` | 120,740 B | 120,816 B |
| CSS | 83,209 B | 83,209 B |

AC「入口 < 600 kB」= **PASS**（489,106 < 614,400）。

three.js 特征串在**入口 chunk 里全部消失**，并在 `three-*.js` 里出现：

| 特征串 | 入口 `index-*.js` | `three-*.js` | `scene-*.js` | `human-*.js` |
|---|---|---|---|---|
| `WebGLRenderer` | **false** | true | — | — |
| `ACESFilmic` | **false** | true | — | — |
| `PMREMGenerator` | **false** | true | — | — |
| `SkinnedMesh` | **false** | true | — | — |
| `AnimationMixer` | **false** | true | — | — |
| `RoomEnvironment` | **false** | — | true | — |
| `FBXLoader` | **false** | — | — | true |

原始输出：`raw/12-bundle-after.txt`。

## 三、CDP 运行时取证：球形态到底加载了什么

命令：`node research/probe-renderer.mjs ball 70`（原始输出 `raw/11-probe-ball-cdp-after.{txt,json}`）

**球形态冷加载（`Page.reload`）的渲染层相关请求，全量 4 条：**

```
assets/index-C0A6XRMa.js
assets/index-gJteAiOs.css
assets/voice-CCQ2qdzT.js
index.html
总请求数 8，其中渲染层相关 4
```

| 判定项 | 基线 | 优化后 |
|---|---|---|
| `three-*.js` 请求数 | —（在入口 chunk 内，无独立请求） | **0** |
| `scene-*.js` 请求数 | —（同上） | **0** |
| `human-*.js` 请求数 | false | false |
| `bd-asset://` 3D 素材 | 0 条 | **0 条** |
| `<canvas>` 数 | 0 | 0 |
| 渲染层 V8 `usedSize`（首屏） | 5.4 MB | **4.5 MB** |

**切到个性人物的那一刻才出现**（同一份 Network 全程开着）：

```
assets/three-wZxwjy_j.js
assets/scene-DSiVMxFF.js
assets/human-Ch0XCOva.js
bd-asset:// 13 个请求（model.fbx / 3 条基础动作 / 7 张贴图 / 2 张 preview.png）
<canvas> 数=1  .pet3d-canvas=[426,586,213,293]  data-figure=1
__bd_ball() : {"petReady":true, …}
```

→ **7 张贴图请求仍然全是 `.png`，0 条 `.tga`** —— 删掉 128 MB 的 `.tga` 没有影响运行时。

人物形态单独一轮（`probe-renderer.mjs figure 70`，`raw/11-probe-figure-cdp-after.txt`）：
首屏 `usedSize=17.4 MB`，切形态后 `usedSize=23.7 MB`，`petReady:true`、canvas 就位。

## 四、常驻内存与 CPU（`research/measure-memory.mjs`，与基线同一套口径）

### 球形态（默认 2D 小圆环，收起态 56×56）

| | 基线（3 次运行） | 优化后 |
|---|---|---|
| `phys_footprint` 常驻 | 335 / 377 / 378 / 380 / 382 MB | **382 MB** |
| `sum-of-RSS` 稳态中位 | 558.5 MB | 562.2 MB |
| CPU（46 s 稳态段） | 2.0 – 2.2 % 单核 | **2.1 % 单核**（main 0.8 / gpu 0.5 / renderer 0.8 / utility 0.0） |

→ 落在基线区间内，**无回归**。

### 人物形态（个性人物 / three.js，收起态 213×293）

| | 基线（3 次运行） | 优化后（**同会话同负载**对照） |
|---|---|---|
| `phys_footprint` 常驻 | 485 / 532 / 537 / 549 MB | **465 MB**（改后） vs **542 MB**（改前，同会话） |
| CPU（46 s 稳态段） | 25 – 29 % 单核 | **59.8 %**（改后） vs **58.6 %**（改前，同会话） |

原始输出：`raw/13-memory-ball-after.txt`、`raw/14-memory-figure-after.txt`、
`raw/15-memory-figure-before-samesession.txt`。

### ⚠ CPU 口径的坑（本轮实际踩到）

人物形态的 CPU 读数从基线的 25–29 % 跳到 55–60 %，**但与本次改动无关**：

1. 采集期间机器 load average **7.7 – 8.4**（iTerm2 151 %、多个 opencode 进程合计 >100 %）。
2. 做了**同会话、同负载**的对照实验：把 `PetBall.tsx` 与 `electron.vite.config.ts`
   还原到 HEAD、重新构建、用同一个脚本重测 ——
   **改前 58.6 %，改后 59.8 %**，差异在噪声内。

→ 结论：**人物形态 CPU 不受本次改动影响**（符合预期 —— 本任务不动那两条 90 ms 轮询，
调研把它们列为中风险、明确排除）。对外引用人物形态 CPU 时**必须**带负载条件，
或换到空闲机器重测。

## 五、实机回归

- `npm run build` —— clean，产物见 §二。
- `npm run uitest` —— **141 个断言键，141 ok，0 fail，`execErrors: "none"`**
  （含 `petFigureUnchanged`；本机 DPR 下它是绿的）。原始输出：`raw/16-uitest-output.txt`。
- `npx electron . --ballshot`（`BD_PET=1` 人物形态）——
  `petFormOn: true`、`petReady: true`、`canvas=[426,586,213,293]`、`fps: 43`、
  `clipParseMs: 206`、`dump` 里有人物 BufferGeometry；
  截图 `/tmp/balancedeck-shots/pet-1.png` 逐像素看着正常（贴图 / 西装 / 接触阴影 / 脚下胶囊都在）。
  → **动态 import 后 3D 场景无回归、无白屏。**
  原始输出：`raw/17-ballshot-figure-output.txt`。
- `npm test` —— 19 个既有套件 + `test:resource` 全绿。
- `npm run typecheck` —— clean。

## 六、打包产物：`filter` 的语义验证（不是整包体积）

⚠ **本机 `electron-builder --mac --dir` 跑不完**：Electron 本体下载到 100% 之后，
下一次请求 600 s 超时（`RequestError: Timeout awaiting 'request' for 600000ms`），
`dist/mac/` 根本没生成。**试了两次，两次都是同一个超时**（原始输出
`raw/21-packaging-blocked-by-network.txt`）。这是**网络限制**（与前面 `fetch:humans`
的全新下载失败同源），不是配置错误 —— 配置在超时前已被 `loaded configuration` 正常读入。

因此 AC「打包产物 .app 体积下降」**未能在本机完成整包实测**。改用
**electron-builder 自己的匹配器**做语义验证（`raw/20-filter-semantics-verified.txt`）：

用 `app-builder-lib` 的 `FileMatcher`（builder 真正拿去 `copyDir` 的那个类，
`createFilter()` 是它的原生方法，不是另写的一套）读 `electron-builder.yml` 里
`from`/`to`/`filter` 三个字段，对真实文件树逐条判定：

```
=== 从 electron-builder.yml 读到的配置（未经任何改写）===
  from   : resources/human-pets
  to     : human-pets
  filter : ["**/*","!**/*.tga","!reyna-pilot/**"]

=== matcher 对真实文件树的判定 ===
  磁盘文件数 : 38 {"fbx":24,"json":2,"png":12}
  进包文件数 : 38 {"fbx":24,"json":2,"png":12}
  磁盘字节   : 62.2 MB
  进包字节   : 62.2 MB

=== 逐条判定 ===
  ✓ aria/model.fbx                      进包=true
  ✓ aria/anims/f_walk_neutral.fbx       进包=true
  ✓ aria/textures/f014_body_color.png   进包=true
  ✓ aria/preview.png                    进包=true
  ✓ aria/meta.json                      进包=true
  ✓ aria/textures/f014_body_color.tga   进包=false   死重：已转 PNG 的源 tga
  ○ ray/textures/m008_head_normal.TGA   进包=true    已知边界（见下）
  ✓ reyna-pilot/model.glb               进包=false   死重：零引用的 GLB 原型
  ✓ reyna-pilot/preview.png             进包=false   死重目录下的任何文件

结果：8 通过 / 0 失败 / 1 已知边界
```

**filter 的大小写边界（已知，未修）**：`app-builder-lib/out/fileMatcher.js:14` 的
`minimatchOptions = { dot: true }` **没有 `nocase`**，所以 `'!**/*.tga'` 不匹配 `.TGA`。
我没有把它改掉（写 `!**/*.{tga,TGA}` 或 `!**/*.[tT][gG][aA]` 都可以），因为：

1. **上游不产生大写文件名** —— 实查 Rocketbox 的
   `Assets/Avatars/Professions/Business_Female_01/Textures` 共 7 个贴图，**全部**是小写 `.tga`；
2. **第一道防线（脚本）是大小写无关的** —— `sweepConvertedTga` 用
   `name.toLowerCase().endsWith('.tga')` 判断，所以 `.TGA` 也会被删掉；
3. macOS / Windows 的文件系统默认大小写不敏感，`.TGA` 与 `.tga` 指同一个文件。

即要触发这个边界，得同时满足「上游改名」+「第一道防线被绕过」。留着这条边界并写进
文档，比悄悄加一个没人验证过的通配符更诚实。

⚠ 由此可得一条**尚未证实的结论**：`.app` 整包体积应当从基线 **520 MB** 降到
**~361 MB**（`human-pets` 237 → 62 MB，`Frameworks` 262 MB 不变）。这个数字
**本轮没有实测**，不写进 README / 不对外引用（research 里的 520 MB 是基线实测值，可用）。

### 顺带修掉的一个真 bug（第一版验证脚本自己的）

验证脚本第一版把 `from` 传成**相对路径**（`resources/human-pets`），
而 `createFilter` 内部用 `file.substring(from + sep)` 算相对路径 —— 于是所有探测串都算不出
正确的相对路径，`reyna-pilot/**` 全部误判为「进包=true」。真实 builder 同样会先把 yml 里的
`from` 相对 projectDir 解析成**绝对路径**再构造 matcher。改成绝对路径后即全部正确。
（这与 `scripts/verify-opencode.mjs` 那条 spec 教训同源：**要验证机制，不能只验证断言**。）

## 七、反验实测（把守卫弄红）

> 下列红集是 **2026-10-01 trellis-check 复核时**重跑的结果，与本文件早先记录的
> 「13 红 / 4 红」有一处差异：`check` 期间补强了 4 条守卫（A4 / D6 / E4 / B3 的坐标），
> 红集因此变宽 —— 详见 §八。

| 反验 | 做法 | 实测红集 |
|---|---|---|
| ① 动态 import 改回静态 | `git checkout src/renderer/src/PetBall.tsx electron.vite.config.ts` | **14 红**：A2 A3 A4 · B1 B2 B3 B4 B5 B6 B7 · C1 C2 C3 C4；`23 通过 / 14 失败`。构建产物回到 `index-*.js = 1,699,669 B` |
| ①a 只改 `PetBall.tsx`（vite 配置保留） | 同上但只 checkout 一个文件 | **10 红**：A2 A3 A4 · B1–B7；`27 通过 / 10 失败` |
| ①b `import type` + 顶层 `import` 拆两行 | 在 `import type` 之后另起一行 `import { createPet3dScene } from './pet3d/scene'` | **1 红**：A2 |
| ①c 用 `require()` 绕开正则 | `const { createPet3dScene } = require('./pet3d/scene')` | **1 红**：A2 |
| ①d 多行顶层 `import`（路径单独一行） | `import {\n createPet3dScene\n} from './pet3d/scene'` | **1 红**：A2 |
| ② 去掉 `filter` | 从 `electron-builder.yml` 删掉 `filter:` 三行（`from`/`to` 保留），**其余改动都在位** | **4 红**：D3 D4 D5 D6；`33 通过 / 4 失败` |
| ③ 只去掉 `manualChunks` | `PetBall.tsx` 保持动态 import | **3 红**：C1 C2 C3；`34 通过 / 3 失败` |
| ④ `.catch` 不再 `setFailed(true)`（白屏回归） | 删掉 chunk 失败分支里的 `setFailed(true)` | **1 红**：B5 |
| ⑤ `setReady(true)` 提到 `import` 之前（D5① 撤销） | | **1 红**：B3 |
| ⑥ `setReady(true)` 只留在 `.catch` 里（失败路径报 ready） | | **1 红**：B4 |
| ⑦ 清理点挪到 `human-pets cached` 短路**之后** | | **1 红**：E4 |
| ⑧ 删掉短路前的整个清理循环 | | **2 红**：E3 E4 |
| ⑨ 删掉「只删已转换的」判断 | | **1 红**：E5 |
| ⑩ `filter` 挪到 `build` 那一条 extraResources 下 | | **1 红**：D6 |

⚠ 第一轮跑 ② 时 `PetBall.tsx` 还处在 ① 的破坏态，红集是 17 条；把 ① 复原后重跑才是
隔离的 4 条 —— 这正是「红集必须等于该批次声明的目标集，多一条就说明爆炸半径没控住」
（`quality-guidelines.md` §Proving an assertion can fail）。

## 八、trellis-check 复核（2026-10-01）

### 独立复现的实测

| 项 | 本文件早先记录 | check 独立复现 |
|---|---|---|
| `npm run build` | exit 0 | exit 0（产物 hash 与记录**完全一致**：`index-C0A6XRMa.js` / `three-wZxwjy_j.js`） |
| 入口 chunk | 489,106 B | 489,106 B ✓ |
| `three-*.js` | 1,182,414 B | 1,182,414 B ✓ |
| 球形态首屏 `three-*.js` 请求 | 0 条 | **0 条**（`probe-renderer.mjs ball 55` 重跑；渲染层相关 4 条 = `index.html` + 入口 js + css + `voice-*.js`） |
| 切人物形态 | `three-`/`scene-`/`human-` 出现 + 13 条 `bd-asset://` | 同上，13 条，**7 张贴图仍全是 `.png`，0 条 `.tga`** ✓ |
| `three` 特征串不在入口 | 6 个特征串全 false | 逐条复现：`WebGLRenderer` / `ACESFilmic` / `PMREMGenerator` / `SkinnedMesh` / `AnimationMixer` 在入口 **0 命中**，在 `three-*.js` 命中 52/5/6/13/9 次 |
| 人物形态截图 | 正常 | `--ballshot` 重跑，`petFormOn:true` / `petReady:true` / `canvas=[426,586,213,293]` / `fps:60` / `clipParseMs:215`，截图逐像素正常（贴图 / 西装 / 接触阴影 / 脚下胶囊） ✓ |
| `npm test` | 全绿 | 全绿（20 个套件；`test:resource` 37 项） |
| `npm run typecheck` | clean | clean |
| `npm run uitest` | 141 ok / 0 fail | 首轮 **4 项 fail**（`petFigureUnchanged:model-not-ready@3` 及其下游 3 项），复跑 **141 ok / 0 fail** |

⚠ **uitest 首轮的 4 项 fail 是本机负载导致的偶发，不是本次改动的回归**：
失败项 `petFigureUnchanged` 的判定里有「25 × 400 ms 等 `petReady`」的窗口，
机器 `load average` 3.9–6.8 时人物模型解析拖过了窗口（`model-not-ready@3` 是
第 3 次尝试仍没 ready）。它下游的 `petToggleOff` / `petBallOff` / `petBallNoBubble`
是因为前者 `continue` 掉了角色切换因而没走到。复跑（同代码、同构建）全绿。
⚠ 这一项**不是**我引入的敏感性，但它确实是动态 import 带来的**新暴露面**：
`setReady(true)` 现在必然晚于 chunk 下载 + 解析，而旧代码里它是同步的。
若要收敛，给 `uitest.ts:1266` 的等待窗口加长或改成「ready 后再等一帧」即可 ——
本轮**未改**（属产品测试代码，不在本任务的改动清单内，且 AC 未要求）。

### 守卫体检：修掉的 3 处空壳/失效断言

`test-resource.mjs` 的 36 项里有 3 条**当时是空壳**（负向断言因为坐标/匹配口径问题
而永真）。都已修，并各配一条实测红集：

1. **E4（清理点在 cached 短路之前）—— 空壳。**
   旧写法 `fetchSrc.indexOf('sweepConvertedTga(')` 命中的是**函数定义那一行**
   （`function sweepConvertedTga(`，它在 `main()` 之前，永远早于短路点），
   不是调用点。实测把真调用点挪到短路之后，E4 仍为绿。
   修法：先用 `defRe` 把定义行剥掉再定位。
2. **B3（`setReady(true)` 在 `.then` 之后）—— 半失效。**
   旧写法在 `eff`（从 `import` 那一行起的**切片**）里 `indexOf`，
   于是「在 import 之前多报一次 ready」根本落不进切片，断言照样为绿（实测）。
   修法：改用全文件绝对坐标，并要求落在 `.then` 与 `.catch` 之间（B4 同坐标系）。
3. **D6（filter 属于 human-pets 那一条）—— 口径偏弱。**
   旧写法只判「`filter:` 出现在 `from: resources/human-pets` 之后」，
   filter 被挪到**另一条** extraResources（如 `build`）时可能仍为绿。
   修法：把 yml 截到「下一条 `- from:`」或「下一个顶格键」为止，要求 filter 在段内。
4. **A4（球形态的 return 守卫）** —— 从「这行存在」升级为「这行早于动态 import」
   （存在但被挪到建场景之后就失效）。

修完后断言总数 36 → **37**（E3 拆成 E0 前置 + E3）。

### 两件交代事项的独立判断

**① `.app` 整包体积没测出来 —— 处理恰当，但有一处该补。**
`FileMatcher` 是 builder 真正拿去 `copyDir` 的那个类（不是另写一套匹配逻辑），
用它验 filter 语义是可接受的替代证据；`~361 MB` 只以「尚未证实的结论」形式
留在 `measurements.md`、**未进 README / DESIGN.md**，符合 prd 的「D7 整包数字不上文档」。
但 `from/to/filter` 之外**还有一条未验**：`asar: true` 下 `extraResources` 不受 asar 影响
（这一条是 electron-builder 的既有事实，不是本轮要验的），实际风险是
**`--dir` 没跑通 = 打包链路本身在本机未端到端验证过**。这一点应在 AC 上记为
「部分通过（配置语义已验 / 整包未实测）」，而不是当作已通过。

**② `.TGA` 大小写缺口 —— 论证成立，保留现状正确。**
三条理由我逐条核实：① `sweepConvertedTga` 用 `toLowerCase().endsWith('.tga')`，
第一道防线**确实**大小写无关（已实测 `.TGA` 也会被删）；② `dl()` 写入的文件名来自
上游 `ghDir()` 的条目名，上游 Rocketbox 的 7 张贴图经查全为小写；
③ macOS/Windows 默认文件系统大小写不敏感。
即要触发这个边界需同时满足「上游改名」+「第一道防线被绕过」。
**但我加了 G1 磁盘兜底**：`!all.some(p => p.toLowerCase().endsWith('.tga'))` 是
大小写无关的真实磁盘断言，且 `npm test` 每次都跑 —— 上游真改名时会立刻红，
而不是等到打包时静默多带 128 MB。这比在 filter 里加一个没人验证过的通配符更可靠。

### 顺带修掉的 1 处日志说错话

`sweepConvertedTga` 原先把「删不掉（EACCES）」和「同名 .png 尚未就位」并进同一个
`kept` 计数器、并共用一句「保留 N 个 .tga（同名 .png 尚未就位）」。
实际行为正确、脚本也不会挂（实测 `chmod a-w` 后 exit 0，`.tga` 保留，素材不受影响），
但**日志把权限问题报成转换问题** —— 排查的人会顺着错误方向去找 `sips`。
已拆成两个计数器 + 两行不同的措辞，并实测两条分支各自触发时输出正确。
