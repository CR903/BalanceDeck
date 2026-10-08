# 2026-10-08 贴边柱内液高为零（诚实水位收口）

## 起因

P6「四种皮肤外观」的 check 发现一个**活的流体缺陷**：`--uitest` 的 `petWaterColumn`
长期失败：

```
"petWaterColumn": "fail:empty-fill=0（有液面却空柱）"
```

判定路径（`src/main/qa/uitest.ts` 贴边水柱段）：`ring==='plan' && surface` 为真时
期望柱内液 `fillH > 0`，实测 `fillH = 0` —— 球内画了液面，屏边柱里却一滴水都没有。

check 在不含 P6 的基线 commit（`122fef4`）上建独立 worktree 复跑，得到完全相同的
失败串 → 不是 P6 引入、不是环境噪音。从 P6 归档里剥离，单独立项
`10-06-column-zero-fill`（父任务 `10-04-rain-weather-column`）。

既有线索：5n 取帧 `fillH: 39.2`（= 56×0.7）是**曾经正常**的 → 优先查
「为什么断言场景下变成 0」，不从零实现。

## 真因（取证）

`src/shared/percent.ts:14` 的 `windowPercent` 在 `used=0 && limit>0` 时返回 **0**，
不是 null：

```ts
if (w.percent != null && Number.isFinite(w.percent)) raw = w.percent
else if (w.limit != null && w.limit > 0) raw = (w.used / w.limit) * 100
if (raw == null) return null
return roundPercent(Math.max(0, Math.min(100, raw)))
```

而旧的门控只看「算不算得出」：

```ts
// 旧
const showWaves = !!s && s.status === 'ok' && (isPlan(s) ? pct != null : true)
const fluidLvl = !showWaves || !s ? 0 : isPlan(s) ? fluidLevel(pct) : 1
```

`pct=0` 时 `showWaves=true` → 球内挂上 `.fluid-surface`；但
`fluidLvl = level(0) = 0` → 柱内 `fill` 高度 `0%`。**`surface ⟺ fill>0` 被破坏**，
就是「有液面却空柱」。

## 第一轮修法与它的回归

第一反应是给 `showWaves` 加 `&& pct > 0`。方向对（水位诚实），但**门控错了对象**：
`showWaves` 同时管两块语义不同的 DOM ——

| 位置 | 内容 |
|---|---|
| `PetBall.tsx:930` | `{showWaves && <div className="slosh">…}` —— 球内水体（三层波 + `.fluid-surface`） |
| `PetBall.tsx:985` | `{showWaves && <div className="fluid-ring">…}` —— 进度环整体（track/seg/ticks/inner/arc/caps） |

收窄 `showWaves` 把整圈环也一起从 DOM 拆掉了。

危害不对称，而且方向反直觉：

| 皮肤 | `--water-display` | `--ring-display` | 原缺陷 | 新缺陷 |
|---|---|---|---|---|
| aero（`:3160`） | block | none | **可见** | 无 |
| dark `:3199` / minimal `:3242` / candy `:3275` / ink `:3314` | none | block | **不可见**（`.slosh` 走 `--water-display`，`:3125`） | **可见**：环是唯一进度载体 |

0% 不是边角：`uitest.ts:1076` 的注释就写着「本机数据里球常落在 5H = 0% 的窗口上」。
pct=0 时球退化成素盘 + `0%` 文字，与「算不出比例」的 nodata 态（素盘 + 金额，
`uitest.ts:1057-1079`）读起来一模一样 —— 同一个球，两种完全不同的数据状态分不开了。

## 定案：两个条件各管一块语义

```ts
const hasData = !!s && s.status === 'ok' && (isPlan(s) ? pct != null : true)
const fluidLvl = !hasData || !s ? 0 : isPlan(s) ? fluidLevel(pct) : 1
const showWaves = hasData && fluidLvl > 0   // 挂水 ⟺ 液位 > 0
```

- `.slosh` 挂 `showWaves`（水体只在液位 > 0 时挂）；`.fluid-ring` 改挂 `hasData`
  （数据已知就有环）。
- 0% 是**空环**不是无环：`ringDash(0)` 返回 `"0.00 100"`（`skin-rings.ts:30`），
  长度 0 的弧是诚实的。
- `water` 颜色口径同步改挂 `hasData`：弧长 0 时描边不可见，但颜色语义（这一格是
  绿/橙/红）不该依赖液位是否 > 0。

## 断言前置条件的修正（PRD 允许的合法路径）

PRD 写明：「若真因是『该场景本就不该有水』，则修正的是**断言前置条件**而非实现」。
`petWaterColumn` 的前置由 `(ring==='plan' && surface) || ring==='balance'` 收窄为
`surface`：balance 在 `status !== 'ok'` 时 `showWaves=false` → 没有 surface → 它该走
「无液面必须空槽」那一支，而不是被拉去判 `fillH > 0`。判据本身（`fillH > 0`）一行没动。

## 新增护栏：夹具推 0%，不赌真实数据

真实数据这轮球落在 1%，新加的 `fail:zero-pct-no-ring` 分支没被走到。代码库里已有
明确纪律（场景五注释）：

> 「无比例的窗口仍是素盘」若不单推一个这样的窗口，就只能指望真实数据恰好出现它时
> 被顺带查到 —— 那是运气，不是护栏（AC3.3 此前正是这种未被断言覆盖的状态）。

按同一套路补场景六，与场景五互为镜像：

| 夹具 | 状态 | 期望 |
|---|---|---|
| `FIX_NOLIMIT`（场景五） | 算不出比例 | 素盘 + 金额，**连轨道都不画**，无波无液面 |
| `FIX_ZERO`（场景六，新增） | 算得出且 = 0 | **轨道仍在**（空环）+ `0%` 读数，无波无液面 |

`FIX_ZERO` 显式给 `used:0 / limit:10 / percent:0` 三个字段（`fw()` 的 `used:1` 与
percent=0 不自洽，夹具该长得像真实数据）。结果并进 `petRingAlwaysOn`
（同一句「套餐水位诚实」的第三半），断言条目数不变。

`ballProbe` 增 `ringTrack` 字段（`.ring-track` 存在性）—— 此前探针只有
`ringNodes`（退役环残留，恒 0），没有新环轨道的正向证据。

## 验证

- `test:structure` **395/0**（基线 394，净 +1）
- `test:fluid` 126/0 · `test:dock-hide` 155/0 · `typecheck` 0 error
- 结构门两条，各自验齿（改回即红，还原即绿）：
  - **K8o1** 锁 `showWaves` 由 `hasData && fluidLvl > 0` 派生 —— 删掉 `fluidLvl > 0` 即红
  - **K8p** 锁 `.fluid-ring` 门控是 `hasData` —— 改回 `showWaves` 即红
- `--uitest`：`petWaterColumn` / `petRingAlwaysOn` / `petBallCenterValue` /
  `petWaterLevel` / `petNoRingOnBalance` 全绿；总 fail 仍是 4 项与本任务无关的
  既有项（`petBallSkinSurface` / `dragReorder` / `dragSettles` / `grpDupCleanup`）。
- 验齿走的是**真实 electron 运行**，不是只跑结构门：把 `.fluid-ring` 门控改回
  `showWaves` 后 `petRingAlwaysOn` 报 `fail:zero-pct-no-ring`，还原即绿。

## 踩坑

1. **一个布尔管两块语义不同的 DOM**：给共享门控加条件前必须 `grep -n` 它门控了几块。
   本案里改动点在 `PetBall.tsx:498-501`（`hasData` / `showWaves` 定义），失败点在 `:999`
   （`.fluid-ring` 门控），离得足够远以至于初看像正常收窄。
2. **DOM 存在性断言看不见 `display:none`**：`surface: !!dot.querySelector('.fluid-surface')`
   长期红，但那四款环形态皮上水体层本就 `display:none` —— 用户在屏幕上从没看见过那个
   「有液面」。断言一直在替一个不可见的 DOM 不一致背锅。要验视觉就读 computed style 或
   bounding rect。
3. **不推夹具就是赌数据**：加了 `fail:zero-pct-no-ring` 后发现这轮数据在 1%，分支没被
   走到。补 `FIX_ZERO` 才是护栏。
4. 结构门的整块文本扫描容易假绿（K11g/K11h 的教训，本文件里就有注释）—— 所以 K8o1
   用「取到 `const showWaves =` 整行再匹配到行尾」，K8p 用「从 `.fluid-ring` marker
   往前 60 字符找最近的 `{xxx &&`」，都定位到具体片段。

## 遗留

- PRD 的 AC「--shots 5n 取帧像素对拍：柱区有液色像素」本轮**没做像素采样**，改由
  `petWaterColumn` 的 `fillH` / `fillColor`（computed）/ `wave` 三件套 + K8o1/K8p
  结构门覆盖。像素级确认待实机看一次。
- 4 项既有 uitest fail 与本任务无关，未处理。

## 知识沉淀

`docs/knowledge/frontend/petball-mount-conditions.md` —— 挂载条件纪律 +
DOM 存在性断言的盲区 + 「本就不该有 X」类缺陷的正确修法。
