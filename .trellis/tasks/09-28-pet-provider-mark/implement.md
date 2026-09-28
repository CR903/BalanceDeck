# 实现计划：球形态供应商标识

## 前置条件

- [x] PRD 已写（`.trellis/tasks/09-28-pet-provider-mark/prd.md`）
- [x] 设计已写（`.trellis/tasks/09-28-pet-provider-mark/design.md`）
- [x] 用户审核通过

## 步骤

### 步 1：在 PetBall.tsx 里加 `.dot-provider` 元素

- [x] 在 `.petball-fallback` 的 JSX 里，在 `.dot-value` **之前**加：
  ```tsx
  {s?.mark && (
    <span
      className="dot-provider"
      aria-hidden="true"
      style={{
        width: 10,
        height: 10,
        backgroundColor: markColor(s.mark),
        WebkitMaskImage: `url("${markDataUrl(s.mark)}")`,
        maskImage: `url("${markDataUrl(s.mark)}")`,
        opacity: 0.85,
        pointerEvents: 'none'
      }}
    />
  )}
  ```
- [x] 给 `.dot-value` 加 `aria-label`：
  ```tsx
  <span
    className={`dot-value${valueText.length > 4 ? ' small' : ''}`}
    aria-label={`${s?.name ?? ''} 用量 ${shownText}`}
  >
    {shownText}
  </span>
  ```
- [x] 确保 `markDataUrl` 和 `markColor` 已从 `ProviderMark.tsx` 导入

### 步 2：在 skins.css 里加 `.dot-provider` 的 CSS

- [x] 在 `.petball.no3d .dot-value` 之前加：
  ```css
  .petball.no3d .dot-provider {
    display: block;
    flex-shrink: 0;
    pointer-events: none;
  }
  ```
- [x] 确保 `.dot-provider` 在 grid 布局中不收缩（`flex-shrink: 0`）

### 步 3：验证

- [x] `npm run typecheck` 通过
- [x] `npm test` 通过（基线 477 项）
- [x] `node scripts/test-structure.mjs` 通过（基线 28 项）
- [x] `npm run build` 通过
- [x] `BD_USER_DATA=/tmp/bd-test npx electron . --uitest` 通过（112 键 / 0 失败）
- [x] `BD_SKINS=1 npx electron . --ball-shot` 生成 5 个皮肤截图
- [x] 标记可见性验证（亮度差 >30 = 可见）：
      | 皮肤 | 背景 L | 标记 L | 差值 | 结论 |
      |---|---|---|---|---|
      | aero | 173 | 198-224 | 25-51 | ✓ |
      | dark | 15 | 77 | 62 | ✓ |
      | minimal | 240 | 181 | 59 | ✓ |
      | candy | 236 | 183 | 52 | ✓ |
      | ink | 239 | 169 | 70 | ✓ |
- [x] 用 `node scripts/lib/png-probe.mjs` 验证标记存在且位置正确
- [x] 人工验证：5 个皮肤 + 外部皮肤兜底均正常显示

### 步 4：文档同步

- [x] 更新 `CONTEXT.md`（如果有球形态相关描述）
- [x] 更新 `README.md`（如果有球形态截图或说明）
- [x] 更新 `DESIGN.md`（如果有球形态设计说明）

## 回退点

- 步 1 完成后：如果标记显示异常，可以回退到只加 `aria-label`（不加视觉标记）
- 步 2 完成后：如果 CSS 有问题，可以回退到内联样式（不用 CSS 类）

## 风险

- 标记可能挤压数值空间 → 空间计算已验证（33px < 39px）
- 标记在特定皮肤上对比度不足 → 验证 5 个皮肤，必要时加底色
- 外部皮肤无品牌色 → `markColor` 有兜底（`generic`）
