# R4返工 — 执行计划

## 顺序

1. R4-2/R4-3（goo 裁剪 + 泡沫带，纯 renderer，无依赖，最先）
2. R4-1/R4-4（雨滴 + 天气变量，依赖 inconsiderable，接上）
3. R4-6（余额水，renderer + 测试门，独立可并行，但放第三以稳住 e2e 基线）
4. R4-5（原地变柱，主进程几何，最后——动口径，影响 e2e/单测最多）

## 固定 checklist（每步）

- [ ] 实现 + 注释（口径唯一出处注明）
- [ ] 单测/结构门先红后绿（`npm run test:fluid` / `test:structure` / 全量 `npm test`）
- [ ] `npm run typecheck`
- [ ] `--shots` 走查 + 像素/探针对拍
- [ ] e2e `--uitest` 流体相关键全绿（R4-5 额外：dockHide/dockEdges 新口径）

## Review Gates

- G1：雨+天气+泡沫实例可走查 → 用户看效果（含余额 accent 色实例、天气映射确认）
- G2：原地变柱走查（屏边常驻柱、点击恢复）→ 用户确认终态
- G3：全量绿 + 父任务跨子任务验收 → archive 全部

## 回滚点

- R1/R2：摘 JSX 挂载即回旧版（CSS 无引用即死码）
- R4-5：hiddenBounds 改回偏移即回滑出（单测期望同步回退）
- R4-6：showWaves 条件收回即回素盘
