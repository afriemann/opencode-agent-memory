# memory-distil-force Specification

## Purpose
TBD - created by archiving change agent-memory-management-tool. Update Purpose after archive.
## Requirements
### Requirement: memory_distil_force plugin tool triggers an immediate distil bypassing only the throttle

The `memory_distil_force` registered tool SHALL call `doDistil(sessionId, { force: true })` for the session identified by `ToolContext.sessionID`, bypassing the `DISTIL_MIN_INTERVAL_MS` throttle early-return while leaving every other step of the distil path (ephemeral-session creation, signal reduction, LLM call, `distil-write` with monotonic guard) intact.

#### Scenario: Force distil while within the throttle window
- **GIVEN** fewer than `DISTIL_MIN_INTERVAL_MS` milliseconds have elapsed since the last idle-path distil for the session
- **WHEN** the agent calls `memory_distil_force`
- **THEN** a distillation pass is initiated and completes for that session

#### Scenario: Force distil with no prior distil
- **GIVEN** no prior distil has been run for the session
- **WHEN** the agent calls `memory_distil_force`
- **THEN** a distillation pass is initiated and completes for that session

#### Scenario: Tool execution error is caught and returned as a ToolResult
- **GIVEN** the distil pass fails internally (e.g. LLM call throws)
- **WHEN** the agent calls `memory_distil_force`
- **THEN** the tool returns an informative error result and does not propagate an unhandled rejection into the opencode host

### Requirement: memory_distil_force SHALL share the distil watermark path but MUST NOT change the idle-throttle interval

A forced distil SHALL run the identical `distil-write` path as the idle distil and therefore advances `last_distil_ms` in the per-session watermark. The idle-path throttle logic and `DISTIL_MIN_INTERVAL_MS` interval are otherwise unchanged: the idle path continues to compare `now - lastDistilMs` against the same constant, regardless of whether the last write was forced or idle.

#### Scenario: Idle distil is subject to the throttle after a forced distil
- **GIVEN** a forced distil completed at time `T_force` (advancing `last_distil_ms = T_force`)
- **WHEN** `session.idle` fires at `T_force + DISTIL_MIN_INTERVAL_MS - 1` (still inside the window)
- **THEN** the idle-path distil is skipped by the throttle check

#### Scenario: Idle distil proceeds once the throttle window elapses after a forced distil
- **GIVEN** a forced distil completed at time `T_force`
- **WHEN** `session.idle` fires at `T_force + DISTIL_MIN_INTERVAL_MS + 1`
- **THEN** the idle-path distil is triggered normally

### Requirement: memory_distil_force is a no-op for sessions whose agent does not match TARGET_AGENT

When the caller's session agent (resolved via `session.get` or `sessionAgents`) is not a member of `TARGET_AGENTS` (or is null), `doDistil` SHALL return early without performing any distillation. The tool SHALL return a successful `ToolResult` in this case; the no-op is the accepted contract, consistent with the idle-path behaviour.

#### Scenario: Force distil from a non-target-agent session

- **GIVEN** the calling session's agent is not a member of `TARGET_AGENTS`
- **WHEN** the agent calls `memory_distil_force`
- **THEN** the tool returns a successful result without performing distillation

#### Scenario: Force distil from a session with null agent

- **GIVEN** the calling session's agent is null or undefined after sessionAgents lookup and session.get fallback
- **WHEN** the agent calls `memory_distil_force`
- **THEN** the tool returns a successful result without performing distillation

### Requirement: memory_distil_force has no CLI subcommand form

The system SHALL NOT expose a `distil-force` subcommand in `src/memory.js`. The sole entry-point for a forced distil SHALL be the `memory_distil_force` plugin tool, which requires the opencode `client` object available only inside the plugin factory.

#### Scenario: memory.js does not accept distil-force as a subcommand
- **GIVEN** the `src/memory.js` CLI is invoked
- **WHEN** `node memory.js distil-force` is called
- **THEN** the process exits with a non-zero code and prints the usage line for unknown commands

