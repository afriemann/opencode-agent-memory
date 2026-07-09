## Why

The memory primer is currently injected via `session.prompt({ noReply: true })`, which places it in the chat thread as a second message immediately after session start. Because the message uses imperative language ("Next action: …", "reconcile against the current code and git state, and get my confirmation first"), the agent treats it as a command and enters an investigation loop before the user has sent a single message. Moving injection to the system prompt places the memory in the background-context register — where it is orientation material, not a directive — eliminating the spurious action trigger.

Additionally, once the primer is invisible in the chat thread there is no way to inspect what was actually injected during a session. A logging event and an extension to the existing `memory_inspect` tool are required to restore that observability.

## What Changes

- Replace the `session.prompt({ noReply: true })` injection call with an `experimental.chat.system.transform` hook that appends the assembled primer to the system prompt on every LLM call for sessions that have a cached prior memory record.
- Refactor `injectPrimer` into a load-and-cache function (`loadMemoryForSession`) that reads the DB, assembles the primer, and stores it in an in-process `primers` Map keyed by session ID — without calling `session.prompt`.
- Rewrite `assemblePrimer` in `src/lib/signal-utils.js`: remove all imperative language, rename `"Next action:"` to `"Suggested next step:"`, drop the investigation-triggering last paragraph, and add a clear passive header ("background context — no action required").
- Emit a `[agent-memory] primer loaded` log line (via the existing `log` helper) when a primer is cached for a session, including session ID, project shortname, and primer char-count.
- Extend `memory_inspect` to include an `active_primer` field in its output: the primer text currently cached for the session, or `null` if none was loaded.

## Capabilities

### New Capabilities

*(none — all changes modify existing capabilities)*

### Modified Capabilities

- `plugin-lifecycle`: The injection mechanism changes from `session.prompt` to `experimental.chat.system.transform`; the `session.created` and `message.updated` fallback handlers now populate an in-memory cache rather than calling `session.prompt`. The `injected` / `priming` Sets are replaced or repurposed.
- `memory-inspect`: The tool's output contract gains a new `active_primer` field (`string | null`).

## Impact

- `src/plugin.js` — primary change: new hook, refactored `injectPrimer`, new `primers` Map, extended `memory_inspect` execute function, console log on load.
- `src/lib/signal-utils.js` — `assemblePrimer` rewrite (framing and tone only; four-field structure unchanged).
- `test/plugin-safety.test.js` — update or add tests for the new injection path and the absence of `session.prompt` calls at startup.
- `test/memory-inspect-correct.test.js` — add assertions for the `active_primer` field.
- No DB schema changes. No CLI changes. No breaking change to the `memory_inspect` JSON shape (additive only).
