# External API Integration Thinking Guide

> **Purpose**: Think before wiring up or maintaining a third-party HTTP API.
> Concrete contract lives in `.trellis/spec/adapters/` — this guide is only about
> what to *consider*.

> **Source**: every item below was paid for with a real incident in
> `.trellis/tasks/09-26-opencode-console-spa/` (2026-09-26, opencode console
> rewritten as a client-side SPA). The failure modes are generic; the endpoint
> names are not.

---

## Step 1: Is this endpoint actually the one you want?

**Trigger**: you picked an endpoint from documentation, a generated client,
a scraped JS bundle, or a previous version of someone's code.

```bash
# Open the real product page in a window and record what IT requests.
node scripts/opencode-go-page-capture.js
```

> **Warning**: A bundle's API declaration proves an endpoint *exists*. It does
> **not** prove it carries the data you need.
>
> Real example: `/console/api/usage/summary` was declared in the bundle and
> annotated "stable", but its body was usage *aggregates*
> (`totalCostMicroCents`, tokens) with **no `percent` / `limit` / `resetsAt`**.
> The window quotas lived in `/console/api/go/status`, which we only found by
> watching the real page. Three hours of design would have been written against
> the wrong endpoint.

**Also ask**: which direction is the authority? A server-supplied limit beats a
constant in your code. If your code still hardcodes `$12 / $30 / $60`, find out
whether the server will tell you and stop trusting the constant.

---

## Step 2: Don't trust a label — verify the mechanism

**Trigger**: a script, test, or doc says "实测" / "verified" / "official".

```bash
# Does it actually make a request? Grep for the thing that talks to the network.
grep -n "fetch\|axios\|http" scripts/whatever.mjs
```

> **Real example**: `scripts/verify-opencode.mjs` had a comment reading
> `// ── 2. 官方 API 响应（实测）` above a hard-coded object literal whose
> `resetsAt` values were two weeks stale. The script never opened a socket.
> We reported "the official API is fine" on the strength of it. It returned 403.

Corollary: a frozen fixture is fine **as a fixture**. It is not evidence about
the live system. Label it as such.

---

## Step 3: When the contract changes, find out which parts are gone

A rewritten page does not fail loudly. It returns *something*. Map the old
shape to the new one field by field, and mark each field:

| New reality | What to do | Why |
|---|---|---|
| Field still exists | wire it | — |
| Field has no source in the new API | **delete it**, don't zero it | `quota: 0` renders as `$0 / 0%` — a lie |
| Value is now server-supplied, not computed | prefer it | `used = percent × limit` is a guess; the server knows |
| Concept renamed (`workspace` → `org`) | accept **both** id prefixes | new sites hand out the new prefix while old data keeps the old |

Emit an "I saw a shape I don't recognise" signal. `parseGoStatus` returns
`unknownMeters`; the adapter logs it. Without it, a partial rename silently
produces a snapshot that looks fine and is quietly wrong.

---

## Step 4: 口径 mismatch — refuse, don't approximate

**Trigger**: you have a value for the right *concept* but the wrong *window*.

```ts
// WRONG — labels 24h data as the 5-hour window.
const MODELS_RANGES = { rolling: '24h', weekly: '7d', monthly: '30d' }

// RIGHT — the 5-hour window gets no detail table at all.
const MODELS_RANGES = { weekly: '7d', monthly: '30d' }
```

A missing table the user notices is better than a plausible table that is wrong.
This repo has been bitten before (`TASKS.md`: "官方源不可达时退回本机统计，与官方
口径不同却用同一套视觉展示").

Same rule for percentages: **if you know spend but cannot compute a ratio, say
"unavailable"**. Do not report 0% — 0% is a claim.

---

## Step 5: Provenance labels follow the data, not the feature

**Trigger**: you changed where a number comes from but not the label near it.

```tsx
// WRONG — tokens now come from the server, the label still says "local machine".
<span className="model-tokens">本机 {fmtAmount(m.tokens, 'token')}</span>

// RIGHT — derive from the row's own `source`.
<span className="model-tokens">
  {m.source === 'console' ? '服务端' : '本机'} {fmtAmount(m.tokens, 'token')}
</span>
```

Search for every string that names a data source when you change where data comes
from. `grep -rn "本机\|官方" src/renderer/` is cheap.

---

## Step 6: Diagnostic tools must share the product's resolution path

**Trigger**: a QA/diagnostic command reads a credential, config key, or store
namespace that the product resolves differently.

```ts
// WRONG — setKey writes to `items`, getExtra reads from `extras`. Always null.
const cookie = (await getExtra('opencodeCookie')) ?? ''

// RIGHT — same order as the product: live session first, saved second, same accessor.
const cookie = (await readPartitionCookie()) ?? (await getKey('opencodeCookie')) ?? ''
```

Symptom of getting this wrong: "the tool says not configured" while the app
works fine. Nine times out of ten the tool is wrong, not the credential.

---

## Step 7: Concurrency to the same host is a reliability decision

**Trigger**: two or more requests to one host fired with `Promise.all`, and
occasionally one fails with a connection-layer error (`fetch failed`).

Observed: parallel range requests intermittently dropped one whole window of
data — invisible in the UI except as "that window has no model table".

```ts
// Sequential + one retry. ~1.4s total either way; the retry costs far less
// than losing a window. Don't retry 401/403 — those are session problems.
for (const range of ranges) {
  rows[range] = await fetchRangeOnce(range) ?? (await fetchRangeOnce(range)) ?? []
}
```

Also: keep a failure **log**. An empty result and "genuinely no data" render
identically.

---

## Step 8: Verify the guard can fail

**Trigger**: you just added a test for a rule you believe matters.

```bash
node scripts/test-ssr-parser.mjs     # baseline: all green
# ...invert the rule, the wrong literal, the wrong key...
node scripts/test-ssr-parser.mjs     # must now FAIL
```

> **Warning**: A test suite that has never been observed failing is not evidence.
> In this task an independent reviewer inverted six behaviours (concurrency,
> retry, mandatory header, key mapping, server-side tokens, range table) and
> **all 49 assertions stayed green**. The suite was real, just blind to the
> orchestration layer — it only covered pure parsers.

Prefer testing the real module over a copy. See
`.trellis/spec/adapters/opencode-console.md` §6 for the two traps found here:
a test that inlined its own copy of the implementation, and tests that loaded
real source but still missed everything above the parser.

---

## Step 9: Verify from the layer that actually makes the request

**Problem.** Three rounds of "实测 confirmed the TTS service returns 200 / 1.4 s / valid MP3"
— all done with `curl` against the endpoint. The feature had never worked once. The renderer's
CSP (`connect-src 'self' data: blob: bd-asset:`) blocks every outbound `fetch` from the page, so
the request was rejected by the browser *before* it left the process and surfaced only as
`TypeError: Failed to fetch`.

**Why it's bad:** `curl` and the app do not share a security context. `curl` is not subject to
CSP, does not run in an origin, and does not go through IPC. Verifying with it proves the
*service* is up — it says nothing about whether *this code path* can reach it. The more
thoroughly you verify at the wrong layer, the more confident (and wrong) you become: the
symptom was mis-attributed to rate limiting, stale flags, and copy, and three fixes shipped on
a foundation that could never have worked.

**Instead:**
- Identify the process/layer that performs the request. Test *there*.
  - renderer → check `connect-src` in CSP first; if the host isn't allowed, nothing else matters
  - main process → CSP doesn't apply, but IPC shape, scheme allow-lists, and timeouts do
- For cross-layer IPC, prove the payload type survives the hop (an `ArrayBuffer` over Electron's
  structured clone is a real risk, not a formality) with a minimal harness in `/tmp` that uses the
  *same* handler shape as production.
- Keep labels honest: 「服务可用」and「应用能用到它」are different claims. Write down which one
  you measured.

**Corollary — a layered symptom set can be one root cause.** "提示不可达 + 点了没反应" looked
like two bugs (sticky flag, swallowed clicks). Both were downstream of a request that could never
leave the process. When several symptoms resist separate explanations, look for the shared
prerequisite before fixing any of them.

---

## Checklist

- [ ] Confirmed the endpoint by observing the real product, not by reading docs
- [ ] Checked the "verified"/"实测" label actually has a mechanism behind it
- [ ] Mapped old fields → new, and deleted the ones with no source
- [ ] Established which side is authoritative for limits/values
- [ ] Refused to approximate any 口径 mismatch; left it absent instead
- [ ] Updated every provenance label that named a source
- [ ] Diagnostic path resolves credentials identically to the product path
- [ ] Sequential + retry if concurrent requests to one host dropped data
- [ ] Broke the new tests on purpose and watched them fail
- [ ] Verified from the layer that actually issues the request (not from `curl`, not from a copy)
- [ ] If the layer is a renderer, read its CSP before anything else
