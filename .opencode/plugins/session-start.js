/* global process */
/**
 * Trellis Session Start Plugin
 *
 * OpenCode V2 plugin API. Injects compact SessionStart context into the copy
 * of the latest user message that OpenCode sends to the model, via
 * `ctx.session.hook("context", ...)`.
 *
 * The V2 `context` hook runs immediately before each model request of the
 * agent loop and receives a per-dispatch working copy, so the mutation
 * affects only the outgoing model call — the TUI / Web / SQLite history
 * stay untouched (issue #553), the same guarantee the V1
 * `experimental.chat.messages.transform` hook relied on.
 */

import { TrellisContext, debugLog, isTrellisSubagent } from "../lib/trellis-context.js"
import {
  V2_CONTEXT_HOOK,
  hasAssistantMessageV2,
  messageAlreadyHasMarkerV2,
  prependTextToUserMessageV2,
} from "../lib/context-visibility-v2.js"
import { buildSessionContext } from "../lib/session-utils.js"

const FIRST_REPLY_NOTICE_RE = /<first-reply-notice>[\s\S]*?<\/first-reply-notice>\s*/g

/**
 * Per-dispatch dedup marker. `buildSessionContext` always emits
 * `<session-context>` as its first block, so its presence in the latest user
 * message means this turn's context was already injected.
 */
const SESSION_CONTEXT_MARKER = "<session-context>"

function stripFirstReplyNotice(context) {
  return context.replace(FIRST_REPLY_NOTICE_RE, "")
}

function hooksDisabled() {
  return process.env.TRELLIS_HOOKS === "0" || process.env.TRELLIS_DISABLE_HOOKS === "1"
}

// OpenCode V2 entrypoint: a default export carrying a stable `id` and
// `setup(ctx)`. V1's `export default async ({ directory }) => ({ hooks })`
// shape is not recognized by V2, so a V1 entrypoint makes this plugin a no-op
// rather than an error — see `.opencode/lib/context-visibility-v2.js` for the
// V2 message shape and `inject-subagent-context.js` for the tool-hook port.
export default {
  id: "trellis.session-start",

  async setup(ctx) {
    const directory = ctx.location.directory
    const trellis = new TrellisContext(directory)
    debugLog("session", "Plugin loaded, directory:", directory)

    await ctx.session.hook(V2_CONTEXT_HOOK, async (event) => {
      try {
        if (isTrellisSubagent(event)) {
          debugLog("session", "Skipping trellis subagent turn:", event?.agent)
          return
        }

        if (hooksDisabled()) {
          debugLog("session", "Skipping - TRELLIS_HOOKS disabled")
          return
        }

        if (process.env.OPENCODE_NON_INTERACTIVE === "1") {
          debugLog("session", "Skipping - non-interactive mode")
          return
        }

        if (!trellis.isTrellisProject()) {
          debugLog("session", "Skipping - not a Trellis project")
          return
        }

        const messages = event?.messages
        if (!Array.isArray(messages)) return

        // The V2 `context` hook fires once per model request — including every
        // tool-driven continuation — over a reused messages array. Without this
        // guard the same context block would be prepended repeatedly within one
        // turn, once per model call.
        if (messageAlreadyHasMarkerV2(messages, SESSION_CONTEXT_MARKER)) {
          debugLog("session", "Skipping - session context already present this turn")
          return
        }

        let context = buildSessionContext(trellis, {
          sessionID: event.sessionID,
          agent: event.agent,
        })
        if (!context) return

        if (hasAssistantMessageV2(messages)) {
          context = stripFirstReplyNotice(context)
        }

        debugLog("session", "Built context, length:", context.length)
        prependTextToUserMessageV2(messages, context)
      } catch (error) {
        debugLog(
          "session",
          "Error in context hook:",
          error instanceof Error ? error.message : String(error),
          error instanceof Error ? error.stack : "",
        )
      }
    })
  },
}
