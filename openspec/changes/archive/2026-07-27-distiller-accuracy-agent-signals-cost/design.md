# Design: Distiller Accuracy, Agent Signals, Cost Tracking

Three independent improvements bundled in one change. All are additive; none break existing signal flow or the hot_state read path.

---

## Component 1 — Distiller Prompt Precedence Rule

**Files:** `src/prompts/distiller.md` only.

**Decision:** Add a `## PRIOR vs SIGNALS` section stating that SIGNALS take precedence over PRIOR where they conflict, but silence in SIGNALS is not abandonment.

| Decision | Rationale | Alternative considered |
|---|---|---|
| Contradiction rule, not absence rule | SIGNALS only capture activity that triggers keyword or role gates — they don't explicitly negate everything PRIOR mentions. Treating absence as abandonment would drop valid background context. | Treat every PRIOR item not in SIGNALS as stale → unacceptable false-negative rate on background facts. |
| Textual rule in the prompt, not code logic | The conflict is an LLM judgement call; a hard deduplicate in code would require structured comparison that doesn't exist. The prompt is the right place. | Parse both sections and diff programmatically → brittle, not worth the complexity for what is a semantic rather than syntactic conflict. |

**Invariant:** PRIOR content that SIGNALS are silent about must survive into the summary unchanged.

---

## Component 2 — Agent Message Capture

**Files:** `src/plugin.js`, `src/memory.js`, `src/lib/signal-utils.js`.

### Data Flow

```
message.updated (assistant role)
  → gate: msgInfo.finish truthy AND body.length >= 50
  → extract: parts text (or msgInfo.text), truncate to 400 chars from start
  → push to buf.agentMessages[]
  → bufferIsEmpty() checks agentMessages alongside files/todos/messages

flush (session idle)
  → agentMessages[] included in delta sent to cmdAccrue
  → cmdAccrue inserts rows: kind='agent', content=text

reduceSignals (distil-time)
  → agent kind branch: cap at MAX_AGENT_SIGNALS = 10
  → formatted as [agent] prefix in distiller prompt (same pattern as [message])
```

### Design Decisions

| Decision | Rationale | Alternative considered |
|---|---|---|
| Gate on `msgInfo.finish` | `message.updated` fires multiple times per streaming turn. `finish` is only set at `session.next.step.ended`, giving exactly one event per completed assistant turn. | Deduplicate by message ID in-memory → adds state, fragile if IDs reused across sessions. |
| `MAX_AGENT_SIGNALS = 10`, independent of `MAX_SIGNALS_PER_KIND = 20` | Agent messages are typically longer and higher-signal than user corrections; a smaller cap keeps prompt size bounded while capturing the last 10 decisions. | Use same cap as other kinds → risks crowding out user corrections if assistant is verbose. |
| Truncate to 400 chars from the **start** | Opening of an assistant turn contains the decision framing; trailing detail matters less for distillation. | Truncate from the end → loses the conclusion, which is what the distiller needs. |
| `kind='agent'` in `memory_signal` | Distinct kind enables independent capping in `reduceSignals` and clear labeling in the distiller prompt without changing the existing schema. | Reuse `kind='message'` with a sub-tag → complicates the cap logic. |

**Invariant:** `bufferIsEmpty()` must return `false` whenever `agentMessages` is non-empty, even if all other fields are empty. Flush must not skip a buffer that contains only agent messages.

---

## Component 3 — Distillation Cost Tracking

**Files:** `src/plugin.js`, `src/memory.js`, `src/lib/schema.js`.

### Schema Migration

```sql
ALTER TABLE hot_state ADD COLUMN distil_cost_usd REAL;
ALTER TABLE hot_state ADD COLUMN distil_tokens_in INTEGER;
ALTER TABLE hot_state ADD COLUMN distil_tokens_out INTEGER;
```

Each `ALTER TABLE` is wrapped in a separate `try/catch` per the existing migration pattern in `schema.js` (idempotent — re-running on an already-migrated DB is safe).

### Design Decisions

| Decision | Rationale | Alternative considered |
|---|---|---|
| Store most-recent distil cost only (not cumulative) | `hot_state` is a single-row UPSERT; cumulative tracking would require a separate table. Operator decision: per-distil snapshot is sufficient for prompt-sizing diagnostics. | Append to a `distil_log` table → useful but out of scope for this change. |
| Capture from whichever `session.prompt()` call succeeds (json_schema first, text fallback) | Only one call produces a valid result; summing both would double-count on retry. | Always capture both and sum → inflates costs on the happy path if json_schema is also counted. |
| `cmdInspect` SELECT lists columns explicitly including the three new ones | Project avoids `SELECT *`; explicit column list is already the pattern. | Add `*` → violates project convention. |
| No change to the tool layer | `memory_state_inspect` passes `cmdInspect` output through as-is; new fields appear automatically once `cmdInspect` includes them. | Add explicit field mapping in the tool → unnecessary indirection. |

**Invariant:** All three new columns are nullable. A `hot_state` row written by an older version of `cmdDistilWrite` (missing these columns) must still be readable by `cmdInspect` without error; the inspect output may omit or show `null` for the cost fields.

---

## Cross-Cutting Constraints

- No new npm dependencies.
- The `agent` kind cap (`MAX_AGENT_SIGNALS`) is defined as a named constant alongside `MAX_SIGNALS_PER_KIND`; no magic numbers.
- The `[agent]` label in the distiller prompt must be consistent with the existing `[message]` label format — same bracket style, same position relative to the signal text.
- Cost fields propagated through `cmdDistilWrite` are passed as-is from `res.data.info`; no rounding or reformatting at the plugin layer.
