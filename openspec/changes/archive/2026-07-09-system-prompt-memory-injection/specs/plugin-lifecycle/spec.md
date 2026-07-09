## ADDED Requirements

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

## REMOVED Requirements

### Requirement: Plugin injects memory primer via session.prompt noReply

**Reason:** Replaced by system prompt injection (`experimental.chat.system.transform`). Injecting the primer as a chat message placed it in the imperative register, causing the agent to treat it as a command and enter an investigation loop.

**Migration:** No migration required. The primer is now injected via the system transform hook; no consumer depends on the primer appearing as a chat message.
