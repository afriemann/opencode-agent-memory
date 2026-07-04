## ADDED Requirements

### Requirement: correct applies a partial patch to hot_state in a single transaction

The system SHALL read the current `hot_state` row, merge the caller-supplied field patch onto it, and UPSERT the merged record — all within one SQLite transaction — when `correct` is invoked. Fields not present in the patch SHALL retain their current values.

#### Scenario: Single-field patch updates only that field
- **GIVEN** a `hot_state` row with `last_worked_summary = "S"`, `next_action = "N"`, `open_questions = ["Q"]`, and `adr_candidate = null`
- **WHEN** `node memory.js correct <agent> <project> '{"next_action":"N2"}'` is invoked
- **THEN** the stored `hot_state` has `next_action = "N2"` and all other fields (`last_worked_summary`, `open_questions`, `adr_candidate`) are unchanged

#### Scenario: Correct on a cold start inserts a new row
- **GIVEN** no `hot_state` row exists for the given agent/project scope
- **WHEN** `correct` is invoked with a patch
- **THEN** a new `hot_state` row is inserted containing the supplied fields; absent fields default to their empty-record values

#### Scenario: Malformed JSON patch is rejected
- **GIVEN** any database state
- **WHEN** `node memory.js correct <agent> <project>` is called with a non-JSON third argument
- **THEN** the process exits with a non-zero code and an error message on stderr; no database row is changed

### Requirement: correct always writes updated_at strictly greater than the current stored value

The system SHALL derive `updated_at = current_updated_at + 1` within the correction transaction, ensuring the existing `distil-write` monotonic UPSERT guard is always satisfied without requiring a wall-clock timestamp.

#### Scenario: Correction timestamp exceeds current stored value
- **GIVEN** a `hot_state` row with `updated_at = T`
- **WHEN** `correct` is invoked for that scope
- **THEN** the written `hot_state` row has `updated_at = T + 1`

### Requirement: correct does not delete signals or advance the watermark

The system SHALL NOT delete any `memory_signal` rows or advance any `distil_watermark` entry as a side-effect of a correction — unlike `distil-write`, which does both.

#### Scenario: Signals and watermarks are preserved after correct
- **GIVEN** `memory_signal` rows and a `distil_watermark` row exist for the session/scope
- **WHEN** `correct` is invoked
- **THEN** all `memory_signal` rows and the `distil_watermark` row are unchanged

### Requirement: memory_correct plugin tool delegates to the correct CLI subcommand

The `memory_correct` registered tool SHALL invoke `spawnMemory($, ['correct', agent, directory, patchJson])` using the scope from `ToolContext`, and SHALL return a `ToolResult` without propagating exceptions into the opencode host.

#### Scenario: Tool applies a correction for the calling session's scope
- **GIVEN** a `hot_state` row exists for the calling session's agent/project
- **WHEN** the agent calls `memory_correct` with a partial patch
- **THEN** the specified field is updated and all other fields are preserved

#### Scenario: Underlying CLI failure
- **GIVEN** the `correct` CLI call fails (e.g. DB locked or malformed patch)
- **WHEN** the agent calls the `memory_correct` tool
- **THEN** the tool returns an informative error result and does not propagate an unhandled rejection into the opencode host
