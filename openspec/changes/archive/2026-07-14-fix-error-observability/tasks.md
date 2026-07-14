## 1. Tests (red step)

- [x] 1.1 Write failing test: `plugin.js` `log()` calls `client.app.log` instead of writing to stderr
- [x] 1.2 Write failing test: `log()` appends `err.stderr` when the error is a `ShellError` with non-empty stderr
- [x] 1.3 Write failing test: `log()` falls back to stderr when `client.app.log` throws
- [x] 1.4 Write failing test: `notify()` calls `client.tui.showToast` with `variant: "error"`
- [x] 1.5 Write failing test: `distil: read failed` path calls both `log()` and `notify()`
- [x] 1.6 Write failing test: `memory.js` dispatch try/catch writes to stderr and exits 1 on uncaught exception
- [x] 1.7 Write failing test: `openDb()` executes `PRAGMA busy_timeout` before `PRAGMA journal_mode = WAL`

## 2. src/lib/db.js — PRAGMA order fix

- [x] 2.1 Move `db.exec('PRAGMA busy_timeout = 5000;')` to before `db.exec('PRAGMA journal_mode = WAL;')`

## 3. src/memory.js — error boundary

- [x] 3.1 Wrap the top-level dispatch `switch` in try/catch
- [x] 3.2 In the catch block, write `[memory.js] <cmd> failed: <err.message>` to `process.stderr` and call `process.exit(1)`

## 4. src/plugin.js — log + notify

- [x] 4.1 Rewrite `log(msg, err)` to call `client.app.log({ body: { service: 'agent-memory', level: 'error', message } })` fire-and-forget, appending `err.stderr.toString()` when present; fall back to `process.stderr.write()` if the client call throws
- [x] 4.2 Add `notify(msg)` helper that calls `client.tui.showToast({ body: { message: msg, variant: 'error' } })` fire-and-forget (never throws)
- [x] 4.3 Add `notify()` call alongside `log()` in the `distil: read failed` catch block
- [x] 4.4 Add `notify()` call alongside `log()` in the `inject: read failed` catch block (`loadMemoryForSession`)
- [x] 4.5 Add `notify()` call alongside `log()` in the top-level event handler error catch block

## 5. Verification

- [x] 5.1 Run full test suite — all tests pass
- [x] 5.2 Run linter — no errors
