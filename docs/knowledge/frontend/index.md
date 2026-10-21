# 端：frontend

渲染层（React / SVG / skins.css）。

## architecture

| 文档 | 说明 | 来源 |
|------|------|------|
| [view-tree-map.md](architecture/view-tree-map.md) | 渲染层视图树：单 overlay 窗四形态切换、App 单一状态持有者、read-model 读模型契约 | `src/renderer/**` 代码事实 |
| [alert-path.md](architecture/alert-path.md) | 提醒链路：alertOrchestrate 收口、TTS/通知双闸门与锁存、系统通知只在 main 发 | `src/renderer/**` 代码事实 |

| 知识 | 一句话 |
|---|---|
| [window-series-view](architecture/window-series-view.md) | 窗口驱动用量序列：起点对齐、`since` 仅 48h 保留期（周/月不带 + 客户端裁窗口）、key 缺失 vs 空数组、本机回退不补 0 |
| [overlay-hitbox](architecture/overlay-hitbox.md) | 透明窗命中区三纪律 + 视觉高度分层归因 |

## guides

| 知识 | 一句话 |
|---|---|
| [prototype-fidelity-diff](guides/prototype-fidelity-diff.md) | 还原原型靠并排 computed style diff，不靠目测截图 |

## troubleshooting

| 知识 | 一句话 |
|---|---|
| [petball-mount-conditions](troubleshooting/petball-mount-conditions.md) | 共享门控布尔只能管一块语义：0% 是空环不是无环 |
| [system-notify-silent-failure](troubleshooting/system-notify-silent-failure.md) | macOS 关通知 = Electron 静默成功：ncprefs flags bit28 归因法 + 「真实链路测试按钮 + 发起≠已显示」自验通路 |
