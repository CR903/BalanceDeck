# BalanceDeck 余额板

常驻桌面的悬浮卡片 + 状态栏组件，集中查看各家 AI coding plan 用量与 API 余额。
设计定稿见 [DESIGN.md](./DESIGN.md)（含技术栈选型理由与各商家数据源清单，接手前必读）。

## 当前状态

- **M1 已完成**（2026-09-06）：Electron 脚手架、悬浮卡片/托盘/收起小圆点、OpenCode Go 本地用量适配器、DeepSeek/Kimi/智谱/MiniMax 余额适配器、凭据扫描+密钥链、默认毛玻璃皮肤（另内置 4 套待 UI 切换入口）、macOS dmg 与 Windows 安装包打包验证通过。
- M2/M3 待办见 [TASKS.md](./TASKS.md)。

## 开发

```bash
npm install          # 建议加 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run dev          # 开发模式（悬浮卡片 + 热重载）
npm run build        # 构建三端产物
npm run smoke        # 构建并冒烟：采集一轮后打印快照 JSON 自动退出
npm run uitest       # 构建 + 无头 UI 自动化（13 项交互断言，回归用）
npm run dist:mac     # 打 macOS dmg/zip
npm run dist:win     # 打 Windows 安装包（macOS 上可交叉打包）
```

> 兼容性注意：**Electron 固定用 37.x**。更新版本在本机 macOS 12 (Intel) 上因强链接 SMAppService 无法启动。electron-builder 下载慢时设置 `ELECTRON_MIRROR` 与 `ELECTRON_BUILDER_BINARIES_MIRROR`（见上方镜像地址）。

## 使用

- 启动后悬浮卡片常驻屏幕右下角：环形进度仪表（用量类）+ 横条余额行，头部状态行汇总健康度，底部渐变按钮刷新/设置/收起。
- 指标按用量染色（绿 <60% / 橙 60-85% / 红 ≥85%）；点击仪表或横条展开窗口明细与每模型 tokens 表。
- `− 收起` 变小圆点：多供应商时每 5 秒轮播（带名称标签与圆点指示器）；小圆点可拖拽移动、点击展开。
- 背景为系统原生磨砂（macOS vibrancy / Windows acrylic），与桌面和背后窗口内容保持一致。
- 托盘图标（macOS 在菜单栏直接显示 5h 百分比），点击切换悬浮卡片显隐；右键菜单可退出。
- ⚙ 设置：供应商启用/禁用开关；OpenCode 多账号 Key（每行一个，可切换当前账号）；各商家 API Key（加密存入系统密钥链）与 Base URL（中转平台）；或预先设置环境变量 `DEEPSEEK_API_KEY` / `MOONSHOT_API_KEY` / `ZHIPUAI_API_KEY` / `MINIMAX_API_KEY`（可选 `MINIMAX_GROUP_ID`）。

## 皮肤

皮肤 = CSS 变量组，挂载于 `.app[data-skin="<name>"]`，见 `src/renderer/src/skins.css`。
内置 5 套：`aero`（默认毛玻璃，跟随系统深浅色）、`dark`、`minimal`、`candy`、`ink`。
换肤 UI 入口在 M2 提供；当前可通过改 `App.tsx` 中 `data-skin` 值预览。
