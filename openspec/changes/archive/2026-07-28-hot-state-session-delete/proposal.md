## Why

Agents currently have no API for removing a specific hot_state session entry.
When a broken, problematic, or orphaned session row appears in the primer, the
only recourse is to shell out to `sqlite3` directly — which requires explicit
shell permissions and is fragile.

A targeted `memory_state_delete` tool closes this gap: agents can identify a
session from the primer and remove it without leaving the opencode tool surface.

To make a session identifiable without any external query, the primer's Recent
sessions section must also expose the full `session_id` so agents can pass it
directly to the new tool.

## What Changes

1. **Session thread format** — each Recent sessions entry gains the full
   `session_id` in its header line so an agent can read it and pass it to the
   delete tool. Rows with an empty `session_id` (orphaned/migrated rows) omit
   the bracket so the absence itself signals "no identity — pass empty string
   to delete".

2. **`memory_state_delete` plugin tool** — accepts a `sessionId` string and
   removes the matching `hot_state` row(s) for the current project:
   - Non-empty `sessionId` → delete the row with that exact `session_id`.
   - Empty string `""` → delete all rows for the current project where
     `session_id IS NULL OR session_id = ''` (orphaned/migrated rows).
   - Blocked from deleting the calling session's own row (safety guard).
   - Returns `{ deleted: number }` — count of rows removed.

3. **`hot-state-delete` CLI subcommand** — backs the plugin tool; accepts
   `<project> <sessionId>` positional arguments and performs the deletion.

## Capabilities

### New Capabilities
- `hot-state-session-delete`: `memory_state_delete` plugin tool and backing
  `hot-state-delete` CLI subcommand for targeted removal of hot_state session
  rows by session_id.

### Modified Capabilities
- `signal-processing`: session thread header line now includes the full
  `session_id` in bracket notation when the row has one.

## Impact

- `src/lib/signal-utils.js` — thread header format change in `assemblePrimer`
- `src/lib/schema.js` — new `hotStateDelete(db, project, sessionId)` helper
- `src/memory.js` — new `hot-state-delete` subcommand
- `src/plugin.js` — new `memory_state_delete` tool registration
- Tests: `test/signal-utils.test.js`, `test/schema.test.js`,
  `test/plugin-safety.test.js`
