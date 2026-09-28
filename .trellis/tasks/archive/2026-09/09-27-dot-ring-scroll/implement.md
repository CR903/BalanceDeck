# 执行计划：2D 小圆环的窗口切换、套餐分流与数字递增

顺序原则：**先拆死设置（编译器能帮忙找漏）→ 再改数据层 → 再加交互 → 最后做动画。**
步 1 结束即可交付；步 4/5 出问题可以停在步 3（数据层变好了，只是没有滚轮）。

> ✅ **两个开放项已拍板（2026-09-27 用户答复）** —— 详见 `prd.md` §6：
> **Q1 → B**：切供应商后固定落 `windows[0]`（5 小时）；
> **D3 → 加**：窗口短标签，且只在多窗口时显示（`design.md` §6，余量 1.3px，实拍须验）。

---

## 进度快照

| 步 | 内容 | 状态 | 门 |
|---|---|---|---|
| 0 | 取证：现状断言基线、`showRing` 七处链路 | ⬜ | 基线跑绿并记录 |
| 1 | 拆除「显示用量环」设置 | ⬜ | typecheck 过；设置页/菜单都没有它 |
| 2 | `isPlan()` 分流 + 环三层判定（L1/L2/L3） | ⬜ | balance 无环、plan 有环 |
| 3 | 多窗口索引 `winIdx` | ⬜ | 三窗口能循环切换 |
| 4 | 滚轮切换 + 自动轮播暂停 8 秒 | ⬜ | AC4.1–4.5 全绿 |
| 5 | 数字递增动画 | ⬜ | AC5.1–5.5 全绿 |
| 6 | 窗口短标签（已定要，仅多窗口） | ⬜ | 实拍确认 9px 不压环（余量 1.3px） |
| 7 | QA 断言 + 逐条「先弄坏一次」 | ✅ | **14 条**断言：13 条各弄坏一次各红一次（B1 作废 + G1–G6 六批，红集均恰好等于声明）+ 1 条基线比对；终跑 109 键 / 0 fail |
| 8 | 走查截图 + 文档同步 | ✅ | `README`/`DESIGN`/`CONTEXT` 同步；`docs/pet-dot.png` 换新实拍（9px `5H` 不压环）；`TASKS.md` 追加第二十三轮（历史条目 0 改动）；三道 grep 门全 0 命中 |

### 步 7 破坏验证记录（批次 × 红集）

纪律：每批次 = 一次完整 `--uitest`（`BD_USER_DATA=/tmp/bd-ud`，改动后单独一行 `npm run build`）。
**红集必须恰好等于该批次声明的目标断言集** —— 多红一条即破坏面没控制住，该批次作废重跑。

> **跑批方式与 EXIT**：G2–G6 与终跑均前台同步跑、结果当场读。`--uitest` 打完完整 JSON
> 后偶发**不自行退出**（TASKS.md 第二十一轮已记的 4GB 磁盘 / SIGSEGV 疑点），
> 故从 G2 起改为「后台起进程 → 轮询日志出现 `execErrors` → 再等 5–8 秒杀掉」；
> 判据是 **JSON 里 109 键齐全 + `execErrors` 已打印**，不是进程退出码
> （G1 与还原后绿跑是自然退出，`EXIT=0`；G2/G3 是外层 shell 超时 SIGTERM，JSON 已完整）。

| 批次 | 弄坏改法（临时，跑完即还原） | 声明目标 | 红集 | 结果 |
|---|---|---|---|---|
| B1-初版 | 填充弧 `Boolean(0)` 隐藏 + 恢复设置行 + `from = countUpKey` | petRingAlwaysOn / petRingRemoved / petCountUp | 实际 5 红：+`petBallCenterValue:fail:plan-fill=no-fill`、+`petWindowCycle:fail:dash0=null` | ❌ 连带 2 红 → **作废**，改 G1 |
| G1 | 弧长 `pct * 0.5`（PetBall:728，填充弧真渲染但只画一半）+ 恢复设置行（PetSection:132-135）+ `from = countUpKey`（PetBall:435） | petRingAlwaysOn / petWindowCycle / petRingRemoved / petCountUp | 恰好 4 红（主会话验收 + `/tmp/uitest-g1.log` 双确认）：`petRingAlwaysOn: fail:dash=6.9115px, 138.23px`、`petWindowCycle: fail:dash0=6.9115px, 138.23px`、`petRingRemoved: fail:个性人物收起态 \| 显示用量环 \| 定时播报系统语音`、`petCountUp: fail:samples=10%/10%/10%/10%/10%/10%/10%/10%`；其余 105 键全绿（含 petFigureUnchanged / petWheelHold / petWheelInertia / petNoRingOnBalance），consoleErrors none、execErrors none | ✅ 红集 = 声明目标 |
| G2 | L1 去掉 `isPlan(s)`（PetBall:716 `{s && (`）+ 删 `hideBalance` 的 `k:'lit'` 分支（PetBall:377-381） | petNoRingOnBalance / petHideBalanceNoAnim | 恰好 2 红：`petNoRingOnBalance: fail:nodes=1`、`petHideBalanceNoAnim: fail:¥1.3k/¥1.3k`；其余 107 键全绿，consoleErrors none、execErrors none（命令 `sh` 内 `BD_USER_DATA=/tmp/bd-ud npx electron . --uitest`，日志 `/tmp/uitest-g2.log`；外层 shell 超时被 SIGTERM，但 JSON 已完整打印到 `execErrors`） | ✅ 红集 = 声明目标 |
| G3 | 删 `.dot-winlabel` 渲染（PetBall:737-743）+ 删 `if (figure) return` 早退（PetBall:613） | petWinLabel / petFigureNoWheel | 恰好 2 红：`petWinLabel: fail:lbl0=null`、`petFigureNoWheel: fail:idx 0->1`；`petFigureUnchanged=ok`（预判的 hold 连带风险未发生）、`petCountUp=ok`、`petWindowCycle=ok`；其余 107 键全绿，consoleErrors none、execErrors none（日志 `/tmp/uitest-g3.log`） | ✅ 红集 = 声明目标 |
| G4 | 横向 dx 分支（PetBall:633）与轮播 tick（PetBall:336）的 `advanceProvider` 改裸 `setIdx`（不归零 winIdx；带 `count > 1` 守卫避免 modulo 0） | petProviderCycle / petCarouselResetsWindow | 恰好 2 红：`petCarouselResetsWindow: fail:winIdx=1`、`petProviderCycle: fail:winIdx=1`；其余 107 键全绿，consoleErrors none、execErrors none（日志 `/tmp/uitest-g4.log`） | ✅ 红集 = 声明目标 |
| G5 | 删 tick 的 `holdUntil` 守卫（PetBall:333）+ `WHEEL_COOLDOWN` 250→0（PetBall:33） | petWheelHold / petWheelInertia | 恰好 2 红：`petWheelHold: fail:idx 1->0 @4.0s`、`petWheelInertia: fail:paced 1->1`；其余 107 键全绿，consoleErrors none、execErrors none（日志 `/tmp/uitest-g5.log`） | ✅ 红集 = 声明目标 |
| G6 | rAF 收尾 `commit(target)` → `commit(target * 0.97)`（PetBall:450，`if (t>=1)` 块内；避开 :442 的早路径） | petCountUpExact / petWindowCycle / petCarouselResetsWindow / petProviderCycle | 恰好 4 红：`petCountUpExact: fail:9.7% want=10%`、`petWindowCycle: fail:v0=9.7%`、`petCarouselResetsWindow: fail:Fix A=10.7% want=11%`、`petProviderCycle: fail:Fix B=42.7% want=44%`；`petCountUp=ok`（中间态不受收尾影响）、`petFigureUnchanged=ok`；其余 105 键全绿，consoleErrors none、execErrors none（日志 `/tmp/uitest-g6.log`） | ✅ 红集 = 声明目标 |
| 终 | 全部还原后的全量复跑（`BD_USER_DATA=/tmp/bd-ud npx electron . --uitest`，日志 `/tmp/uitest-final.log`） | — | 实测 **109 键 / 0 fail / consoleErrors none / execErrors none**，14 条断言全 `ok`；`npm run typecheck` exit 0、`npm test` 462 项 0 失败（9 套件；原文「48 项」是末套 read-model 的数，check 复核时更正）、三道 grep 门（`显示用量环` / `showRing` / `ui:petRing`）全 0 命中 | ✅ |

**为什么是这六批、以及与 `design.md` §8 的偏差**（每条都是为满足「红集 = 声明目标」）：

- **petRingAlwaysOn 只能与 petWindowCycle 同批**：可隔离的破坏面只有「弧长百分比错」——
  隐藏 track/fill 会连带红基线断言 `petBallCenterValue`（`fail:plan-track/-fill`），
  而 `dashNear(dash,10)` 这一子检查在 g0 上被两条断言**逐字共用**，拆不开。
- **design 给 petWindowCycle 的「去掉 setWinIdx」不可用**：它会连锁红 8 条
  （`setWindowTo → fail:setwin → hold/adv/prov`、petWinLabel、petCountUp/Exact、petWheelInertia）。
  改用两条受控破坏各证一次：G1 弧长（`fail:dash0`）、G6 读数（`fail:v0`）。
- **petCountUpExact 的「末帧不赋值」在 easeOut `t=1` 时恰好精确**（断言恒绿，证不了），
  改用 `commit(target*0.97)`；它必然连带红所有**文本比读数**的断言
  （petWindowCycle v0、scenario4 的 adv/prov 值比对）→ 这三条声明为同批目标，
  且它们各自另有专属批次（G1/G4）独立证明。
- **petFigureUnchanged 不弄坏**（`design.md` §8 明文：基线比对条目）——共 13 条弄坏 + 1 条基线比对。

### `FIG_BASE` 的出处（主会话取证，2026-09-27）

轮播帧对齐一度看起来像「为了让断言变绿而改预期」，实际不是：

```
$ git show HEAD:src/main/qa/uitest.ts | grep -n "FIG_BASE\|idx:\|caption:"
（零命中）
```

**`FIG_BASE` 在 HEAD `1704b56` 里根本不存在** —— 它连同 `idx` / `caption` / `figFieldsJs`
都是本任务新建的。`idx:0 → 1`、`caption:'41% / OpenCode Go' → '13.7% / Claude Code'`
是**新建时的第一稿**被修正，不是旧基线被移动。

自证的依据：`overlay[68,145]` 是 7 个 PRD 字段之一、出处是步 0 `--ballshot` diag（权威），
它只能由 `Claude Code` 标签（59.28+18=77.28 → 68..145）撑出，`OpenCode Go` 是
64.24+18=82.24 → 65..148，**与基线盒几何上不可能同帧**。所以对齐方向必须是
**改附加观测点去就权威字段，而不是改权威字段去就第一稿**。

7 个 PRD 字段（win/stage/canvas/overlay/rect/center/stride/petReady）**逐字未动**，
比对字段数也未减少（11 个）。

**纪律结论**：`petCountUpExact` 那条同理 —— 「末帧不赋值」在 `easeOut` 的 `t=1`
下恰好精确、断言恒绿，属于**弄不红的假护栏**，必须换破坏手法（`commit(target*0.97)`）才能证到。
每条断言都要问一句：我这个破坏改法，真的会让**只这一条**变红吗？


---

## 步 0：取证（不改行为）

- [ ] 跑一次基线，记录**当前**断言数：`npm run typecheck`、`npm test`、`npm run build`、
      `BD_USER_DATA=<临时> npx electron . --uitest` → 记下 `总键 / ok / fail`
- [ ] `git show HEAD:src/renderer/src/PetBall.tsx | grep -n showRing` 复核 `showRing`
      的七处落点与 `design.md` §7 表格一致（行号可能已漂移，以 `grep` 结果为准）
- [ ] 确认人物形态基线字段（AC6.1 用；`out/` 上一行刚 build 过）：
      `BD_USER_DATA=<临时> BD_PET=1 BD_PET_ID=aria npx electron . --ballshot`
      记下 `win` / `canvas` / `rect` / `center` / `stride` / `overlay` / `petReady`

**门**：三者全绿，否则停下查环境（`--uitest` 不带 `BD_USER_DATA` 会报假失败）。

---

## 步 1：拆除「显示用量环」（R1）

- [ ] `src/shared/types.ts`：`PetMenuModel` 去掉 `ring` 字段
- [ ] `src/renderer/src/PetBall.tsx`：删 `showRing` prop（`:35` 注释、`:36` 类型、
      `:48` 默认值）；`:453` 注释重写、`:455` `{showRing && pct != null && (` → `{pct != null && (`
- [ ] `src/renderer/src/PetSection.tsx`：删整行 `.enable-row`（`:144-149`）、删 prop
      （`:19,20,36`）、`:11` 注释「三个开关」→「两个开关」（**同文件里还有没有别处写
      「三个开关」，`grep -n 三个开关` 确认**）
- [ ] `src/renderer/src/App.tsx`：删 `petRing` state（`:67,68`）、`togglePetRing`
      （`:148-152`）、`toggle-ring` 分支（`:192-196`）、`getExtras` 列表里的
      `'ui:petRing'`（`:212`）、`setPetRing(...)`（`:217`）、
      `showRing={petRing}`（`:381`）、`petRing={petRing}`（`:395`）
- [ ] `src/main/ipc.ts:251`：删菜单项；同时确认 `:227` 的 `const m: PetMenuModel`
      里没有 `ring` 残留
- [ ] `grep -rn "petRing\|showRing\|显示用量环" src/` → **必须 0 命中**
      （`ui:petRing` 这个字符串本身也应消失 —— 它只写在 `App.tsx` 的 extras 里）

**验证**
```bash
npm run typecheck
grep -rn "petRing\|showRing\|显示用量环" src/   # 期望：无输出
```
**门**：`grep` 零命中且 typecheck 干净。
**回滚点**：本步纯删除，`git checkout -- src/` 即可回退。

> ⚠️ 删 `PetMenuModel.ring` 后 `main/ipc.ts` 里 `checked: m.ring` 会编译失败 ——
> 这正是编译器帮你找漏的机制，**不要**用 `as any` 或 `m.ring!` 绕过。

---

## 步 2：`isPlan()` 分流 + 环三层判定（R2 / R3 的 L1–L3）

- [ ] `src/shared/quality.ts`：新增 `export const isPlan = (s: { kind: string }): boolean => s.kind !== 'balance'`
      （**放 shared 而不是 renderer**：`CardView` 也要用，否则两处口径会劈叉）
- [ ] `src/renderer/src/CardView.tsx:557`：改成 `isPlan(s) ? 'plan' : 'balance'`
      （顺序变了，注意分支方向！原来是 `s.kind === 'balance' ? 'balance' : 'plan'`）
- [ ] `src/renderer/src/PetBall.tsx` 的 `.petball-fallback` 改成三层：
      - L1：`!isPlan(s)` → **整块 SVG 不渲染**
      - L2：`isPlan(s)` → 始终渲染 `.dot-ring-track`（**不看 `pct`**，见 AC3.3）
      - L3：`isPlan(s) && pct != null` → 渲染 `.dot-ring-fill`
- [ ] 注释写清**为什么 L2 与 `pct` 解耦**：沿用「`pct != null` 才画」会把
      无 `limit` 的窗口显示成素圆盘，用户读成「这个供应商没环」，与 R2 混淆

**验证**
```bash
npm run typecheck && npm test && npm run build
npx electron . --ballshot      # 看 balance / plan 两种 provider 的 overlay（先 build 才有效）
```
**门**：plan 有 track+fill，balance 两者皆无（人工看截图 + 断言，见步 7）。

---

## 步 3：多窗口索引 `winIdx`（R3）

- [ ] `src/renderer/src/PetBall.tsx:56` 旁加 `const [winIdx, setWinIdx] = useState(0)`
- [ ] `:265` `worst` → `w = s?.windows[clamp(winIdx, len-1)]`；`pct` 改由 `w` 算
- [ ] `ballLevel(s, worst)` → `ballLevel(s, w)`
- [ ] `value` 的 `useMemo` 里 `worst` → `w`（`:270-277`）
- [ ] `:268` 之外：`label`/tooltip 里补上窗口名（tooltip 现在只有供应商名）
- [ ] 加 `stepWindow(dir)` 与 `advanceProvider(dir)` 两个 helper（先不接滚轮），
      `advanceProvider` 内部 `setIdx` + **`setWinIdx(0)`**（Q1 定的 B：固定落
      `windows[0]`；回退 A 的一行改法见 `design.md` §2）
      **它是换人的唯一入口** —— 步 4 改轮播 tick 时必须改成调它，
      不许在 interval 里另写一次 `setIdx`（那条路径就不会重置窗口）
- [ ] 夹紧 effect：`windows.length` 变化时 clamp（**依赖是长度不是 `s`** ——
      数据刷新不应打断正在浏览的窗口，见 `design.md` §2）

**验证**
```bash
npm run typecheck && npm run build
BD_USER_DATA=<临时> npx electron . --uitest
```
**门**：单窗口供应商切换是空操作（AC3.4）；人物形态字段与步 0 基线逐位相同（AC6.1）。
**回滚点**：`winIdx` 只影响取数，删掉 effect 与 helper 即回到「固定显示 worst」。

---

## 步 4：滚轮切换 + 自动轮播暂停（R4）

- [ ] `.petball-hit`（`PetBall.tsx:423`）加 `onWheel={onWheel}`
- [ ] **`if (figure) return` 放在 handler 最前** —— 人物形态也渲染 `.petball-hit`，
      不加这句人物形态下滚轮也会切窗口（R6 违规，`design.md` §9 已标为最易漏项）。（**勘误 2026-09-28**：本任务规划阶段此处写成 `if (!figure) return`，**方向反了** —— `figure` 为真即人物形态，写成 `!figure` 会挡住球形态、人球表现整体互换。实现时已纠正为 `if (figure) return`，并由 `petFigureNoWheel` 弄坏验证证到。）
- [ ] 分轴累积 + `THRESHOLD=60` + `COOLDOWN=250` + **`GESTURE_GAP=150`**
      （`design.md` §4.2 三个常量，各挡一件事）
- [ ] `wheel.current` 里存 `accX/accY/lastX/lastY` **以及 `lastEvent`**；
      **断流清残量必须写在累加之前** —— 否则惯性手势留下的 1000+px 残量会让
      下一次 1px 轻扫立刻过阈值误切一格（复核补记，见 design §4.2）
- [ ] 判据用 `Math.abs(acc)`、**方向取 `acc` 的符号**（带符号 `acc >= 60` 对上滚/左滚
      永假，会静默失效）
- [ ] 每次手动动作 → `holdUntil.current = Date.now() + 8000`
- [ ] 轮播改秒级 tick：`setInterval(1000)` + `lastAdvance` + `holdUntil`
      **tick 里的推进必须调 `advanceProvider(1)`**（自动换人也要 `setWinIdx(0)`，
      不许只写 `setIdx` —— 那样自动轮播就把用户选的时限冲掉了）
      （**必须验证**「第 9 秒起恢复」，固定 6 秒 interval 做不到 —— `design.md` §4.3）
- [ ] tooltip（`:404`）补一句滚轮操作说明（现在是「单击展开 · 拖动移动 · 右键菜单」）

**验证**
```bash
npm run typecheck && npm run build
BD_USER_DATA=<临时> npx electron . --uitest   # 跑断言（步 7 建好后）
```
**门**：AC4.1–4.5 全绿；人物形态滚动**无效**（R6）。

---

## 步 5：数字递增动画（R5）

- [ ] `value` 的 `useMemo` 改为返回 `Reading`（`k:'lit' | k:'num'`，`design.md` §5.1）
- [ ] `k:'lit'` 覆盖 `!` / `—` / `…` / `••••`；**`hideBalance` 命中时不构建数字**
- [ ] `fmt`：`pct != null ? fmtPercent : fmtAmount(...)`，**两条都走动画**
- [ ] `prevRef = { idx, winIdx, targetNum }` → 决定 `animateFrom()`（0 或当前显示值）
- [ ] rAF 循环：`start` 前 `cancelAnimationFrame`；结束时 **`display.current = target`**
      （不用末帧插值，否则留 `40.999999` 尾差 → AC5.2 红）
- [ ] 渲染：`fmt(display.current)`；**`.small` 分类用目标值算**
      （`PetBall.tsx:466` 的 `value.length > 4` 改用 target，否则中途来回切字号）
- [ ] 卸载 cleanup 取消 rAF
- [ ] 参数 600ms + `1-(1-t)^3`

**验证**
```bash
npm run typecheck && npm test
```
**门**：AC5.1–5.5 全绿；`hideBalance` 下零数字跳动（AC5.3）。

---

## 步 6：窗口短标签（D3 已定：**要**，仅多窗口时显示）

- [ ] `src/renderer/src/skins.css` 新增 `.dot-winlabel`（左下角，`font-size: 9px`，
      几何与余量见 `design.md` §6）
- [ ] `PetBall.tsx` 的 `.petball-fallback` 内加 `<span className="dot-winlabel">`
      仅当 `s.windows.length > 1`
- [ ] 复用 `shortWindowLabel(w.name)`（`shared/tray-text.ts:15`）

**门**：`--ballshot` 实拍放大确认 9px 标签**不压环**（余量仅 1.3px）——
压环则退到 `8px`（余量 3.0px），**不许**把标签挪进环内换空间（会盖住读数）。

---

## 步 7：QA 断言 + 逐条「先弄坏一次」

按 `design.md` §8 的 **14 条断言**实现，**每条按顺序执行**：

1. 写断言 → 跑 → 确认**绿**（证明它不是恒红）
2. 弄坏被测行为 → 跑 → 确认**红**（证明它不是恒绿）
3. 还原 → 跑 → 确认**绿**
4. 把「弄坏的改法 + 红的输出」记进本文件的进度快照

**关键几条的弄坏手法**（详见 `design.md` §8）：
- `petWheelInertia`：去掉 `COOLDOWN` → 连发 30 个 `deltaY:40` 应从跳 1 格变跳 20 格；
  另验残量：惯性手势结束 → 等 >150ms → 再发 **1 个** `deltaY:10`，
  **不得**推进（去掉 `GESTURE_GAP` 断流清零 → 必红）
- `petCountUp`：`animateFrom()` 恒返 `target` → 中间态断言必红
- `petNoRingOnBalance`：`isPlan()` 恒返 `true` → balance 出现环必红

**合成滚轮事件**：`dispatchEvent(new WheelEvent('wheel', {deltaY:100, bubbles:true}))`
对 React `onWheel` **有效**（与 `:active` 不同，后者由 UA 合成器驱动、合成事件点不亮）。

**门**：`npm test` 与 `--uitest` 全绿，且 14 条断言的「弄坏记录」都写完。

---

## 步 8：走查截图 + 文档同步

- [x] `npm run build` 后 `npx electron . --ballshot` 出新球形态实拍，替换 `docs/pet-dot.png`
      （**不要动 `docs/pet-3d.png`** —— 那是 `09-18-human-realism` 的对照基线）
      → 需带 `BD_USER_DATA=<干净目录>`：本机 userData 里 `ui:pet=1`，不带会拍成人物形态。
      实拍 `win[56,56]` / `overlay[["petball-fallback",0,0,56,56]]`，放大确认 9px `5H` 不压环
- [x] `BD_PET=1 BD_PET_ID=aria npx electron . --ballshot` 复核人物形态逐位字段 →
      8 个 PRD 字段 + `idx 1` + `pet aria` 全部与 `FIG_BASE` 逐位相同（见步 8 记录）
- [x] `README.md` 收起态那节：删「显示用量环」的说法，补窗口切换与套餐分流
- [x] `DESIGN.md`：形态表后补窗口切换一节
- [x] `CONTEXT.md`：如「用量环」进入统一术语，补定义（`Avoid` 词也标上）
- [x] `TASKS.md` 追加本次条目（**历史条目不要改**）→ 第二十三轮，`git diff` 39 insertions / 0 deletions

**门**：`grep -rn "显示用量环" src/ README.md DESIGN.md` 零命中。

---

## 自检命令

> ⚠️ **`npx electron . --X` 跑的是 `out/`，不是 `src/`** —— `package.json` 的
> `"main": "./out/main/index.js"`。**任何源码改动后必须先 `npm run build`**，
> 否则测的是旧构建，绿灯是假的。
> 正确的全量入口是 `npm run uitest`（= `npm run build && electron . --uitest`）；
> 但 `--ballshot` 没有对应 npm 脚本，**必须显式先 build**。

```bash
npm run typecheck
npm test
node scripts/test-structure.mjs

# —— 以下全部要求 out/ 是最新的 ——
npm run build

# uitest 必须带 BD_USER_DATA，否则继承本机偏好报 20+ 项假失败
# （构建要单独一行，写成 `BD_USER_DATA=... npm run build && ...` 会把 env 只传给 build）
rm -rf /tmp/bd-ud && mkdir -p /tmp/bd-ud
BD_USER_DATA=/tmp/bd-ud npx electron . --uitest

# 球形态（默认，56×56，无 WebGL）
npx electron . --ballshot
# 人物形态（213×293，字段应与步 0 基线逐位相同）
BD_PET=1 BD_PET_ID=aria npx electron . --ballshot
```

**判断 `out/` 是否够新**：`ls -l out/main/index.js` 的 mtime 必须**晚于**你最后一次改的源文件。
步 0 的基线、步 8 的截图，都受这条约束。

---

## 上下文清单（按需 `Read`，不进 jsonl）

超 `context_injection.max_file_bytes` = 32KB 会被截断却仍吃满注入预算
（2026-09-19 派发连续失败就是这个原因）：

- `src/renderer/src/PetBall.tsx`（~560 行）—— 步 2/3/4/5/6 的手术台
- `src/main/qa/uitest.ts`（~790 行）—— 步 7 的手术台，用 `grep -n` 定位
- `src/renderer/src/skins.css`（~2370 行）—— 步 6，只读 `.petball` / `.dot-*` 段
- `src/renderer/src/read-model.ts`（~120 行）—— **只读**，不改

## 回滚策略

- 步 1–3 各自独立成组，任一步出问题 `git checkout -- <文件>` 回退该步
- 步 4/5 都是**新增**（handler + 动画），删掉即回退到步 3 的状态
- 全程单次提交，整体回滚 `git revert` 即可；不新增持久化键 → 无数据迁移要回滚

---

## check 复核补记（2026-09-28，check agent）

### 1. AC3.3 此前无断言覆盖 → 补进现有条目（条目数仍 14 / 109 键）

- **发现**：14 条断言里没有任何一条证明「plan 窗口算不出比例时仍有轨道」—— 场景一/二/四的
  plan 夹具全都带 `percent`，无 `limit` 的窗口只能指望真实数据恰好出现时被
  `petBallCenterValue` 顺带查到，那是运气不是护栏。
- **改法**：`uitest.ts` 新增夹具 `FIX_NOLIMIT`（单窗 plan、无 `limit`），推入后连查 6 项：
  `ring==='plan'` / `winCount===1` / 有 track 且 stroke 是真实值 / **无 fill** / 中心 `¥1.3k` /
  单窗口无短标签。结果**并进 `petRingAlwaysOn`**（同一句「套餐必有轨道」的另一半，复写该键），
  所以断言条目数与 JSON 键数都不变（14 / 109），README 的计数无需改。
- **弄坏一次**：L1 改成 `{s && isPlan(s) && pct != null && (` → 跑得红集**恰好**
  `{"petRingAlwaysOn": "fail:no-track"}`（其余 108 键全绿，日志 `/tmp/uitest-break-ac33.log`）。
- **还原**：改回 `{s && isPlan(s) && (`，`md5 -q src/renderer/src/PetBall.tsx` =
  `3c6bfccfca548308699aef3d27487f3f`（与步 7 终跑同一份源码），单独一行 `npm run build` 后复跑全绿。

### 2. 门禁与文档修正（check 自修，均未动基线/期望值）

- `DESIGN.md:277` 字面写了 `ui:petRing` → 第三道门在该文件上命中。改写为
  「环的开关已随该偏好一并删除，键留在 extras 成为孤儿」，三门复跑全 0。
- `.trellis/spec/frontend/component-guidelines.md`（`showRing` prop 快照 2 处）与
  `state-management.md`（`ui:petRing` 键表、`<PetBall … showRing={petRing}>` 示例）是删除前的
  旧快照，已改成现状（在门禁范围 `src/ README.md DESIGN.md` 之外，属过时文档，非门禁命中）。
- `README.md:141` 的空行把「使用速查」表截成两段（142–144 行掉出表格）→ 删空行。
- 本文「终」行的 `npm test 48 项` 其实是末套 read-model 的数字 → 更正为 **462 项 / 9 套件**。

### 3. 终跑数字（2026-09-28 当场重跑）

- `npm run typecheck` exit 0 · `npm test` exit 0 = **462 ✓ / 0 ✗**（9 套件）· `npm run build` exit 0。
- `BD_USER_DATA=/tmp/bd-ud-final npx electron . --uitest` → **109 键 / 0 fail /
  consoleErrors none / execErrors none**，14 条新断言全 `ok`（日志 `/tmp/uitest-final.log`；
  打完完整 JSON 后偶发不自行退出，判据是 JSON 完整 + `execErrors` 已打印，随后 kill）。
- 三道 grep 门（`显示用量环` / `showRing` / `ui:petRing`）在 `src/ README.md DESIGN.md` 全 **0 命中**；
  `src/` 内 `弄坏验证|G1..G6|0\.97|pct \* 0\.5|三个开关` 也是 0 命中。

### 4. 未验证清单（如实标注，不冒充已验）

| AC | 状态 | 原因 |
|---|---|---|
| AC4.2 斜向滚轮不误判 | 部分间接 | 纯 dx→切供应商（`petProviderCycle`）、纯 dy→切窗口（`petWindowCycle`）都有断言；但 uitest 只发纯轴事件，没有混合 `deltaX/deltaY` 的主导方向用例 |
| AC4.5 球外滚轮穿透 | 间接验证 | `petBallHitRect` 断言命中区仍贴合 56×56（= 未新增命中区）+ 处理器只挂在 `.petball-hit`；但没有「在球外派发 wheel」的用例 |
| AC5.4 无百分比时动画金额本身 | 间接验证 | 金额与百分比走同一条 rAF 路径（`countUpKey = reading.target`，不区分口径）；断言只在百分比夹具上采样中间帧 |
| AC5.5 快速连切不并发动画 | 未验证 | 无连发切换用例；结构保证是 `start` 前 `cancel()` 上一条 rAF（`PetBall.tsx:436`），仅代码审查确认 |
| AC4.3 第 9 秒起恢复 | 部分（区间） | `petWheelHold`：换人后 7s（14×500ms）内 idx 不许动，随后 8s 内必须推进 → 暂停期被夹在 **[7s, 15s)**，未钉死「恰好第 9 秒」（实现是 `MANUAL_HOLD_MS=8000` + `AUTO_MS=6000` 轮播节拍，本身就不是一个可钉的整秒点） |

