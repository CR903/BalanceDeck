# 执行计划：灵动岛收起比例与展开结构还原

## 有序清单

1. **断言先行**：`scripts/test-structure.mjs` 改 L 章（logo 15 / gap 10 / 高光 60% / vb36+r15.5），
   新增 D6c（展开单行骨架、无 `.isl-open-head`、`.wbar` 4px）→ 先跑红。
2. **环几何同源**（`IslandView.tsx`）：抽 `RING_GEO` 常量，`NestedRings`/`Ring` 收起与展开共用；
   环心补 `fmtPercent` 文字（缺失保持缺失）。
3. **收起比例**（`island.css`）：logo 20→15、strip gap 12→10、高光线宽 60%。
4. **展开骨架**（`IslandView.tsx` + `island.css`）：`PlanCell` 改单行 `[mark26][ring40][side]`，
   右列 = name +（嵌套 ? 图例 : 文字+4px 彩条）；删 StatusDot；删 `.isl-open-head`。
5. **容器氛围**（`island.css`）：padding 16、渐变 `#2b2b31 28%`、5 层阴影单点声明、
   `::before/::after` 挂 `.isl-body` 不分状态。
6. **验证**：`npm run typecheck` + `npm test` 全绿；harness 与原型并排截图
   （收起 / 展开嵌套开 / 展开嵌套关 / 隐藏）落 `prototype/shots/`。

## 验证命令

```bash
npm run typecheck
npm test
node_modules/.bin/esbuild prototype/island-harness/entry.tsx --bundle \
  --outfile=prototype/island-harness/bundle.js --format=iife --jsx=automatic --loader:.ts=ts
# http.server 起服务 → playwright 并排截图（原型 ?variant=B 与 harness 同视口同数据）
```

## 风险文件 / 回滚点

- `src/renderer/src/island.css`、`src/renderer/src/IslandView.tsx`（revert 即回）。
- `scripts/test-structure.mjs`（断言与码同步，不可单回滚）。
- 不动：`overlay.ts`、`dock-hide.ts`、`shared/levels.ts`；`.playwright-mcp/` 不入库。
