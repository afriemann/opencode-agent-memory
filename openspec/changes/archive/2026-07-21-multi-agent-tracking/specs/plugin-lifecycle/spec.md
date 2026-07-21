## MODIFIED Requirements

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

## ADDED Requirements

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
