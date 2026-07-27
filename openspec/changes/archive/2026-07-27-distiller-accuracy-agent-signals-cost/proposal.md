## Why

The distillation system has two independent accuracy bugs that cause the agent to give wrong recaps at session start. First, the distiller prompt blends PRIOR (previous hot_state summary) with SIGNALS (captured events) without a precedence rule, allowing abandoned approaches to re-surface as current plans — a real failure seen in practice with `acpi_osi` vs SSDT. Second, agent (assistant) messages are completely invisible to the signal capture system: only keyword-matched user corrections are captured, while decisive agent choices ("we ruled out X, going with Y") leave no signal trace at all.

Additionally, each distillation triggers an LLM API call but records no metadata about it. Storing cost and token counts per distil would allow operators to track spend and reason about prompt sizing — a useful diagnostic given that signal capture is about to grow.

## What Changes

- **Distiller prompt** (`src/prompts/distiller.md`): add a `PRIOR vs SIGNALS precedence` section. SIGNALS represent the most recent session state. Where SIGNALS describe an approach that conflicts with or supersedes what PRIOR states (e.g. PRIOR says "trying X", SIGNALS show work on Y instead), SIGNALS take precedence. PRIOR content about domains not addressed at all by SIGNALS remains valid background context and must not be dropped.
- **Agent message capture** (`src/plugin.js`, `src/memory.js`, `src/lib/signal-utils.js`): on `message.updated`, capture assistant responses that have `finish` set (i.e. completed, not mid-stream) and body ≥50 chars, truncated to 400 chars, as `agent` kind signals, with an independent cap of 10, so the distiller sees recent agent decisions alongside user corrections. The `finish` gate ensures exactly one signal per completed assistant turn regardless of how many streaming updates fire. `makeBuffer()` and `bufferIsEmpty()` are updated to include `agentMessages`.
- **Distillation cost tracking** (`src/plugin.js`, `src/memory.js`, `src/lib/schema.js`): read `res.data.info.cost` and `res.data.info.tokens` from the existing `session.prompt()` response (currently discarded), store per-distil cost and token counts in `hot_state`, and expose them via `memory_state_inspect`.

## Capabilities

### New Capabilities

- `distiller-accuracy`: Behavior contract for the distiller prompt's PRIOR vs SIGNALS precedence rule — SIGNALS represent current reality; PRIOR items absent from SIGNALS must be treated as abandoned.

### Modified Capabilities

- `signal-processing`: Add `agent` kind signal capture in the buffer and accrue path; `reduceSignals` gets an independent `MAX_AGENT_SIGNALS` cap for `agent` kind signals.
- `memory-store`: `hot_state` schema gains three nullable columns (`distil_cost_usd REAL`, `distil_tokens_in INTEGER`, `distil_tokens_out INTEGER`) populated on each `distil-write`.
- `memory-inspect`: `inspect` CLI output and `memory_inspect` tool output include the new distil cost/token fields from the `hot_state` row.

## Impact

- `src/prompts/distiller.md` — prompt text; no runtime call-site changes
- `src/plugin.js` — `message.updated` handler (agent capture) + cost/token extraction in `distilSession`
- `src/memory.js` — `cmdAccrue` (new `agentMessages` delta key), `cmdDistilWrite` (new columns), `cmdInspect` (pass-through of new fields)
- `src/lib/signal-utils.js` — `reduceSignals` agent kind with independent cap
- `src/lib/schema.js` — migration to add three nullable columns to `hot_state`
- No new npm dependencies; no infrastructure or configuration changes
