# design.md — 灵动岛三修

## 边界

- 只动收起态链：`IslandView.tsx`（环 + 命中上报 + 确认条 ref）、`island.css`（环/确认条视觉）。
- 主进程 `overlay.ts` 穿透轮询只读 `hitbox`，不改判定口径（pad=3、90ms、forward:true 保持）。
- `App.tsx` 播报确认链（`onConfirmAlert`/`alertPending`）不改语义，只消费。
- 不碰几何 `RING_GEO`、窗口顺序、`dock` 隐藏 dwell 时长。

## R1 原型嵌套色 + 辉光保留（取代固定彩虹）

- `NestedRings` 进度环改回每窗按等级着色（与 `prototype/dynamic-island-demo.html:157-167` 同口径，`COLOR[lvlOf(pct)]` / 现代码即 `waterColor(p, anchors)` 语义；截图“外橙内绿”是两窗等级不同所致，应可复现）。
- 轨道保持 `#333` 系；三色辉光改回按 `data-lvl`（ok/warn/danger），缺失灰无辉光。
- 恢复 `readWaterAnchors` 胶水 + `shared/water-color` 导入（彩虹版删掉的那部分）；`data-slot` 可退役，`data-lvl` 恢复为环色唯一口径。
- 收起与展开共用 `NestedRings`，一次改两处生效；几何/窗口顺序/尺寸不动。
- 测试同步回摆：`uitest.ts:1125-1131` 与 J4c 恢复 `waterColor` 期望（彩虹版改动原样 revert 即可）。

## R2 确认条可点（PetBall 同路）

- 根因：`reportHit` 只并了 `isl-body`，确认条（`top:70px` 的兄弟节点）在命中区外 → OS 层直接穿透，按钮收不到点击。
- 修法：照抄 `PetBall.tsx:311-330` 的 union 逻辑——给 `.isl-confirm` 加 `confirmRef`，可见（`offsetHeight>0`）时与 body 矩形求并集上报；`notice` 纯装饰不并入。
- 手势侧已有防护（按钮不进拖拽状态机 `:387`、双击不回卡片 `:489`），本次不改；`reportHit` 依赖补 `alertText/notice`，确认条出现/消失即刷一次。

## R3 可见态点穿（命中丢失）

- 已排除隐藏误认（用户确认岛可见但点穿）。
- 主嫌疑：`reportHit` 的早退 `if (cb.width<=0||hb.width<=0) return`——某帧量到 0 就不再上报，`hitbox` 永远停在旧值；长时运行中一次布局抖动即可永久点穿。
- 修法：去掉“静默早退”，量不到时上报兜底（整窗顶条），与 `PetBall` 的 fallback 对齐；确认条 union 顺带修复“一出确认条岛就点不到”的子情形。
- 次嫌疑（修完仍复现再查）：渲染层 90ms interval 被后台节流、窗口 bounds 漂移、`dock:hidden` 失步。排查用 `petHitboxDebug` + `petIgnoreState` 对比可见矩形，不加新常驻定时器。

## R4 永驻顶部 + 中部拖修好（已确认）

- 锁顶：窗口 y 恒定贴顶（`overlay.ts` 已有 R2 锁顶口径 `snapBackToWorkArea`：y 回 workArea 顶部），拖动只改 x；上下拖/往别处拖无效，松手回顶部。边缘拖的 `startWinDrag` 路径须同样只横向（主进程侧钳制 y）。
- 中部拖修好（真 bug）：用户实测中部拖完全没反应、只有底部边缘拖有效。实现时先查清断点（zone 误判 / state 未更新 / 钳制卡死三选一，用日志或单测复现定性），再修；不改成移窗——岛身拖继续调岛横向落点（`posX` 落盘保留）。
- 带子保留：fit-content 缩窗替代 deferred（岛宽随家数/展开态变化，频繁 resize 易闪）；穿透判定口径不动。
- 横向范围收窄到中间一半：`pet-view.ts:46-47` 的 legacy 界 `ISLAND_POS_MIN/MAX` 从 `0.08/0.92` 改为 `0.25/0.75`，宽度感知交集逻辑（`:59-64`）不动——窄岛退化为中间一半，宽岛仍被窗界收紧，出厂即“只能在顶部中间滑动”。存量越界落盘值就地收敛（读回与重测两处已调同一函数，自动生效）。
- `CLICK_SLOP=6` 点击/拖动分界、展开/收起入口逻辑不动。

- 已排除隐藏误认（用户确认岛可见但点穿）。
- 主嫌疑：`reportHit` 的早退 `if (cb.width<=0||hb.width<=0) return`（`:298`）——某帧量到 0 就不再上报，`hitbox` 永远停在旧值；长时运行中一次布局抖动即可永久点穿。
- 修法：去掉“静默早退”，量不到时上报兜底（整窗顶条或上一次有效矩形），与 `PetBall` 的 fallback 对齐；确认条 union 顺带修复“一出确认条岛就点不到”的子情形。
- 次嫌疑（修完仍复现再查）：渲染层 90ms interval 被后台节流、窗口 bounds 漂移、`dock:hidden` 失步。排查用 `petHitboxDebug` + `petIgnoreState` 对比可见矩形，不加新常驻定时器。

## R5 opencode 换实心图标 + 品牌色（已确认）

- 找 opencode 官方实心版图形（`sst/opencode` 仓库或官网品牌资产；simple-icons 若有更新版也可），墨量与别家相当，24 视口内视觉居中。
- 定一个品牌色（与现有各家不撞：深鲨蓝 `#4D6BFE`、Kimi 跟随灰白、Claude `#D97757` 已占），写入 `color`。
- 约束：只改 `scripts/gen-provider-icons.mjs`（或其图标源），跑 regen，不手工改生成文件； island 收起/展开、设置页、托盘三处同源生效后一起目检截图。

## R6 品牌色补齐 + 嵌套家 logo 缩小（已确认）

- 9 个无色 mark（codex/copilot/cursor/gemini/antigravity/kimi/openrouter/openai-billing/generic）各定品牌色：贴官方品牌色优先，不撞现有 8 色（`#12B76A/#D97757/#4D6BFE/#3859FF/#7C5CFF/#E23B5C/#615CED/#1664FF`）；走生成器 + regen（R5 同路，不手改产物）。
- 嵌套家（≥2 窗）收起 combo 中央 logo 缩小：现 15px 半径 7.5 恰压最内环（r=7.5/stroke 3，内缘 6.0），收到半宽 ≤6（即 ≤12px，实施定具体值，建议 11~12）让出内环；单环家保持 15px；展开态 cell logo（26px 独立位，不在环心）不动。
- 验证： island 收起截图（嵌套/单环并排）+ 设置页 + 撞车检查脚本口径（全仓品牌色唯一）。

## 兼容与回滚

- 视觉只动环色/辉光与图标资产，不改布局尺寸；`--uitest` 岛断言随口径同步（R1 已做两轮），R5 补图标回归目检。
- 命中区只在确认条可见时扩大，平时死区不变；锁顶与 `[0.25, 0.75]` 收窄回滚即恢复常量。

- 视觉只加色/辉光，不改布局尺寸，`--uitest` 的岛断言（`dockHide/islandPill`）不受影响；若辉光过曝，回滚即删 `drop-shadow` 层。
- 命中区只在确认条可见时扩大，平时死区不变；回滚即恢复只报 body。
