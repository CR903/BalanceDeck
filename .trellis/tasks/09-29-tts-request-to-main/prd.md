# TTS 请求迁移到主进程（CSP 阻断修复）

## Goal

把 TTS 的 HTTP 请求从渲染层移到主进程，修复 `TypeError: Failed to fetch` —— 渲染层 CSP 阻断一切外部出网，导致 TTS 播报**从未真正工作过**。

## Background

### 根因（已实测确认）

`src/renderer/index.html:11`：

```
connect-src 'self' data: blob: bd-asset:
```

渲染层只允许向自身与三种内部协议发请求。`fetch('https://voice.mytts.ccwu.cc/v1/audio/speech')`
被浏览器在**发出之前**拦截 → 抛 `TypeError: Failed to fetch` → 请求从未到达网络。

### 这条 CSP 是对的，不应修改

它防的是渲染层 XSS 外连。项目所有既有外连都走主进程：

- `src/main/adapters/` — 全部供应商采集
- `src/main/request.ts` — 出网实现，注释明写「只有这个模块依赖 electron」
- `src/main/scheduler.ts` — 采集调度

**TTS 违反了这个架构约定**：上一轮把 `fetch` 直接放在 `speechOut.ts`（渲染层）。服务本身完全正常
（实测 `POST` → HTTP 200 / 1.39s / 有效 MP3），但请求永远发不出去。

### 连带影响：三轮修复都建立在错误前提上

| 提交 | 修了什么 | 现状 |
|---|---|---|
| `b88e38a` | TTS 集成 + 5 场景播报 | 网络层不可用 |
| `5e37562` | AC7 重复提醒 + 自愈探测 | 探测永远失败 |
| `f88806a` | 测试播报绕闸门、文案、自愈 | 绕的是「永远失败的请求」 |

自愈探测、退避冷却、频率闸门、试听反馈 —— 全部建立在一个发不出去的请求上。**本次迁移后
这些逻辑才会第一次真正运行**，必须重新验证。

## Requirements

### 功能需求

- **FR1**：TTS HTTP 请求在主进程执行，与 `adapters` 同一边界
- **FR2**：新增 TTS IPC（渲染层 → 主进程请求 → 返回音频字节）
- **FR3**：保留主进程已有的超时与网络记账（`request.ts` 模式）
- **FR4**：主进程连接失败**必须显式抛**并携带可辨识原因，渲染层据此更新不可达提示
- **FR5**：CSP **不修改**
- **FR6**：TTS token 全程留在主进程（明文不再进渲染层内存）

### 非功能需求

- **NFR1**：不引入新依赖
- **NFR2**：不削弱 CSP
- **NFR3**：不改 `adapters` 现有行为

### 约束

- 自建 TTS URL 是**用户可配置的任意地址** —— 主进程需能连任意用户配置的域名，这是有意放开
  的输入，不是漏洞
- 音频以二进制返回（ArrayBuffer / Buffer），不走 JSON 字符串化

## Acceptance Criteria

- [ ] **AC1**：`__bd_voice_diagnostic__()` 或等效手段能证明请求**真的到达网络**
- [ ] **AC2**：试听播报实际发出声音（不再 `Failed to fetch`）
- [ ] **AC3**：`src/renderer/index.html` 的 CSP **逐字未改**
- [ ] **AC4**：主进程网络失败时，渲染层收到可辨识原因并更新提示
- [ ] **AC5**：自愈探测在迁移后**能成功探测并清除不可达标志**（上一轮从未跑通过）
- [ ] **AC6**：`style` 真的进了请求体（此前硬编码 `general`）
- [ ] **AC7**：token 不出现在渲染层 state（主进程持有）
- [ ] **AC8**：`npm run typecheck` / `npm test` / `npm run build` 全绿

## Design Decisions

| 问题 | 决策 | 说明 |
|---|---|---|
| 请求放哪 | 主进程 | 与 adapters 一致；CSP 不动 |
| 音频回传 | 二进制 | ArrayBuffer，不走 JSON |
| 自建 URL 安全边界 | 允许连任意用户配置域名 | 有意输入，非漏洞 |
| 现有修复 | 保留，全部重测 | 它们本身是对的，只是从未被真正执行 |

## Out of Scope

- 修改 CSP
- 给渲染层加外连白名单
- 改 `adapters` 采集链路
- 代理配置（不在本次范围）

## Notes

- 本任务本质是**修一个从未通过端到端的功能**，不是加功能
- 迁移完成后必须做真机验证（`npm run uitest` 之外的实际点试听）—— 此前三轮我所有
  「实测」都是用 curl 打服务端，**从未验证过应用内真的能发出去**
- 这是本次教训：curl 200 不等于应用可用。CSP 是浏览器行为，curl 不受它约束
