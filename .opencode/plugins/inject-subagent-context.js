/* global process */
/**
 * Trellis Context Injection Plugin
 *
 * Injects context when the `subagent` tool is called with a supported Trellis
 * sub-agent type, via `ctx.tool.hook("execute.before", ...)`.
 *
 * Also injects `TRELLIS_CONTEXT_ID` into every `shell` tool invocation, which
 * is the only channel by which an AI-run `task.py` learns the OpenCode
 * session identity (OpenCode exports no session env var of its own).
 */

import { existsSync, readdirSync } from "fs"
import { join } from "path"
import {
  TrellisContext,
  debugLog,
  readContextInjectionLimits,
  ContextBudget,
  materializeArtifact,
} from "../lib/trellis-context.js"

// Supported sub-agent types
const AGENTS_ALL = ["implement", "check", "research"]
const AGENTS_REQUIRE_TASK = ["implement", "check"]

// OpenCode V2 renamed the V1 tool names. `bash` -> `shell` and `task` ->
// `subagent`; the `subagent_type` argument became `agent`. The V1 spellings
// are still accepted so a stale dispatch prompt or a mixed tool snapshot
// cannot silently skip injection.
const SHELL_TOOLS = new Set(["shell", "bash"])
const SUBAGENT_TOOLS = new Set(["subagent", "task"])

// Marks a prompt this plugin already wrapped. OpenCode loads plugins from the
// global and the project directory independently, so the same plugin can be
// registered twice; without this guard the second instance would re-wrap the
// already-wrapped prompt and duplicate the whole injected context block.
const INJECTED_MARKER = "<!-- trellis-hook-injected -->"

// Match `Active task: <path>` on the first non-empty line of the dispatch
// prompt. Mirrors the contract in workflow.md's [workflow-state:in_progress]
// breadcrumb so multi-window users can disambiguate which task is targeted.
const ACTIVE_TASK_HINT_RE = /^\s*Active task:\s*(\S+)\s*$/m

function extractActiveTaskHint(prompt) {
  if (typeof prompt !== "string" || !prompt) return null
  const match = prompt.match(ACTIVE_TASK_HINT_RE)
  return match ? match[1].trim() : null
}

/**
 * Get context for implement agent. `taskDir` may be relative
 * (`.trellis/tasks/foo`) or absolute; both are resolved via
 * `ctx.resolveTaskDir`.
 *
 * Read order (mirrors Python `get_implement_context`):
 *   1. All files in implement.jsonl (spec/research manifests)
 *   2. prd.md (requirements)
 *   3. design.md if present (technical design)
 *   4. implement.md if present (execution plan)
 * All blocks share one total budget (issue #441).
 */
function getImplementContext(ctx, taskDir) {
  const parts = []
  const taskDirFull = ctx.resolveTaskDir(taskDir)
  if (!taskDirFull) return ""

  const limits = readContextInjectionLimits(ctx.directory)
  const budget = new ContextBudget(limits.max_total_bytes)

  // 1. Read implement.jsonl
  const jsonlPath = join(taskDirFull, "implement.jsonl")
  const blocks = ctx.readJsonlWithFiles(jsonlPath, limits, budget)
  if (blocks.length > 0) {
    parts.push(ctx.buildContextFromEntries(blocks))
  }

  // 2. Requirements document
  const prdBlock = materializeArtifact(
    ctx.directory,
    `${taskDir}/prd.md`,
    `${taskDir}/prd.md (Requirements)`,
    "Requirements document",
    limits,
    budget,
  )
  if (prdBlock) parts.push(prdBlock)

  // 3. Technical design for complex tasks
  const designBlock = materializeArtifact(
    ctx.directory,
    `${taskDir}/design.md`,
    `${taskDir}/design.md (Technical Design)`,
    "Technical design document",
    limits,
    budget,
  )
  if (designBlock) parts.push(designBlock)

  // 4. Execution plan for complex tasks
  const implementPlanBlock = materializeArtifact(
    ctx.directory,
    `${taskDir}/implement.md`,
    `${taskDir}/implement.md (Execution Plan)`,
    "Execution plan document",
    limits,
    budget,
  )
  if (implementPlanBlock) parts.push(implementPlanBlock)

  return parts.join("\n\n")
}

/**
 * Get context for check agent. `taskDir` may be relative or absolute.
 * Same read order and shared budget as the implement context.
 */
function getCheckContext(ctx, taskDir) {
  const parts = []
  const taskDirFull = ctx.resolveTaskDir(taskDir)
  if (!taskDirFull) return ""

  const limits = readContextInjectionLimits(ctx.directory)
  const budget = new ContextBudget(limits.max_total_bytes)

  const jsonlPath = join(taskDirFull, "check.jsonl")
  const blocks = ctx.readJsonlWithFiles(jsonlPath, limits, budget)
  if (blocks.length > 0) {
    parts.push(ctx.buildContextFromEntries(blocks))
  }

  const prdBlock = materializeArtifact(
    ctx.directory,
    `${taskDir}/prd.md`,
    `${taskDir}/prd.md (Requirements)`,
    "Requirements document",
    limits,
    budget,
  )
  if (prdBlock) parts.push(prdBlock)

  const designBlock = materializeArtifact(
    ctx.directory,
    `${taskDir}/design.md`,
    `${taskDir}/design.md (Technical Design)`,
    "Technical design document",
    limits,
    budget,
  )
  if (designBlock) parts.push(designBlock)

  const implementPlanBlock = materializeArtifact(
    ctx.directory,
    `${taskDir}/implement.md`,
    `${taskDir}/implement.md (Execution Plan)`,
    "Execution plan document",
    limits,
    budget,
  )
  if (implementPlanBlock) parts.push(implementPlanBlock)

  return parts.join("\n\n")
}

/**
 * Get context for finish phase (final check before PR)
 */
function getFinishContext(ctx, taskDir) {
  // Finish reuses check context (same JSONL source)
  return getCheckContext(ctx, taskDir)
}

/**
 * Get context for research agent
 */
function getResearchContext(ctx) {
  const parts = []

  // Dynamic project structure (scan actual spec directory)
  const specPath = ".trellis/spec"
  const specFull = join(ctx.directory, specPath)

  const structureLines = [`## Project Spec Directory Structure\n\n\`\`\`\n${specPath}/`]
  if (existsSync(specFull)) {
    try {
      const entries = readdirSync(specFull, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith("."))
        .sort((a, b) => a.name.localeCompare(b.name))

      for (const entry of entries) {
        const entryPath = join(specFull, entry.name)
        if (existsSync(join(entryPath, "index.md"))) {
          structureLines.push(`├── ${entry.name}/`)
        } else {
          try {
            const nested = readdirSync(entryPath, { withFileTypes: true })
              .filter(d => d.isDirectory() && existsSync(join(entryPath, d.name, "index.md")))
              .sort((a, b) => a.name.localeCompare(b.name))
            if (nested.length > 0) {
              structureLines.push(`├── ${entry.name}/`)
              for (const n of nested) {
                structureLines.push(`│   ├── ${n.name}/`)
              }
            }
          } catch {
            // Ignore nested read errors
          }
        }
      }
    } catch {
      // Ignore read errors
    }
  }
  structureLines.push("```")

  parts.push(structureLines.join("\n") + `

## Search Tips

- Spec files: \`.trellis/spec/**/*.md\`
- Known issues: \`.trellis/big-question/\`
- Code search: Use Glob and Grep tools
- Tech solutions: Use mcp__exa__web_search_exa or mcp__exa__get_code_context_exa`)

  return parts.join("\n\n")
}

/**
 * Build enhanced prompt with context
 */
function buildPrompt(agentType, originalPrompt, context, isFinish = false) {
  const templates = {
    implement: `${INJECTED_MARKER}
# Implement Agent Task

You are the Implement Agent in the Multi-Agent Pipeline.

## Your Context

${context}

---

## Your Task

${originalPrompt}

---

## Workflow

1. **Understand specs** - All dev specs are injected above
2. **Understand task artifacts** - Read requirements, technical design if present, and execution plan if present
3. **Implement feature** - Follow specs and task artifacts
4. **Self-check** - Ensure code quality

## Important Constraints

- Do NOT execute git commit
- Follow all dev specs injected above
- Report list of modified/created files when done`,

    check: isFinish ? `${INJECTED_MARKER}
# Finish Agent Task

You are performing the final check before creating a PR.

## Your Context

${context}

---

## Your Task

${originalPrompt}

---

## Workflow

1. **Review changes** - Run \`git diff --name-only\` to see all changed files
2. **Verify task artifacts** - Check prd.md and, when present, design.md / implement.md
3. **Spec sync** - Analyze whether changes introduce new patterns, contracts, or conventions
   - If new pattern/convention found: read target spec file → update it → update index.md if needed
   - If infra/cross-layer change: follow the 7-section mandatory template from update-spec.md
   - If pure code fix with no new patterns: skip this step
4. **Run final checks** - Execute lint and typecheck
5. **Confirm ready** - Ensure code is ready for PR

## Important Constraints

- You MAY update spec files when gaps are detected (use update-spec.md as guide)
- MUST read the target spec file BEFORE editing (avoid duplicating existing content)
- Do NOT update specs for trivial changes (typos, formatting, obvious fixes)
- If critical CODE issues found, report them clearly (fix specs, not code)
- Verify all acceptance criteria in prd.md are met
- Verify design.md and implement.md constraints when those files are present` :
      `${INJECTED_MARKER}
# Check Agent Task

You are the Check Agent in the Multi-Agent Pipeline.

## Your Context

${context}

---

## Your Task

${originalPrompt}

---

## Workflow

1. **Get changes** - Run \`git diff --name-only\` and \`git diff\`
2. **Check against specs** - Check item by item
3. **Self-fix** - Fix issues directly, don't just report
4. **Run verification** - Run lint and typecheck

## Important Constraints

- Fix issues yourself, don't just report
- Must execute complete checklist`,

    research: `${INJECTED_MARKER}
# Research Agent Task

You are the Research Agent in the Multi-Agent Pipeline.

## Core Principle

**You do one thing: find and explain information.**

## Project Info

${context}

---

## Your Task

${originalPrompt}

---

## Workflow

1. **Understand query** - Determine search type and scope
2. **Plan search** - List search steps
3. **Execute search** - Run multiple searches in parallel
4. **Organize results** - Output structured report

## Strict Boundaries

**Only allowed**: Describe what exists, where it is, how it works

**Forbidden**: Suggest improvements, criticize implementation, modify files`
  }

  return templates[agentType] || originalPrompt
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function envValue(env, key) {
  const value = env?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function shellBasename(value) {
  return value.replace(/\\/g, "/").split("/").pop()?.toLowerCase() || ""
}

function isWindowsPosixShell(env = process.env) {
  if (envValue(env, "MSYSTEM")) return true
  if (envValue(env, "MINGW_PREFIX")) return true
  if (envValue(env, "OPENCODE_GIT_BASH_PATH")) return true

  const ostype = envValue(env, "OSTYPE")?.toLowerCase() || ""
  if (/(msys|mingw|cygwin)/.test(ostype)) return true

  const shell = shellBasename(envValue(env, "SHELL") || "")
  return /^(bash|sh|zsh)(\.exe)?$/.test(shell)
}

function buildTrellisContextPrefix(contextKey, hostPlatform = process.platform, env = process.env) {
  if (hostPlatform === "win32" && !isWindowsPosixShell(env)) {
    return `$env:TRELLIS_CONTEXT_ID = ${powershellQuote(contextKey)}; `
  }

  return `export TRELLIS_CONTEXT_ID=${shellQuote(contextKey)}; `
}

function getShellCommandKey(input) {
  if (!input || typeof input !== "object") return null
  if (typeof input.command === "string") return "command"
  if (typeof input.cmd === "string") return "cmd"
  return null
}

function commandStartsWithTrellisContext(command) {
  const firstCommand = command.trimStart().split(/[;&|]/, 1)[0].trimStart()
  return (
    /^TRELLIS_CONTEXT_ID\s*=/.test(firstCommand) ||
    /^export\s+TRELLIS_CONTEXT_ID\s*=/.test(firstCommand) ||
    /^env\s+(?:(?:-\S+|[A-Za-z_][A-Za-z0-9_]*=\S*)\s+)*TRELLIS_CONTEXT_ID\s*=/.test(firstCommand) ||
    /^\$env:TRELLIS_CONTEXT_ID\s*=/i.test(firstCommand)
  )
}

/**
 * OpenCode exposes no session identity to the shell at all — it sets no
 * session env var in any process, and the V2 `shell.create.before` hook
 * carries no `sessionID` either. The tool hook does receive it, so inject it
 * into the shell command before execution; that prefix is the only channel by
 * which an AI-run `task.py` sees the OpenCode session.
 */
function injectTrellisContextIntoShell(ctx, event) {
  const commandKey = getShellCommandKey(event.input)
  if (!commandKey) return false

  const command = event.input[commandKey]
  if (!command.trim()) return false
  if (commandStartsWithTrellisContext(command)) return false

  // The V2 tool event carries `sessionID`, which `getContextKey` resolves.
  const contextKey = ctx.getContextKey(event)
  if (!contextKey) return false

  event.input[commandKey] = `${buildTrellisContextPrefix(contextKey)}${command}`
  return true
}

/**
 * Resolve which task the dispatch targets, then wrap the prompt with context.
 */
function injectSubagentContext(ctx, event) {
  const args = event.input
  const rawAgent = args.agent ?? args.subagent_type
  // Strip "trellis-" prefix added by v0.5.0-beta.5 agent rename migration
  const agentType = String(rawAgent || "").replace(/^trellis-/, "")
  const originalPrompt = args.prompt || ""

  debugLog("inject", "Subagent tool called, agent:", rawAgent)

  if (!AGENTS_ALL.includes(agentType)) {
    debugLog("inject", "Skipping - unsupported sub-agent type")
    return
  }

  // Resolve active task in this priority order (only later steps
  // run when earlier ones miss):
  //   1. Exact session runtime context lookup for event.sessionID
  //   2. `Active task: <path>` hint in the dispatch prompt
  //      (explicit per-dispatch override — beats single-session
  //      inference so multi-window users can disambiguate)
  //   3. Single-session fallback — only when exactly 1 session
  //      runtime file exists locally
  let taskDir = null
  let taskSource = null

  const contextKey = ctx.getContextKey(event)
  if (contextKey) {
    const context = ctx.readContext(contextKey)
    const exactRef = ctx.normalizeTaskRef(context?.current_task || "")
    if (exactRef) {
      taskDir = exactRef
      taskSource = `session:${contextKey}`
    }
  }

  if (!taskDir) {
    const hintRef = extractActiveTaskHint(originalPrompt)
    if (hintRef) {
      const hintNormalized = ctx.normalizeTaskRef(hintRef)
      if (hintNormalized) {
        const hintDir = ctx.resolveTaskDir(hintNormalized)
        if (hintDir && existsSync(hintDir)) {
          taskDir = hintNormalized
          taskSource = "prompt-hint"
          debugLog("inject", "Resolved task from Active task: hint:", hintNormalized)
        }
      }
    }
  }

  if (!taskDir) {
    const fallback = ctx._resolveSingleSessionFallback()
    if (fallback?.taskPath) {
      const fallbackDir = ctx.resolveTaskDir(fallback.taskPath)
      if (fallbackDir && existsSync(fallbackDir)) {
        taskDir = fallback.taskPath
        taskSource = fallback.source
        debugLog("inject", "Resolved task via single-session fallback:", taskDir, "source:", taskSource)
      }
    }
  }

  // Agents requiring task directory
  if (AGENTS_REQUIRE_TASK.includes(agentType)) {
    if (!taskDir) {
      debugLog("inject", "Skipping - no current task")
      return
    }
    const taskDirFull = ctx.resolveTaskDir(taskDir)
    if (!taskDirFull || !existsSync(taskDirFull)) {
      debugLog("inject", "Skipping - task directory not found")
      return
    }
  }

  // Check for [finish] marker
  const isFinish = originalPrompt.toLowerCase().includes("[finish]")

  // Get context based on agent type
  let context = ""
  switch (agentType) {
    case "implement":
      context = getImplementContext(ctx, taskDir)
      break
    case "check":
      context = isFinish
        ? getFinishContext(ctx, taskDir)
        : getCheckContext(ctx, taskDir)
      break
    case "research":
      context = getResearchContext(ctx)
      break
  }

  if (!context) {
    debugLog("inject", "No context to inject")
    return
  }

  const newPrompt = buildPrompt(agentType, originalPrompt, context, isFinish)

  // Mutate the nested field in-place rather than replacing `event.input`:
  // the runtime holds a local reference to the same input object, so
  // whole-object replacement would not be observed.
  args.prompt = newPrompt

  debugLog("inject", "Injected context for", agentType, "prompt length:", newPrompt.length)
}

function hooksDisabled() {
  return process.env.TRELLIS_HOOKS === "0" || process.env.TRELLIS_DISABLE_HOOKS === "1"
}

// OpenCode V2 entrypoint: a default export carrying a stable `id` and
// `setup(ctx)`. The V1 `export default async ({ directory }) => ({ hooks })`
// shape is not recognized by V2.
export default {
  id: "trellis.subagent-context",

  async setup(ctx) {
    const directory = ctx.location.directory
    const trellis = new TrellisContext(directory)
    debugLog("inject", "Plugin loaded, directory:", directory)

    await ctx.tool.hook("execute.before", async (event) => {
      try {
        if (hooksDisabled()) return

        const toolName = String(event?.tool || "").toLowerCase()
        debugLog("inject", "execute.before called, tool:", toolName)

        if (SHELL_TOOLS.has(toolName)) {
          if (injectTrellisContextIntoShell(trellis, event)) {
            debugLog("inject", "Injected TRELLIS_CONTEXT_ID into shell command")
          }
          return
        }

        if (!SUBAGENT_TOOLS.has(toolName)) return
        if (!event.input || typeof event.input !== "object") return

        // A second registration of this plugin (global + project plugin dir)
        // would otherwise re-wrap the prompt and duplicate the context block.
        if (typeof event.input.prompt === "string" && event.input.prompt.includes(INJECTED_MARKER)) {
          debugLog("inject", "Skipping - prompt already carries injected context")
          return
        }

        injectSubagentContext(trellis, event)
      } catch (error) {
        debugLog(
          "inject",
          "Error in execute.before:",
          error instanceof Error ? error.message : String(error),
          error instanceof Error ? error.stack : "",
        )
      }
    })
  },
}
