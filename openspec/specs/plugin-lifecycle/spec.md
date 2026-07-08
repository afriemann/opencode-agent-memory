# plugin-lifecycle Specification

## Purpose
TBD - created by archiving change agent-memory-management-tool. Update Purpose after archive.
## Requirements
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

### Requirement: Plugin factory returns a config hook that registers a hidden distiller agent

The `AgentMemory` factory SHALL return an object that includes a `config` hook in addition to the existing `event` and `tool` keys. When invoked, the `config` hook SHALL add a key `distiller` to `cfg.agent` (creating the map if absent) with `mode: 'subagent'`, `hidden: true`, and `permission: 'deny'` (the scalar deny-all form). The hook SHALL use a non-destructive assignment (`??=`) so a user-defined `distiller` agent in their config is not overwritten.

#### Scenario: config hook is present on the returned hooks object
- **WHEN** the `AgentMemory` factory resolves
- **THEN** the returned object has a `config` property that is a function

#### Scenario: config hook registers the distiller agent
- **WHEN** `plugin.config({})` is called with an empty config object
- **THEN** `cfg.agent.distiller` is defined with `mode: 'subagent'`, `hidden: true`, and `permission === 'deny'`

#### Scenario: config hook does not overwrite existing agent entries
- **WHEN** `plugin.config({ agent: { engineer: { existing: true } } })` is called
- **THEN** `cfg.agent.engineer` is still `{ existing: true }` and `cfg.agent.distiller` is also present

### Requirement: Ephemeral distil session is created with the distiller agent

When the plugin creates an ephemeral distil sub-session, the `session.create` call SHALL include `agent: 'distiller'` in the request body alongside the existing `title` field.

#### Scenario: session.create body contains agent: 'distiller'
- **WHEN** a distil run is triggered (e.g. via `session.idle` or `memory_distil_force`)
- **THEN** `client.session.create` is called with a body containing `agent: 'distiller'`

