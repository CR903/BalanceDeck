# 水球流体视觉重设计 — 技术方案

## 现状锚点（实测结论，不是推测）

- 球内水：`PetBall.tsx` 经 `waveD/waveLine` 算三层正弦路径 + 高光线，CSS 错速漂移；
  颜色走三档 `lvl`（`ballLevel` → `ok/warn/danger`，阈值唯一源 `shared/levels.ts:60/85`），
  CSS 规则 `.petball.no3d.lvl-warn .fluid-wave{fill:var(--warn)}`。用户所谓"不变色"的主因是
  **只有三档跳变 + 三层半透明叠加洗色**，不是完全没实现——本任务把它做成连续插值。
- 贴边：`data-fluid=absorbing/hidden/revealing` 三段 morph 已有（`disc/bridge/pill` 关键帧），
  但只是"球整体平移缩小"，没有"水流走"的观感；且 `hidden` 态连柱顶波都暂停了（与"柱内动荡"要求相悖）。
- 皮肤：5 套只有颜色令牌不同，球体 3D 结构与波参数完全同一套。

## 架构决策

### D1. 水色连续插值，但阈值语义不动

- 新增渲染侧纯函数 `src/renderer/src/water-color.ts`：`waterColor(pct, anchors): string`。
  输入 pct（0–100，已钳制），锚点固定三段：`0→ok色 → 60→warn色 → 85→danger色 → 100→danger深一档`。
  保证在 60/85 处**精确命中等级色**（与卡片/托盘逐像素同色），段间 RGB 线性插值。
- 锚点色来源：JS 经 `getComputedStyle` 读当前皮肤的 `--ok/--warn/--danger`（缓存，皮肤切换时失效重读）。
  换肤自动换水色系，外部皮肤零代码接入；解析失败回退到 aero 缺省三色。
- 消费点：三层波 `fill` + 柱内液 `background` 走**内联 style**；现有 `lvl-*` CSS 填充规则保留为兜底
  （JS 色不可用时仍是三档，不透明不透明）。
- 不动 `shared/levels.ts`（阈值是语义，不是表现）；不动 `shared/fluid.level`（液位映射）。
- 单测：`test-fluid.mjs` 加锚点命中/钳制/单调断言（经 `loadTs` 读真源码）；
  `test-structure.mjs` K 门"水色=lvl 令牌"更新为"内联水色存在 + lvl 兜底仍在"。

### D2. 倒水入场 = 整水体位移三段，不碰逐帧 d 重算

液面路径 `d` 是 JS 按 `surfaceY` 算的，入场若逐帧重算 d = 每帧 React 重渲染Svg。
改走 CSS 合成器动画，零重渲染：

- `data-pour="in"`（mount 时挂，`--uitest`/`--shots` 可冻结取帧）：
  ① 灌入：`.fluid-waves{translateY(-60px)→0}` 600ms ease-in（水从球顶之上倒进来，被 clip 圆裁出"倒满"感）；
  ② 冲顶 overshoot：整球 `scale 1→1.07→1` 250ms + 高光线 opacity 闪峰（"差点冲出瓶口"）；
  ③ 荡漾平息：在 waves 外加 `.slosh` 包裹层，`translateX ±8px→0` 衰减包络 keyframes 1.8s（写死衰减，
  不过渡 duration——CSS 过渡不了 duration，直接一段播完）。
- 切供应商/窗口：G1 评审结论要求重播完整三段（`data-pour="in"` 复用，不另设 tick 档）。
- reduced-motion：全跳过（无 data-pour，直接终态）。
- 计时器：入场总时长后 JS 摘属性（rAF/timeout + unmount 清理，与现有 `docHidden` 模式一致）。

### D3. 贴边吸溜 = 水位"流走"而非球"缩走"

- `absorbing` 阶段新增 `.fluid-waves` 的 `drain`：整水体 `translateY(0→+30px)` + 向贴边侧偏移
  （复用 `--dx/--dy` 变量），被 clip 圆裁出"水面下降、被边吸走"；`bridge` 拉宽成流道（scaleX 沿边方向拉长）；
  柱内液高度经 `--lvl` 变量（JS 内联，與 `fluidLvl` 同源）从 0 升到满——柱是"被灌满"的，不是淡入的。
- `hidden` 态：球内波保持暂停（省电），**柱顶波与柱内涌动保持动画**（用户明确要求"里面也是水在动荡"）。
  `test-structure.mjs` J3b 选择器形状随之更新（hidden 暂停列表删去 `.fluid-column-wave svg`，另起 K8d 断言柱波在 hidden 下仍 animating）。
  另：hidden 稳态球内水 `opacity: 0`（屏上只剩温度计柱）+ **关 goo 滤镜**（K8h；离屏 SVG 滤镜子树画不出，
  morph 仍走 goo —— morph 与位移串行，morph 时窗口全程在屏内）。
- 温度计形状：柱体 + 顶部圆泡（`::before` 圆头，半径=柱宽）+ 侧面高光线 + 可选刻度线（默认开 3 格，
  见评审 Q3）。液位 0 时只留空槽（不造假水位纪律延续）。

### D4. 皮肤差异化 = 全 CSS 变量，振幅统一、性格走视觉层

无缝循环的数学（位移距离=波长整数倍）若逐皮肤改振幅/波长，JS 与 CSS 两处都要开洞且易破环。
决定：**振幅/波长 JS 统一**；皮肤差异走速度/透明度变量 + 球面整组覆盖 + 层数显隐：

| 手段 | 说明 |
|---|---|
| `--wave-speed-a/b/c` | 三层漂移时长（性格主载体：candy 慢、aero 快） |
| `--wave-opacity-a/b/c` | 层透明度（minimal 低、dark 高） |
| 球面 `background` 整组覆盖 | 每皮肤显式写 disc 渐变（玻璃双高光 / 霓虹内圈 / 扁平 / 果冻 / 哑光纸） |
| 层数显隐 | ink 藏 C 层（留白）；其余用透明度调性格 |
| 刻度 | candy 强 / ink 弱两档 opacity 覆盖；其余默认 |

（初版设想的 `--wave-layers/--ball-gloss/--ball-depth/--column-style` 四个标量令牌未采用 ——
球面整组覆盖表达力更强且同样零代码；minimal 也有显式值，静与淡本身即性格。）

- 5 皮肤性格：aero 玻璃水球 / dark 霓虹深海 / minimal 扁平纯净 / candy 果冻糖浆（Q 弹回弹曲线）/ ink 水墨宣纸。
- `:root` 给全套默认值（ext 皮肤退化为统一默认水效，不断裂）。
- 水色系差异免费获得：D1 的锚点色本来就读自皮肤令牌。

## 兼容与回滚

- 新增的只是 `data-pour` 属性、`--lvl` 变量与几组 keyframes；摘掉挂载代码即回旧版（CSS 无引用即死码，
  不影响旧选择器）。
- J3b/K 门的单测更新与实现同一次提交，先弄坏再修绿（本仓纪律：断言必须先红过）。
- `--shots` 新增取帧：`pour-mid`（灌入中）、`pour-top`（冲顶）、`column-full`（柱满）；
  复用 `__bd_fluid_freeze` 模式（`data-pour` 冻结值）。
