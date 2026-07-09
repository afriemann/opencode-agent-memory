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

The `AgentMemory` factory SHALL return an object that includes a `config` hook in addition to the existing `event` and `tool` keys. When invoked, the `config` hook SHALL add a key `distiller` to `cfg.agent` (creating the map if absent) with `mode: 'subagent'`, `hidden: true`, and `permission: { '*': 'deny' }` (object form with wildcard key — the scalar string form is not valid for agent-level PermissionConfig). The hook SHALL use a non-destructive assignment (`??=`) so a user-defined `distiller` agent in their config is not overwritten.

#### Scenario: config hook is present on the returned hooks object
- **WHEN** the `AgentMemory` factory resolves
- **THEN** the returned object has a `config` property that is a function

#### Scenario: config hook registers the distiller agent
- **WHEN** `plugin.config({})` is called with an empty config object
- **THEN** `cfg.agent.distiller` is defined with `mode: 'subagent'`, `hidden: true`, and `permission['*'] === 'deny'`

#### Scenario: config hook does not overwrite existing agent entries
- **WHEN** `plugin.config({ agent: { engineer: { existing: true } } })` is called
- **THEN** `cfg.agent.engineer` is still `{ existing: true }` and `cfg.agent.distiller` is also present

### Requirement: Plugin injects memory primer via system prompt transform

The `AgentMemory` factory SHALL register an `"experimental.chat.system.transform"` hook on the returned hooks object. When the hook fires for a session whose ID is present in the in-process `primers` Map, the hook SHALL append the cached primer text to `output.system`. When the session has no cached primer (cold start or unloaded session), the hook SHALL leave `output.system` unmodified. Ephemeral distil sessions SHALL be skipped.

#### Scenario: Session with cached primer — primer appended to system
- **GIVEN** a session with a cached primer in the `primers` Map
- **WHEN** `experimental.chat.system.transform` fires for that session
- **THEN** the primer text is appended to `output.system`

#### Scenario: Session with no cached primer — system unchanged
- **GIVEN** a session with no entry in the `primers` Map (cold start)
- **WHEN** `experimental.chat.system.transform` fires for that session
- **THEN** `output.system` is not modified

#### Scenario: Ephemeral distil session — system unchanged
- **GIVEN** a session ID present in the `ephemerals` Set
- **WHEN** `experimental.chat.system.transform` fires for that session
- **THEN** `output.system` is not modified

### Requirement: Session memory is loaded into the primers cache on session.created, not injected via session.prompt

When a `session.created` event fires for the target agent, the plugin SHALL read the DB, assemble the primer, and store it in the in-process `primers` Map. The plugin SHALL NOT call `client.session.prompt` for memory injection. When no prior `hot_state` exists for the session's project (cold start), the `primers` Map SHALL receive no entry for that session.

#### Scenario: session.created with prior memory — primer cached, no session.prompt call
- **GIVEN** a `hot_state` row exists for the project
- **WHEN** `session.created` fires for a target-agent session
- **THEN** the primer text is stored in `primers.get(sessionId)` and `client.session.prompt` is NOT called for injection purposes

#### Scenario: session.created on cold start — no entry added, no session.prompt call
- **GIVEN** no `hot_state` row exists for the project
- **WHEN** `session.created` fires for a target-agent session
- **THEN** no entry is added to the `primers` Map and `client.session.prompt` is NOT called for injection purposes

#### Scenario: message.updated fallback for undetected session resume — primer cached
- **GIVEN** a session whose `session.created` event was not caught (e.g. resumed session) and a `hot_state` row exists for its project
- **WHEN** `message.updated` fires for that session for the first time
- **THEN** the plugin resolves the session's agent and project, reads the DB, and stores the primer in `primers.get(sessionId)`

### Requirement: A console log is emitted when a primer is loaded for a session

When the plugin successfully assembles and caches a primer for a session, it SHALL emit a `[agent-memory]` prefixed log line via `console.error` that includes the session ID, the project short-name (last two path segments), and the primer's character count.

#### Scenario: Primer loaded — log line emitted
- **GIVEN** a session with prior memory
- **WHEN** the primer is successfully loaded and cached
- **THEN** a log line matching `[agent-memory] primer loaded` is written to stderr, including the session ID, project shortname, and char count

#### Scenario: Cold start — no log line for missing primer
- **GIVEN** no prior memory exists for the session's project
- **WHEN** session memory loading completes (no primer cached)
- **THEN** no "primer loaded" log line is emitted

