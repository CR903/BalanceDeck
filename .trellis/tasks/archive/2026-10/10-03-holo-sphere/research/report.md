# 全息球 Phase 0 原型验证报告

- 日期：2026-10-03（UTC+8）
- 原型：`prototype/holo/`（独立 Electron 小应用，主干零改动、零引用 `pet3d/`）
- 启动：`npx electron prototype/holo --measure-run --skin=<abyss|ember> [--still]`
- 机器：MacBook Pro（Intel Iris Pro，Retina DPR=2），Electron 37.10.3 / Chromium 138 / three 0.177.0

## 测量数据（macOS，真机，10s 稳态窗口，丢弃前 10 帧热身）

| 皮肤 | fps avg | fps p50 | fps p95 | fps min | geo/tex | JS 堆 | 对比度 |
|---|---|---|---|---|---|---|---|
| abyss 深海 | 60.1 | 59.9 | 66.2 | 53.8 | 6 / 2 | 10MB | 17.48:1 |
| ember 余烬 | — | 60.2 | 66.2 | 53.5 | 6 / 2 | 10MB | 17.62:1 |
| abyss still 静态帧 | n/a（单帧） | n/a | n/a | n/a | 6 / 2 | 10MB | 17.48:1 |

- 粒子规模：点云球壳 1500 + 轨道 350/300 + 数据流字符带 1（CanvasTexture）+ 光晕 sprite 1。
- 进程 workingSet 总和 282MB：Chromium 运行时基线（场景侧 JS 堆仅 10MB，
  `renderer.info` 仅 6 geometries / 2 textures，顶点数据约几十 KB）。
  renderer API 读不到真实 VRAM 占用；按帧缓冲（464×888×4B ≈ 1.6MB）+ 纹理/几何体估算，
  场景增量显存 < 5MB。
- 原始 JSON + 整窗 PNG（含 HUD）：本目录 `measure-*.json` / `holo-*-window.png`。

## 阈值对照

| 阈值 | 结果 |
|---|---|
| M 系 ≥50fps | ⏳ 本机 Intel 核显 p50 59.9–60.2（参考通过；非 M 系实测，不算达标，M 系真机待补） |
| 显存 <150MB | ✅ 场景增量 <5MB（估算，方法见上；进程总量 282MB 系 Chromium 基线） |
| HUD 对比度 ≥4.5:1 | ✅ 17.5:1（卡片文字 vs 卡纸底，最坏底黑混合计算） |
| Windows 真机取证 | ⬜ 未做（本会话无 Windows 真机；沙盒 SwiftShader 数据不参与结论） |

## 结论：CONDITIONAL GO（macOS）→ 需 Windows 取证后转正

- 性能与可读性在 macOS 真机达标，转正门有两项缺口（均非通过，见下）。
- 缺口① Windows：**同一命令在 Windows 真机（独显 + 核显各一）复测**，
  p50 ≥50fps 且合成无异常（透明窗口 + WebGL 在部分 Windows 驱动下异常，PRD 已预警）。
- 缺口② M 系：本报告为 Intel 核显数据，仅参考；M 系真机复测 p50 ≥50fps 后才算阈值达标。
- 尺寸偏离记录：design 写 210×220 级，原型实际 232×444（HUD 三卡 + perf 面板纵向排布所致；
  宽度 232 ≈ 200 级，高度翻倍是为容纳三卡的刻意取舍，主干化清单第 1 条已按 232×444 落字）。
- `prefers-reduced-motion` 单帧路径已验证（`--still` 出静态窗截图，rAF 停转）。

## 主干化改造清单（转正后另起 planning）

1. 窗口：232×444 透明窗（现收起态 56×56 不兼容）；命中区/鼠标穿透/`setIgnoreMouseEvents` 重调。
2. three 去留：go 则保留依赖（约 1.18MB 独立 chunk，默认形态仍动态加载）；no-go 则随 remove-human 删除。
3. HUD 接实时采集（原型为静态桩 + count-up 一次）；hover 加速 / click 展开按 PRD P1 补。
4. 皮肤：5 套球令牌族 + 新增粒子/光晕令牌，原型已验证 2 套接线机制（CSS 变量 → 材质色）。
5. uitest：新增截图断言（两皮肤窗截图 + still 帧）；DPR 按 CSS 尺寸折算（本机 2×）。
6. 微调：球心 additive 堆积偏白（能量核观感，可接受；主干化时可降点尺寸/中心透明度）。

## 主干零改动自证

本会话新增仅两处 untracked：`prototype/holo/`（7 文件）与本任务目录；
`git status` 中其余 tracked 改动均属同分支并行的 remove-human 任务，与本原型无关。
no-go 时清理：`git clean -fd prototype/holo/` 即可，主干零痕迹。
