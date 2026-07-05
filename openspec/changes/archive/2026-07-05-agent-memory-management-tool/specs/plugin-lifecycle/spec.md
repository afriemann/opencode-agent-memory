## ADDED Requirements

### Requirement: Plugin factory returns a tool hook with three management tools

The `AgentMemory` factory SHALL return an object containing both an `event` key (unchanged) and a `tool` key exposing `memory_inspect`, `memory_correct`, and `memory_distil_force` tools, each with a description, argument schema, and `execute` function.

#### Scenario: Returned Hooks object contains event and tool keys
- **GIVEN** the `AgentMemory` factory is invoked with a valid `{ client, $ }` context
- **WHEN** the factory resolves
- **THEN** the returned object has both an `event` property (the existing event handler) and a `tool` property containing exactly `memory_inspect`, `memory_correct`, and `memory_distil_force`

#### Scenario: Default export contract is unchanged
- **GIVEN** the plugin module is imported
- **WHEN** the default export is inspected
- **THEN** it is the `AgentMemory` factory function (identical signature to before this change)

### Requirement: doDistil accepts an optional force parameter that bypasses only the throttle

The `doDistil` internal function SHALL accept an optional second argument `{ force = false }`. When `force` is `true`, the idle-throttle early-return (`now - lastDistilMs < DISTIL_MIN_INTERVAL_MS`) SHALL be skipped; all other guards and steps (ephemeral-session check, `session.get` resolution, signal flush, LLM call, `distil-write`, cleanup) SHALL remain unchanged.

#### Scenario: Forced call proceeds within the throttle window
- **GIVEN** fewer than `DISTIL_MIN_INTERVAL_MS` ms have elapsed since the last distil
- **WHEN** `doDistil(sessionId, { force: true })` is called
- **THEN** the distil proceeds (throttle early-return is skipped)

#### Scenario: Non-forced idle call is still throttled
- **GIVEN** fewer than `DISTIL_MIN_INTERVAL_MS` ms have elapsed since the last distil and there are no new signals
- **WHEN** `doDistil(sessionId)` is called (without force)
- **THEN** the distil is skipped (existing throttle behaviour preserved)
