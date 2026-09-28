# 设计：球形态供应商标识

## 1. 边界

### 1.1 改动范围

| 文件 | 改动 |
|---|---|
| `src/renderer/src/PetBall.tsx` | 在 `.petball-fallback` 的 JSX 里加 `.dot-provider` 元素；给 `.dot-value` 加 `aria-label` |
| `src/renderer/src/skins.css` | 新增 `.dot-provider` 的 CSS 规则 |
| `src/renderer/src/ProviderMark.tsx` | 可能新增一个简化版导出（无外框，仅图标） |

### 1.2 不改动的部分

- `.petball-hit` 的 `inset: 0` 和 `pointer-events: auto`（命中区不变）
- `.petball-fallback` 的 `border-radius: 50%` 和 `overflow: hidden`（圆形裁剪不变）
- 环的 SVG（r=22, stroke=5）
- `.dot-value` 的字体、字号、颜色
- `.dot-winlabel` 的字体、字号、颜色
- 自动轮播逻辑
- 窗口切换逻辑

## 2. 布局

### 2.1 当前布局

```
.petball-fallback (56×56, grid, place-items: center, grid-auto-flow: row, align-content: center, gap: 1px)
├── svg (环, r=22, stroke=5)
├── .dot-value (13px, line-height 1)
└── .dot-winlabel (8px, line-height 1, 仅多窗口时)
```

### 2.2 新布局

```
.petball-fallback (56×56, grid, place-items: center, grid-auto-flow: row, align-content: center, gap: 1px)
├── svg (环, r=22, stroke=5)
├── .dot-provider (10px × 10px, 新增)
├── .dot-value (13px, line-height 1)
└── .dot-winlabel (8px, line-height 1, 仅多窗口时)
```

### 2.3 空间计算

- 环内可用直径：39px（r=19.5）
- 数值高度：13px
- 时限标签高度：8px
- 标记高度：10px
- 间距：2 × 1px = 2px
- 总高度：10 + 13 + 8 + 2 = 33px < 39px ✓

**余量：6px**，足够安全。

## 3. 标记样式

### 3.1 尺寸与位置

- 尺寸：10px × 10px
- 位置：grid 第一行，数值正上方
- 对齐：水平居中（`place-items: center` 已保证）

### 3.2 颜色

- 使用供应商品牌色（`markColor(mark)`）
- 不透明度：0.85（`opacity: 0.85`）
- 这样既能在深色/浅色背景上可读，又不会太抢眼

### 3.3 图标生成

- 复用 `ProviderMark` 的 `markDataUrl(mark)` 生成 SVG data URL
- 用 CSS `mask-image` 应用图标（与 `ProviderMark` 内部一致）
- 背景色设为品牌色

### 3.4 无障碍

- `.dot-provider` 设 `aria-hidden="true"`（装饰性，不单独读屏）
- `.dot-value` 加 `aria-label`，格式：`${providerName} 用量 ${valueText}`
- 这样读屏软件会读出 "Claude 用量 44%"，而不是只读 "44%"

## 4. 皮肤适配

### 4.1 内置皮肤

5 个内置皮肤（aero/dark/minimal/candy/ink）都有各自的 `--ball-bg` 和 `--ball-rim`。标记颜色使用供应商品牌色，与皮肤无关，因此自动适配。

### 4.2 外部皮肤

外部皮肤（`ext:*`）未定义 `--ball-bg` 时由 `:root` 兜底。标记颜色同样使用品牌色，无需额外处理。

### 4.3 对比度

根据 ui-ux-pro-max 的 "Icon Contrast" 指导，有意义的图标需要至少 3:1 对比度。品牌色在大多数皮肤上都能满足，但需要验证：

- `minimal` 皮肤：浅色背景，品牌色需要足够深
- `ink` 皮肤：深色背景，品牌色需要足够亮

如果某个品牌色在特定皮肤上对比度不足，可以考虑：
- 给标记加一层半透明底色（如 `rgba(0,0,0,0.1)` 或 `rgba(255,255,255,0.1)`）
- 或调整 opacity

## 5. 交互

### 5.1 点击与拖拽

- `.petball-hit` 仍覆盖整个 56×56，`pointer-events: auto`
- `.dot-provider` 设 `pointer-events: none`，不拦截事件
- 点击、拖拽行为不变

### 5.2 轮播

- 自动轮播切换供应商时，`.dot-provider` 的 `mark` 属性同步更新
- 无需额外动画（可选：淡入淡出，但非必需）

### 5.3 按压反馈

- `.petball-fallback` 的 `:active` 缩放动画不变
- `.dot-provider` 随父元素一起缩放

## 6. 备选方案

### 6.1 标记放数值下方

- 优点：不占用数字上方空间
- 缺点：与 `.dot-winlabel` 冲突，需要并排或替换
- 结论：不推荐，会破坏现有布局

### 6.2 只加供应商名（不放图标）

- 优点：最简洁，不占用视觉空间
- 缺点：不符合 "直观" 要求，用户需要读文字
- 结论：不推荐，用户明确要求 "直观"

### 6.3 用颜色编码（不用图标）

- 优点：不占用空间
- 缺点：不符合 "Color Only" 设计指导，用户需要记忆颜色对应关系
- 结论：不推荐

## 7. 风险与缓解

| 风险 | 可能性 | 缓解 |
|---|---|---|
| 标记挤压数值空间 | 低 | 空间计算已验证（33px < 39px） |
| 标记在特定皮肤上对比度不足 | 中 | 验证 5 个皮肤，必要时加底色 |
| 标记被圆形边界裁剪 | 低 | 10px 标记在环内，远离边界 |
| 外部皮肤无品牌色 | 低 | `markColor` 有兜底（`generic`），但 `generic.color` 为空 → 用 `currentColor` 兜底（与 `ProviderMark.tsx:49` 一致） |
