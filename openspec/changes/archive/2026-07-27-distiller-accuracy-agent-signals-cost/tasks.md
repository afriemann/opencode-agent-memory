# Tasks: distiller-accuracy-agent-signals-cost

## Component 1 — Distiller Prompt Precedence Rule

- [x] **1.1** Add `## PRIOR vs SIGNALS` section to `src/prompts/distiller.md`:
  - State that SIGNALS represent the most recent session state
  - Where SIGNALS describe an approach that *conflicts with or supersedes* PRIOR's stated approach, the distiller MUST favour SIGNALS
  - PRIOR content about domains that SIGNALS do not address MUST be preserved as valid background context
  - This is a contradiction rule, not an absence rule: silence ≠ abandonment

- [x] **1.2** Write failing tests for `distiller-accuracy` scenarios:
  - "SIGNALS contradict PRIOR approach" — assert distil output does not carry forward the PRIOR approach
  - "PRIOR content not addressed by SIGNALS is preserved"
  - "SIGNALS that expand on PRIOR are merged"
  (Tests are at the prompt level via the distil integration path or by mocking the LLM call)

## Component 2 — Agent Message Capture

- [x] **2.1** Add named constant `MAX_AGENT_SIGNALS = 10` to `src/lib/signal-utils.js` alongside `MAX_SIGNALS_PER_KIND`

- [x] **2.2** Update `reduceSignals` in `src/lib/signal-utils.js` to add an explicit `agent` kind branch:
  - Select the most recent `MAX_AGENT_SIGNALS` signals of `kind='agent'`
  - Applied independently of the `MAX_SIGNALS_PER_KIND` cap for other kinds

- [x] **2.3** Update `makeBuffer()` in `src/plugin.js` to include `agentMessages: []`

- [x] **2.4** Update `bufferIsEmpty()` in `src/plugin.js` to return `false` when `agentMessages` is non-empty

- [x] **2.5** Add `assistant` role branch to the `message.updated` handler in `src/plugin.js`:
  - Gate: `msgInfo.role === 'assistant' && msgInfo.finish && body.length >= 50`
  - Extract body by joining `text`-type parts (or `msgInfo.text`), truncate to 400 chars from start
  - Push to `buf.agentMessages` for that session

- [x] **2.6** Include `agentMessages` in the buffer flush delta sent to `cmdAccrue` in `src/plugin.js`

- [x] **2.7** Update `cmdAccrue` in `src/memory.js` to handle `delta.agentMessages`:
  - Insert each entry as `kind='agent'` into `memory_signal`

- [x] **2.8** Write failing tests for `signal-processing` agent scenarios:
  - "Completed assistant message is captured"
  - "In-progress assistant message is not captured" (no `finish`)
  - "Short assistant message is not captured" (body < 50 chars)
  - "Agent message body truncated to 400 chars"
  - "Buffer with only agent messages is not considered empty"
  - "Flush includes agentMessages in delta"
  - "Agent signals capped at MAX_AGENT_SIGNALS"
  - "Agent cap is independent of other kinds"
  - "Agent signals appear as [agent] in the distiller prompt"

## Component 3 — Distillation Cost Tracking

- [x] **3.1** Add schema migration in `src/lib/schema.js` after existing migrations:
  ```sql
  ALTER TABLE hot_state ADD COLUMN distil_cost_usd REAL;
  ALTER TABLE hot_state ADD COLUMN distil_tokens_in INTEGER;
  ALTER TABLE hot_state ADD COLUMN distil_tokens_out INTEGER;
  ```
  Each wrapped in a separate `try/catch` (idempotent — no-op on already-migrated DB)

- [x] **3.2** Capture cost and tokens in `distilSession()` in `src/plugin.js`:
  - After the `json_schema` call succeeds: extract `res.data.info.cost`, `res.data.info.tokens.input`, `res.data.info.tokens.output`
  - If `json_schema` fails and text fallback succeeds: extract from `res2.data.info` instead
  - Pass `distilCostUsd`, `distilTokensIn`, `distilTokensOut` in the `distil-write` payload

- [x] **3.3** Update `cmdDistilWrite` in `src/memory.js`:
  - Accept `distilCostUsd`, `distilTokensIn`, `distilTokensOut` from payload (default `null` if absent)
  - Include these in the UPSERT INSERT and DO UPDATE SET clauses

- [x] **3.4** Update `cmdInspect` SELECT in `src/memory.js` to include `distil_cost_usd`, `distil_tokens_in`, `distil_tokens_out` from `hot_state`

- [x] **3.5** Write failing tests for `memory-store` and `memory-inspect` cost scenarios:
  - "distil-write stores cost and token counts"
  - "distil-write without cost data leaves columns NULL"
  - "Migration runs on existing database"
  - "Migration is idempotent"
  - "Inspect output contains cost fields when distil recorded them"
  - "Inspect output contains null cost fields for legacy rows"

## Verification

- [x] **V.1** Run full test suite — all existing tests pass, all new scenario tests pass
- [ ] **V.2** Run linter — zero new lint errors
- [ ] **V.3** Manually verify `memory_state_inspect` output includes cost fields after a live distillation
