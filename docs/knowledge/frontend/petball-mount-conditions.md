# PetBall 挂载条件：一个布尔只管一块语义

**遇到** 要给 `PetBall.tsx` 里一个已经门控多块 DOM 的共享布尔加/改条件
**→ 做** 先 `grep -n` 它门控了几块，语义不同的块拆成独立条件
**否则** 收窄其中一个语义会连带拆掉另一个，且失败点离改动点很远

## 取证（2026-10-08，`10-06-column-zero-fill`）

`showWaves` 曾同时门控两块 DOM（修复前）：

- `PetBall.tsx:930` `{showWaves && <div className="slosh">…}` —— 球内水体（三层波 + `.fluid-surface`），今天仍是
- 原 `PetBall.tsx:985` `{showWaves && <div className="fluid-ring">…}` —— 进度环整体（track / seg / ticks / inner / arc / caps），今天已移到 `:999` 且改挂 `hasData`

为了「pct=0 不画假水位」给 `showWaves` 加 `&& pct > 0`，结果把整圈环也从 DOM 拆掉。

危害不对称，且方向反直觉：

| 皮肤 | `--water-display` | `--ring-display` | 后果 |
|---|---|---|---|
| aero | block（`:3160`） | none | 水体可见 → 原缺陷**可见** |
| dark / minimal / candy / ink | none（`:3199` `:3242` `:3275` `:3314`） | block | 水体 `display:none`（`.slosh` 走 `--water-display`，`:3125`）→ 原缺陷**不可见**；而环是唯一进度载体 → 新缺陷**可见** |

pct=0 是常见态：`percent.ts:14` 的 `windowPercent` 在 `used=0, limit>0` 时返回 `0`（非 null）；
`uitest.ts:1067` 注释「本机数据里球常落在 5H = 0% 的窗口上」。

定案（两条件分工）：

```ts
const hasData = !!s && s.status === 'ok' && (isPlan(s) ? pct != null : true)  // 有没有环
const fluidLvl = !hasData || !s ? 0 : isPlan(s) ? fluidLevel(pct) : 1
const showWaves = hasData && fluidLvl > 0                                     // 有没有水体
```

0% 是**空环**不是无环：`ringDash(0)` 返回 `"0.00 100"`（`skin-rings.ts:30`），长度 0 的弧是诚实的。
0% 与 nodata 的读感必须分得开——nodata 是素盘 + 金额（`uitest.ts:1062`），pct=0 是空环 + `0%`。

门禁：K8o1 锁 `showWaves` 由 `fluidLvl > 0` 派生；K8p 锁 `.fluid-ring` 门控是 `hasData`。
两条各自验齿（改回 `showWaves` 红 / 删掉 `fluidLvl > 0` 红）。

## 相关：DOM 存在性断言看不见 `display:none`

**遇到** QA 探针用 `querySelector` 判「有没有水 / 有没有环」
**→ 做** 明确这条断言只是 DOM 卫生，别当视觉验收；要验视觉就读 computed style 或 bounding rect
**否则** `display:none` 的层照样算「存在」，DOM 级不一致可能长期不可见，而断言一直在替它背锅

本案里 `petWaterColumn` 的 `surface: !!dot.querySelector('.fluid-surface')` 长期红，
但四款环形态皮上水体层本就 `display:none` —— 用户在屏幕上从没看见过那个「有液面」。

## 相关：「该场景本就不该有 X」类缺陷的正确修法

**遇到** 断言报「有 A 却无 B」，而真因是「该场景本就不该有 A」
**→ 做** 收窄断言前置条件（或让渲染条件与数据条件同源），在日志里写清为什么不该有
**否则** 把整个挂载块判掉 → 修好了 A，拆掉了别的东西

`petWaterColumn` 的前置由 `(ring==='plan' && surface) || ring==='balance'` 收窄为 `surface`：
balance 在 `status != 'ok'` 时 `showWaves=false` → 无 surface → 该走「无液面必须空槽」分支，
而不是被拉去判 `fillH > 0`。
