# Spec: Plugin Lifecycle

Behaviour contract for the opencode plugin: factory export, startup, session event handling, and fail-safe degradation.

---

## Factory & Exports

### Requirement: AgentMemory is the default export only

The plugin module SHALL export `AgentMemory` as its default export. `reduceSignals` and `assemblePrimer` SHALL NOT be named exports of the plugin module.

---

## Startup

### Requirement: Factory invokes prune on startup

The system SHALL call `spawnMemory(['prune'])` as part of `AgentMemory` factory initialisation.

---

## Session Creation

### Requirement: session.created injects the primer at most once per session

The system SHALL inject the memory primer into a session exactly once when `session.created` fires for a target session; a second `session.created` event for the same session SHALL NOT trigger a second injection.

### Requirement: session.created does not inject for cold-start sessions

The system SHALL skip primer injection when the session has no prior hot_state entry (cold start).

### Requirement: session.created filters by agent and project

The system SHALL skip primer injection when the session's `agent` or `project` does not match the configured target values.

#### Scenario: Matching agent and project
- GIVEN a session whose agent and project match the plugin configuration
- WHEN `session.created` fires
- THEN the primer is injected (if not a cold start)

#### Scenario: Non-matching agent or project
- GIVEN a session whose agent or project does not match the plugin configuration
- WHEN `session.created` fires
- THEN no injection occurs

---

## Ephemeral Sessions

### Requirement: Ephemeral sessions skip injection and idle-distil

The system SHALL skip both primer injection and idle-distil for sessions whose title equals `'agent-memory distil'`.

#### Scenario: Ephemeral session created
- GIVEN a session with title `'agent-memory distil'`
- WHEN `session.created` fires
- THEN no primer injection occurs

#### Scenario: Ephemeral session idle
- GIVEN a session with title `'agent-memory distil'`
- WHEN `session.idle` fires
- THEN no distil is triggered

---

## Idle Distil

### Requirement: session.idle is throttled to at most one distil per 60 seconds

The system SHALL NOT trigger a distil if fewer than 60 seconds have elapsed since the last distil, unless the session buffer contains new signals since the last distil.

#### Scenario: Idle within throttle window, no new signals
- GIVEN fewer than 60 seconds have elapsed since the last distil and the buffer has no new signals
- WHEN `session.idle` fires
- THEN no distil is triggered

#### Scenario: Idle within throttle window, new signals present
- GIVEN fewer than 60 seconds have elapsed since the last distil but the buffer contains new signals
- WHEN `session.idle` fires
- THEN a distil is triggered

#### Scenario: Idle outside throttle window
- GIVEN at least 60 seconds have elapsed since the last distil
- WHEN `session.idle` fires
- THEN a distil is triggered

---

## Fallback Injection

### Requirement: message.updated injects the primer if not yet primed

The system SHALL inject the primer on `message.updated` if the session has not yet been primed, providing a fallback for sessions that missed `session.created` injection.

### Requirement: message.updated does not double-inject

The system SHALL NOT inject the primer on `message.updated` if the session has already been primed.

---

## Signal Capture

### Requirement: file.edited, todo.updated, and message.updated are captured in the session buffer

The system SHALL add an entry to the per-session signal buffer whenever a `file.edited`, `todo.updated`, or `message.updated` event fires for a target session.

---

## Fail-Safe Degradation

### Requirement: session.created and session.idle never propagate exceptions into opencode

The system SHALL catch all exceptions thrown by internal operations (including `session.get`, primer assembly, and `session.create`) within the `session.created` and `session.idle` handlers, ensuring the plugin never causes an unhandled rejection visible to the opencode host.

#### Scenario: session.get fails during session.created
- GIVEN `session.get` throws an error
- WHEN `session.created` fires
- THEN the error is caught and does not propagate to the opencode host

#### Scenario: session.create fails during session.idle distil
- GIVEN the distil spawn (`session.create`) throws an error
- WHEN `session.idle` fires
- THEN the error is caught and does not propagate to the opencode host
