# P1 剩余：供应商覆盖 + 资源占用

## Goal

落地竞品报告 P1 档剩余三项，六项并行交付：

| 子任务 | 交付物 | 来源 |
|---|---|---|
| `10-01-gemini-code-assist` | Google Gemini Code Assist 适配器 | P1-2 |
| `10-01-google-antigravity` | Google Antigravity 适配器 | P1-2 |
| `10-01-cursor` | Cursor 适配器 | P1-2 |
| `10-01-openai-quota` | OpenAI（ChatGPT 额度）适配器 | P1-2 |
| `10-01-p1-5-resource` | 文档明示 + 常驻内存实测与优化 | P1-5 前两项 |
| `10-01-tauri-eval` | Tauri 迁移成本与收益评估（纯调研） | P1-5 第三项 |

调研依据：`.trellis/tasks/archive/2026-09/09-30-similar-projects-research/research/report.md` 第 4 节。

## Task Map

```
10-01-p1-remaining（本任务：需求集 / 任务图 / 跨子任务验收 / 最终集成评审）
├── 10-01-gemini-code-assist    ┐
├── 10-01-google-antigravity    ├ 四家并行，每家独立可验收
├── 10-01-cursor                │
├── 10-01-openai-quota          ┘
├── 10-01-p1-5-resource   （文档 + 内存实测，与适配器无交集）
└── 10-01-tauri-eval      （纯调研，零代码改动）
```

**父子结构不是依赖系统。** 已知并行冲突如下：

| 冲突项 | 涉及子任务 | 处置 |
|---|---|---|
| `src/main/adapters/**`（协议与解析） | 四家适配器 | **每家一个文件/目录**（`protocols.ts` 是共享的，需分区 + 各自常量） |
| `scripts/test-adapters.mjs`（fixture 测试） | 四家适配器 | **必须按段落增量追加**，各自只加自己的 golden sample 段 |
| `src/shared/types.ts` | 可能需新增 provider kind/mark | 各家独立判定；若需共享枚举则**先合一个，其余基于它** |
| `README` / 文档 | resource ↔ 其余 | 只有 `p1-5-resource` 改文档 |
| `package.json` 的 `test` 链 | resource / tauri-eval | 前两项若新增脚本**合并时统一接一次** |

**新增供应商的快照会自动进 `usage-history.json`**，所以刚完成的 P1-1 趋势图
**零改动即支持**它们（`usageStore` 按 `providerId` 分桶，不认具体供应商）。

## Requirements

### P1-2 供应商覆盖（四家）

1. **每家一个可用的适配器**：能查到用量/额度，失败时给出可诊断的错误原因。
2. **数据诚实**：所有降级路径（离线 / 鉴权失败 / 解析失败）必须走既有的
   `DataQuality`（`official` / `cached` / `local`）与 `degradedReason`，不得伪装成官方数据。
3. **fixture 测试**：每家必须有 golden sample（真实抓取的响应样本）+ 解析断言。
4. **凭据只进 `items`（加密）**，绝不进 `extras`（明文）—— 沿用 `keystore.ts` 的双命名空间纪律。

### P1-5 资源占用

5. **文档明示**：README / FAQ 说清「默认形态（2D 圆环）不加载 three.js、不下载 3D 素材」，
   用**实测数字**而不是承诺。
6. **常驻内存实测与优化**：先测出基线（常驻 + 峰值），再做优化，再复测对比。
   只做**低风险**优化（延迟加载非首屏模块、减少主进程定时器唤醒）；
   **不做**需要改动渲染架构的重构。

### P1-5 Tauri 评估

7. **输出一份可决策的评估文档**：迁移成本（人日）、收益（内存/体积/启动时间）、
   风险（托盘/悬浮窗/全局快捷键/Tauri 插件成熟度）、以及**明确的建议**（迁移 / 不迁移 / 部分迁移）。

## Constraints

- **许可边界（需在各家子任务里显式声明）**：竞品报告说「各项目许可均为 MIT，可参考实现」。
  MIT 允许把代码抄进闭源产品，但**必须保留版权声明**。
  **决策：参考「解析思路」并自己重写实现**，不逐行复制他人代码；
  若确实复用了代码片段，则必须在该文件头附上版权与许可声明。
  ⚠ **这条边界目前没有任何自动化守卫**（`test-structure.mjs` 里零许可相关断言；
  本 PRD 此前误写「由 test-structure.mjs 守门」，已更正）。四家调研结论一致：
  **预计可复用的只有接口事实**（URL、字段名、公开的 OAuth client id），实现均自行重写，
  实际复制量应为 0；即便如此仍在文件头附一行来源与许可声明（零成本）。
- **测试段落字母已分配，防并行覆盖**：`scripts/test-adapters.mjs` 现有段占用
  `A–N R S T`（O/P/Q/U/V/W/X/Y/Z 空闲）。**四家各锁一个、互不重叠** ——
  撞字母会让两段互相覆盖，而这种覆盖在测试里表现为「某段没跑到」而不是报错。
  分配：Gemini `V` · Cursor `W` · Antigravity `X` · OpenAI（升级 `codex.ts`）`Y`。
- **三家共同硬前置**：`10-01-seam-post-body`（采集接缝支持 POST body）。
  `CollectRequest` 与 `request.ts` 目前只能发 GET、无 body；`protocol-adapter.ts:68-72`
  的协议工厂也写死 GET + 两个固定头、无 body 扩展点，所以**即使接缝合入，仍不能走
  `protocols.ts` 声明表** —— 四家都写独立适配器。
- **共享文件冲突面**：`src/main/adapters/protocols.ts` 是四家共用的解析层 ——
  各自只追加自己的段落，**不重排既有内容**。
- **不做数据迁移**：新增适配器不涉及既有存储格式变更。
- **像素宠物瘦身线不在本批次**（另一条研究线）：结论已记录在
  `.trellis/tasks/archive/2026-09/09-30-pixel-pet-assets-research/` ——
  **没有合适的 2D 宠物素材就等于废掉整个数字助理**，因此该线暂缓。

## Cross-Child Acceptance Criteria

- [ ] `npm test` 全绿（六项的新测试脚本都已接入 `test` 链）
- [ ] `npm run typecheck` 通过
- [ ] 四家适配器各自满足自己 prd.md 的验收标准，且**每家有 fixture 测试**
- [ ] 四家适配器的降级路径都走 `DataQuality` + `degradedReason`（无「伪装成官方数据」的路径）
- [ ] 四家适配器的凭据只进 `items`，不进 `extras`（有静态断言）
- [ ] 资源占用子任务产出**实测数字**（优化前后对比），不是承诺
- [ ] Tauri 评估文档给出**明确的建议**（迁移 / 不迁移 / 部分迁移 + 理由）
- [ ] 本父任务的 spec 更新（Phase 3.3）覆盖新增的适配器契约与资源占用结论

## Out of Scope

- **竞品报告的 P2 档全部**（桌面小组件 / CSV 导出 / 皮肤市场 / i18n / 成本追踪）
- **Tauri 迁移本身的实施**：本批次只评估，不实施
- **像素宠物瘦身 / 3D 素材移除**：等有合适的 2D 素材再动（见 Constraints）

## Notes

- 六个子任务**并行**推进，各自定义、实现、验收、提交。
- 并行冲突面已在 Task Map 逐项列出；合并时「先合不改公共文件的，最后统一接 `test` 链」。
- 每项都是**复杂任务**，`task.py start` 前各自需要 `prd.md` + `design.md` + `implement.md`。