/**
 * Trellis V2 message helpers (OpenCode v2 `session.hook("context")` shape).
 *
 * V1 plugins used `experimental.chat.messages.transform` with
 * `{ info: { role, sessionID, agent }, parts: [...] }` messages (see
 * `context-visibility.js`). V2 `context` hook events carry
 * `{ sessionID, agent, model, system, messages, options, tools }` where
 * `messages` are `{ id, role, content: [{ type, text, ... }], metadata? }`
 * and `system` is `[{ type: "text", text }]`.
 *
 * Mutations here affect only the outgoing model call, never persisted
 * history — the same guarantee V1 relied on (issue #553).
 */

/** Name of the V2 session hook that replaces `experimental.chat.messages.transform`. */
export const V2_CONTEXT_HOOK = "context"

/** Index of the last `role === "user"` message, or -1. */
export function findLastUserMessageIndex(messages) {
  if (!Array.isArray(messages)) return -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i
  }
  return -1
}

function textOfPart(part) {
  if (!part || typeof part !== "object") return ""
  if (typeof part.text === "string") return part.text
  return ""
}

function contentParts(message) {
  const content = message?.content
  if (Array.isArray(content)) return content
  if (typeof content === "string") return [{ type: "text", text: content }]
  return []
}

/** Plain text of the last user message (joined text parts), or "". */
export function lastUserTextV2(messages) {
  const index = findLastUserMessageIndex(messages)
  if (index < 0) return ""
  return contentParts(messages[index])
    .filter((part) => part?.type === "text")
    .map(textOfPart)
    .join("\n")
}

/** True when the transcript already contains an assistant message. */
export function hasAssistantMessageV2(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some((message) => message?.role === "assistant")
}

/**
 * True when the last user message already contains `marker`
 * (per-dispatch dedup: the V2 `context` hook can fire several times per
 * turn over a reused messages array, so re-injection must be skipped).
 */
export function messageAlreadyHasMarkerV2(messages, marker) {
  if (!marker) return false
  const index = findLastUserMessageIndex(messages)
  if (index < 0) return false
  const text = contentParts(messages[index])
    .filter((part) => part?.type === "text")
    .map(textOfPart)
    .join("\n")
  return text.includes(marker)
}

/**
 * Prepend an ephemeral `{ type: "text", text }` part to the last user
 * message. The message object itself is mutated in place (the V2 event
 * payload is a per-dispatch working copy); nothing is persisted.
 * Returns false when there is no user message to attach to.
 */
export function prependTextToUserMessageV2(messages, text) {
  if (!Array.isArray(messages)) return false
  if (typeof text !== "string" || !text) return false
  const index = findLastUserMessageIndex(messages)
  if (index < 0) return false
  const message = messages[index]
  if (Array.isArray(message.content)) {
    message.content.unshift({ type: "text", text })
    return true
  }
  if (typeof message.content === "string") {
    message.content = [
      { type: "text", text },
      { type: "text", text: message.content },
    ]
    return true
  }
  message.content = [{ type: "text", text }]
  return true
}
