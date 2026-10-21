/**
 * selftest.mjs — docs-recall-dsh 的离线功能自测（不起 DSH、不碰用户配置、不联网）
 *
 * 干什么：import 本包的 `apply()`，喂一个假的 Cordis ctx，捕获它注册的
 * `agent/pre-step` 监听器，然后用合成的 payload 驱动它，断言：
 *   1. 用 `{ prepend: true }` 注册（与第一方 dsh-time-context / dsh-mnemon 同形）
 *   2. 委托上游 decision 后，往后追一条 `source.kind === 'plugin'` 的 UserMessage
 *   3. 注入文本 = `scripts/recall-core.py` 的 stdout，且查询词确实传进去了
 *   4. 每个 turn 只注入一次（step !== 1 不注入）
 *   5. 幂等：decision 里已有本插件来源的消息时不再重复
 *   6. 不自己喂自己：`messages` 里只有 plugin 来源时不算查询词
 *   7. decision 为 reject 时原样透传（添加上下文不构成否决）
 *   8. 同文本命中不跨轮重复注入
 *   9. 找不到 recall-core.py 时完全不注册监听器（静默退出）
 *
 * 用法：node selftest.mjs            （测本地兜底构造器）
 *       node selftest.mjs --verbose  （多打印）
 *
 * 环境变量 DOCS_RECALL_PLUGIN_ENTRY 可指向另一份 index.js —— verify.sh 用它
 * 把插件放到 `~/.dsh/profiles/` 下的临时目录里跑一次，以覆盖"官方
 * createUserMessage 可用"的分支。
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = process.env.DOCS_RECALL_PLUGIN_ENTRY ?? join(HERE, "lib", "index.js");
const VERBOSE = process.argv.includes("--verbose");

let pass = 0;
let fail = 0;
const ok = (m) => { pass += 1; console.log(`  ✅ ${m}`); };
const bad = (m) => { fail += 1; console.log(`  ❌ ${m}`); };
const chk = (m, cond) => (cond ? ok(m) : bad(m));
const say = (m) => { if (VERBOSE) console.log(`     · ${m}`); };
const existsSyncMaybe = (p) => existsSync(p);
const safeRead = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };

/** 假 Cordis ctx：只实现本插件用到的最小面。 */
function fakeCtx(options = {}) {
  const listeners = new Map();
  const disposers = [];
  return {
    listeners, disposers,
    // 官方服务：解析「该 agent 的工作目录」（可选；用来验证"每轮按会话目录解析"）
    ...(options.workingDirectory
      ? { workingDirectory: { ensure: options.workingDirectory } }
      : {}),
    on(event, listener, options) {
      listeners.set(event, { listener, options });
      const dispose = () => listeners.delete(event);
      disposers.push(dispose);
      return dispose;
    },
    effect(fn) {
      const d = fn();
      if (typeof d === "function") disposers.push(d);
      return d;
    },
  };
}

const userMsg = (text) => ({
  id: `u-${Math.random().toString(16).slice(2)}`,
  role: "user",
  content: [{ type: "text", text }],
  source: { kind: "user" },
});

const pluginMsg = (text, plugin = "docs-recall") => ({
  id: `p-${Math.random().toString(16).slice(2)}`,
  role: "user",
  content: [{ type: "text", text }],
  source: { kind: "plugin", plugin },
});

/** 造一个临时"项目"：只有 scripts/recall-core.py 这个桩。 */
function fixtureProject(stdoutLine) {
  const root = mkdtempSync(join(tmpdir(), "docs-recall-selftest-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(
    join(root, "scripts", "recall-core.py"),
    `import sys\nprint(${JSON.stringify(stdoutLine)} + " :: " + " ".join(sys.argv[1:]))\n`,
    "utf8",
  );
  return root;
}

/** 驱动已注册的 pre-step 监听器。agent 默认复用同一个对象（真实宿主也是每会话一个）。 */
const AGENT = { id: "selftest-agent" };
async function fire(ctx, { messages, turn = 1, step = 1, aborted = false, base, agent = AGENT }) {
  const entry = ctx.listeners.get("agent/pre-step");
  if (!entry) throw new Error("agent/pre-step 监听器未注册");
  const payload = { agent, messages, turn, step, signal: { aborted } };
  return entry.listener(payload, async () => base ?? { kind: "enter", messages });
}

const { default: apply } = await import(`file://${ENTRY}`);

console.log(`\n\u001b[1mdocs-recall-dsh selftest\u001b[0m  entry=${ENTRY}`);

// ── 1. 注册形状 ────────────────────────────────────────────
const root = fixtureProject("KNOWLOG_HIT_MARKER");
const ctx = fakeCtx();
apply(ctx, { root, core: "scripts/recall-core.py" });

const entry = ctx.listeners.get("agent/pre-step");
chk("注册了 agent/pre-step 监听器", Boolean(entry));
chk("以 { prepend: true } 注册（先委托下游再追加）", entry?.options?.prepend === true);
chk("没有注册别的探测式服务（只动 agent/pre-step）", ctx.listeners.size === 1);
say(`listeners=${[...ctx.listeners.keys()].join(",")}`);

// ── 2/3. 注入形状与内容 ────────────────────────────────────
{
  const decision = await fire(ctx, { messages: [userMsg("改一下 consumeRate 换算系数")] });
  const injected = decision.messages.at(-1);
  chk("enter 决策里追加了一条消息", decision.kind === "enter" && decision.messages.length === 2);
  chk("新消息 source 是 { kind:'plugin', plugin:'docs-recall' }",
    injected?.source?.kind === "plugin" && injected?.source?.plugin === "docs-recall");
  chk("新消息 source.form 是 'snapshot'（与第一方 dsh-time-context 同形）",
    injected?.source?.form === "snapshot" && injected?.source?.sections?.[0]?.name === "docs-recall");
  chk("新消息有 id 与 role:'user'（是合法 UserMessage，不是裸对象）",
    typeof injected?.id === "string" && injected.id.length > 0 && injected.role === "user");
  chk("注入文本来自 recall-core.py 的 stdout", String(injected?.content?.[0]?.text).includes("KNOWLOG_HIT_MARKER"));
  chk("查询词确实传给了 recall-core.py",
    String(injected?.content?.[0]?.text).includes("consumeRate"));
  say(`injected text = ${JSON.stringify(injected?.content?.[0]?.text)}`);
}

// ── 4. 每轮只在 step 1 注入 ────────────────────────────────
{
  const decision = await fire(ctx, { messages: [userMsg("再改一下 consumeRate")], turn: 2, step: 2 });
  chk("step !== 1 不注入（每轮一次）", decision.messages.length === 1);
}

// ── 5. 幂等 ────────────────────────────────────────────────
{
  const base = { kind: "enter", messages: [userMsg("改一下 consumeRate"), pluginMsg("上一轮已注入")] };
  const decision = await fire(ctx, { messages: base.messages, turn: 3, base });
  chk("decision 已含本插件来源消息时不再重复注入", decision.messages.length === 2);
}

// ── 6. 不自己喂自己 ───────────────────────────────────────
{
  const base = { kind: "enter", messages: [pluginMsg("time-context 快照之类", "time-context")] };
  const decision = await fire(ctx, { messages: base.messages, turn: 4, base });
  chk("messages 里只有 plugin 来源时不当作查询词（拒绝自我喂养）", decision.messages.length === 1);
}

// ── 7. reject 透传 ────────────────────────────────────────
{
  const base = { kind: "reject" };
  const decision = await fire(ctx, { messages: [userMsg("改一下 consumeRate")], turn: 5, base });
  chk("上游 reject 时原样透传（添加上下文不构成否决）", decision.kind === "reject");
}

// ── 8. 同文本不跨轮重复注入 ────────────────────────────────
{
  const decisions = [];
  for (let i = 0; i < 2; i += 1) {
    decisions.push(await fire(ctx, { messages: [userMsg("交期与报警阈值的换算")], turn: 10 + i }));
  }
  chk("同文本首次注入、跨轮重复时跳过",
    decisions[0].messages.length === 2 && decisions[1].messages.length === 1);
}

// ── 9. 会话目录里缺 recall-core.py → 不注入、不报错（监听器仍注册）──
{
  const empty = mkdtempSync(join(tmpdir(), "docs-recall-empty-"));
  const bare = fakeCtx({ workingDirectory: async () => empty });
  apply(bare, { core: "scripts/recall-core.py" });
  chk("监听器照常注册（不再因加载时机缺核心而整体失效）", bare.listeners.size === 1);
  const decision = await fire(bare, { messages: [userMsg("改一下 consumeRate 换算系数")] });
  chk("会话目录没有召回核心时不注入（也不抛错）", decision.kind === "enter" && decision.messages.length === 1);
  rmSync(empty, { recursive: true, force: true });
}

// ── 11. 每轮按「会话目录」解析（常驻宿主的关键）────────────
{
  const projA = fixtureProject("SESSION_A_HIT");
  const projB = fixtureProject("SESSION_B_HIT");
  const ctxAB = fakeCtx({ workingDirectory: async (agent) => (agent.id === "agent-a" ? projA : projB) });
  apply(ctxAB, { core: "scripts/recall-core.py" });          // 故意不给 root（模拟真实 profile）
  const agentA = { id: "agent-a", session: { meta: {} } };
  const agentB = { id: "agent-b", session: { meta: {} } };
  const dA = await fire(ctxAB, { messages: [userMsg("改一下 consumeRate 换算")], agent: agentA });
  const dB = await fire(ctxAB, { messages: [userMsg("改一下 tenantId 过滤")], agent: agentB });
  chk("未配置 root 时用 workingDirectory.ensure 解析会话目录（会话 A）",
    String(dA.messages.at(-1)?.content?.[0]?.text).includes("SESSION_A_HIT"));
  chk("同一进程内不同会话解析到各自目录（会话 B，不串味）",
    String(dB.messages.at(-1)?.content?.[0]?.text).includes("SESSION_B_HIT"));
}

// ── 12. 兜底：没有 workingDirectory 服务时用 session.meta.cwd ──
{
  const projC = fixtureProject("SESSION_C_HIT");
  const ctxC = fakeCtx();
  apply(ctxC, { core: "scripts/recall-core.py" });
  const agentC = { id: "agent-c", session: { meta: { cwd: projC } } };
  const dC = await fire(ctxC, { messages: [userMsg("改一下 consumeRate 换算")], agent: agentC });
  chk("没有 workingDirectory 服务时回退到 agent.session.meta.cwd",
    String(dC.messages.at(-1)?.content?.[0]?.text).includes("SESSION_C_HIT"));
}

// ── 13. 显式绝对 root 优先（调试/单项目场景）────────────────
{
  const projD = fixtureProject("EXPLICIT_HIT");
  const other = fixtureProject("SHOULD_NOT_WIN");
  const ctxD = fakeCtx({ workingDirectory: async () => other });
  apply(ctxD, { root: projD, core: "scripts/recall-core.py" });
  const dD = await fire(ctxD, { messages: [userMsg("改一下 consumeRate 换算")] });
  chk("配置了绝对 root 时以它为准（不被会话目录覆盖）",
    String(dD.messages.at(-1)?.content?.[0]?.text).includes("EXPLICIT_HIT"));
}

// ── 14. 加载事件写 ~/.dsh（确认插件有没有被加载）────────────
{
  const home = mkdtempSync(join(tmpdir(), "docs-recall-home-"));
  const prevDebug = process.env.DOCS_RECALL_DEBUG;
  const prevHome = process.env.DSH_HOME;
  process.env.DOCS_RECALL_DEBUG = "1";
  process.env.DSH_HOME = home;
  try {
    const ctxE = fakeCtx();
    apply(ctxE, { core: "scripts/recall-core.py" });
    const logPath = join(home, "docs-recall.log");
    chk("apply() 会在 DSH_HOME 下写 plugin loaded 日志",
      existsSyncMaybe(logPath) && safeRead(logPath).includes("plugin loaded"));
  } finally {
    if (prevDebug === undefined) delete process.env.DOCS_RECALL_DEBUG; else process.env.DOCS_RECALL_DEBUG = prevDebug;
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
}

// ── 15. 不设 DOCS_RECALL_DEBUG 也会记一行「plugin loaded」────
{
  const home = mkdtempSync(join(tmpdir(), "docs-recall-home2-"));
  const prevDebug = process.env.DOCS_RECALL_DEBUG;
  const prevHome = process.env.DSH_HOME;
  delete process.env.DOCS_RECALL_DEBUG;
  process.env.DSH_HOME = home;
  try {
    apply(fakeCtx(), { core: "scripts/recall-core.py" });
    chk("不需要调试开关也记录 plugin loaded（便于确认加载）",
      safeRead(join(home, "docs-recall.log")).includes("plugin loaded"));
  } finally {
    if (prevDebug !== undefined) process.env.DOCS_RECALL_DEBUG = prevDebug;
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
}

// ── 10. abort 透传 ────────────────────────────────────────
{
  const decision = await fire(ctx, { messages: [userMsg("改一下 consumeRate 换算法")], turn: 20, aborted: true });
  chk("signal 已 abort 时不注入", decision.messages.length === 1);
}

console.log(`\n  ${fail === 0 ? "\u001b[32mPASS\u001b[0m" : "\u001b[31mFAIL\u001b[0m"} ${pass} passed, ${fail} failed\n`);

rmSync(root, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
