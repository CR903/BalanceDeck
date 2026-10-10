// shared/dock-hide.ts + main/dockHide.ts 行为测试（纯函数 + 注入依赖，node 直接跑）
// 用法：node scripts/test-dock-hide.mjs
//
// 悬浮球贴边自动隐藏：边沿判定/隐藏偏移/角落平局 + 主进程状态机的
// 计时与取消路径（隐藏/唤出/重藏/路过不唤出/拖拽取消/开关关闭）。
// 隐藏态命中区是渲染层 reportHit 上报的实测矩形 —— 主进程零覆盖
// （10-10-island-mini-tune R3 新契约，见用例 6）。

import { loadTs } from './lib/load-ts.mjs'

const shared = await loadTs('src/shared/dock-hide.ts')
const {
  EDGE_THRESHOLD,
  HIDE_DWELL_MS,
  REVEAL_DWELL_MS,
  REHIDE_MS,
  HIDE_ANIM_MS,
  REVEAL_ANIM_MS,
  detectEdge,
  hiddenBounds,
  easeOutCubic,
  animBounds
} = shared
const { createDockHide } = await loadTs('src/main/dockHide.ts')

let pass = 0
let fail = 0
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}\n      实际: ${a}\n      期望: ${e}`)
  }
}
function ok(cond, label) {
  eq(!!cond, true, label)
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
/** 等到状态机进入指定相位（动画相只有 200–300ms 宽，固定 sleep 在负载机上抓不住） */
async function waitPhase(d, want, maxMs = 5000) {
  const t0 = Date.now()
  for (;;) {
    const p = d.phase()
    if (p === want || Date.now() - t0 > maxMs) return p
    await sleep(50)
  }
}
const WA = { x: 0, y: 25, width: 1440, height: 875 } // 主屏工作区（菜单栏 25px）
const B = (x, y, w = 56, h = 56) => ({ x, y, width: w, height: h })

console.log('用例 1：常量口径（PRD R1–R5 + 10-10-island-mini-tune R3 零覆盖）')
eq(EDGE_THRESHOLD, 8, '贴边阈值 8px')
// R3：MINI_PILL_* 已删除 —— 隐藏态信任渲染层实测矩形，不再覆盖居中 pill；
// pill 高 22 只活在 island.css（D6b 钉），本模块不再备第二个数。
eq(shared.MINI_PILL_W, undefined, 'MINI_PILL_W 已删除（pill 宽 fit-content，随家数变）')
eq(shared.MINI_PILL_H, undefined, 'MINI_PILL_H 已删除（pill 高 22 只活在 island.css）')
eq(shared.peekHitbox, undefined, 'peekHitbox 已删除（morph 期全窗可点即 fail-open，无覆盖可设）')
eq(HIDE_DWELL_MS, 1000, '隐藏停留 1000ms')
eq(REVEAL_DWELL_MS, 300, '唤出停留 300ms')
eq(REHIDE_MS, 1500, '离开重藏 1500ms')
ok(HIDE_ANIM_MS >= 250 && HIDE_ANIM_MS <= 350, `隐藏动画 250–350ms（实际 ${HIDE_ANIM_MS}）`)
ok(REVEAL_ANIM_MS >= 180 && REVEAL_ANIM_MS <= 220, `唤出动画 180–220ms（实际 ${REVEAL_ANIM_MS}）`)
ok(REVEAL_ANIM_MS < HIDE_ANIM_MS, '退出更快：唤出动画短于隐藏动画')

console.log('用例 2：四边判定')
eq(detectEdge(B(0, 400), WA), 'left', '左贴边')
eq(detectEdge(B(1440 - 56, 400), WA), 'right', '右贴边')
eq(detectEdge(B(700, 25), WA), 'top', '上贴边（工作区顶部，非屏幕 0）')
eq(detectEdge(B(700, 25 + 875 - 56), WA), 'bottom', '下贴边（工作区底部，避开 Dock）')
eq(detectEdge(B(700, 400), WA), null, '屏幕中间不贴边')
eq(detectEdge(B(8, 400), WA), 'left', '阈值边界 8px 算贴边')
eq(detectEdge(B(9, 400), WA), null, '阈值之外 9px 不贴边')

console.log('用例 3：角落平局（左/右/上/下顺序确定性选择）')
eq(detectEdge(B(0, 25), WA), 'left', '左上角左/上距离都是 0 → 取左')
eq(detectEdge(B(1440 - 56, 25), WA), 'right', '右上角右/上距离都是 0 → 取右')
eq(detectEdge(B(5, 400), WA), 'left', '左 5px / 右远 → 取最近的左')
eq(detectEdge({ x: 6, y: 400, width: 1428, height: 56 }, WA), 'left', '左右平局（6px/6px，宽窗）→ 取左')
eq(detectEdge({ x: 700, y: 31, width: 56, height: 863 }, WA), 'top', '上下平局（6px/6px，高窗）→ 取上')

console.log('用例 4：非法输入守卫（沿 overlay NaN 守卫模式）')
eq(detectEdge(B(NaN, 400), WA), null, 'NaN 坐标 → null')
eq(detectEdge(B(0, 400), { ...WA, width: NaN }), null, 'NaN 工作区 → null')
eq(detectEdge(B(0, 400, 2000, 56), WA), null, '窗口比工作区宽（小屏负区间）→ null')
eq(detectEdge(B(0, 400, 56, 2000), WA), null, '窗口比工作区高 → null')
eq(detectEdge(B(-10, 400), WA), null, '探出工作区（负距离）不算贴边')
eq(detectEdge(B(0, 400, 0, 56), WA), null, '零宽窗口 → null')

console.log('用例 5：隐藏位置（R4-5 原地变柱：窗口不动，返回 docked 本身）')
eq(hiddenBounds(B(0, 400), 'left'), { x: 0, y: 400, width: 56, height: 56 }, '左：原地')
eq(hiddenBounds(B(1384, 400), 'right'), { x: 1384, y: 400, width: 56, height: 56 }, '右：原地')
eq(hiddenBounds(B(700, 25), 'top'), { x: 700, y: 25, width: 56, height: 56 }, '上：原地')
eq(hiddenBounds(B(700, 844), 'bottom'), { x: 700, y: 844, width: 56, height: 56 }, '下：原地')

console.log('用例 6：隐藏稳态信任渲染层（10-10-island-mini-tune R3：主进程零覆盖）')
// 旧契约（居中 132×26 覆盖）三处全对不上渲染：跟 posX 走（非居中）、宽 fit-content
// （非 132）、岛 top:0（非 y=0）→ 点 pill 必穿透。新契约：落定只通知 + 持久化，
// 一次 setPeekOverride 都不调 —— 命中判定走渲染层 reportHit 实测矩形。
{
  const w = fakeWorld({ bounds: B(700, 25, 560, 480) })
  const d = createDockHide(w.api)
  d.onDragStop()
  eq(d.edge(), 'top', '岛窗上沿贴边（y=wa.y 时 d=0，锁顶与 dwell 相容）')
  await sleep(90)
  eq(d.phase(), 'hidden', '计时到 → hidden')
  eq(w.calls.peek.length, 0, '隐藏落定零 setPeekOverride（信任渲染层实测矩形）')
  eq(w.calls.hiddenChange, [true], '通知渲染层 hidden=true（渲染层据此切 pill 形态）')
  eq(w.calls.persist[w.calls.persist.length - 1], { edge: 'top', hidden: true }, '持久化 {edge, hidden}')
  eq(w.boundsOf().x, 700, '窗口原地不动（R4-5 无滑出）')
  eq(w.calls.setPosition.length, 0, '隐藏全程零 setPosition（无位移可崩）')
}

console.log('用例 7：动画曲线')
eq(easeOutCubic(0), 0, 't=0 → 0')
eq(easeOutCubic(1), 1, 't=1 → 1')
ok(easeOutCubic(0.5) > 0.5, 'ease-out：中段进度超前')
eq(animBounds(B(0, 400), B(-52, 400), 1), B(-52, 400), 't=1 落终态（取整精确）')
const mid = animBounds(B(0, 400), B(-52, 400), 0)
eq(mid, B(0, 400), 't=0 在起点')

// ─── 状态机（注入假依赖，真计时，fast 压缩到 50ms）─────────────────────────
function fakeWorld(opts = {}) {
  const calls = { setPosition: [], peek: [], hiddenChange: [], persist: [], fluid: [] }
  let bounds = opts.bounds ?? B(0, 400)
  const fast = opts.fast ?? true
  const api = {
    getBounds: () => ({ ...bounds }),
    setPosition: (x, y) => {
      calls.setPosition.push([x, y])
      bounds = { ...bounds, x, y }
    },
    getWorkArea: () => (opts.workArea ? { ...opts.workArea } : { ...WA }),
    isActive: () => opts.active ?? true,
    reducedMotion: () => opts.reducedMotion ?? false,
    setPeekOverride: (r) => calls.peek.push(r ? { ...r } : null),
    onHiddenChange: (h) => calls.hiddenChange.push(h),
    onPersist: (d) => calls.persist.push({ ...d }),
    onFluidPhase: (phase, edge) => calls.fluid.push({ phase, edge }),
    fast: () => fast
  }
  return { calls, api, boundsOf: () => ({ ...bounds }) }
}

console.log('用例 8：贴边 dragStop → 隐藏（零覆盖 + 持久化，窗口不动）')
{
  const w = fakeWorld()
  const d = createDockHide(w.api)
  d.onDragStop()
  eq(d.phase(), 'dwell-hide', '先起 1000ms 隐藏计时（fast 压到 50ms）')
  await sleep(90)
  eq(d.phase(), 'hidden', '计时到 → hidden')
  eq(d.hidden(), true, 'hidden() 为真')
  eq(d.edge(), 'left', '记住贴的是左邊')
  eq(w.calls.peek.length, 0, '隐藏落定零覆盖（R3：信任渲染层实测矩形）')
  eq(w.calls.hiddenChange, [true], '通知渲染层 hidden=true')
  eq(w.calls.persist[w.calls.persist.length - 1], { edge: 'left', hidden: true }, '持久化 {edge, hidden}')
  eq(w.boundsOf().x, 0, '窗口原地不动（R4-5 无滑出）')
  eq(w.calls.setPosition.length, 0, '隐藏全程零 setPosition（无位移可崩）')
}

console.log('用例 9：中间松手 → 不隐藏')
{
  const w = fakeWorld({ bounds: B(700, 400) })
  const d = createDockHide(w.api)
  d.onDragStop()
  eq(d.phase(), 'idle', '不贴边 → idle')
  await sleep(90)
  eq(d.phase(), 'idle', '计时后仍 idle')
  eq(w.calls.hiddenChange.length, 0, '没有 hidden 通知')
}

console.log('用例 10：隐藏计时期间光标进入球体 → 取消（R1）')
{
  const w = fakeWorld()
  const d = createDockHide(w.api)
  d.onDragStop()
  eq(d.phase(), 'dwell-hide', '计时中')
  d.onCursor(true)
  eq(d.phase(), 'idle', '进入球体 → 取消')
  await sleep(90)
  eq(d.phase(), 'idle', '计时到也不隐藏')
}

console.log('用例 11：痕迹停留 300ms → 唤出；路过不停留 → 不唤出（R3）')
{
  const w = fakeWorld()
  const d = createDockHide(w.api)
  d.onDragStop()
  await sleep(90)
  eq(d.phase(), 'hidden', '前置：已隐藏')
  d.onCursor(true)
  eq(d.phase(), 'dwell-reveal', '柱上进入 → 起唤出计时')
  d.onCursor(false)
  eq(d.phase(), 'hidden', '没停够就离开 → 回 hidden，不唤出')
  eq(w.boundsOf().x, 0, '窗口没动')
  d.onCursor(true)
  await sleep(90)
  eq(d.phase(), 'edge-visible', '停留够 → 回到贴边全可见（窗口本就没动过）')
  eq(w.boundsOf().x, 0, '窗口仍在贴边全可见位置')
  eq(w.calls.hiddenChange[w.calls.hiddenChange.length - 1], false, '通知渲染层 hidden=false')
}

console.log('用例 12：滑出后离开 1500ms → 重藏（跳过 1000ms，直接藏）')
{
  const w = fakeWorld()
  const d = createDockHide(w.api)
  d.onDragStop()
  await sleep(90)
  d.onCursor(true)
  await sleep(90)
  eq(d.phase(), 'edge-visible', '前置：已滑出')
  d.onCursor(false)
  eq(d.phase(), 'dwell-rehide', '离开球体 → 起重藏计时')
  await sleep(90)
  eq(d.phase(), 'hidden', '计时到 → 直接重藏（无 1000ms 停留）')
  // 重藏计时期间光标回来 → 取消重藏
  d.onCursor(true)
  await sleep(90)
  eq(d.phase(), 'edge-visible', '唤出后留在全可见')
  d.onCursor(false)
  d.onCursor(true)
  eq(d.phase(), 'edge-visible', '重藏计时中回来 → 取消重藏')
  await sleep(90)
  eq(d.phase(), 'edge-visible', '不再隐藏')
}

console.log('用例 13：拖拽取消一切并复位（与拖拽计时器互斥）')
{
  const w = fakeWorld()
  const d = createDockHide(w.api)
  d.onDragStop()
  await sleep(90)
  eq(d.phase(), 'hidden', '前置：已隐藏')
  d.onDragStart()
  eq(d.phase(), 'idle', 'dragStart → idle')
  eq(w.boundsOf().x, 0, '先回贴边全可见，拖拽再按它算偏移')
  eq(w.calls.peek[w.calls.peek.length - 1], null, '命中覆盖清除（恢复采信渲染层）')
}

console.log('用例 14：展开/开关关闭 → 回全可见并清 hidden（R7）')
{
  const w = fakeWorld()
  const d = createDockHide(w.api)
  d.onDragStop()
  await sleep(90)
  d.resetToVisible()
  eq(d.phase(), 'idle', '复位到 idle')
  eq(w.boundsOf().x, 0, '窗口回到贴边全可见')
  eq(w.calls.persist[w.calls.persist.length - 1], { edge: 'left', hidden: false }, '持久化 hidden=false（edge 保留）')
}

console.log('用例 15：开关关闭/人物形态/展开态 → 不参与')
{
  const w = fakeWorld({ active: false })
  const d = createDockHide(w.api)
  d.onDragStop()
  eq(d.phase(), 'idle', 'isActive=false → idle，不起计时')
  eq(w.calls.persist[w.calls.persist.length - 1], { edge: null, hidden: false }, 'dock 字段清掉')
  d.onCursor(true)
  eq(d.phase(), 'idle', '光标事件也被忽略')
}

console.log('用例 16：无 hover 点击柱体 → 直接唤出')
{
  const w = fakeWorld()
  const d = createDockHide(w.api)
  d.onDragStop()
  await sleep(90)
  d.onTapPeek()
  eq(d.phase(), 'revealing', '点击即进唤出（不等 300ms 停留）')
  eq(await waitPhase(d, 'edge-visible'), 'edge-visible', 'morph 尾（fast 跳等待）后落定')
  eq(w.boundsOf().x, 0, '窗口本就没动过')
}

console.log('用例 17：reduced-motion 下跳 morph、留计时（R5，真计时证明）')
// ⚠ 之前这里用 fast:true —— fast 与 reduced-motion 走同一个"直接落终态"分支，
// 删掉 reducedMotion() 判断也照样绿。用 fast:false + 真实 1000ms 停留重测，
// 分支才真正被 reduced-motion 撑住（弄坏验证时把 reducedMotion 判据取反，这里必须红）。
{
  const w = fakeWorld({ reducedMotion: true, fast: false })
  const d = createDockHide(w.api)
  d.onDragStop()
  eq(d.phase(), 'dwell-hide', '先起 1000ms 真实隐藏计时')
  eq(await waitPhase(d, 'hidden'), 'hidden', '计时保留，仍隐藏')
  eq(w.calls.setPosition.length, 0, '原地变柱本就没有位移（R4-5：连终态落点都不需要）')
  eq(w.boundsOf().x, 0, '窗口原地')
}

console.log('用例 18：启动恢复（R6）与显示器变化')
{
  const w = fakeWorld()
  const d = createDockHide(w.api)
  d.restore({ edge: 'left', hidden: true })
  eq(d.phase(), 'hidden', '按持久化恢复隐藏态')
  eq(w.boundsOf().x, 0, '原地恢复（R4-5：窗口从未离开，无偏移可重算）')
  d.onDisplayChange()
  eq(d.phase(), 'hidden', '显示器变化后仍 hidden')
  eq(w.boundsOf().x, 0, '仍在原位，不漂移')
  const w2 = fakeWorld()
  const d2 = createDockHide(w2.api)
  d2.restore(undefined)
  eq(d2.phase(), 'idle', '老 state.json 无 dock 字段 → idle，零迁移')
  eq(d2.hidden(), false, 'hidden=false')
}

console.log('用例 19：允许动画时隐藏全程零位移（R4-5：morph 是唯一的动）')
{
  const w = fakeWorld({ fast: false })
  const d = createDockHide(w.api)
  d.onDragStop()
  eq(await waitPhase(d, 'hidden'), 'hidden', '落定 hidden（真实 1000ms 停留 + 530ms morph 等待）')
  eq(w.calls.setPosition.length, 0, '隐藏全程零 setPosition（删掉步进，744 类崩溃无处发生）')
  eq(w.boundsOf().x, 0, '窗口原地')
}

console.log('用例 20：morph 期间的光标翻转不丢（柱上/柱外的人不扑空）')
{
  // 吸入 morph 播到一半进入柱区 → 落定后直接起唤出停留，不用再 wiggle 一次鼠标
  const w = fakeWorld({ fast: false })
  const d = createDockHide(w.api)
  d.onDragStop()
  eq(await waitPhase(d, 'hiding'), 'hiding', '前置：吸入 morph 中')
  d.onCursor(true) // 柱上有人（tick 只在翻转瞬间调一次，这里必须被记住）
  eq(await waitPhase(d, 'edge-visible'), 'edge-visible', '落定后消费记住的翻转，直接唤出')
  eq(w.calls.hiddenChange[w.calls.hiddenChange.length - 1], false, '通知渲染层 hidden=false')
}
{
  // morph 尾播到一半离开 → 落定后直接起重藏停留
  const w = fakeWorld({ fast: false })
  const d = createDockHide(w.api)
  d.onDragStop()
  eq(await waitPhase(d, 'hidden'), 'hidden', '前置：已隐藏')
  d.onCursor(true)
  // 唤出停留 300ms 后 morph 尾（400ms）：轮询抓到 revealing 相再喂离开
  eq(await waitPhase(d, 'revealing'), 'revealing', '前置：汇聚 morph 尾中')
  d.onCursor(false) // 人走了（必须被记住，否则落定后傻站着不藏）
  eq(await waitPhase(d, 'hidden', 6000), 'hidden', '落定后消费记住的离开，直接重藏（1500ms 重藏停留）')
}

console.log('用例 21：显示器变化取消等待态并重判（R1/R6，不沿用旧记忆）')
{
  // 隐藏计时中显示器变化 → 回 idle（旧实现按 edge-visible 留记忆，下一次离开直接藏，少了 1000ms 停留）
  const w = fakeWorld()
  const d = createDockHide(w.api)
  d.onDragStop()
  eq(d.phase(), 'dwell-hide', '前置：隐藏计时中')
  d.onDisplayChange()
  eq(d.phase(), 'idle', '取消等待态，不替用户决定隐藏')
  eq(d.edge(), 'left', '仍在边沿：记住边（docked 已按当前位置刷新）')
  await sleep(90)
  eq(d.phase(), 'idle', '不会自己藏回去（必须重新 dragStop + 停留）')
}
{
  // 窗口已被夹回屏幕中间（display-removed 后的 overlay 行为）→ 边与 docked 都清掉
  const w = fakeWorld()
  const d = createDockHide(w.api)
  d.onDragStop()
  await sleep(90)
  eq(d.phase(), 'hidden', '前置：已隐藏')
  w.api.setPosition(700, 400) // overlay 把漂出可视区的窗口夹回主屏中间
  d.onDisplayChange()
  eq(d.phase(), 'idle', '不在边沿 → idle')
  eq(d.edge(), null, '旧 edge 不再作数（否则下一次唤出飞回旧屏）')
}

console.log('用例 22：启动恢复只认当前边沿（旧屏隐藏态不带到新屏）')
{
  // 显示器拔掉重启：state.json 说 hidden，窗口却被夹在屏幕中间 ——
  // 按旧 edge 藏会造出"球全可见、命中区只有 4px"（看得见点不着）。必须按全可见启动。
  const w = fakeWorld({ bounds: B(700, 400) })
  const d = createDockHide(w.api)
  d.restore({ edge: 'left', hidden: true })
  eq(d.phase(), 'idle', '不在边沿 → 按全可见启动，不隐藏')
  eq(d.hidden(), false, 'hidden=false')
  eq(w.boundsOf().x, 700, '窗口不动（不飞去屏外）')
  eq(w.calls.hiddenChange.length, 0, '不发 hidden 通知')
}

console.log('用例 23：上沿同样隐藏（R4-5：无位移 → 无菜单栏夹取 → 无平台禁藏边）')
{
  // 旧 OS 夹回落点校验随滑出机制一并退役：窗口从不动，就没有"落点被夹回"这件事。
  // 本用例钉住"上沿与其它三边同权" —— 之前上沿是被拒绝的那条边。
  const w = fakeWorld({ bounds: B(700, 25) })
  const d = createDockHide(w.api)
  d.onDragStop()
  eq(d.phase(), 'dwell-hide', '上贴边起计时（不再拒绝）')
  eq(d.edge(), 'top', '记住上沿')
  eq(await waitPhase(d, 'hidden'), 'hidden', '计时到 → hidden')
  eq(w.boundsOf().y, 25, '窗口原地（无处可夹）')
  eq(w.calls.peek.length, 0, '上沿隐藏同样零覆盖（R3）')
  eq(w.calls.persist[w.calls.persist.length - 1], { edge: 'top', hidden: true }, '持久化 hidden=true')
}

console.log('用例 24：右沿隐藏同样信任渲染层（R3：零覆盖，四边一致）')
// 隐藏态命中区不再由主进程决定 —— 四边都是"通知 + 持久化"，无覆盖可设。
{
  const w = fakeWorld({ bounds: B(1384, 400) })
  const d = createDockHide(w.api)
  d.onDragStop()
  eq(d.edge(), 'right', '记住右沿')
  await sleep(90)
  eq(d.phase(), 'hidden', '右沿照常隐藏')
  eq(w.calls.peek.length, 0, '右沿隐藏同样零覆盖（R3）')
  eq(w.boundsOf().x, 1384, '窗口原地')
}

console.log('用例 25：流体相位随状态机推送（dock:fluid 唯一口径，fast 跳 morph）')
{
  const w = fakeWorld()
  const d = createDockHide(w.api)
  d.onDragStop()
  await sleep(90)
  eq(d.phase(), 'hidden', '前置：已隐藏')
  d.onCursor(true)
  await sleep(90)
  eq(d.phase(), 'edge-visible', '前置：已滑出')
  // 去重连续重复：arm 与 animateTo 在同一相位会推两次，序列只看变化
  const seq = w.calls.fluid.map((f) => f.phase).filter((p, i, a) => i === 0 || a[i - 1] !== p)
  const want = ['edge-visible', 'absorbing', 'hidden', 'revealing', 'edge-visible']
  let j = 0
  for (const p of seq) if (p === want[j]) j++
  eq(j, want.length, `流体序列按序出现 ${want.join(' → ')}（实际 ${seq.join(' → ')}）`)
  ok(w.calls.fluid.length > 0 && w.calls.fluid.every((f) => f.edge === 'left'), '每次推送都带当前边（edge=left）')
}

console.log('用例 26：morph 期间窗口纹丝不动（R4-5：morph 是唯一的动）')
{
  const w = fakeWorld({ fast: false })
  const d = createDockHide(w.api)
  d.onDragStop()
  eq(await waitPhase(d, 'hiding'), 'hiding', '前置：吸入 morph 开始（hiding）')
  eq(w.boundsOf().x, 0, 'morph 等待期间窗口纹丝不动（本就没有位移）')
  eq(await waitPhase(d, 'hidden'), 'hidden', 'morph 播完落定 hidden')
  eq(w.boundsOf().x, 0, '终态原地')
  eq(w.calls.setPosition.length, 0, '全程零 setPosition')
  // 唤出侧：revealing 相里窗口本就在全可见位，morph 尾后才进全可见相
  d.onCursor(true)
  eq(await waitPhase(d, 'revealing'), 'revealing', '前置：汇聚 morph 尾中')
  const t0 = Date.now()
  eq(await waitPhase(d, 'edge-visible'), 'edge-visible', 'morph 尾后才进全可见相')
  ok(Date.now() - t0 >= 250, `revealing 相跨越 morph 尾（≥250ms，实际 ${Date.now() - t0}ms）`)
}

console.log('用例 27：非法几何永不产生 undefined（744 崩溃回归 · 纯函数层）')
// 崩溃前 hiddenBounds 对非法边直接回 undefined（switch 无 default，
// 类型却写 Rect）—— 调用方读 to.x 先抛 TypeError，抛在无 try/catch 的定时器里
// 就是主进程对话框。现在非法一律回 null，调用方走"不动 + idle"。
// （peekHitbox 已随 R3 删除：覆盖本身不存在了，无需再守它的非法输入。）
{
  eq(hiddenBounds(B(0, 400), 'up'), null, '非法边 → null（不是 undefined）')
  eq(hiddenBounds(B(0, 400), null), null, 'null 边 → null')
  eq(hiddenBounds(B(0, 400), undefined), null, 'undefined 边 → null')
  eq(hiddenBounds({ x: NaN, y: 400, width: 56, height: 56 }, 'left'), null, 'NaN docked → null')
  eq(hiddenBounds(undefined, 'left'), null, 'undefined docked → null')
  // 有效输入不受影响（正常路别被守卫改坏）
  eq(hiddenBounds(B(0, 400), 'left'), { x: 0, y: 400, width: 56, height: 56 }, '有效边原地返回')
  // fuzz：任何边 × 任何 docked → null 或有限矩形，永不出现 undefined
  const edges = ['left', 'right', 'top', 'bottom', 'up', '', null, undefined, 0]
  const dockeds = [B(0, 400), B(NaN, 400), undefined, null]
  let bad = 0
  for (const ed of edges) {
    for (const dk of dockeds) {
      const r = hiddenBounds(dk, ed)
      if (r === undefined) bad++
      else if (r !== null && (!Number.isFinite(r.x) || !Number.isFinite(r.y))) bad++
    }
  }
  eq(bad, 0, `fuzz ${edges.length * dockeds.length} 组：无 undefined、无非有限坐标`)
}

console.log('用例 28：隐藏全程零位移（744 崩溃回归 · R4-5：无步进无处抛）')
{
  // 28a setPosition 全程抛（模拟 Object has been destroyed）：
  // 隐藏路径根本不碰窗口 —— 抛无处发生，隐藏照常落定，进程不死（这本身就是断言）。
  const w = fakeWorld({ fast: false })
  w.api.setPosition = (x, y) => {
    w.calls.setPosition.push([x, y])
    throw new Error('Object has been destroyed')
  }
  const d = createDockHide(w.api)
  const errors = []
  const origErr = console.error
  console.error = (...a) => { errors.push(a.join(' ')) }
  try {
    d.onDragStop()
    eq(await waitPhase(d, 'hidden', 6000), 'hidden', '28a 全抛 → 照常 hidden（隐藏不碰窗口）')
    eq(w.calls.setPosition.length, 0, '28a 零调用（无处可抛）')
    eq(w.calls.hiddenChange, [true], '28a 通知照常')
    eq(errors.length, 0, '28a 无异常可记（连兜底都不需要经过）')
  } finally {
    console.error = origErr
  }
}
{
  // 28b fast 路径同样零位移：计时回调里只有相位切换 + 通知，无窗口动作。
  const w = fakeWorld({ fast: true })
  w.api.setPosition = (x, y) => {
    w.calls.setPosition.push([x, y])
    throw new Error('Object has been destroyed')
  }
  const d = createDockHide(w.api)
  const errors = []
  const origErr = console.error
  console.error = (...a) => { errors.push(a.join(' ')) }
  try {
    d.onDragStop()
    eq(d.phase(), 'dwell-hide', '28b 前置：隐藏计时中')
    eq(await waitPhase(d, 'hidden', 6000), 'hidden', '28b 全抛 → 照常 hidden')
    eq(w.calls.setPosition.length, 0, '28b 零调用')
    eq(errors.length, 0, '28b 无异常可记')
  } finally {
    console.error = origErr
  }
}
{
  // 28c bounds 全程读不到（关闭中/屏幕瞬态）：onDragStop 按"不参与"处理，不动窗口不起计时
  const w = fakeWorld()
  w.api.getBounds = () => { throw new Error('Object has been destroyed') }
  w.api.getWorkArea = () => { throw new Error('no display') }
  const origErr = console.error
  console.error = () => {}
  try {
    const d = createDockHide(w.api)
    d.onDragStop()
    eq(d.phase(), 'idle', '28c 读不到 bounds → idle，不起计时')
    eq(w.calls.setPosition.length, 0, '28c 窗口一次都没动过')
    await sleep(90)
    eq(d.phase(), 'idle', '28c 计时后仍 idle')
  } finally {
    console.error = origErr
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
