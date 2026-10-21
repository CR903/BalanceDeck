# 渲染层视图树（frontend）

适用：改 UI 前（加视图 / 改窗口形态 / 加设置项）先看这篇，避免把单窗多形态误当成多窗。

## 一个窗口，四种形态

全仓只有 **2 处 `new BrowserWindow`**：
- 常驻 overlay 窗 = **唯一 UI 窗**（`src/main/overlay.ts:385` `createOverlay()`）——没有独立的托盘窗/设置窗，托盘只是菜单栏图标（`src/main/tray.ts:43`），设置页是 overlay 窗内的一个视图。
- opencode 授权临时窗（`src/main/opencode-auth.ts:218`，一次性 OAuth 回调页，与 UI 无关）。

overlay 窗关键参数（overlay.ts:19-21, 411-423）：尺寸随形态在 384×600（展开）与 560×480（收起灵动岛 `ISLAND_VIEW`，常量唯一出处 `src/shared/pet-view.ts:31`）间切换；`transparent: true`、`skipTaskbar`、**`backgroundThrottling: false` 必须关**（注释解释了为什么：1 小时级定时播报会被 Chromium 节流）。命中/穿透：`setPetHitbox` + `tickCursorWatch`（90ms 光标轮询 + `setIgnoreMouseEvents`，overlay.ts:803-903）。

## React 单根切换

- `src/renderer/src/App.tsx:1077-1228` 四分支：`collapsed ? <IslandView/> : view === 'settings' ? <SettingsView/> : view === 'detail' ? <DetailView/> : <CardView/>`（`View = 'card'|'detail'|'settings'` :93）。
- **收起/展开由主进程改窗**：`overlay.ts:674 setCollapsed()` 改 BrowserWindow 尺寸/阴影/穿透后 `safeSend('ui:collapsed')`；渲染层 `App.tsx:985` 订阅 + `:991` `getCollapsed()` 启动期拉取（启动时序洞说明在 overlay.ts:76-89）。切换入口：`doCollapse`(:1009)/`doExpand`(:1013)/`openDetail`(:1018)/`openIslandDetail`(:1029)。

## 组件职责与状态源

| 组件 | 职责 | 状态 |
|---|---|---|
| `App.tsx` | 顶层编排：持 AppState/视图/收起态/提醒配置 | 全部 `useState`（:96-254）+ `window.api`；**无全局 store**（无 zustand/redux），持久化走 extras `ui:*` 键（:283-301），难同步的走 ref 镜像（`alertCtxRef`:548、`alertLatchRef`:605、`notifyLatchRef`:195） |
| `IslandView.tsx` | 收起态唯一形态：平铺岛/展开卡/mini-pill | 纯受控，全 props 进；自有少量 `ui:islandX` 位置 state |
| `CardView.tsx` | 主页卡片网格，拖拽排序=优先级（:22-23） | `state` 整包 props 下钻 |
| `DetailView.tsx` | 单供应商完整统计 | props + 本地 `EMPTY_POINTS`(:24) |
| `SettingsView.tsx` | 实例 CRUD + 外观/刷新/系统/语音 | 纯 props 回调转回 App，内部只有表单草稿 |
| `PetBall.tsx` | **已退役**（不再被任何文件 import，头注释 :26-31）；确认气泡新家在 IslandView（`isl-confirm-text` :660-671） | — |

## read-model：纯函数读模型契约

`src/renderer/src/read-model.ts` 无 electron/DOM/React，被 `npm run test:read-model` 直测（文件头 :1-14 记了动机）。
- 输入：`ProviderSnapshot[]` + `ProviderInfo[]`。
- 派生：`primaryWindow`(:23)/`worstWindow`(:28)/`maxPercent`(:43)/`snapshotLevel`(:49)/`speakableSnapshots`(:85)/`groupOf`、`orderForDisplay`(:165-234)/`ballLevel`(:241)。
- **阈值判定不在这里**：委托 `format.levelOfPercent`（format.ts:57 re-export 自 `src/shared/levels.ts:14`，全仓唯一阈值）。

## 参考

- 命中区的结构契约：[overlay-hitbox](overlay-hitbox.md)。
- 收起态内部的时序/样式纪律：`/island.css` 与 [pets knowledge 相关篇](../troubleshooting/petball-mount-conditions.md)。
