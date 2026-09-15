---
id: "3b531203-d169-4571-a6bc-78472cd54224"
title: "BalanceDeck 收起态交互：指针状态机契约与「黏住光标」根因（第十八轮）"
description: "BalanceDeck 悬浮球指针交互增量：右键/原生菜单抢走事件序列导致「宠物黏住光标」的根因与修复契约（主键判定、buttons 校验、菜单前后复位、window 级兜底）、合成指针事件必须带 buttons、设置页开关行间距约定、回归断言与验证数字。"
status: "active"
created_at: "2026-09-15T08:46:12.699Z"
updated_at: "2026-09-15T08:46:12.699Z"
content_hash: "e97077cc2b1bd4d1da243a3cc6caceea5cf4d2a6169fc8154fe61f387f6315e7"
source_paths:
  - "src/renderer/src/PetBall.tsx"
  - "src/renderer/src/skins.css"
  - "src/main/index.ts"
  - "src/main/overlay.ts"
  - "DESIGN.md"
  - "TASKS.md"
session_ids:
  - "8533e722-e807-4fd3-915e-d0ebd9101020"
memory_body_ids:
  []
---

# BalanceDeck 收起态交互：指针状态机契约与「黏住光标」根因

来源：2026-09-15 第十八轮用户反馈（① 设置页两个开关框挨太近；② 右键弹菜单后点宠物区域外，宠物黏住鼠标焦点一起乱动，直到单击宠物区域才释放）。

**不重复既有文档**（本轮结论晚于两者，二者未覆盖）：
- `38d69245-956d-408c-ae68-40d6fde75151` — 第十六轮：球体合成、逐皮肤令牌、命中半径换算、鼠标穿透协议。
- `067a74d8-c3d4-42ec-8b9c-a9bd100dc025` — 第十七轮：球/宠物双形态、`ui:alwaysOnTop`、收起态必须关原生窗口阴影、CC0 GLB 内联管线与 CSP。

## 1. 「宠物黏住光标」根因链（用户可见 bug）

1. 右键同样触发 `pointerdown`，旧代码不判按键 → `press.current.down = true`（并启动 620ms 长按计时器）。
2. 原生菜单 `Menu.popup()` 抢走事件序列；**点菜单外面那一下不会回到本窗口**，`pointerup` 永远收不到 → 按下状态永久残留。
3. 之后鼠标在球上移动超过 8px（阈值判定）→ 被判为拖拽 → 主进程 16ms 拖拽循环让窗口跟着光标跑。
4. 直到用户再点一次宠物，才走到 `pointerup` → `finish()` → 释放。

**核心教训：在桌面悬浮窗里，「pointerdown 之后必然收到 pointerup」这个假设不成立** —— 原生菜单、系统弹窗、窗口失焦、指针移出窗口都会吃掉后半段事件序列。任何依赖"按下中"状态的交互（拖拽/长按/连点）都必须有失效检测与复位路径。

## 2. 指针状态机契约（`src/renderer/src/PetBall.tsx`）

1. `onPointerDown` 只处理主键：`if (e.button !== 0) return`（右键/中键不进入按下与长按状态）。
2. `onPointerMove` 要求主键仍按着：`if ((e.buttons & 1) === 0) { resetPress(); return }`。
3. 抽出 `resetPress(endDrag = false)`：清 `press`、清长按计时器、必要时通知主进程 `dragEnd`（幂等）。
   在**右键菜单弹出前后各调用一次**（`openMenu` 开头与 `await onMenu()` 之后）。
4. window 级兜底：`pointerup` / `pointercancel` / `blur` → `resetPress(true)`（指针在窗口外抬起、窗口失焦都能释放）。
5. 主进程侧同源约束（见 `overlay.ts`）：抓取点必须 `Number.isFinite` 才采用；光标/目标坐标非有限值跳过该帧；
   拖拽帧与光标轮询定时器整体 `try/catch` —— **定时器回调抛异常会直接终止主进程**（此前实机表现为点击悬浮球弹 Uncaught Exception）。

## 3. 测试侧强制约束

- **合成 `PointerEvent` 必须显式带 `buttons`**：真实事件一定有；`buttons` 缺省为 0，
  会被第 2 条判定当成"指针状态失效"，于是测试里的拖拽静默不再触发（本轮曾因此让 `dragFired` 变红）。
  约定：按下用 `buttons: 1`，抬起用 `buttons: 0`，右键用 `button: 2, buttons: 2`，
  "无按键移动"用 `button: -1, buttons: 0`。
- 新增回归断言（`src/main/index.ts --uitest`）：
  - `petNoStickyDrag`：右键 → contextmenu → Esc 关菜单 → 无按键移动鼠标 5 次，断言**未触发任何拖拽**
    （用既有观测点 `consumeDragFired()` 判定）；
  - `petStillCollapsed`：上述过程不得展开面板；
  - `petLongPress` / `petToast`：长按 0.78s → 亲密度上升、面板不展开、出现互动提示（重构时曾被漏掉，已补回）。

## 4. 设置页开关行间距（设计系统约定）

`.enable-row` 是自带底色与描边的独立圆角卡片；相邻两块默认无间距，会贴成一整块（用户反馈"两个设置框挨太近"）。
约定：`.enable-row + .enable-row { margin-top: 8px }`（`src/renderer/src/skins.css`）。
容器已有 `gap` 的场景（如 `.pet-sec`）不需要再依赖这条。

## 5. 涉及文件与验证

- `src/renderer/src/PetBall.tsx`（指针状态机、`resetPress`、window 级兜底）
- `src/renderer/src/skins.css`（`.enable-row + .enable-row`）
- `src/main/index.ts`（回归断言、合成事件补 `buttons`）
- `DESIGN.md`「指针状态机」小节；`TASKS.md` 第十八轮

验证快照（本轮）：typecheck ✓ build ✓ 单元测试 187（`test:pet` 64 · `test:walker` 24 · 其余 99）✓
uitest 78 项全通过（consoleErrors: none）✓ 设计走查 29 张 ✓
