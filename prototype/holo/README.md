# 全息球 Phase 0 原型（可丢弃）

独立 Electron 小应用，主干零依赖、零改动。禁止 import 主干 `pet3d/`。

## 启动

```bash
# 交互预览（换肤按钮 / 数字滚动 / perf 面板）
npx electron prototype/holo

# 指定皮肤 + 静态帧（reduced-motion 同效果）
npx electron prototype/holo --skin=ember --still

# 10s 自动测量：帧率窗口 + 显存 + 对比度 + PNG，写入任务 research/
npx electron prototype/holo --measure-run --skin=abyss
npx electron prototype/holo --measure-run --skin=ember
npx electron prototype/holo --measure-run --skin=abyss --still
```

测量产物：`.trellis/tasks/10-03-holo-sphere/research/measure-<skin>[ -still].json`
+ `holo-<skin>[ -still].png`，控制台另有一行 `HOLO_RESULT` 摘要。

## 结构

| 文件 | 说明 |
|---|---|
| `main.js` | 透明窗口 232×372（内容 200 级球 + 三卡 HUD），console 转发 + 存图/测量 IPC |
| `preload.js` | 只暴露 `savePng` / `measureDone` |
| `index.html` | canvas + HUD 三卡 DOM 浮层（billboard，不进场景图） |
| `scene.mjs` | 点云 1500 + wireframe 反转 + 轨道粒子 350/300 + 数据流字符带 |
| `holo.css` | 皮肤变量 `--holo-primary/--holo-glow`（abyss 深海 / ember 余烬） |

three 走仓库已有 `node_modules/three`（importmap，只读引用，未改主干）。
