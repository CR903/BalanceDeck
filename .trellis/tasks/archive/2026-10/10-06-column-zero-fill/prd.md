# 贴边柱内液高为零缺陷修复

## 背景

P6「四种皮肤外观」的质量检查发现一个**活的流体缺陷**（不是环境噪音、也不是本轮回归）：

`--uitest` 的 `petWaterColumn` 断言长期失败：

```
"petWaterColumn": "fail:empty-fill=0（有液面却空柱）"
```

判定路径（`src/main/qa/uitest.ts` 贴边水柱段）：`ring==='plan' && surface` 为真时，
期望柱内液 `fillH > 0`，实测 `fillH = 0` —— 球内有液面，屏边柱里却一滴水都没有。

## 已确认的事实

- **不是 P6 引入**：trellis-check 在不含 P6 的基线 commit（`122fef4`）上建独立 worktree
  复跑 `--uitest`，得到**完全相同的失败串**。
- **不是环境噪音**：失败稳定可复现，且语义上是"有液面却空柱" —— 屏边柱看起来是空的，
  违反「不造假水位」的对偶面（水位诚实原则：要么有水且高度对，要么明确空槽）。
- **与 `petWaterLevel`（球内液位）不同**：球内液位断言是绿的，所以取数链路本身通，
  断点在"球内液位 → 柱内液高"这一段映射上。

## 待查方向（实施时确认，勿预设结论）

1. 柱内液高是否真的绑 `fluidLvl`（K8f 断言的是 `(fluidLvl * 100).toFixed(1)` 存在于 JSX，
   但断言存在 ≠ 运行期取到非零值）。
2. hidden 相位下 `data-fluid` 与柱几何的时序：柱内液高是否在 `data-fluid='hidden'` 才生效，
   而取帧/断言时相位还没到。
3. 冻结/取帧态（`data-freeze`）是否把柱内液冻在 0。
4. `fluidLvl` 在该场景是否因"算不出比例"走了 0 分支（例如切换供应商瞬间的短暂态）。

## Requirements

- 定位真因并修复，使 `petWaterColumn` 在断言场景下转绿
- 修复不得靠放宽断言（`fillH > 0` 是诚实水位的一部分，放宽等于把缺陷藏起来）
- 若真因是"该场景本就不该有水"（例如无液面时柱应空槽），则修正的是**断言前置条件**而非实现，
  须在日志里说清为什么该场景不该有水
- 相关结构门/单测同步（先红后绿）

## Acceptance Criteria

- [x] `petWaterColumn` 转绿（或前置条件被修正且理由充分可核验）
  → 两者兼得：实现拆成 `hasData` / `showWaves` 两条件后 `petWaterColumn = ok`；前置条件
  另做一处合法收窄（`ring==='balance'` 不再无条件进「有液面」分支，理由见日志）。
- [x] 屏边柱在有液位时实际可见水（--shots 5n 取帧像素对拍：柱区有液色像素）
  → **已按原方式验收（2026-10-08 补做）**：用 `scripts/lib/png-probe.mjs` 解码 `--shots`
  产物 `5n-column-70.png`（112×112 设备像素，dpr 2），7 条断言全过——水色族像素
  y22..y111 共 90 行、逐行满宽 24 设备像素（= 12 CSS = `pillW`）、自管底起、视觉液高
  45.0 CSS（= `fillH` 39.2 + 上帽半径 6，不是 `fillH` 本身）、液面连续 0 空洞、液面上方
  y0..y21 为空管、管外无溢出。详见 daily 日志「补记：5n 柱区像素对拍」。仍保留
  `petWaterColumn` 的 `fillH` / `fillColor`（computed）/ `wave` + K8o1/K8p 作回归门。
- [x] 若修了实现：新增结构门/单测锁住"柱内液高随 fluidLvl 非零"（含 `fluidLvl=0` 时才空槽的反向断言）
  → K8o1 锁 `showWaves` 由 `hasData && fluidLvl > 0` 派生；K8p 锁 `.fluid-ring` 门控是
  `hasData`；uitest 场景六（`FIX_ZERO` 夹具）锁 `fluidLvl=0` 时的正反向：空环**在**、
  波与液面**不在**。两条各验齿（改回即红，还原即绿）。
- [x] `test:fluid` / `test:structure` / `test:dock-hide` / `typecheck` / `npm test` 全绿
  → fluid 126/0 · structure **395**/0（基线 394，净 +1）· dock-hide 155/0 · typecheck 0 error。
- [x] `--uitest` 该键绿，且不新增其他 fail
  → 160 键 4 fail，仍是与本任务无关的既有 4 项（`petBallSkinSurface` / `dragReorder` /
  `dragSettles` / `grpDupCleanup`）；`petWaterColumn` / `petRingAlwaysOn` /
  `petBallCenterValue` / `petWaterLevel` / `petNoRingOnBalance` 全绿。
- [x] 开发日志 + 索引（slug `column-zero-fill`）
  → `docs/daily/2026-10-08_column-zero-fill.md` + `docs/index.md` 加行；
  另沉淀 `docs/knowledge/frontend/petball-mount-conditions.md`（+ 端索引）。

## 真因（验收时回填）

`src/shared/percent.ts:14` 的 `windowPercent` 在 `used=0 && limit>0` 时返回 **0** 而不是
null，而旧门控 `showWaves = … (isPlan(s) ? pct != null : true)` 只看「算不算得出」→
球内挂上 `.fluid-surface`，但 `fluidLvl = level(0) = 0` → 柱内 `fill` 高度 0%，
破坏 `surface ⟺ fill>0`。对应 PRD 待查方向 4。

**中途走过一版错修法**：给 `showWaves` 加 `&& pct > 0` 能让断言转绿，但 `showWaves`
同时门控 `.slosh`（水体）与 `.fluid-ring`（环整体）→ 0% 时整圈环从 DOM 被拆。4 款环
形态皮上水体本就 `display:none`（原缺陷不可见），而环是唯一进度载体（新缺陷可见），
且 0% 是本机常态。定案见日志「两个条件各管一块语义」。

## Notes

- 本任务由 P6 check 发现并从 P6 归档中剥离，P6 不等本任务即可归档。
- 相关既有证据：5n 取帧 `fillH: 39.2`（= 56×0.7）是**曾经正常**的，说明该路径在某些场景可用 ——
  实施时优先查"为什么断言场景下变成 0"，而不是从零实现。