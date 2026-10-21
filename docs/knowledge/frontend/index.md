# 端：frontend

渲染层（React / SVG / skins.css）。

| 知识 | 一句话 |
|---|---|
| [window-series-view](window-series-view.md) | 窗口驱动用量序列：起点对齐、`since` 仅 48h 保留期（周/月不带 + 客户端裁窗口）、key 缺失 vs 空数组、本机回退不补 0 |
| [petball-mount-conditions](petball-mount-conditions.md) | 共享门控布尔只能管一块语义：0% 是空环不是无环 |
| [prototype-fidelity-diff](prototype-fidelity-diff.md) | 还原原型靠并排 computed style diff，不靠目测截图 |
| [overlay-hitbox](overlay-hitbox.md) | 透明窗命中区三纪律 + 视觉高度分层归因 |
| [system-notify-silent-failure](system-notify-silent-failure.md) | macOS 关通知 = Electron 静默成功：ncprefs flags bit28 归因法 + 「真实链路测试按钮 + 发起≠已显示」自验通路 |