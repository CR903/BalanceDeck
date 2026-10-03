# 技术设计：悬浮球贴边自动隐藏

## 架构与边界

- **几何唯一来源**：主进程 `src/main/overlay.ts`。新增 `dockHide.ts`（主进程模块，状态机 + 计时器 + 动画步进）与
  `src/shared/dock-hide.ts`（纯函数：边沿判定、隐藏偏移、痕迹命中区、常量）。渲染层不算几何，只上报常规命中区；
  隐藏态下主进程覆盖命中区为痕迹条（跨层契约见下）。
- **不碰的**：拖拽手感（16ms 轮询宽松夹取不变）、`snapBackToWorkArea` 严格收回口径、`setPetCursorWatch`
  90ms 轮询节拍、展开态所有路径。

## 状态机

```
visible-at-edge --(dragStop贴边 + 1000ms停留)--> hiding --(动画250-350ms)--> hidden
hidden --(痕迹区停留300ms / 点击)--> revealing --(动画180-220ms)--> visible-at-edge
visible-at-edge --(光标离开球1500ms)--> hiding（重藏跳过1000ms停留）
any --(dragStart / setCollapsed(false) / 显示器变化 / 开关关闭)--> visible-at-edge（取消计时与动画）
```

- 计时器共三把：`hideDwellTimer`（1000ms）、`revealDwellTimer`（300ms）、`rehideTimer`（1500ms），同一时刻最多一把存活。
- 动画是主进程 interval 步进（16ms/帧，`easeOutCubic`），与拖拽计时器互斥：动画期间 `dragTimer` 不启动，
  `dragStart` 直接取消动画并复位到贴边全可见位置。

## 数据流与契约

1. `dragStop()` 收回后调 `dockHide.onDragStop(bounds, workArea)` → 若贴边（≤8px）起 `hideDwellTimer`，
   期间 `cursorInsideHit` 为 true 则取消（用户还抓着球看）。
2. 隐藏偏移计算（纯函数）：`hiddenBounds(dockedBounds, edge, peek=4)`。例：左贴边 `x = wa.x - (W - peek)`。
3. 隐藏态命中区覆盖：`peekHitbox(edge, peek)`（窗口局部坐标，如左贴边 `x ∈ [W-peek, W]`），
   渲染层常规上报在隐藏态下被忽略（主进程以覆盖值为准；恢复可见后重新采信）。
4. `tickCursorWatch` 不变：它只读 `hitbox` + `setIgnoreMouseEvents`。隐藏态痕迹区 `over=true` → 不穿透、可 hover；
   其余区域穿透到桌面。唤出停留 300ms 由 `dockHide` 的 reveal 计时器消费 `cursorOver` 翻转事件（`pet:cursor` 已有通道）。
5. 持久化：`state.json` 新增 `dock: { edge: 'left'|'right'|'top'|'bottom'|null, hidden: boolean }`；
   坐标仍存贴边全可见位置，隐藏偏移每次按当前 `workArea` 重算（显示器变化不漂移）。
6. 开关：`extras` `ui:dockHide`（缺省开，即值 `!== '0'`）；设置页“系统”分区开关 + 球右键原生菜单
   （`src/main/ipc.ts:449,468` 同模型）。关闭 → 取消一切并滑回全可见、清 `hidden`。

## 兼容与迁移

- 老 `state.json` 无 `dock` 字段 → 视为 `{edge: null, hidden: false}`，零迁移。
- 多显示器：`display-removed` / `display-metrics-changed` 取消计时与动画，按现有 `reposition` 口径回正后再重判贴边。
- `prefers-reduced-motion`：渲染层 `matchMedia` 结果经现有偏好通道给主进程（或主进程读系统值，以实现时探到的现成
  API 为准）；命中则跳过动画直接 `setPosition` 到终态，计时器（1000/300/1500ms）保留——降级的是 motion 不是 dwell。
- uitest/shots：隐藏/唤出依赖真实计时；测试侧用短延迟 env 覆盖（如 `BD_DOCK_FAST=1` 将三把计时器压到 50ms），
  断言走 stdout JSON 既有契约。

## 权衡

- 原生窗口逐帧移动 vs 渲染层 CSS 位移：选前者。CSS 位移下透明窗口矩形仍压住边缘，会挡住下方窗口点击；
  移动原生窗口让 OS 级遮挡关系正确。代价是动画期间 ~16 次 `setPosition` IPC，主进程已有 NaN 守卫模式可复用。
- 重藏跳过 1000ms 停留：刚唤出又离开 hung 在边沿反复等 1s 体验差；直接 1500ms 离开计时后藏，误藏成本低（hover 即回）。

## 回滚

- 开关关闭即回滚到现行行为（计时器/动画全取消，`dock.hidden=false` 持久化）。
- 代码回滚点：`dockHide.ts` 独立模块 + `overlay.ts` 三个调用点（`dragStop` 尾、`dragStart` 头、显示器重定位处）；
  删模块 + 恢复三处即回到当前行为，`state.json` 多余 `dock` 字段被忽略。

---

## Fluid 补充设计（2026-10-04，路线 A：SVG gooey + 渐变 3D，无 WebGL）

### 渲染结构

`.petball-goo` 容器挂 `filter: url(#goo)`（feGaussianBlur + feColorMatrix alpha 对比），内部三元素：

1. 球体组（R8 的渐变球 + R9 的水满波浪 + 用量数字）；
2. 液桥 blob（平时 `scale(0)` 藏在球心，吸入时向贴边侧拉伸长大）；
3. 贴边水渍 pill（平时藏，吸入终态留下；沿边沿约 20px × 探出 4px，圆角水滴形）。

动画 = 球体向 pill 侧拉伸 → 液桥长大连通 → 球体收缩汇入 → 窗口整体滑出（主进程既有步进）。
汇聚反向：窗口先滑回 → 液桥拉出 → 球体回弹成形（scale + 微 elastic）→ 桥/pill 收起。

### 状态驱动

主进程 dockHide 状态机新增流体相位，经 `dock:fluid` 通道推送
（`edge-visible | absorbing | hidden | revealing`），渲染层只切 CSS 类、不算几何。
窗口位移仍走主进程 `setPosition` 步进（OS 级遮挡正确），morph 动画与位移动画串行不重叠。
morph 期间命中区取并集（球起始区 ∪ pill 区），主进程覆盖逻辑扩展：
`hidden` → pill 条，`absorbing/revealing` → 并集，落定后恢复常规。

### 3D 观感与水满

- 球体：径向渐变（`--ball-bg` 为基、顶部 `--dot-top` 高光点、底部 `--dot-bottom` 内阴影、
  边缘 `--ball-rim` 反向描边），与 09-28 球形态令牌体系同源，换肤零代码。
- 水满：球内 `<clipPath>` 圆形 + 双层正弦波浪 `<path>`（错速 1:1.6），液位 = `percent`；
  数字仍居中压在液面上（沿用现有环心读数样式）。余额类（`isPlan()` 为假）不挂波浪。
- 波浪用 CSS animation；`hidden` 态暂停；reduced-motion 下静态液位 + slide/跳变位移。

### 时序常量（纯函数，`src/shared/fluid.ts` 新增）

`ABSORB_STRETCH_MS=150`、`ABSORB_MERGE_MS=300`、`ABSORB_SETTLE_MS=80`、
`REVEAL_MS=400`；液位映射 `level(percent)`（clamp 0–100 → 0–1，整数无小数抖动）。
uitest 用 `BD_DOCK_FAST=1` 同比例压缩（复用既有时钟覆盖）。

### 性能与回退

- goo 滤镜 `filterRes` 裁到 56×56 内；动画结束移除 `will-change`。
- 走查验证透明窗口合成（macOS 与 Windows 都要看）；
  若 goo 异常则该形态回退 slide（CSS `@supports` 检测不到滤镜效果，按走查结论硬开关，记入 TASKS）。
- 回滚：删 goo 容器恢复旧 `.petball-fallback` 即回 slide 版（保留 R8/R9 可独立回滚：关水满只留渐变球）。
