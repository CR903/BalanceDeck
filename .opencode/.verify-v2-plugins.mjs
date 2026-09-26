/**
 * Throwaway harness: loads each plugin with a mock V2 context and drives both
 * hook types, so we can confirm the V2 entrypoint is recognized and the
 * injection actually mutates the payload.
 *
 * Run: node .opencode/.verify-v2-plugins.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs"
import { join } from "path"

const ROOT = process.cwd()
const PLUGINS = [
  "session-start.js",
  "inject-workflow-state.js",
  "inject-subagent-context.js",
]

let failures = 0
function check(label, ok, extra = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${extra ? ` — ${extra}` : ""}`)
  if (!ok) failures++
}

// --- fixtures: a throwaway task so the subagent path has something to read ---
const taskId = "verify-v2-fixture"
const taskDir = join(ROOT, ".trellis", "tasks", taskId)
mkdirSync(taskDir, { recursive: true })
writeFileSync(join(taskDir, "task.json"), JSON.stringify({ id: taskId, status: "in_progress", title: "V2 port verification" }, null, 2))
writeFileSync(join(taskDir, "prd.md"), "# Fixture PRD\n\nAcceptance: the V2 port loads and injects.\n")

const sessionID = "ses_verify_v2_port_fixture"
const sessionsDir = join(ROOT, ".trellis", ".runtime", "sessions")
mkdirSync(sessionsDir, { recursive: true })
const contextKey = `opencode_${sessionID}`
writeFileSync(join(sessionsDir, `${contextKey}.json`), JSON.stringify({ current_task: `.trellis/tasks/${taskId}` }, null, 2))

function mockContext() {
  const registered = { session: [], tool: [] }
  return {
    registered,
    location: { directory: ROOT, project: { id: "p", directory: ROOT, canonical: ROOT } },
    options: {},
    session: {
      hook: async (name, cb) => { registered.session.push({ name, cb }); return { dispose() {} } },
    },
    tool: {
      hook: async (name, cb) => { registered.tool.push({ name, cb }); return { dispose() {} } },
    },
  }
}

function userMessage(text) {
  return { id: "msg_1", role: "user", content: [{ type: "text", text }] }
}

function textOf(messages) {
  const last = messages[messages.length - 1]
  return last.content.filter((c) => c.type === "text").map((c) => c.text).join("\n")
}

const loaded = {}
for (const file of PLUGINS) {
  const mod = await import(join(ROOT, ".opencode", "plugins", file))
  const def = mod.default
  console.log(`\n${file}`)
  check("default export is an object (not a V1 factory function)", typeof def === "object" && def !== null)
  check("has stable id", typeof def.id === "string" && def.id.length > 0, def.id)
  check("has setup(ctx)", typeof def.setup === "function")
  check("no leftover V1 hook keys", !("tool.execute.before" in def) && !("experimental.chat.messages.transform" in def))

  const ctx = mockContext()
  const cleanup = await def.setup(ctx)
  check("setup() returned no cleanup requirement", cleanup === undefined || typeof cleanup === "function")

  if (file === "inject-subagent-context.js") {
    check("registered ctx.tool.hook('execute.before')", ctx.registered.tool.some((h) => h.name === "execute.before"))
  } else {
    check("registered ctx.session.hook('context')", ctx.registered.session.some((h) => h.name === "context"))
  }
  loaded[file] = ctx
}

// --- drive the session `context` hook twice (per-turn dedup) ---
console.log("\n--- session-start.js behaviour ---")
{
  const hook = loaded["session-start.js"].registered.session[0].cb
  const messages = [userMessage("hello there")]
  const ev = { sessionID, agent: "build", system: [], messages, options: {} }
  await hook(ev)
  const after1 = textOf(messages)
  check("injected <session-context> on first pass", after1.includes("<session-context>"))
  check("injected <task-status>", after1.includes("<task-status>"))
  check("injected resolved task path", after1.includes(taskId), "current task visible")
  check("first-reply notice present on first turn", after1.includes("<first-reply-notice>"))

  // second model call in the same turn: must not duplicate
  await hook(ev)
  const count = (textOf(messages).match(/<session-context>/g) || []).length
  check("no duplicate injection on 2nd model call", count === 1, `occurrences=${count}`)

  // next turn (new user message) should re-inject but drop the one-shot notice
  const turn2 = [userMessage("first"), ...messages, { id: "a1", role: "assistant", content: [{ type: "text", text: "hi" }] }, userMessage("second turn")]
  const ev2 = { sessionID, agent: "build", system: [], messages: turn2, options: {} }
  await hook(ev2)
  const t2 = textOf(turn2)
  check("re-injected on a new turn", (t2.match(/<session-context>/g) || []).length === 1)
  check("one-shot ack notice dropped after first reply", !t2.includes("<first-reply-notice>"))
}

console.log("\n--- inject-workflow-state.js behaviour ---")
{
  const hook = loaded["inject-workflow-state.js"].registered.session[0].cb
  const messages = [userMessage("do the thing")]
  const ev = { sessionID, agent: "build", system: [], messages, options: {} }
  await hook(ev)
  const after1 = textOf(messages)
  check("injected <workflow-state>", after1.includes("<workflow-state>"))
  check("breadcrumb names the active task + status", after1.includes(taskId) && after1.includes("in_progress"))
  await hook(ev)
  const count = (textOf(messages).match(/<workflow-state>/g) || []).length
  check("no duplicate breadcrumb on 2nd model call", count === 1, `occurrences=${count}`)

  // skip keyword escape hatch
  const skip = [userMessage("please no-trellis just answer")]
  await hook({ sessionID, agent: "build", system: [], messages: skip, options: {} })
  check("skip keyword suppresses injection", !textOf(skip).includes("<workflow-state>"))
  check("skip keyword does not mutate the user's own text", textOf(skip).includes("no-trellis"))
}

console.log("\n--- inject-subagent-context.js behaviour ---")
{
  const hook = loaded["inject-subagent-context.js"].registered.tool[0].cb

  // shell command gets the session context prefix
  const shellInput = { command: "python3 ./.trellis/scripts/task.py current" }
  await hook({ tool: "shell", sessionID, agent: "build", messageID: "m", id: "c", input: shellInput })
  check("shell command prefixed with TRELLIS_CONTEXT_ID", /^export TRELLIS_CONTEXT_ID=/.test(shellInput.command), shellInput.command.slice(0, 60))
  check("original command preserved", shellInput.command.includes("task.py current"))
  check("prefix is idempotent", await (async () => {
    await hook({ tool: "shell", sessionID, agent: "build", messageID: "m", id: "c", input: shellInput })
    return (shellInput.command.match(/TRELLIS_CONTEXT_ID=/g) || []).length === 1
  })())

  // subagent dispatch gets context-wrapped
  const sub = { agent: "trellis-implement", description: "d", prompt: "Active task: .trellis/tasks/" + taskId + "\n\nDo the work." }
  await hook({ tool: "subagent", sessionID, agent: "build", messageID: "m", id: "c", input: sub })
  check("prompt wrapped with injected marker", sub.prompt.includes("<!-- trellis-hook-injected -->"))
  check("injected prd.md content", sub.prompt.includes("Fixture PRD"))
  check("original task instruction retained", sub.prompt.includes("Do the work."))
  check("no git-commit constraint present", sub.prompt.includes("Do NOT execute git commit"))

  // double-registration guard
  const before = sub.prompt
  await hook({ tool: "subagent", sessionID, agent: "build", messageID: "m", id: "c", input: sub })
  check("second registration does not re-wrap", sub.prompt === before)

  // research agent needs no task dir
  const res = { agent: "trellis-research", description: "d", prompt: "find things" }
  await hook({ tool: "subagent", sessionID, agent: "build", messageID: "m", id: "c", input: res })
  check("research agent injected without a task", res.prompt.includes("Research Agent Task"))

  // unsupported agent untouched
  const other = { agent: "explore", description: "d", prompt: "unchanged" }
  await hook({ tool: "subagent", sessionID, agent: "build", messageID: "m", id: "c", input: other })
  check("non-Trellis agent left alone", other.prompt === "unchanged")

  // unrelated tool untouched
  const read = { filePath: "/x" }
  await hook({ tool: "read", sessionID, agent: "build", messageID: "m", id: "c", input: read })
  check("unrelated tool left alone", JSON.stringify(read) === '{"filePath":"/x"}')
}

// --- cleanup fixtures ---
rmSync(taskDir, { recursive: true, force: true })
rmSync(join(sessionsDir, `${contextKey}.json`), { force: true })

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
