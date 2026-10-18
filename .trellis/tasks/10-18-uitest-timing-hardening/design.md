# 设计：uitest 时序脆弱断言收口

## 1. 边界与文件清单

| 文件 | 改动性质 |
|---|---|
| `src/main/qa/uitest.ts` | 主体：收敛轮询助手 + 按分类改造断言（**不动产品代码**） |
| `scripts/uitest-baseline.mjs` | **新增**。N 轮基线：解析 `--uitest` 的 stdout JSON，输出逐键通过率 / 翻转键 / 每轮耗时 |
| `scripts/test-structure.mjs` | 加棘轮守卫（结构门，**零新增套件注册**） |
| `docs/daily/2026-10-18_uitest-timing-hardening.md` | 日志（门禁） |
| `docs/knowledge/agents/uitest-timing.md` | 沉淀：瞬时判据 vs 轮询判据、以及"先证明不是我引入的"的复用手法 |

**不碰**：`src/main/{scheduler,collect-loop,deadline,request,ipc}.ts`、`adapters/**`、`renderer/**`、`shared/**`、`preload/**`。本任务**只改测试与测试工具**。

## 2. 契约：单一轮询助手

文件里**已经有一个** `waitFor(cond, tries)`（`uitest.ts:1794`），它证明了写法，但只被 dock/岛段落使用。本任务把它**收敛成唯一实现**（不许新增第二套）：

```ts
/** 在预算内轮询一个布尔谓词。budgetMs 是**上界**，命中即早退。 */
const pollCheck = async (
  condJs: string,                       // 一段返回 truthy 的表达式（注入渲染层执行）
  opts: {
    mode: 'appear' | 'absent'           // 等它成立 / 等它不再成立
    budgetMs?: number                   // 缺省 600
    stepMs?: number                     // 缺省 50
    diagJs?: string                     // 失败时抓的诊断表达式（当时的 DOM 实况）
  } = {}
): Promise<{ ok: boolean; waitedMs: number; diag: string }>
```

**三条纪律**：

1. **`absent` 必须等满预算才可判成立**（"现在没看到"不等于"不会出现"）。所以负向断言的首选写法是：**动作后先 `pollCheck(目标, {mode:'appear'})` 等它出现，再等它消失**；只有在无法这么写时才用 `absent` + 预算。
2. **失败必须带诊断**：`diagJs` 抓当时的实际 DOM（例如 `document.querySelector('.settings-foot')?.innerText`），失败值写成 `fail:no-flash | diag=…`。现状大量断言只写 `fail`，复现一次就得手工再跑 —— 这是 flaky 排查成本高的另一半原因。
3. **不许用 `sleep` 换绿**：把 `sleep(900)` 变成 `sleep(3000)` 只是把概率降低，判据仍然是"某一瞬间"。允许保留的 `sleep` 只有"等动效稳定"这类**没有可观察谓词**的场景，且必须在注释里写明为什么没有谓词可用。

## 3. 分类判据（39 处逐条过）

| 类别 | 判据 | 处理 |
|---|---|---|
| ① 必须轮询 | 谓词依赖**异步渲染 / 动效 / 落盘后回读**（`.saved-flash` 这类瞬时元素、切换后的列表、卡片出现） | 改 `pollCheck(..., {mode:'appear'})` |
| ② 可保持瞬时 | 同一谓词**已在前面被 `waitFor`/`pollCheck` 等过**（等价于"已经确认过状态"），或谓词本身就是稳定结构（`.card .titlebar` 这类挂载即存在的） | 保留，但加一行注释说明"为什么瞬时是安全的" |
| ③ 负向断言 | 断言"某元素**不存在**"（移除后 / 关闭后 / 隐藏后） | 改成"动作 → 等目标出现 → 等目标消失"，或 `mode:'absent'` + 预算 |

**产出物**：一张清单（键名 + 行号 + 类别 + 理由），写进 `prd.md` 的验收取证或日志的「改了什么」节。
**判据的重要性**：没有这张清单，"39 处"就只是个数；有了它，后来者才知道哪一处可以放过、为什么。

## 4. flaky 基线脚本

- **为什么解析 stdout JSON 而不是 grep 日志**：`modes.ts:81` 已经写 `JSON.stringify({ uitest: true, consoleErrors, ...results })`，结构化输出天然稳定；grep 会随日志文案变化而误判。
- 形状：

```bash
node scripts/uitest-baseline.mjs --runs 5 [--user-data /tmp/bd-uitest-base] [--keep]
```

输出：
```
每轮耗时: 1m32s / 1m35s / …
键总数: 172（修复前后必须相同 —— AC9）
逐键通过率: <key>: 5/5 | 4/5 | …
跨轮翻转键: <key>（值序列 ok,fail:no-flash,ok,…）
诊断摘要: 每个失败键附最后一轮的 diag
```
- **跑法纪律**：每轮用**独立的临时 `BD_USER_DATA`**（`/tmp/bd-uitest-<n>`），绝不用真实 userData（会与用户常驻实例抢 `secrets.bin` / `usage-history.json` / `state.json`）。这条要写进脚本注释。

## 5. 棘轮守卫（R6）

在 `scripts/test-structure.mjs` 加一条**整文件计数**守卫（该文件已经是"结构门"的家，零新增套件注册）：

```js
// 「瞬时判据」形态：r.X = (await exec(...)) ? 'ok' : ...
const instant = (src.match(/r\.\w+ = \(await exec\([^\n]*\? 'ok'/g) ?? []).length
assert(instant <= 0, `瞬时判据必须为 0，实际 ${instant} 处`)
```

- **为什么是 `<= 0` 而不是钉住 39**：目标是**收口到零**（分类②的"安全瞬时判据"要改写成 `pollCheck(..., {budgetMs:0})` 或加显式注释标记，从而不落进这个正则）。若实施中发现②类无法归零，就把守卫改成"不超过一个**显式白名单**的长度"，白名单必须写在守卫旁边并逐条给理由。
- **必须先弄坏一次**：随手加回一处瞬时判据 → 守卫必须红。

## 6. 性能预算（R5）

- `appear` 命中即早退：已渲染场景成本 ≈ 1 次 `exec`（30–50ms）。
- 最坏估算：39 处 × 600ms ≈ 23s；现状整轮 90–120s ⇒ 约 1.2×，在 1.5× 红线内。
- **必须在验收里给修复前后各 3 轮的真实墙钟**，不许用估算代替。

## 7. 产品竞态 vs 测试时序（R4）

对每个 flaky 键跑一次**放大预算**的诊断（例如 `pollCheck(..., {budgetMs: 3000})`）：

| 观察 | 结论 | 动作 |
|---|---|---|
| 最终出现（例如 1.2s 后） | 测试时序 bug | 本任务修测试（把预算定在实测等待时间的 2–3 倍） |
| 始终不出现 | **产品竞态** | 记录 + 给复现命令 + 写进「存疑」，**不在本任务里猜着修** |

这条纪律的意义：flaky 最容易被"改成轮询"顺手掩盖 —— 如果产品真的有时序竞态，轮询只是把它从"偶尔红"变成"偶尔慢"，而**慢是不报警的**。

## 8. 测试策略

- 基线脚本自身要有自检：喂一份**构造的** JSON（含已知翻转键）→ 断言它能算出正确的通过率与翻转集合（否则基线数字不可信）。
- 棘轮守卫：加回一处瞬时判据 → 红；还原 → 绿。
- 端到端：修复后连续 5 轮，翻转键 = 0（AC4）。

## 9. 回滚形态

改动集中在 `qa/uitest.ts`（单文件）+ 两个新脚本 ⇒ 任一步失败可整文件 revert 回现状；基线脚本与棘轮守卫是纯新增，可独立保留（即使 uitest 改造回滚，它们仍有价值：基线会告诉你它有多 flaky）。
