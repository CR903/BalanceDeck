/**
 * docs-recall-dsh — DSH 召回桥接插件（Cordis 插件）
 *
 * 职责：在"用户提交 prompt"那一轮，调用项目内的 `.knowlog/recall-core.py`（旧项目 `scripts/`），
 * 把命中的规范/坑点作为一条带来源的 user 消息送进该轮上下文。
 * 与 Claude Code / Codex 的钩子、OpenCode 的插件**同源**：匹配逻辑只有一份
 * （recall-core.py），本文件只负责"怎么送进 DSH 的上下文"。
 *
 * ── 官方每轮注入机制（本机实测核实，v0.1.6-alpha.2）──
 * DSH 的每轮注入点是 **`agent/pre-step` waterfall**，不是任何 `prompt` / `context`
 * 服务的 `.inject()`。契约（`@deepseek-ai/dsh-agent` 的 `runtime-types.d.ts`）：
 *
 *   ctx.on('agent/pre-step', async ({ agent, messages, turn, step, signal }, next) => {
 *     const decision = await next();                    // ① 先委托下游（添加上下文≠否决）
 *     if (decision.kind !== 'enter') return decision;   //    kind: 'enter' | 'reject'
 *     return { ...decision, messages: [...decision.messages, createUserMessage({...})] };
 *   }, { prepend: true });
 *
 * 消息必须是 `@deepseek-ai/dsh-llm` 的 `UserMessage`（带 `id` + `source`），
 * 不能是裸对象；`source` 用 `{ kind: 'plugin', plugin: <本插件名>, form: 'snapshot',
 * sections: [{ name, text }] }`（与第一方 dsh-time-context 同形）。
 *
 * 三处真实先例（都在本机可读，本文件照抄其形状）：
 *   · 第一方 `@deepseek-ai/dsh-time-context`  → 每轮 pre-step 追加一条 sourced UserMessage
 *   · 第一方 `@deepseek-ai/dsh-agent-instructions` → 首个 pre-step 折入 AGENTS.md 基线
 *   · 生产插件 `dsh-mnemon`（用户 profile 里已装）→ pre-step + prepend 做每轮记忆召回
 * 官方把"每轮注入"统一放在这个 seam 上；Claude Code 的 UserPromptSubmit 钩子
 * 也是被 `@deepseek-ai/dsh-hooks-claude-code` 映射到 `agent/pre-step` 的。
 *
 * 本文件仍刻意不**静态** import 任何 DSH 内部包（依赖装不上时不会连带炸掉宿主）：
 * 先尝试动态 `import('@deepseek-ai/dsh-llm')` 拿官方构造器，失败则用本地等价实现
 * （与上游 `createMessage` 的实现逐字一致：`{...input, role:'user', id: randomUUID()}`）。
 *
 * 任何一步失败都只记日志、不动宿主；此时用命令行兜底：
 *   bash .knowlog/knowledge-retrieve.sh "<prompt>"
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** 插件名：同时是 `source.plugin` 的取值，宿主按它归属上下文。 */
export const name = "docs-recall";
/** 不依赖任何宿主服务（只用 ctx.on / ctx.effect）。 */
export const inject = [];

const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_MIN_QUERY_CHARS = 4;

function log(root, line) {
  if (process.env.DOCS_RECALL_DEBUG !== "1") return;
  try {
    const dir = join(root, ".dsh");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "docs-recall.log"), `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

/** 宿主级日志（加载/卸载/异常兜底）：直接写 <DSH_HOME>/docs-recall.log，路径可预期。 */
function logHost(line, { always = false } = {}) {
  // 加载事件 always=true：每次宿主启动只一行，零噪音，但能一眼确认"插件有没有被加载"
  if (!always && process.env.DOCS_RECALL_DEBUG !== "1") return;
  try {
    const dir = process.env.DSH_HOME || join(homedir(), ".dsh");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "docs-recall.log"), `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

/** 调项目内的召回核心（唯一实现）；任何失败都返回空串。 */
function recall(root, corePath, query, maxChars) {
  try {
    if (!query || !query.trim()) return "";
    return execFileSync("python3", [corePath, "--query", query.slice(0, maxChars)], {
      cwd: root, timeout: 3000, maxBuffer: 1 << 20,
    }).toString().trim().slice(0, maxChars);
  } catch {
    return "";
  }
}

/**
 * 官方构造器（`@deepseek-ai/dsh-llm`）优先，缺失时退回本地等价实现。
 * 动态 import 而非顶层 await：宿主以 require() 方式加载 ESM 时，
 * 顶层 await 会抛 ERR_REQUIRE_ASYNC_MODULE，插件就整个装不上了。
 */
let ctorCache;
async function userMessageCtor() {
  if (ctorCache === undefined) {
    try {
      ctorCache = (await import("@deepseek-ai/dsh-llm")).createUserMessage ?? null;
    } catch {
      ctorCache = null;
    }
  }
  return ctorCache;
}

/** 读一块消息的纯文本（照第一方取法：只取 text block）。 */
function textOf(content) {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => (block?.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("\n");
}

/**
 * 只取"用户亲手输入"的文本：`source.kind === 'user'`。
 * 必须排除 `kind === 'plugin'`（含本插件自己上一轮的注入、time-context 快照等），
 * 否则召回会自己喂自己，越滚越大。
 */
function directUserText(messages) {
  if (!Array.isArray(messages)) return "";
  return messages
    .filter((message) => message?.source?.kind === "user")
    .map((message) => textOf(message.content))
    .join("\n")
    .trim();
}

/** 本轮是否已经注入过本插件的内容（幂等；跨 step 不重复）。 */
function alreadyInjected(messages) {
  return messages.some((message) => {
    const source = message?.source;
    return source?.kind === "plugin" && source.plugin === name;
  });
}

export function apply(ctx, config = {}) {
  // 召回核心路径：新项目在 .knowlog/，旧项目在 scripts/（显式 config.core 优先）
  const coreCandidates = config.core ? [config.core] : [".knowlog/recall-core.py", "scripts/recall-core.py"];
  const maxChars = Number.isFinite(config.maxChars) ? config.maxChars : DEFAULT_MAX_CHARS;
  const minQueryChars = Number.isFinite(config.minQueryChars) ? config.minQueryChars : DEFAULT_MIN_QUERY_CHARS;
  const configuredRoot = typeof config.root === "string" ? config.root.trim() : "";

  if (typeof ctx?.on !== "function") return; // 非 Cordis 宿主 → 安静退出

  // 每个 agent 记住上一次注入的文本：同一份命中不重复占上下文。
  const lastHint = new WeakMap();
  const warned = new Set();                  // 同一个目录只提醒一次，别每轮刷日志

  /**
   * 解析**本次会话**的项目根。
   *
   * 为什么不能像最初那样在 apply() 里 `resolve(".")`：web profile 是**常驻进程**，
   * 它的 cwd 往往是 `/` 或 `~`（本机实测 cwd=/），于是插件会在加载时就去检查
   * `/.knowlog/recall-core.py`、找不到便直接 return —— 在任何项目里都失效。
   * 官方姿势是问 workingDirectory 服务要该 agent 的工作目录（第一方 dsh-tool-skill 同款），
   * 兜底顺序：显式绝对配置 → workingDirectory → session 元数据里的 cwd → 进程 cwd。
   */
  async function projectRoot(agent, signal) {
    if (configuredRoot && isAbsolute(configuredRoot)) return configuredRoot;
    try {
      const dir = await ctx.workingDirectory?.ensure?.(agent, signal);
      if (typeof dir === "string" && dir) return dir;
    } catch { /* 服务缺失或失败 → 继续兜底 */ }
    const metaCwd = agent?.session?.meta?.cwd;
    if (typeof metaCwd === "string" && metaCwd) return metaCwd;
    return resolve(configuredRoot || ".");
  }

  /**
   * 每轮注入。prepend:true 表示先注册、先跑 → `next()` 拿到的是所有下游
   * 监听器（压缩、skill 目录、AGENTS.md 等）组装完的最终 decision，
   * 我们再往后追一条；与第一方 dsh-time-context 完全同形。
   */
  const disposeListener = ctx.on("agent/pre-step", async ({ agent, messages, turn, step, signal }, next) => {
    const decision = await next();
    let root = "";
    try {
      if (decision?.kind !== "enter" || signal?.aborted) return decision;
      if (step !== 1) return decision;                        // 每轮只在首个 step 召回
      if (decision.messages.length === 0) return decision;
      if (alreadyInjected(decision.messages)) return decision;

      const query = directUserText(messages) || directUserText(decision.messages);
      if (query.replace(/\s+/g, "").length < minQueryChars) return decision;

      root = await projectRoot(agent, signal);
      const corePath = coreCandidates.map((c) => join(root, c)).find((p) => existsSync(p));
      if (!corePath) {
        if (!warned.has(root)) {
          warned.add(root);
          log(root, `会话目录里没有召回核心（找过 ${coreCandidates.join(" / ")}，root=${root}）→ 本轮起静默；命令行兑底 knowledge-retrieve.sh`);
        }
        return decision;
      }

      const hint = recall(root, corePath, query, maxChars);
      if (!hint) return decision;
      if (lastHint.get(agent) === hint) {
        log(root, `turn ${turn}: 命中与上轮相同，跳过重复注入`);
        return decision;
      }

      const create = await userMessageCtor();
      const build = create ?? ((input) => Object.freeze({ ...input, role: "user", id: randomUUID() }));
      const context = build({
        content: [{ type: "text", text: hint }],
        source: { kind: "plugin", plugin: name, form: "snapshot", sections: [{ name, text: hint }] },
      });

      lastHint.set(agent, hint);
      log(root, `turn ${turn} step ${step}: 注入 ${hint.length} chars（${create ? "官方 createUserMessage" : "本地等价实现"}）root=${root}`);
      return { ...decision, messages: [...decision.messages, context] };
    } catch (error) {
      if (root) log(root, `pre-step 注入失败（已忽略）：${error?.message ?? error}`);
      else logHost(`pre-step 解析会话目录失败（已忽略）：${error?.message ?? error}`);
      return decision;
    }
  }, { prepend: true });

  if (typeof ctx.effect === "function") {
    ctx.effect(() => () => {
      logHost(`plugin unloaded（core=${core}）`);
      disposeListener?.();
    }, "docs-recall: dispose pre-step listener");
  }

  logHost(`plugin loaded（core=${coreCandidates.join(" / ")} maxChars=${maxChars}；会话目录按每轮解析）`, { always: true });
}

export default apply;
