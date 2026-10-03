# 执行计划：全息球原型验证

## 进度快照

| 步 | 内容 | 状态 | 门 |
|---|---|---|---|
| 1 | 原型骨架（透明窗 + 双球壳 + 粒子 + HUD 桩） | ✅ 完成 | 独立启动，静态帧正常 |
| 2 | 皮肤 ×2 + reduced-motion 静态 | ✅ 完成 | 换肤特效肉眼可辨 |
| 3 | 测量 + 双平台取证 + 报告 | ✅ macOS 完成 / ⬜ Windows 待补 | 数据写 `research/report.md`（缺口见报告“转正门”） |

## 步 1：骨架

- [x] `prototype/holo/`：`index.html` + `scene.mjs`（three 用 npm 已有依赖，禁止碰主干代码）。
- [x] HUD 三卡 DOM 浮层 + count-up 播一次；启动方式记入 README（一行命令）。
- [x] 门：本机启动可见球壳 + 卡片，控制台零报错。

## 步 2：皮肤与静态

- [x] 两套皮肤变量接线；`prefers-reduced-motion` 渲染单帧停 rAF。
- [x] 门：同场景两皮肤截图肉眼可辨差异。

## 步 3：测量与结论

- [x] 10s 帧率窗口、显存、macOS 截图、HUD 对比度取色；Windows 截图未做（无真机，如实记为转正门缺口）。
- [x] `research/report.md`：数据表 + CONDITIONAL GO + 转正门缺口 + 主干化清单。
- [x] 门：报告齐全；主干 `git status` 无原型引入的脏文件（其余 tracked 改动属同分支 remove-human 任务）。

## 自检命令

```bash
npx electron prototype/holo  # 或报告内记录的实际启动方式
```

## 风险文件 / 回滚点

- 仅 `prototype/holo/` + 本任务目录；no-go 直接删除目录。
- 不碰 `pet3d/`（后台有删除任务在跑，别引用别修改）。
