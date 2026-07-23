# plugin-lifecycle Specification

## Purpose
TBD - created by archiving change agent-memory-management-tool. Update Purpose after archive.
## Requirements
### Requirement: Plugin factory returns a tool hook with three management tools
The `AgentMemory` factory SHALL return an object containing both an `event` key and a `tool` key exposing exactly nine tools: `memory_atom_write`, `memory_atom_append`, `memory_atom_get`, `memory_atom_search`, `memory_atom_list`, `memory_atom_delete`, `memory_state_inspect`, `memory_state_patch`, and `memory_state_distil`, each with a description, argument schema, and `execute` function.

#### Scenario: Returned hooks object exposes all nine tools
- **GIVEN** the `AgentMemory` factory is invoked with a valid `{ client, $ }` context
- **WHEN** the factory resolves
- **THEN** the returned object has a `tool` property containing exactly the nine named tools and no others

#### Scenario: Default export contract is unchanged
- **GIVEN** the plugin module is imported
- **WHEN** the default export is inspected
- **THEN** it is the `AgentMemory` factory function with the same signature as before

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

When a `session.created` event fires for a session whose agent is a member of `TARGET_AGENTS`, the plugin SHALL resolve the agent name (from the event payload or via a `session.get` fallback), record it in the `sessionAgents` Map, read the DB, assemble the primer, and store it in the in-process `primers` Map. The plugin SHALL NOT call `client.session.prompt` for memory injection. When no prior `hot_state` exists for the session's project (cold start), the `primers` Map SHALL receive no entry for that session. Sessions whose agent is null (after the `session.get` fallback) or not a member of `TARGET_AGENTS` SHALL be skipped silently without loading memory.

#### Scenario: session.created with prior memory — primer cached, no session.prompt call

- **GIVEN** a `hot_state` row exists for the project AND the session's agent is a member of `TARGET_AGENTS`
- **WHEN** `session.created` fires for that session
- **THEN** the primer text is stored in `primers.get(sessionId)`, the agent name is stored in `sessionAgents.get(sessionId)`, and `client.session.prompt` is NOT called for injection purposes

#### Scenario: session.created on cold start — no primer entry added, sessionAgents still populated

- **GIVEN** no `hot_state` row exists for the project AND the session's agent is a member of `TARGET_AGENTS`
- **WHEN** `session.created` fires for that session
- **THEN** no entry is added to the `primers` Map, an entry IS added to `sessionAgents`, and `client.session.prompt` is NOT called for injection purposes

#### Scenario: session.created for an untracked agent — skipped silently

- **GIVEN** the session's agent (from the event payload or session.get) is not a member of `TARGET_AGENTS`
- **WHEN** `session.created` fires for that session
- **THEN** no entry is added to `primers` or `sessionAgents` and no DB read is performed

#### Scenario: session.created with null/undefined agent — skipped silently

- **GIVEN** the session's agent is null or undefined after both the event-payload check and the session.get fallback
- **WHEN** `session.created` fires for that session
- **THEN** no entry is added to `primers` or `sessionAgents`

#### Scenario: message.updated fallback for undetected session resume — primer cached

- **GIVEN** a session whose `session.created` event was not caught (e.g. resumed session), the session's agent is a member of `TARGET_AGENTS`, and a `hot_state` row exists for its project
- **WHEN** `message.updated` fires for that session for the first time
- **THEN** the plugin resolves the session's agent and project, stores the agent in `sessionAgents`, reads the DB, and stores the primer in `primers.get(sessionId)`

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

### Requirement: Plugin caches per-session agent resolution and enforces a not-tracked guard for all management tools

The plugin SHALL maintain a `sessionAgents` Map (closure-scoped alongside `primers`) mapping `sessionId → resolvedAgentName`. It is the sole source of the agent dimension for all three management tool invocations (`memory_inspect`, `memory_correct`, `memory_distil_force`), which receive only `sessionID` and `directory` in `ToolContext` but not `agent`.

Resolution contract (`resolveSessionAgent(sessionId)`):
1. Return the cached value from `sessionAgents` on a hit.
2. On a miss, call `client.session.get(sessionId)` to obtain the agent name.
3. If the resolved agent is a member of `TARGET_AGENTS`, store it in `sessionAgents` and return it.
4. Otherwise (not a member, or null/undefined) return `null`.

When `resolveSessionAgent` returns `null`, **all three management tools SHALL return an informative `ToolResult`** (e.g. "this session's agent is not tracked") **without making any CLI call or DB access**. The Map is never evicted — its growth profile matches the existing `primers` and `primerLoaded` Maps.

#### Scenario: Tool invoked after session.created populates sessionAgents — no extra session.get call

- **GIVEN** `session.created` was handled for a tracked session, populating `sessionAgents.get(sessionId) = agentName`
- **WHEN** any management tool is invoked for that session
- **THEN** the tool uses `agentName` as the agent dimension without a further `session.get` call

#### Scenario: Tool invoked before sessionAgents is populated — cold-miss resolution

- **GIVEN** no entry exists in `sessionAgents` for the calling session
- **WHEN** any management tool is invoked
- **THEN** the plugin calls `client.session.get(sessionId)`, checks the resolved agent against `TARGET_AGENTS`, populates `sessionAgents` on a hit, and proceeds; on a miss returns the not-tracked result

#### Scenario: Tool invoked from an untracked session — not-tracked result, no CLI call

- **GIVEN** the calling session's agent (after sessionAgents lookup and session.get fallback) is not a member of `TARGET_AGENTS`
- **WHEN** any of the three management tools is invoked
- **THEN** the tool returns a result indicating the session is not tracked, with no CLI process spawned and no DB access performed

### Requirement: session.created does not inject for cold-start sessions
The system SHALL skip injection of the multi-row primer when the session has no prior hot_state rows. However, when no hot_state rows exist but one or more global atoms exist, the system SHALL inject a minimal primer containing only the `### Global atoms` section. When there are no hot_state rows AND no global atoms, no injection occurs.

#### Scenario: Cold start with global atoms injects global-only primer
- **GIVEN** no hot_state row exists for the session but at least one global atom exists
- **WHEN** session.created fires
- **THEN** a primer is injected containing the `### Global atoms` section and no `### Recent sessions` section

#### Scenario: Cold start with no global atoms and no hot_state injects nothing
- **GIVEN** no hot_state row exists and no global atoms exist
- **WHEN** session.created fires
- **THEN** no primer injection occurs

#### Scenario: Warm start with hot_state rows injects the full multi-row primer
- **GIVEN** at least one hot_state row exists for the session's agent and project
- **WHEN** session.created fires
- **THEN** the full primer is injected including `### Recent sessions` and atom directory sections

### Requirement: session.created captures session_name from event properties
The system SHALL capture `event.properties.info.title` at `session.created` and store it in an in-process `sessionNames` Map keyed by session ID. This value SHALL be passed to atom write and distil calls as the session name. When `info.title` is absent or falsy, `session_name` SHALL be stored as null.

#### Scenario: Session name is captured when title is present
- **GIVEN** a session.created event fires with event.properties.info.title = 'my-task'
- **WHEN** the session.created handler runs
- **THEN** sessionNames.get(sessionId) returns 'my-task'

#### Scenario: Session name is null when title is absent
- **GIVEN** a session.created event fires with no info.title in event.properties
- **WHEN** the session.created handler runs
- **THEN** sessionNames.get(sessionId) returns null and no error is raised

### Requirement: Primer inject includes atom directory sections for project and global atoms
The system SHALL query both the current-workspace atoms and global atoms via two separate `atom-list` spawns at `session.created` (inject time) and include the results in the injected primer under `### Project atoms` and `### Global atoms` sub-sections respectively. Each sub-section SHALL be capped independently at `atomInjectCap`. When a sub-section has no atoms it SHALL display a one-liner placeholder. When the atom count exceeds the cap the sub-section SHALL end with `(+N more — call memory_atom_list to see all)`.

#### Scenario: Project and global atom sections both appear in warm-start primer
- **GIVEN** project atoms and global atoms both exist
- **WHEN** session.created fires for a warm start
- **THEN** the injected primer contains `### Project atoms` and `### Global atoms` sections each listing their respective atoms

#### Scenario: Overflow line is emitted when atoms exceed the inject cap
- **GIVEN** more than atomInjectCap project atoms exist
- **WHEN** session.created fires
- **THEN** only atomInjectCap atoms are listed under `### Project atoms` and the overflow line `(+N more — call memory_atom_list to see all)` follows

#### Scenario: Empty atom section collapses to a one-liner
- **GIVEN** no global atoms exist
- **WHEN** session.created fires for a warm start
- **THEN** the `### Global atoms` section shows 'No global atoms yet' (or equivalent) rather than an empty heading

### Requirement: atomInjectCap config key controls the atom directory inject cap
The system SHALL resolve the `atomInjectCap` key from the config file as a positive integer, defaulting to 40 when absent or invalid. The resolved value SHALL be used as the per-section cap in `assemblePrimer`. An invalid value SHALL warn and fall back to 40.

#### Scenario: atomInjectCap from config is used
- **GIVEN** the config file contains atomInjectCap=20
- **WHEN** session.created fires and the primer is assembled
- **THEN** each atom directory sub-section is capped at 20 atoms

#### Scenario: Missing atomInjectCap defaults to 40
- **GIVEN** the config file does not specify atomInjectCap
- **WHEN** the primer is assembled
- **THEN** each sub-section is capped at 40 atoms

#### Scenario: Invalid atomInjectCap warns and falls back to 40
- **GIVEN** the config file contains atomInjectCap='not-a-number'
- **WHEN** the plugin initialises
- **THEN** a warning is logged and the effective cap is 40

