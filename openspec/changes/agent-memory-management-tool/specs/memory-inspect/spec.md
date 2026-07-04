## ADDED Requirements

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

The `memory_inspect` registered tool SHALL invoke `spawnMemory($, ['inspect', TARGET_AGENT, directory])` using `TARGET_AGENT` (the plugin-configured agent dimension) and the `directory` from `ToolContext`, and SHALL return the result as a `ToolResult` without propagating exceptions into the opencode host.

#### Scenario: Tool invoked for an agent with existing memory
- **GIVEN** a `hot_state` row and signals exist for the calling session's agent/project
- **WHEN** the agent calls the `memory_inspect` tool
- **THEN** the tool returns the hot state summary and signal list

#### Scenario: Tool invoked on a cold start
- **GIVEN** no `hot_state` row exists for the calling session's agent/project
- **WHEN** the agent calls the `memory_inspect` tool
- **THEN** the tool returns a cold-start result and does not throw

#### Scenario: Underlying CLI failure
- **GIVEN** the `inspect` CLI call fails (e.g. DB locked)
- **WHEN** the agent calls the `memory_inspect` tool
- **THEN** the tool returns an informative error result and does not propagate an unhandled rejection into the opencode host
