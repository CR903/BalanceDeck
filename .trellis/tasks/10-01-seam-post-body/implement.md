# Implement: 采集接缝支持 POST body 与 method

## Ordered Checklist

### Phase 1: 契约扩展（types.ts）

- [ ] **1.1** `src/main/adapters/types.ts` 的 `CollectRequest` 加两个**可选**字段
  - [ ] `method?: 'GET' | 'POST'`（**字面量联合**，不放开成 `string`）
  - [ ] `body?: string`（**已序列化**的字符串，接缝不决定序列化方式）
- [ ] **1.2** 注释写清两条边界：序列化归调用方（Gemini 有 JSON 与 form-encoded 两种端点）、
      `Content-Type` 归调用方（接缝只在缺失时补 JSON）
- [ ] **1.3** 确认既有调用点**零改动**（grep `request({` 确认全部仍只传 url/headers/timeoutMs）

### Phase 2: 生产实现透传（request.ts）

- [ ] **2.1** `src/main/request.ts` 的 fetch 调用改为
      `fetch(req.url, { method: req.method ?? 'GET', headers, body: req.body, signal })`
- [ ] **2.2** `Content-Type` 补齐规则：**有 body 且调用方未带 Content-Type** 时补 `application/json`；
      调用方自带就原样用
- [ ] **2.3** 确认缺省路径（无 method/body）**逐字等价**于改动前

### Phase 3: 测试桩记录 body/method

- [ ] **3.1** `scripts/test-adapters.mjs` **新增**一个 rich 记录函数
      （返回 `{ url, auth, accept, method, body }`），**不改既有 `callProject` 的返回形状**
      —— 它被既有断言深度依赖，改形状会红
- [ ] **3.2** 桩的 `request` 把 method/body 传给 rich 函数记录
- [ ] **3.3** 确认既有断言逐字不受影响（既有段全绿）

### Phase 4: 测试

- [ ] **4.1** 新建 `scripts/test-seam.mjs`（`loadTs` 加载 `request.ts` 真源码，注入 electron 替身）
  - [ ] 缺省（无 method）→ GET、无 body
  - [ ] 显式 `method:'GET'` → 仍是 GET
  - [ ] `POST` + JSON body + 无 Content-Type → 补 `application/json`
  - [ ] `POST` + form body + 自带 Content-Type → **不被覆盖**（form 编码要生效）
  - [ ] `POST` 无 body → **不补** Content-Type
  - [ ] 静态守卫：`request.ts` 的 fetch **必须读 `req.method`**（否则有人清理时改回硬编码 GET）
  - [ ] 静态守卫：`types.ts` 里 `method` / `body` 都是**可选**（`?`）
- [ ] **4.2** `package.json` 加 `test:seam` 并接入 `test` 链
  - ⚠ 本批次多家适配器都在改 `package.json`，**用 `edit` 精确匹配、只加自己那一行**

### Phase 5: spec

- [ ] **5.1** 更新 `.trellis/spec/adapters/index.md` —— 接缝契约变了，
      spec 里 `CollectRequest` 现在只写了三个字段（**不改它会让下一个人以为不能 POST**）

## Review Gates

- [ ] `npm test` 通过（含新增 `test-seam.mjs`）
- [ ] `npm run typecheck` 通过
- [ ] **既有 18 个套件的断言数与改动前完全一致**（纯增量的证明；这是本任务最关键的一条门）
- [ ] **反验**：把 `req.method ?? 'GET'` 改回硬编码 `'GET'` → 静态守卫必须报红
- [ ] **反验**：让接缝「自动 JSON.stringify body」→ form 编码那条用例必须报红
- [ ] `trellis-check` 对照 prd.md 的 8 条 AC 逐条复核

## Rollback

- **纯增量**：删掉 `types.ts` 的两个可选字段 + `request.ts` 的透传即可回到改动前。
  **既有适配器全程零改动**，所以回滚不影响任何现有功能。
- 无数据迁移、无存储格式变更。