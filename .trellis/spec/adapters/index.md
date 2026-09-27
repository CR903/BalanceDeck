# Adapters & External Integrations

> Executable contracts for talking to third-party APIs from the main process.
> Thinking triggers (which endpoint? is it honest? is it robust?) live in
> [`../guides/external-api-integration.md`](../guides/external-api-integration.md).

---

## Why this layer exists

The main process owns every outbound integration. Those are the places where
the codebase is most likely to be *silently* wrong: a renamed field, a changed
auth scheme, or a fixture mistaken for evidence all produce output that looks
plausible and renders as fact. So this layer is written as contracts, not
adjectives.

## Guides Index

| Spec | Covers | Status |
|---|---|---|
| [opencode-console.md](./opencode-console.md) | opencode.ai 控制台：授权会话、配额窗口、每模型明细 | 已填（2026-09-27，任务 `09-26-opencode-console-spa`） |

## Layer-wide rules

1. **端点与请求头常量只有一个来源。** 同一组常量被多处使用时，
   放一个模块导出，其它文件 import 它 —— 两份会漂。
   见 `src/main/adapters/opencode-console-api.ts`。
2. **测试加载真源码，不用内联副本。** `scripts/lib/loadTs()` 把 `src` 下的
   TS 打成内存 ESM 后 import。测试里复制一份实现（哪怕注明"请与源保持一致"）
   是假护栏：源改错了测试照样绿。
3. **未知形状要有出口。** 解析器遇到不认识的字段/端点时，把它报出来并记日志，
   不要静默丢掉 —— 否则一次部分改名会悄悄少一个窗口，而界面上看不出异常。
4. **诊断命令与产品路径同源。** 凭据、配置、命名空间的解析顺序必须一致，
   否则会出现"工具说没配置、应用好好的"。
5. **端口径不一致时宁可不显示。** 近似值是撒谎；缺失是可见的。
6. **新增护栏后，先弄坏它一次**，确认测试真的会红。

## Related

- 领域词汇与架构分层：[`../../../CONTEXT.md`](../../../CONTEXT.md)
  （协议 / 适配器 / 采集引擎 / 快照 / 可信度）
- 历史决策：[`../../../docs/adr/`](../../../docs/adr/)
