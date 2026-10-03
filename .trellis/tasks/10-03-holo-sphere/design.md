# 技术设计：全息球原型（可丢弃）

## 边界

原型与主干零耦合：独立目录 `prototype/holo/`（HTML + 模块脚本 + 取数桩），
以 Electron 透明窗口加载（验证真实合成），`git status` 只脏本任务目录。
**禁止 import 主干 `pet3d/`**（remove-human 正在删除它）与 `PetBall`（避免双向依赖）。

## 场景结构

```
透明窗口（~210×220, transparent, 无阴影）
└─ WebGLRenderer(alpha:true)
   ├─ 点云球壳（Points, ~1500 点, 自转 0.05 rad/s）
   ├─ wireframe 球壳（Icosahedron detail 2, LineSegments, 反向慢转）
   ├─ 粒子轨道 ×2（Points, 半径/速度不同, additive blending）
   ├─ 数据流字符带（CanvasTexture 贴于细圆环, 滚动 UV）
   └─ HUD 卡 ×3（DOM 浮层, 屏幕空间定位, 不进场景图 → 天然 billboard）
```

- 皮肤：CSS 变量驱动粒子色/光晕（`--holo-primary/--holo-glow`），原型只接 2 套验证机制。
- reduced-motion：`matchMedia` 命中则渲染单帧后停 rAF（静态取证用同一帧）。

## 数据与测量

- 数据桩：静态代表值（15.4M/50M、65%、¥1,230.50），数字滚动播一次（复用 count-up 思想，重写轻量版）。
- 测量：rAF 帧计数（10s 窗口取 p50/p95）、`renderer.info.memory.geometries/textures` +
  `performance.memory`（Chromium），截图 macOS + Windows（含静态帧）。
- 阈值：M 系 ≥50fps、显存 <150MB、HUD 对比度 ≥4.5:1（取色实测）。

## Trade-off

- 粒子数 vs 帧率：先 1500+2×400，不达标先降点数再谈降分辨率（记录拐点）。
- 真机优先：沙盒（SwiftShader）数据只记参考列，不参与 go/no-go。

## 回滚/清理

no-go 则整目录删除（`git clean -fd prototype/holo/`），主干零痕迹；
go 则输出主干化清单（另起 planning，不在本任务实现）。
