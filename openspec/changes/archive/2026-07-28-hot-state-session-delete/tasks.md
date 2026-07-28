## 1. Session thread format — show session_id in primer

- [x] 1.1 Add `[<session_id>]` bracket to the thread header line in `assemblePrimer` (`signal-utils.js`) — omit when `session_id` is falsy
- [x] 1.2 Add/update tests in `signal-utils.test.js` for both cases (non-empty session_id shows bracket; empty/null session_id omits bracket)

## 2. DB helper — hotStateDelete

- [x] 2.1 Add `hotStateDelete(db, project, sessionId)` to `schema.js` — non-empty sessionId: `DELETE WHERE project=? AND session_id=?`; empty sessionId: `DELETE WHERE project=? AND (session_id IS NULL OR session_id='')`
- [x] 2.2 Export `hotStateDelete` from `schema.js`
- [x] 2.3 Add tests in `schema.test.js` covering all four spec scenarios (delete by id, delete nameless, no match returns 0, does not delete across projects)

## 3. CLI subcommand — hot-state-delete

- [x] 3.1 Add `hot-state-delete <project> <sessionId>` subcommand to `memory.js` calling `hotStateDelete` and printing JSON result `{ deleted: n }`

## 4. Plugin tool — memory_state_delete

- [x] 4.1 Register `memory_state_delete` tool in `plugin.js` with `sessionId` parameter; block when `sessionId === context.sessionID`; call `hot-state-delete` via `spawnMemory`; return result
- [x] 4.2 Add plugin-safety test covering the self-delete block scenario

## 5. Tests and validation

- [x] 5.1 Run full test suite and confirm all tests pass
