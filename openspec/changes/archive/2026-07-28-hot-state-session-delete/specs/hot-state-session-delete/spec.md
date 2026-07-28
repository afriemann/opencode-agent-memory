## ADDED Requirements

### Requirement: memory_state_delete removes a hot_state session row by session_id
The `memory_state_delete` registered tool SHALL invoke the `hot-state-delete <project> <sessionId>` CLI subcommand and return the count of rows deleted.

When `sessionId` is a **non-empty string**, the command SHALL delete the `hot_state` row(s) for the given project where `session_id = <sessionId>`.

When `sessionId` is an **empty string**, the command SHALL delete all `hot_state` rows for the given project where `session_id IS NULL OR session_id = ''` (orphaned/migrated rows with no identity).

The plugin tool SHALL reject a call where `sessionId` equals the calling session's own `context.sessionID` and return an error result without performing any deletion.

The tool SHALL return a result containing the count of deleted rows: `{ deleted: <n> }`.

#### Scenario: Deletes a row by non-empty session_id
- **GIVEN** a hot_state row exists with `session_id = 'ses_abc123'` for the current project
- **WHEN** the agent calls `memory_state_delete({ sessionId: 'ses_abc123' })`
- **THEN** the row is removed and the tool returns `{ deleted: 1 }`

#### Scenario: Deletes all nameless rows when sessionId is empty string
- **GIVEN** two hot_state rows exist for the current project with `session_id = ''`
- **WHEN** the agent calls `memory_state_delete({ sessionId: '' })`
- **THEN** both rows are removed and the tool returns `{ deleted: 2 }`

#### Scenario: Rejects deletion of the calling session's own row
- **GIVEN** the calling session has `sessionId = 'ses_current'`
- **WHEN** the agent calls `memory_state_delete({ sessionId: 'ses_current' })`
- **THEN** the tool returns an error result and no row is deleted

#### Scenario: Returns zero when no matching row exists
- **GIVEN** no hot_state row exists with the given session_id for the current project
- **WHEN** the agent calls `memory_state_delete({ sessionId: 'ses_nonexistent' })`
- **THEN** the tool returns `{ deleted: 0 }` and no error is thrown
