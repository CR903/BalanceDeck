# 系统通知自验通路：测试按钮 + 「发起≠已显示」引导（根因：macOS 吞弹）

任务：`.trellis/tasks/10-21-test-notify-and-hint`

## 起因

用户报告两件事：①昨天（10-19）用量 80% 未弹系统通知，要求检查提醒逻辑；②核查 OpenCode Go
月额度是否从 $60 提到 $80 的传言。

排查结论：**提醒逻辑正确（73 项单测全绿），根因在 macOS 权限层 —— 系统设置里 BalanceDeck
的「允许通知」是关的，Electron `Notification.show()` 静默成功、应用无感知通路，锁存把该键
当「弹过」记下后全天不重试。** 应用内无 API 探测授权状态 → 本任务给用户一条自验通路。

| # | 证据 | 观测值 |
|---|---|---|
| E1 | `node scripts/test-system-notify.mjs`（判定层） | 73 通过 / 0 失败 |
| E2 | `secrets.bin` extras | `ui:notifyOn=1`、`pctWarn=50/pctHigh=80`（配置正常） |
| E3 | `usage-history.json` 10-19 本月窗口 | 15:58 达 80.5%（越过 80），采集点全程连续 |
| E4 | `ncprefs.plist` flags 对比 | `dev.zhouri.balancedeck`=8396814（无 bit28）vs 微信=276832270（有 bit28，macOS 15.7.7 实测「允许通知」位=bit28，社区旧解码 bit25 已过时） |
| E5 | OpenCode Go 官方文档（10-20 口径） | 额度按模型：多数 $60；DeepSeek V4.1 Flash 近期 $60→$80（单模型，非整体提额）——显示 $60 没错 |

## 改了什么

| 文件 | 改动 |
|---|---|
| `src/renderer/src/systemNotify.ts` | 新增纯函数 `testNotifyPayload()`：与真实提醒同构（title='BalanceDeck 测试通知'、level='warn'），被单测钉住「能过主进程逐字段校验」 |
| `src/renderer/src/App.tsx` | `testNotify` 走真实链路 `notifyShow(testNotifyPayload())`，不受 `ui:notifyOn` 约束；`showNotifyTestNote`（独立 `notifyTestNoteTimerRef`，成功 3s 消失/失败不消失，与 `showTestNote` 同构）；反馈文案写明「发起 ≠ 已显示」+ 系统设置路径；卸载清理补新定时器 |
| `src/renderer/src/VoiceReminderSection.tsx` | E 区开关下方（`{notifyOn && …}` **之外**）加测试按钮 `vrs-notify-test`、反馈条 `vrs-notify-test-note`、常驻引导 `vrs-notify-guide` |
| `src/renderer/src/skins.css` | 补 `.vrs-notify-test` 尺寸（防 `.btn-secondary` 拉满整行）与 `.vrs-notify-test-note.ok` 绿色（check 自修：同族样式缺失） |
| `src/main/qa/uitest.ts` | `vrsNotifyTestVisible` / `vrsNotifyTestFired` 两条 UI 断言，放在「通知开关刚关」状态（恰好覆盖 AC3 + 本机权限关着 = AC2 真机过） |
| `scripts/test-system-notify.mjs` | J 区 11→12 条断言（check 自修：首版 J9/J10 被无关调用点喂绿 → 函数切片 J11 前置守卫 + 变异验证） |
| `.trellis/spec/frontend/{quality-guidelines,component-guidelines}.md` | 两条 spec 沉淀：全文正则断言空洞通过陷阱；通知「静默成功」gotcha + 测试按钮模式 |
| `docs/knowledge/frontend/system-notify-silent-failure.md` + `index.md` | P2 沉淀：归因四步法 + ncprefs bit28 取证 + 自验通路对策 |

## 设计取舍

### ① 不做应用内探测 macOS 授权状态

Electron 无 API，hack（轮询 `systemPreferences`/私有 plist 读）不可靠且越界。代价：测试按钮
只能证明「链路发了」，给不了「系统显示了」——所以反馈措辞承担了举证责任。

### ② 测试按钮不受 `ui:notifyOn` 开关约束

要测的恰是「开了开关却不弹」的场景，按钮被开关挡住就测不到。代价：开关关着也能发起一条
通知（用户显式点击，可接受）。

### ③ 反馈 timer 独立，不与 `showTestNote` 共用

共用一条计时器时两条反馈互相顶掉对方的 3s 计时（先点测试播报再点测试通知 → 前者提示被清）。
代价：多一个 ref，换取两条反馈互不干扰。

## 取证（命令 + 原始输出）

### 1. 类型门禁

```bash
npm run typecheck
```

```
通过（0 error）
```

### 2. 全量单测（含加固后的 J 区）

```bash
npm test
```

```
24 个套件全绿，test-system-notify 84 通过 / 0 失败
```

### 3. 真 Electron UI 测试

```bash
npm run build
BD_USER_DATA=$(mktemp -d) npx electron . --uitest
```

```
174 条断言 0 失败；vrsNotifyTestVisible = ok、vrsNotifyTestFired = ok
```

### 4. 变异验证（守卫有牙）

```
把 testNotifyPayload() 换成内联字面量 → J10 变红；还原 → 84 全绿。
```

## 其他结论（不落代码）

- **OpenCode Go 额度**：按模型给月度美元额度。多数模型 $60（GLM-5.3-Flash/Kimi K2.7 Code/
  Qwen3.7 Plus 等）；**DeepSeek V4.1 Flash 最近 $60→$80**（Plus $120→$160）——「提到 $80」
  的传言出处是这一条，单模型调整，非整体提额。窗口结构 5h=20%、周=50%、月=100%，与本仓
  兜底 `LOCAL_LIMITS={12,30,60}` 吻合；DeepSeek 提额后兜底口径偏低，但适配器优先用控制台
  下发的 `limitMicroCents`，一般无碍，可留意。
- 本机排查结论已沉淀 mnemon（insight imp5；fact imp3）。
