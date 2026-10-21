# BalanceDeck 开发日志索引

## 2026-10

| 日期 | 日志 | 任务 |
|---|---|---|
| 2026-10-04 | [水色随用量连续变色](daily/2026-10-04_water-color-by-usage.md) | `10-04-water-color-by-usage` |
| 2026-10-04 | [倒水入场与荡漾平息](daily/2026-10-04_pour-in-slosh.md) | `10-04-pour-in-slosh` |
| 2026-10-04 | [贴边吸溜水柱温度计](daily/2026-10-04_edge-sip-column.md) | `10-04-edge-sip-column` |
| 2026-10-04 | [R4返工：雨滴天气泡沫余额水+原地变柱](daily/2026-10-04_rain-weather-column.md) | `10-04-rain-weather-column` |
| 2026-10-04 | [皮肤差异化返工 R1–R3](daily/2026-10-04_skin-fluid-rework.md) | `10-04-skin-fluid-redesign` |
| 2026-10-05 | [六参考图转皮肤效果图](daily/2026-10-05_skin-refs-mock.md) | `10-04-rain-weather-column` |
| 2026-10-05 | [皮肤外观×进度语义效果图](daily/2026-10-05_skin-applied-mock.md) | `10-04-rain-weather-column` |
| 2026-10-05 | [皮肤视觉原型落地 P1–P4（skin-landing）](daily/2026-10-05_skin-landing-p1p4.md) | `10-04-rain-weather-column` |
| 2026-10-05 | [球体外观四皮互不相同（P6 环替代水体）](daily/2026-10-05_skin-ball-forms-p6.md) | `10-04-rain-weather-column` |
| 2026-10-06 | [球盘底色还原 + 去雨效（P6-demo 一比一）](daily/2026-10-06_ball-bg-derain.md) | `10-04-rain-weather-column` |
| 2026-10-06 | [球柱三修（读数可读 + 柱体全圆 + morph 带底盘）](daily/2026-10-06_ball-column-fixes.md) | `10-06-ball-column-fixes` |
| 2026-10-07 | [去预计耗尽 + 用量热力图（日历网格 + streak）](daily/2026-10-07_detail-predict-trim-heatmap.md) | `10-07-detail-predict-trim-heatmap` |
| 2026-10-08 | [贴边柱内液高为零（诚实水位收口）](daily/2026-10-08_column-zero-fill.md) | `10-06-column-zero-fill` |
| 2026-10-10 | [灵动岛替换水柱（复检 pass，待实机）](daily/2026-10-10_dynamic-island.md) | `10-10-dynamic-island` |
| 2026-10-10 | [灵动岛跟进修复（复检 pass，实机待验）](daily/2026-10-10_island-fixes.md) | `10-10-island-fixes` |
| 2026-10-10 | [灵动岛边缘裁剪修复（复检 pass，截图交付）](daily/2026-10-10_island-clip-fix.md) | `10-10-island-clip-fix` |
| 2026-10-10 | [灵动岛高保真还原（复检 pass，截图交付）](daily/2026-10-10_island-fidelity.md) | `10-10-island-fidelity` |
| 2026-10-10 | [mini微调与点击穿透修复（复检 pass）](daily/2026-10-10_island-mini-tune.md) | `10-10-island-mini-tune` |
| 2026-10-10 | [收起比例与展开结构还原（复检 pass，截图交付）](daily/2026-10-10_island-fidelity-2.md) | `10-10-island-fidelity-2` |
| 2026-10-10 | [余额家logo对版（复检 pass，截图交付）](daily/2026-10-10_island-balance-mark.md) | `10-10-island-balance-mark` |
| 2026-10-11 | [灵动岛六修（复检 pass，截图交付）](daily/2026-10-11_island-tri-fix.md) | `10-11-island-tri-fix` |
| 2026-10-11 | [展开面板点进详情（复检 pass）](daily/2026-10-11_island-open-to-detail.md) | `10-11-island-open-to-detail` |
| 2026-10-11 | [opencode 详情页 v2：官网数据对齐与用量视图重构](daily/2026-10-11_opencode-detail-v2-sync.md) | `10-11-opencode-detail-v2-sync` |
| 2026-10-11 | [opencode 周/月序列与模型受 since 保留期限制修复](daily/2026-10-11_opencode-detail-window-series-fix.md) | `10-11-opencode-detail-window-series-fix` |
| 2026-10-13 | [展开面板滚动条归零 + 托盘左键展开定位（复检 pass，实机待验）](daily/2026-10-13_island-open-overflow-and-tray-expand.md) | `10-13-island-open-overflow-and-tray-expand` |
| 2026-10-18 | [采集轮级看门狗：同步不再永久卡死 + 刷新不再静默丢弃](daily/2026-10-18_sync-collect-watchdog.md) | `10-18-sync-collect-watchdog` |
| 2026-10-18 | [本机用量扫描移出阻塞路径：消灭每轮 2 秒沙漏 + 修缓存键](daily/2026-10-18_local-db-off-mainthread.md) | `10-18-local-db-off-mainthread` |
| 2026-10-18 | [本机用量首轮全量移出主线程：worker 化 + 全量核对间隔 6h → 1h](daily/2026-10-18_local-db-worker-offload.md) | `10-18-local-db-worker-offload` |
| 2026-10-18 | [补齐 AGENTS.md 引用的门禁文档（三个从未落地的文件）](daily/2026-10-18_docs-gate-files.md) | `10-18-docs-gate-files` |
| 2026-10-18 | [uitest 时序脆弱断言收口：52 处瞬时判据归零，翻转键 1 → 0](daily/2026-10-18_uitest-timing-hardening.md) | `10-18-uitest-timing-hardening` |
| 2026-10-18 | [采集健壮性与主进程阻塞修复（父任务收尾：2.6 小时无断点）](daily/2026-10-18_sync-stall-and-mainthread-block.md) | `10-18-sync-stall-and-mainthread-block` |
| 2026-10-21 | [系统通知自验通路：测试按钮 + 「发起≠已显示」引导（根因：macOS 吞弹）](daily/2026-10-21_10-21-test-notify-and-hint.md) | `10-21-test-notify-and-hint` |
| 2026-10-18 | [uitest 时序脆弱断言收口：52 处瞬时判据归零，翻转键 1 → 0](daily/2026-10-18_uitest-timing-hardening.md) | `10-18-uitest-timing-hardening` |
