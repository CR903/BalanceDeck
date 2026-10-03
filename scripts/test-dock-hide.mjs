// shared/dock-hide.ts + main/dockHide.ts 行为测试（纯函数 + 注入依赖，node 直接跑）
// 用法：node scripts/test-dock-hide.mjs
//
// 悬浮球贴边自动隐藏：边沿判定/隐藏偏移/痕迹命中区/角落平局 + 主进程状态机的
// 计时与取消路径（隐藏/唤出/重藏/路过不唤出/拖拽取消/开关关闭）。

import { loadTs } from './lib/load-ts.mjs'

const shared = await loadTs('src/shared/dock-hide.ts')
const {
  EDGE_THRESHOLD,
  PEEK,
  HIDE_DWELL_MS,
  REVEAL_DWELL_MS,
  REHIDE_MS,
  HIDE_ANIM_MS,
  REVEAL_ANIM_MS,
  detectEdge,
  hiddenBounds,
  peekHitbox,
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

console.log('用例 1：常量口径（PRD R1–R5）')
eq(EDGE_THRESHOLD, 8, '贴边阈值 8px')
eq(PEEK, 4, '痕迹 4px')
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

console.log('用例 5：隐藏偏移（只留 4px 痕迹）')
eq(hiddenBounds(B(0, 400), 'left'), { x: -52, y: 400, width: 56, height: 56 }, '左：x = 0 - (56-4)')
eq(hiddenBounds(B(1384, 400), 'right'), { x: 1436, y: 400, width: 56, height: 56 }, '右：x = 1384 + (56-4)')
eq(hiddenBounds(B(700, 25), 'top'), { x: 700, y: -27, width: 56, height: 56 }, '上：y = 25 - (56-4)')
eq(hiddenBounds(B(700, 844), 'bottom'), { x: 700, y: 896, width: 56, height: 56 }, '下：y = 844 + (56-4)')

console.log('用例 6：痕迹命中区（窗口局部坐标，与隐藏偏移同源）')
eq(peekHitbox('left', { width: 56, height: 56 }), { x: 52, y: 0, width: 4, height: 56 }, '左：痕迹条在窗口右侧')
eq(peekHitbox('right', { width: 56, height: 56 }), { x: 0, y: 0, width: 4, height: 56 }, '右：痕迹条在窗口左侧')
eq(peekHitbox('top', { width: 56, height: 56 }), { x: 0, y: 52, width: 56, height: 4 }, '上：痕迹条在窗口底部')
eq(peekHitbox('bottom', { width: 56, height: 56 }), { x: 0, y: 0, width: 56, height: 4 }, '下：痕迹条在窗口顶部')

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
    fast: () => fast,
    // 平台约束注入（默认全支持；macOS 上沿用 (e) => e !== 'top' 模拟，见用例 24）
    isEdgeSupported: typeof opts.edgeSupported === 'function' ? opts.edgeSupported : () => true
  }
  return { calls, api, boundsOf: () => ({ ...bounds }) }
}

console.log('用例 8：贴边 dragStop → 隐藏（痕迹覆盖 + 持久化）')
{
  const w = fakeWorld()
  const d = createDockHide(w.api)
  d.onDragStop()
  eq(d.phase(), 'dwell-hide', '先起 1000ms 隐藏计时（fast 压到 50ms）')
  await sleep(90)
  eq(d.phase(), 'hidden', '计时到 → hidden')
  eq(d.hidden(), true, 'hidden() 为真')
  eq(d.edge(), 'left', '记住贴的是左邊')
  const lastPeek = w.calls.peek[w.calls.peek.length - 1]
  eq(lastPeek, { x: 52, y: 0, width: 4, height: 56 }, '命中区覆盖为左贴边痕迹条')
  eq(w.calls.hiddenChange, [true], '通知渲染层 hidden=true')
  eq(w.calls.persist[w.calls.persist.length - 1], { edge: 'left', hidden: true }, '持久化 {edge, hidden}')
  eq(w.boundsOf().x, -52, '窗口滑出到只剩 4px（fast 跳终态）')
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

console.log('用例 11：痕迹停留 300ms → 滑出；路过不停留 → 不唤出（R3）')
{
  const w = fakeWorld()
  const d = createDockHide(w.api)
  d.onDragStop()
  await sleep(90)
  eq(d.phase(), 'hidden', '前置：已隐藏')
  d.onCursor(true)
  eq(d.phase(), 'dwell-reveal', '痕迹区进入 → 起唤出计时')
  d.onCursor(false)
  eq(d.phase(), 'hidden', '没停够就离开 → 回 hidden，不唤出')
  eq(w.boundsOf().x, -52, '窗口没动')
  d.onCursor(true)
  await sleep(90)
  eq(d.phase(), 'edge-visible', '停留够 → 滑出到贴边全可见')
  eq(w.boundsOf().x, 0, '窗口回到贴边全可见位置')
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

console.log('用例 16：无 hover 点击痕迹 → 直接滑出')
{
  const w = fakeWorld()
  const d = createDockHide(w.api)
  d.onDragStop()
  await sleep(90)
  d.onTapPeek()
  eq(d.phase(), 'edge-visible', '点击即滑出（不等 300ms）')
  eq(w.boundsOf().x, 0, '窗口回到全可见')
}

console.log('用例 17：reduced-motion 下跳动画、留计时（R5，真计时证明）')
// ⚠ 之前这里用 fast:true —— fast 与 reduced-motion 走同一个"直接落终态"分支，
// 删掉 reducedMotion() 判断也照样绿。用 fast:false + 真实 1000ms 停留重测，
// 分支才真正被 reduced-motion 撑住（弄坏验证时把 reducedMotion 判据取反，这里必须红）。
{
  const w = fakeWorld({ reducedMotion: true, fast: false })
  const d = createDockHide(w.api)
  d.onDragStop()
  eq(d.phase(), 'dwell-hide', '先起 1000ms 真实隐藏计时')
  eq(await waitPhase(d, 'hidden'), 'hidden', '计时保留，仍隐藏')
  eq(w.calls.setPosition.length, 1, '只落一次终态（无逐帧步进）')
  eq(w.boundsOf().x, -52, '落在隐藏终态')
}

console.log('用例 18：启动恢复（R6）与显示器变化')
{
  const w = fakeWorld()
  const d = createDockHide(w.api)
  d.restore({ edge: 'left', hidden: true })
  eq(d.phase(), 'hidden', '按持久化恢复隐藏态')
  eq(w.boundsOf().x, -52, '按当前 workArea 重算偏移')
  d.onDisplayChange()
  eq(d.phase(), 'hidden', '显示器变化后仍 hidden')
  eq(w.boundsOf().x, -52, '偏移重算，不漂移')
  const w2 = fakeWorld()
  const d2 = createDockHide(w2.api)
  d2.restore(undefined)
  eq(d2.phase(), 'idle', '老 state.json 无 dock 字段 → idle，零迁移')
  eq(d2.hidden(), false, 'hidden=false')
}

console.log('用例 19：允许动画时真逐帧步进（不是一次跳终态）')
{
  const w = fakeWorld({ fast: false })
  const d = createDockHide(w.api)
  d.onDragStop()
  eq(await waitPhase(d, 'hidden'), 'hidden', '落定 hidden（真实 1000ms 停留 + 300ms 动画）')
  ok(w.calls.setPosition.length >= 5, `动画逐帧调 setPosition（实际 ${w.calls.setPosition.length} 次，删掉 interval 就剩 1 次）`)
  eq(w.boundsOf().x, -52, '终态精确')
}

console.log('用例 20：动画期间的光标翻转不丢（追球的手不扑空）')
{
  // 隐藏播到一半进入痕迹 → 落定后直接起唤出停留，不用再 wiggle 一次鼠标
  const w = fakeWorld({ fast: false })
  const d = createDockHide(w.api)
  d.onDragStop()
  eq(await waitPhase(d, 'hiding'), 'hiding', '前置：隐藏动画播到一半')
  d.onCursor(true) // 痕迹上有人（tick 只在翻转瞬间调一次，这里必须被记住）
  eq(await waitPhase(d, 'edge-visible'), 'edge-visible', '落定后消费记住的翻转，直接滑出')
  eq(w.calls.hiddenChange[w.calls.hiddenChange.length - 1], false, '通知渲染层 hidden=false')
}
{
  // 滑出播到一半离开 → 落定后直接起重藏停留
  const w = fakeWorld({ fast: false })
  const d = createDockHide(w.api)
  d.onDragStop()
  eq(await waitPhase(d, 'hidden'), 'hidden', '前置：已隐藏')
  d.onCursor(true)
  // 唤出停留 300ms 后滑出动画（200ms）：轮询抓到 revealing 相再喂离开
  eq(await waitPhase(d, 'revealing'), 'revealing', '前置：滑出动画播到一半')
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

console.log('用例 23：OS 夹回落点 → 不算隐藏成功（macOS 菜单栏实测）')
{
  // macOS 不许窗口顶部越过菜单栏：setPosition(y=-27) 被系统夹回 y=25。
  // 控制器必须验落点，失败则回到贴边全可见 + idle，绝不停在半态。
  const calls = { setPosition: [], peek: [], hiddenChange: [], persist: [] }
  let bounds = B(700, 25)
  const api = {
    getBounds: () => ({ ...bounds }),
    setPosition: (x, y) => {
      calls.setPosition.push([x, y])
      // 模拟系统夹取：窗口顶部不许越过 workArea 顶部
      bounds = { ...bounds, x, y: Math.max(y, WA.y) }
    },
    getWorkArea: () => ({ ...WA }),
    isActive: () => true,
    reducedMotion: () => false,
    setPeekOverride: (r) => calls.peek.push(r ? { ...r } : null),
    onHiddenChange: (h) => calls.hiddenChange.push(h),
    onPersist: (d) => calls.persist.push({ ...d }),
    fast: () => true
  }
  const d = createDockHide(api)
  d.onDragStop()
  eq(d.phase(), 'dwell-hide', '上贴边起计时')
  await sleep(90)
  eq(d.phase(), 'idle', '落点被夹回 → 回到 idle，不停在半态')
  eq(bounds.y, 25, '窗口回到贴边全可见位置')
  eq(calls.hiddenChange.length, 0, '从未通知过 hidden（没有"看得见点不着"的窗口期）')
  eq(calls.persist[calls.persist.length - 1], { edge: 'top', hidden: false }, '持久化 hidden=false')
}

console.log('用例 24：平台不支持的边直接拒绝（macOS 上沿，不试藏）')
// abort 是"试了再撤"（1s 停留后无事发生）；拒绝是"根本不起藏" —— 确定性行为，E2E 可断言。
// overlay 侧用 (e) => e !== 'top' || platform !== 'darwin' 注入（裸窗口探针实测：
// 可见窗口 setPosition 到 workArea.y-52 会被系统同步夹回，隐藏窗口则不会）。
{
  const macTop = (e) => e !== 'top'
  const w = fakeWorld({ bounds: B(700, 25), edgeSupported: macTop })
  const d = createDockHide(w.api)
  d.onDragStop()
  eq(d.phase(), 'idle', '上贴边但平台不支持 → idle，不起计时')
  eq(d.edge(), null, 'edge 不记忆（与"屏幕中间"同口径：不参与）')
  eq(w.calls.setPosition.length, 0, '窗口一次都没动过（没有 1s 后的定向闪烁）')
  eq(w.calls.hiddenChange.length, 0, '不发 hidden 通知')
  await sleep(90)
  eq(d.phase(), 'idle', '计时后仍 idle（不是 abort，是从未开始）')
  // 同一约束下左沿照常藏（拒绝只针对上沿）
  const w2 = fakeWorld({ edgeSupported: macTop })
  const d2 = createDockHide(w2.api)
  d2.onDragStop()
  eq(d2.phase(), 'dwell-hide', '左贴边不受影响')
  await sleep(90)
  eq(d2.phase(), 'hidden', '左沿照常隐藏')
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

console.log('用例 26：全动效下 morph 与位移串行（先 morph 后滑，不重叠）')
{
  const w = fakeWorld({ fast: false })
  const d = createDockHide(w.api)
  d.onDragStop()
  eq(await waitPhase(d, 'hiding'), 'hiding', '前置：吸入 morph 开始（hiding）')
  eq(w.boundsOf().x, 0, 'morph 等待期间窗口纹丝不动（位移尚未开始）')
  eq(await waitPhase(d, 'hidden'), 'hidden', 'morph 播完才滑，落定 hidden')
  eq(w.boundsOf().x, -52, '终态精确')
  // 唤出侧：滑出落定后 morph 尾才结束（revealing 相里窗口已在全可见位）
  d.onCursor(true)
  eq(await waitPhase(d, 'revealing'), 'revealing', '前置：滑出 morph 中')
  const t0 = Date.now()
  for (;;) {
    if (w.boundsOf().x === 0 || Date.now() - t0 > 5000) break
    await sleep(50)
  }
  eq(w.boundsOf().x, 0, '滑块先落定到贴边全可见')
  const tSlide = Date.now()
  eq(await waitPhase(d, 'edge-visible'), 'edge-visible', 'morph 尾后才进全可见相')
  ok(Date.now() - tSlide >= 250, `位移落定与相位落定之间隔着 morph 尾（≥250ms，实际 ${Date.now() - tSlide}ms）`)
}

console.log('用例 27：非法几何永不产生 undefined（744 崩溃回归 · 纯函数层）')
// 崩溃前 hiddenBounds/peekHitbox 对非法边直接回 undefined（switch 无 default，
// 类型却写 Rect）—— 调用方读 to.x 先抛 TypeError，抛在无 try/catch 的定时器里
// 就是主进程对话框。现在非法一律回 null，调用方走"不动 + idle"。
{
  eq(hiddenBounds(B(0, 400), 'up'), null, '非法边 → null（不是 undefined）')
  eq(hiddenBounds(B(0, 400), null), null, 'null 边 → null')
  eq(hiddenBounds(B(0, 400), undefined), null, 'undefined 边 → null')
  eq(hiddenBounds({ x: NaN, y: 400, width: 56, height: 56 }, 'left'), null, 'NaN docked → null')
  eq(hiddenBounds(undefined, 'left'), null, 'undefined docked → null')
  eq(peekHitbox('up', { width: 56, height: 56 }), null, '非法边 → null（不是 undefined）')
  eq(peekHitbox('left', { width: NaN, height: 56 }), null, 'NaN 尺寸 → null')
  eq(peekHitbox('left', null), null, 'null 尺寸 → null')
  eq(peekHitbox('left', { width: 0, height: 56 }), null, '零宽尺寸 → null')
  // 有效输入不受影响（正常路别被守卫改坏）
  eq(hiddenBounds(B(0, 400), 'left'), { x: -52, y: 400, width: 56, height: 56 }, '有效边仍精确')
  eq(peekHitbox('left', { width: 56, height: 56 }), { x: 52, y: 0, width: 4, height: 56 }, '有效边仍精确')
  // fuzz：任何边 × 任何 docked → null 或有限矩形，永不出现 undefined
  const edges = ['left', 'right', 'top', 'bottom', 'up', '', null, undefined, 0]
  const dockeds = [B(0, 400), B(NaN, 400), undefined, null]
  let bad = 0
  for (const ed of edges) {
    for (const dk of dockeds) {
      const r = hiddenBounds(dk, ed)
      if (r === undefined) bad++
      else if (r !== null && (!Number.isFinite(r.x) || !Number.isFinite(r.y))) bad++
      const q = peekHitbox(ed, { width: 56, height: 56 })
      if (q === undefined) bad++
      else if (q !== null && (!Number.isFinite(q.x) || !Number.isFinite(q.y))) bad++
    }
  }
  eq(bad, 0, `fuzz ${edges.length * dockeds.length * 2} 组：无 undefined、无非有限坐标`)
}

console.log('用例 28：定时器链异常安全（744 崩溃回归 · 状态机层）')
{
  // 28a 动画中途窗口关闭：setPosition 全抛（模拟 Object has been destroyed）。
  // 崩溃前 animTimer 的 16ms 步进无 try/catch，第一次 tick 就把异常抛给 Node
  // 计时器 → 主进程对话框，整个测试进程都会被杀死（这本身就是断言）。
  const w = fakeWorld({ fast: false })
  const d = createDockHide(w.api)
  const errors = []
  const origErr = console.error
  console.error = (...a) => { errors.push(a.join(' ')) }
  try {
    d.onDragStop()
    eq(await waitPhase(d, 'hiding'), 'hiding', '28a 前置：隐藏动画播到一半')
    w.api.setPosition = (x, y) => {
      w.calls.setPosition.push([x, y])
      throw new Error('Object has been destroyed')
    }
    eq(await waitPhase(d, 'idle', 6000), 'idle', '28a 步进抛 → 停动画回 idle（不崩进程）')
    const nonFinite = w.calls.setPosition.filter(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))
    eq(nonFinite, [], '28a setPosition 记录里无 undefined/NaN（undefined 不得进 setPosition）')
    ok(errors.length >= 1, '28a 异常被记了一次日志（兜底跑过，不是空洞通过）')
  } finally {
    console.error = origErr
  }
}
{
  // 28b 位移动作抛（窗口已销毁，destroyed 窗口的 setPosition 抛）：
  // fast 路径下 animateTo 跑在 arm 的 setTimeout 回调里，崩溃前该回调无
  // try/catch → 未捕获异常对话框，测试进程会被杀死（这本身就是断言）。
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
    eq(await waitPhase(d, 'idle', 6000), 'idle', '28b 计时回调里抛 → 回 idle（不崩进程）')
    const nonFinite = w.calls.setPosition.filter(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))
    eq(nonFinite, [], '28b setPosition 记录里无 undefined/NaN（抛之前参数已是有限数）')
    ok(errors.length >= 1, '28b 异常被记了一次日志（兜底跑过，不是空洞通过）')
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
