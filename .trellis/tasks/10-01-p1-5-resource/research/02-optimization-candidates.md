# Research: 优化候选清单（带 file:line、风险、预估收益）

- **Query**: 找「低风险」的资源优化点
- **Scope**: internal
- **Date**: 2026-10-01
- **边界声明**: 本文只**描述现状并标注事实**，不代替 implement 决策；每条都给了可复验的量化依据。

## 评级口径

- **风险**：改动会不会碰到用户可见行为 / 共享契约（`src/shared/**`）/ 打包产物布局。
- **收益**：三档 —— `磁盘`（安装包）、`首屏`（启动时解析的 JS/CSS 字节）、`常驻`（`phys_footprint`）、`CPU`（单核百分点）。
- **不碰共享文件**：默认全部候选都不改 `src/shared/**`。唯一例外是候选 #2b（要动 `App.tsx` 的一行 import），它也不碰 `src/shared/**`。

---

## #1 打包时排除 `.tga` 与 `reyna-pilot/` —— 安装包 −159 MB

| | |
|---|---|
| **file:line** | `electron-builder.yml:9-14`（`extraResources`）；死重证据在 `src/renderer/src/pet3d/human.ts:27-33`、`src/main/human-assets.ts:39-44`、`src/shared/pet.ts:46-49`、`scripts/fetch-human-pets.mjs:111-119,145-149` |
| **风险** | **极低**。两个目录**运行时从不被读取**（见下），删掉不改任何行为。 |
| **收益** | **磁盘：`resources/human-pets` 221 MB → 62 MB（−159 MB，−72 %）** |

### 事实依据

| 内容 | 体积 | 运行时是否读取 |
|---|---|---|
| 24 个 `.fbx`（模型 + 动作） | 49.9 MB | ✅ 读（`human.ts` 的 `loadHumanClip` / `loadHumanTemplate`） |
| 12 个 `.png`（7 贴图 + 2 preview + 3 其他） | 12.2 MB | ✅ 读 |
| **10 个 `.tga`** | **128.0 MB** | ❌ **从不读** |
| **`reyna-pilot/model.glb`** | **31.0 MB** | ❌ **全仓库零引用** |

**`.tga` 死重的三重证据**
1. `src/renderer/src/pet3d/human.ts:27-33` —— FBX 里记的是 `xxx.tga`，取 URL 时按 basename 换成 `textures/<base>.png`：
   ```ts
   if (/\.tga$/i.test(base)) return asset(id, `textures/${base.replace(/\.tga$/i, '.png')}`)
   ```
2. `scripts/fetch-human-pets.mjs:111-119` 用 `sips` 把 `.tga` 转成 `textures/*.png`，**转完不删源文件**；`:145` 只是把它排除在体积统计里（`:149` 打印 "converted, tga excluded"）。
3. `src/main/human-assets.ts:39-44` 的 `MIME` 表**没有 `.tga`** —— 这条路径设计时就没打算服务它。
4. CDP 实测：切到人物形态抓到的 7 条贴图请求**全是 `.png`**，`bd-asset://` 里 0 条 `.tga`（`raw/04-probe-ball-cdp.txt`）。

**`reyna-pilot/` 死重的三重证据**
1. `src/shared/pet.ts:46-49` 的 `PETS` 只有 `aria` / `ray`。
2. `scripts/fetch-human-pets.mjs:26-44` 的 `PETS` 也只有 `aria` / `ray` —— 这个目录**不是该脚本产出的**。
3. `grep -rn "reyna" src/ scripts/ electron-builder.yml README.md` → **0 命中**；`MIME` 表也没有 `.glb`。它是更早 GLB 原型的遗留（`README.md:208` 的 Roadmap 还留着「外部 GLB 模型加载」）。

### 三种落地方式（供选）

| 方式 | 改哪 | 代价 | 备注 |
|---|---|---|---|
| A. `extraResources` 加 filter | `electron-builder.yml` | 零代码 | 只影响打包，磁盘上仍留 221 MB（`resources/` 本来就 gitignored） |
| B. `fetch:humans` 转完删 `.tga` | `scripts/fetch-human-pets.mjs:111-119` | 零产品代码 | 磁盘上也省；但改了脚本（属于「共享文件」性质，需 implement 确认） |
| C. 两者都做 | — | — | 最彻底 |

⚠ **A 方案要注意**：`electron-builder` 的 filter 语法是 `from: resources/human-pets, to: human-pets, filter: ['**/*', '!**/*.tga', '!reyna-pilot/**']`。**不要动 `from`/`to` 本身** —— `src/main/human-assets.ts:31` 依赖 `process.resourcesPath/human-pets` 这个落点。

---

## #2 `PetBall` 的 `./pet3d/scene` 静态 import → 动态 import —— 首屏 JS −71 %

| | |
|---|---|
| **file:line** | `src/renderer/src/PetBall.tsx:11`（`import { createPet3dScene, type Pet3dHandle } from './pet3d/scene'`） |
| **不碰共享文件** | ✅ |
| **风险** | **低**。但要处理两件事（见「注意事项」）。 |
| **收益** | **首屏 JS：1,699,669 B → 514,469 B（−71 %）**；3D 场景代码只占 36,981 B，其余 1,298,531 B 是 three.js 本体。 |

### 现状事实

- 导入链全是静态：`App.tsx:7` → `PetBall.tsx:11` → `pet3d/scene.ts:1`（`import * as THREE from 'three'`）+ `:2`（`RoomEnvironment`）。
- **「加载了一半」已经存在**：`pet3d/scene.ts:274` 的 `const { instantiateHuman } = await import('./human')` 就是动态的 —— 但这已经太晚了，因为 `scene.ts` 本身连带 three.js 已经被静态拽进入口 chunk 了。
- **仓库里已有可直接照抄的先例**（也是 `App.tsx:479-483` 点名要求的写法）：
  - `src/renderer/src/speechOut.ts:487` — `const { speak } = await import('./voice')`
  - `src/renderer/src/App.tsx:486` — `void import('./voice')`（诊断钩子），注释 `App.tsx:480-483` 明确写着「用动态 import 而非顶层静态 import…改成静态 import 会让 vite 退化成单块」

### 实测（`raw/08-bundle-split-experiment.txt`）

用一次性 vite 配置（写在仓库外、`outDir` 指向临时目录，**不改仓库任何文件**）把 `node_modules/three` 与 `src/renderer/src/pet3d/**` 拆成独立 chunk：

```
out/renderer/assets/index-Dq0ygv6D.js     486.02 kB   ← 应用自己的代码（不含 three、不含 pet3d）
out/renderer/assets/three-DGAWYAdk.js   1,298.57 kB   ← three.js 本体
out/renderer/assets/pet3d-CZ0RtmYH.js      36.98 kB   ← scene / gesture / rig / clips / tokens
out/renderer/assets/voice-CCQ2qdzT.js        2.79 kB
out/renderer/assets/index-gJteAiOs.css      83.21 kB
```

**⚠ 只拆 chunk 不改 import，省不了内存**：`raw/06-probe-ball-threesplit-build.txt` 里球形态 `Runtime.getHeapUsage` = **usedSize 5.7 MB**，与不拆的 **5.4 MB** 相同。**必须 import 变动态才成立。**

### 注意事项（给 implement）

1. `createPet3dScene` 现在是**同步返回** `Pet3dHandle`（`PetBall.tsx:191` 直接 `handle = createPet3dScene(...)`）。改成动态 import 后会有一个 await 空窗，`ready` 状态与 `PetBall.tsx:199` 的 `setReady(true)` 需要跟着挪。
2. `PetBall.tsx:192-197` 现有的 WebGL 失败兜底（`catch` → `setFailed(true)` → 退回 2D 圆环）**必须一并覆盖「chunk 加载失败」**，否则 CDN/文件缺失时会变成白屏而不是退回 2D。
3. 建议**同时**加 `manualChunks` 把 `node_modules/three` 固定成独立 chunk（否则 vite 可能把 three 又并回入口，因为它被 `scene.ts` 与 `human.ts` 同时引用）。仓库现有 `electron.vite.config.ts` 只有 `plugins`，加 `build.rollupOptions.output.manualChunks` 即可。
4. 顺带收益：`voice-*.js` 现在**首屏就会被加载**（`App.tsx:486` 的诊断钩子无条件 `void import('./voice')`），实测 `raw/04` 的 Network 列表里它在冷加载中。2.75 kB，收益可忽略，但**它是「动态 import 却被首屏触发」的现成反例**，可以拿来说明纪律。

---

## #3 主进程 QA 模块改动态 import —— 主进程 bundle −95 %

| | |
|---|---|
| **file:line** | `src/main/index.ts:17-18` |
| **不碰共享文件** | ✅ |
| **风险** | **低** |
| **收益** | **磁盘：主进程 bundle 262.62 kB → 12.93 kB（−95 %）** |

### 现状事实

```ts
// src/main/index.ts:16-18
// QA 工具（--shots / --uitest）不参与产品运行，见 ./qa —— 入口只负责分派
import { runBallshot } from './qa/ballshot'
import { runDetailsTest, runShotsMode, runSmoke, runUiTestAndReport, setupTestApp } from './qa/modes'
```

`qa/modes.ts:5-6` 又静态拉进 `./shots` 与 `./uitest`。整条链的源码体积：

| 文件 | 源码字节 | 行数 |
|---|---|---|
| `src/main/qa/uitest.ts` | **137,241** | 2,500 |
| `src/main/qa/ballshot.ts` | 14,114 | 265 |
| `src/main/qa/shots.ts` | 13,890 | 291 |
| `src/main/qa/modes.ts` | 7,010 | 145 |
| `src/main/qa/fixtures.ts` | 2,142 | 54 |

实测拆分（`raw/08`）：

```
out/main/index.js                 12.93 kB   ← 去掉 qa/ 后的主进程入口
out/main/qa-BBWtI_ne.js          251.94 kB   ← 全部 QA 代码
out/main/opencode-details-*.js     6.02 kB   （本来就已是独立 chunk）
```

→ **生产主进程 bundle 里 96 %（251,940 / 262,620 B）是永不执行的 QA 代码。**

「这段代码真的在包里」的直接验证：

```bash
$ for s in petFigureUnchanged petBallCenterValue runUiTest capturePage demoSnapshot; do
    printf "%-22s " "$s"; grep -c "$s" out/main/index.js; done
petFigureUnchanged       1
petBallCenterValue       1
runUiTest                4
capturePage              3
demoSnapshot             4
```

### 注意事项

- 这些是**同步** import，改动态后 `src/main/index.ts:141-158` 的分派点（`if (shots) { await runShotsMode(...) }` 等）本来就已经在 `app.whenReady()` 的 async 回调里，`await import()` 直接可用。
- `--ballshot` 那条（`index.ts:141-144`）是 `await runBallshot()`，同理。
- `--smoke` / `--uitest` 共用的 `setupTestApp`（`index.ts:153`）也在 `whenReady` 里，可直接 `await`。
- 主进程里已有动态 import 的先例：`src/main/overlay.ts:36`（`await import('./keystore')`）、`src/main/qa/modes.ts:94-95,108,120`。

---

## #4 两条 90 ms 轮询 —— 收起态 CPU −1.7 个百分点单核

| | |
|---|---|
| **file:line** | `src/main/overlay.ts:433`（`watchTimer = setInterval(tickCursorWatch, 90)`）+ `src/renderer/src/PetBall.tsx:332`（`setInterval(..., 90)`） |
| **不碰共享文件** | ✅（但碰命中判定，**有行为风险**） |
| **风险** | **中** |
| **收益** | **CPU：收起态 2.2 % → 0.3 % 单核（−1.9 个百分点）** |

### 实测（`raw/09-cpu-wakeups-3-modes.txt`）

| 形态 | main | gpu | renderer | 合计 |
|---|---|---|---|---|
| ball + 收起（两条 90 ms 轮询在跑） | 0.7 % | 0.6 % | 0.8 % | **2.2 %** |
| ball + 展开（两条不起） | 0.0 % | 0.2 % | 0.1 % | **0.3 %** |

两条轮询是**同频的**：主进程每 90 ms 取一次光标位置算命中 → 变化时才 `webContents.send('pet:cursor')`（`overlay.ts:408-411` 有 `if (over !== cursorOver)` 守卫）；渲染层每 90 ms 上报一次命中矩形（`PetBall.tsx:328-361`，与主进程轮询同频，注释明写「90ms 与主进程光标轮询同频」）。

### 为什么列为「中风险」

命中判定是这个应用的核心交互（`overlay.ts` 的 `cursorInsideHit` + `setIgnoreMouseEvents`）。降频 / 合并会直接改变：
- 鼠标移入移出时 `hover` 反馈的延迟（现在是 ≤90 ms）
- 拖动起点判定的精度

**低风险的子集**：先只做「合并」不做「降频」—— 让主进程那一轮顺便把渲染层的命中矩形一起取（渲染层上报改成事件驱动：只在 `setPetHitbox` 的输入真的变了时才发 IPC，主进程在 90 ms tick 里统一处理）。这能把 2 个 90 ms 定时器降到 1 个，**行为延迟不变**。

⚠ 另一条不可动的：`src/main/overlay.ts:167` 的 `backgroundThrottling: false`（`overlay.ts:161-166` 有 6 行注释解释为什么必须关）—— **它让隐藏/非聚焦窗口的 `setTimeout` 不被 Chromium 降到 1 分钟一次，是「到点播报」的前提**。`src/renderer/src/PetBall.tsx` 那两条 90 ms `setInterval` 因此也不会被节流，是实打实的 90 ms。

---

## #5 设置页 / 详情页视图改 `React.lazy` —— 首屏再减 ~38 % 的自有代码

| | |
|---|---|
| **file:line** | `src/renderer/src/App.tsx:4`（`DetailView`）、`:5`（`SettingsView`）、`:6`（`presetConfig` 来自 `VoiceReminderSection`）；渲染分支在 `App.tsx:1088-1090` |
| **不碰共享文件** | ✅（但 `App.tsx` 是共享文件，会影响 `App.tsx:78-84` 那类渲染期 ref 镜像，需 implement 确认改动面） |
| **风险** | **低–中**（首帧会闪骨架屏；`App.tsx` 有 `ErrorBoundary`，lazy 失败的表现要确认） |
| **收益** | 首屏 JS 再减 **~38 % 的自有代码**（见下表）。**但总量只减 ~11 %** —— 因为入口 chunk 里 53 % 是 `react-dom`，动不了。 |

按 sourcemap 把入口 chunk（486 kB）归因到源文件（`raw/08`，`sourcemap-attrib.py`）：

| 源文件 | 归因字节（sourcemap 单位） | 占自有代码 | 何时才需要 |
|---|---|---|---|
| **`react-dom`（node_modules）** | 137,463 | — | **首屏必需**（占入口 chunk 53.3 %） |
| `App.tsx` | 15,819 | 15.1 % | 首屏必需 |
| **`SettingsView.tsx`** | 13,541 | 12.9 % | **点「设置」** |
| `PetBall.tsx` | 13,025 | 12.4 % | 收起态 |
| `CardView.tsx` | 12,349 | 11.8 % | 展开态 |
| **`VoiceReminderSection.tsx`** | 11,657 | 11.1 % | **设置页内** |
| **`DetailView.tsx`** | 6,883 | 6.6 % | **点某个供应商** |
| `speechOut.ts` | 5,066 | 4.8 % | 播报时 |
| `components.tsx` | 3,656 | 3.5 % | 首屏必需 |
| `smartBroadcast.ts` | 3,004 | 2.9 % | 播报时 |
| `systemNotify.ts` | 2,409 | 2.3 % | 通知时 |
| `alertOrchestrate.ts` | 2,326 | 2.2 % | 播报时 |
| **`TrendChart.tsx`** | 2,208 | 2.1 % | **详情页** |
| **`usagePredict.ts`** | 2,161 | 2.1 % | **详情页** |
| `read-model.ts` | 2,157 | 2.1 % | 首屏必需 |
| **`PetSection.tsx`** | 2,085 | 2.0 % | **设置页内** |
| **`usageHistory.ts`** | 1,569 | 1.5 % | **详情页** |

「点一次才需要」的小计：**27,283（SettingsView + VoiceReminderSection + PetSection）+ 12,821（DetailView + TrendChart + usagePredict + usageHistory）= 40,104 / 104,642 = 38.3 % 的自有代码。**

⚠ 注意 `App.tsx:6` 的 `import { presetConfig } from './VoiceReminderSection'` —— **只为了一个函数**就把 41 kB 的 `VoiceReminderSection.tsx` 拉进首屏（`App.tsx:1112` 用它算 `ttsPreset` 的只读端点）。**这可能比整体 lazy 更划算**：把 `presetConfig` 挪进 `src/shared/tts-preset.ts`（该文件已在包里，归因 1,248 B），`App.tsx:6` 与 `SettingsView` 都从 shared 取。⚠ 这会**碰 `src/shared/`**（`tts-preset.ts` 已经是 shared 里的现成文件，属于「扩展 shared 而非新增契约」）。

---

## #6 设置页不再预取未选中角色的 `preview.png`

| | |
|---|---|
| **file:line** | `src/renderer/src/PetSection.tsx:51-60` |
| **不碰共享文件** | ✅ |
| **风险** | **低**（chip 缩略图会晚 ~100 ms 出现） |
| **收益** | 磁盘 0 / 首屏 0 / 常驻：设置页打开时少 454 kB 网络 + 一张解码位图 |

```tsx
// src/renderer/src/PetSection.tsx:51-60
useEffect(() => {
  let alive = true
  for (const p of PETS) {                 // ← 遍历全部 PETS
    if (!alive) return
    setThumbs((prev) => ({ ...prev, [p.id]: `bd-asset://${p.id}/preview.png` }))
  }
  return () => { alive = false }
}, [])
```

实测两个 `preview.png` 的体积：`aria/preview.png` **420,187 B**、`ray/preview.png` **454,042 B**。

现状是**合理的**（`:139-156` 的 chip 确实两位都渲染），但 `<img>` 没有 `loading="lazy"`，且头像那张（`:73-79`）和 chip 那张（`:149-153`）指向同一个 URL，浏览器会去重 —— **真正多出来的只有「另一位角色」那一张**。改动空间很小（给 chip 加 `loading="lazy"`），收益也小，**优先级最低**。

---

## #7 `three` / `react` / `react-dom` 移到 `devDependencies` —— `app.asar` −18.9 MB

| | |
|---|---|
| **file:line** | `package.json:57-61` |
| **不碰共享文件** | ✅ |
| **风险** | **低**（但必须跑一次完整验证，见下） |
| **收益** | **`app.asar` 20.79 MB → ~1.9 MB（−91 %）** |

### 实测（`raw/10`：`npx asar extract` 后逐目录 `du`）

```
$ du -sh <asar>/node_modules/*
 12K  js-tokens
 28K  loose-envify
364K  react
4.4M  react-dom
140K  scheduler
 14M  three            ← 714 个文件

$ find <asar>/node_modules/three -type f | wc -l
714

$ du -sh <asar>/node_modules/three/*
9.0M  three/build      ← 11 个文件（含 three.webgpu.js 1.78MB / three.webgpu.nodes.js 1.78MB /
                               three.cjs 1.99MB / three.core.js 1.39MB / three.module.js 600KB）
5.4M  three/src       ← 760 个 TypeScript 源文件

$ du -sh <asar>/out
2.2M  out             ← vite 的真产物：main 262kB + preload 9kB + renderer 1.94MB
```

**主进程实际 require 的模块（`grep -o 'require("…")' out/main/index.js | sort -u`）：**

```
require("crypto")
require("electron")
require("fs")
require("os")
require("path")
```

**零个 npm 包。** 因为 `electron.vite.config.ts:6,9` 的 `externalizeDepsPlugin()` 只 externalize **main / preload**，而这三个包只被**渲染层**用，渲染层是 vite 打包的（产物就是 `out/renderer/assets/index-CnTfnHRm.js`）。

→ **`app.asar` 里 18.9 MB / 91 % 是运行时没有任何代码 require 的 npm 包。**

### 为什么它们在 `dependencies` 而不是 `devDependencies`

`package.json:57-61`：

```json
"dependencies": {
  "react": "^18.3.1",
  "react-dom": "^18.3.1",
  "three": "^0.177.0"
}
```

`electron-builder` 默认只把 `dependencies` 打进 asar。对**纯前端打包型**的 Electron 应用（渲染层全部 bundle、没有 native 模块需要运行时解析），这三个包本质上是**构建期依赖**。

### 注意事项

1. 改完**必须跑一遍完整验证**：`npm run build && npx electron . --smoke`（`package.json:12`）+ `npm test`（`package.json:35`）+ 一次 `electron-builder --dir`。理由：`externalizeDepsPlugin()` 的 externalize 清单是从 `dependencies` 推的，若某个我们没看到的路径（`preload`？`out/tsc-node`？）在运行时 require 了它们，会在打包后才炸。
2. `out/tsc-node/tsconfig.node.tsbuildinfo` 也被塞进了 asar（`npx asar list` 里能看到；`out/` 目录共 2.2 MB）。可在 `electron-builder.yml` 的 `files` 里加 `!out/tsc-node/**` 排除。
3. ⚠ **动 `package.json` 的 `dependencies` 分区会影响 `npm install` 的行为**（`--omit=dev` 场景下不再装这三个包）。本项目 `npm install` 是全量安装（`README.md:150`），**不受影响**；但如果有 CI 用 `npm ci --omit=dev`，需要确认渲染层仍能构建。

---

## 已核查但**不是**问题（避免误改）

| 项 | 结论 |
|---|---|
| `DetailView` 的每模型明细表 | **已经按需展开**：`DetailView.tsx:264-273` 是 `{models && models.length > 0 && (<div className="dwin-details">…{open && <WindowModels rows={models} />}</div>)}`，`open` 初值 `false`。**不是浪费，别动。** |
| `App.tsx:872` `armAlertTimer`（30 s 轮询） | `if (!ttsOn) return`（`:871`），而 `ttsOn` **出厂默认关**（`App.tsx:139` 注释「ui:ttsOn，默认关」）。**默认配置下这条定时器根本不存在。** |
| `App.tsx:904` `armVoiceTimer`（兜底播报） | `if (!ttsOn \|\| !ttsRoutine) return`。**默认配置下不存在。** |
| `src/main/scheduler.ts:180` 的 `scheduleLoop` | 单条自重排 `setTimeout` 链（`:176-186`），每轮一个唤醒（默认 60 s，用户可设 10–300 s）。**不是忙循环** —— `:173-174` 的注释记录过一次「delay=0 导致空转」的 bug 已修。 |
| `src/main/overlay.ts:327` `dragTimer` | 只在 `dragStart` 期间存在（`:313 if (!win \|\| dragTimer) return`）。 |
| `DetailView.tsx:296`（30 s 时钟）/ `CardView.tsx:296`（15 s 时钟） | 各只在自己那页挂载时存在，且都是「更新相对时间文案」的必要刷新。 |
| `src/renderer/src/pet3d/human.ts` 的动作懒加载 | **已经做了**：`clips.ts:40` 的 `BASE_CLIPS = ['idle','walk','wave']` 随模型加载，其余第一次被抽到才解析（CDP 实测切到人物形态只请求了 3 条 anims）。 |
| `src/main/opencode-details.ts` | 已经是独立 chunk（`out/main/opencode-details-*.js` 6.02 kB），且由 `opencode.ts:721` 动态 import。用的是 `fetch`，**不建隐藏窗口**（`index.ts:86` 那句注释里的「隐藏窗口」在本版本已不成立）。 |
| GPU 进程 | **球形态也会起**（Chromium 合成需要）。只能说 footprint 从 95–100 MB 降到 39–40 MB，**不能说「不占 GPU 进程」**。 |

---

## 附带发现（不在本任务范围，但值得记一笔）

1. **`.trellis/spec/frontend/hook-guidelines.md:137-152` 的定时器表行号全部过期**：`state-management.md` 里同一批（`App.tsx:608-617` / `:639-645`）也一样。核对：

   | spec 写的 | 实际 |
   |---|---|
   | `CardView.tsx:217`（15 s clock） | `CardView.tsx:296` |
   | `DetailView.tsx:155`（30 s clock） | `DetailView.tsx:296` |
   | `App.tsx:609`（待确认轮询） | `App.tsx:872`（`const armAlertTimer`） |
   | `App.tsx:640`（定时兜底播报） | `App.tsx:903`（`const scheduleNext`） |
   | `PetBall.tsx:214,242`（carousel + hitbox） | `PetBall.tsx:332`（90 ms）/ `PetBall.tsx:417`（1 s） |
   | `PetBall.tsx:321-323`（全局 pointer 监听） | `PetBall.tsx:649-660` |

   **任何按这份表去改定时器的 implement 都会改错行。** 这是 spec 漂移，不是代码问题。
2. **主进程采集路径第一轮有 +71 MB 的一次性预热**（`01-baseline-measurements.md` §2）。不是泄漏，但「峰值」口径要算进去。
3. `README.md:208` 的 Roadmap 还留着「助理素材包（外部 GLB 模型加载）」，而 `reyna-pilot/model.glb`（31 MB）正是那个 GLB 原型的遗留物 —— 两条线索指向同一件事：**文档里的 GLB 路线已经废弃，但素材还躺在磁盘上并会进包**。