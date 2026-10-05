# 2026-10-05 球柱并存 Bug

## 现象

用户实拍：贴边隐藏态下圆球完整保留，水柱叠在右侧 —— 球柱并存。

## 根因

R4-5 改原地变柱后，fallback 底盘背景 + 内阴影 + 读数 + 品牌标在 hidden 下从未隐藏。
旧滑出设计靠窗口离屏遮丑，原地后全漏出来。另：品牌标 opacity 是 JSX 内联（0.85），
样式表 opacity 盖不住（第二茬，像素定位 x44-62 白块确认为 mark 图标）。

## 修复（skins.css，只有 CSS）

- hidden 下底盘 transparent + 去阴影（180ms 淡出，与 drain 衔接）
- 读数/短标签 opacity 0（淡出）；品牌标 opacity 0 !important（盖内联）
- 角标/气泡/雨 display:none（hidden 下无处安放；确认按钮本来就点不着，reveal 恢复）
- 结构门 K10c 扩展 mark 断言

## 取证

- 5g 隐藏稳态：10990px → 2852px，且仅 x0-24 柱区（12px 柱 @2x）
- test-structure 205/205，npm test 全绿，typecheck 干净，e2e 流体+贴边键全绿
- commit bef7d24
