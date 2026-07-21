# memory-inspect Specification

## Purpose
TBD - created by archiving change agent-memory-management-tool. Update Purpose after archive.
## Requirements
### Requirement: inspect returns hot_state and pending signals without modifying any row

The system SHALL return the current `hot_state` row (all fields) and all `memory_signal` rows for the given `(agent, project)` scope when `inspect` is invoked, and SHALL NOT insert, update, or delete any row in any table as a side-effect.

#### Scenario: Hot state and signals both exist
- **GIVEN** a `hot_state` row and one or more `memory_signal` rows exist for the given agent/project scope
- **WHEN** `node memory.js inspect <agent> <project>` is invoked
- **THEN** stdout contains a JSON object `{ prior: <hot_state row>, signals: [<signal rows>] }` with all fields present

#### Scenario: Cold start — no hot_state row
- **GIVEN** no `hot_state` row exists for the given agent/project scope
- **WHEN** `node memory.js inspect <agent> <project>` is invoked
- **THEN** stdout contains `{ prior: null, signals: [] }` (or the signals array populated if any signals exist)

#### Scenario: Hot state exists but no pending signals
- **GIVEN** a `hot_state` row exists but no `memory_signal` rows are pending for the scope
- **WHEN** `node memory.js inspect <agent> <project>` is invoked
- **THEN** stdout contains `{ prior: <hot_state row>, signals: [] }`

#### Scenario: No rows are inserted, updated, or deleted by inspect
- **GIVEN** any combination of `hot_state`, `memory_signal`, and `distil_watermark` rows
- **WHEN** `node memory.js inspect <agent> <project>` is invoked
- **THEN** no row is inserted, updated, or deleted in any of the three tables

### Requirement: memory_inspect plugin tool delegates to the inspect CLI subcommand using TARGET_AGENT

The `memory_inspect` registered tool SHALL resolve the calling session's agent via `resolveSessionAgent(context.sessionID)`. When null is returned (session not tracked), the tool SHALL return an informative `ToolResult` without making any CLI call (per the plugin-lifecycle not-tracked contract). When an agent is resolved, the tool SHALL invoke `spawnMemory($, ['inspect', agent, directory])` using that agent and the `directory` from `ToolContext`, and SHALL return the result as a `ToolResult` without propagating exceptions into the opencode host. The tool's output SHALL include an `active_primer` field containing the primer text currently cached in the `primers` Map for the calling session's ID, or `null` if no primer was loaded.

#### Scenario: Tool invoked for a tracked agent with existing memory

- **GIVEN** the calling session's agent is a member of `TARGET_AGENTS` AND a `hot_state` row exists for the agent/project
- **WHEN** the agent calls the `memory_inspect` tool
- **THEN** the tool returns the hot state summary, signal list, and `active_primer` set to the cached primer text

#### Scenario: Tool invoked on a cold start

- **GIVEN** the calling session's agent is a member of `TARGET_AGENTS` AND no `hot_state` row exists for the agent/project
- **WHEN** the agent calls the `memory_inspect` tool
- **THEN** the tool returns a cold-start result with `active_primer: null` and does not throw

#### Scenario: active_primer reflects in-process cache, not DB

- **GIVEN** a primer was loaded at session start and cached in the `primers` Map
- **WHEN** the agent calls `memory_inspect`
- **THEN** `active_primer` contains the exact assembled primer text that the system transform hook is injecting into the system prompt

#### Scenario: Underlying CLI failure

- **GIVEN** the `inspect` CLI call fails (e.g. DB locked)
- **WHEN** the agent calls the `memory_inspect` tool
- **THEN** the tool returns an informative error result and does not propagate an unhandled rejection into the opencode host

### Requirement: assemblePrimer produces passive background-context framing

The `assemblePrimer` function in `src/lib/signal-utils.js` SHALL produce primer text that uses passive, non-imperative language throughout. The output SHALL:
- Open with a header that identifies the block as "background context" and states that no action is required.
- Label the next-action field as "Suggested next step" (not "Next action").
- Contain no instruction directing the agent to investigate the codebase, reconcile state, or perform any action before receiving a user request.

#### Scenario: Primer header is passive
- **WHEN** `assemblePrimer` is called with any prior record
- **THEN** the returned string contains a header phrase that includes "background context" or equivalent passive framing and does not include an imperative verb directed at the agent

#### Scenario: Next-action field uses suggested-step framing
- **WHEN** `assemblePrimer` is called with a prior record where `next_action` is non-empty
- **THEN** the returned string includes "Suggested next step" (case-insensitive) and does not include "Next action:"

#### Scenario: No investigation instruction in primer
- **WHEN** `assemblePrimer` is called with any prior record
- **THEN** the returned string does not contain phrases like "reconcile", "replay your understanding", or "get my confirmation"

