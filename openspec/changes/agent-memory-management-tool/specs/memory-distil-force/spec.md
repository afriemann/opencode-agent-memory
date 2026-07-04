## ADDED Requirements

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

### Requirement: memory_distil_force does not affect the idle-throttle clock

The system SHALL NOT reset or advance the idle-path throttle timer as a side-effect of a forced distil; the idle-path distil remains subject to its normal `DISTIL_MIN_INTERVAL_MS` window relative to the last idle-path distil timestamp.

#### Scenario: Forced distil does not block a subsequent idle distil
- **GIVEN** a forced distil was triggered at time `T_force` and the last idle-path distil occurred at `T_idle`
- **WHEN** `session.idle` fires at `T_idle + DISTIL_MIN_INTERVAL_MS + 1`
- **THEN** an idle-path distil is triggered normally, unaffected by `T_force`

### Requirement: memory_distil_force has no CLI subcommand form

The system SHALL NOT expose a `distil-force` subcommand in `src/memory.js`. The sole entry-point for a forced distil SHALL be the `memory_distil_force` plugin tool, which requires the opencode `client` object available only inside the plugin factory.

#### Scenario: memory.js does not accept distil-force as a subcommand
- **GIVEN** the `src/memory.js` CLI is invoked
- **WHEN** `node memory.js distil-force` is called
- **THEN** the process exits with a non-zero code and prints the usage line for unknown commands
