# 球形态：添加供应商标识

## Goal

在悬浮球环内数值上方添加 10px 供应商品牌标记，并让 `aria-label` 自带供应商名，使用户能直观识别当前数据来源。

## Requirements

### 功能需求

- **FR1**：球形态（`.petball-fallback`）环内、数值正上方显示供应商品牌标记
- **FR2**：标记尺寸 10px × 10px，无外框，仅显示品牌图形
- **FR3**：标记颜色使用供应商品牌色，不透明度 0.85（避免太抢眼）
- **FR4**：`.dot-value` 的 `aria-label` 包含供应商名（如 "Claude 用量 44%"）
- **FR5**：仅在供应商标记可识别时显示（`mark` 字段存在且非空）
- **FR6**：切换供应商时标记同步更新

### 非功能需求

- **NFR1**：不影响现有点击、拖拽、轮播功能
- **NFR2**：不改变 `.petball-hit` 的命中区域（仍覆盖整个 56×56）
- **NFR3**：不挤压现有元素（数值、时限标签）的可用空间
- **NFR4**：标记在 56×56 球体内完全可见，不被裁剪
- **NFR5**：支持所有内置皮肤（aero/dark/minimal/candy/ink）
- **NFR6**：支持外部皮肤（`ext:*`）的兜底标记

### 约束

- 球体窗口固定 56×56，不可改变
- 环内可用直径 39px（r=19.5），已有数值（13px）和时限标签（8px）
- 标记总高度（含间距）不超过 15px，确保不挤压现有元素
- 使用现有 `ProviderMark` 组件的 `markDataUrl` 生成图标，不引入新依赖

## Acceptance Criteria

- [ ] **AC1**：球形态环内数值正上方显示 10px 供应商品牌标记
- [ ] **AC2**：标记颜色为供应商品牌色，opacity 0.85
- [ ] **AC3**：`.dot-value` 的 `aria-label` 包含供应商名
- [ ] **AC4**：`mark` 字段为空或不存在时，标记不显示
- [ ] **AC5**：切换供应商时标记同步更新，无延迟
- [ ] **AC6**：点击、拖拽、轮播功能正常（uitest 112 键全绿）
- [ ] **AC7**：5 个内置皮肤 + 外部皮肤兜底均正常显示
- [ ] **AC8**：标记不被球体圆形边界裁剪
- [ ] **AC9**：数值和时限标签的现有布局不被破坏

## Notes

- 设计指导来源：ui-ux-pro-max（Color Only / Compact Label Overflow / Contextual Live Badge Updates / Icon Contrast）
- 现有 `ProviderMark` 组件已支持 `mark` → 图标的转换，可直接复用
- 球体已有 `.petball-hit` 覆盖整个 56×56，无需修改命中区域
