# error-observability Specification

## Purpose
TBD - created by archiving change fix-error-observability. Update Purpose after archive.
## Requirements
### Requirement: Plugin errors are written to the opencode session log
The plugin SHALL write all error-level diagnostic messages to the opencode session log via `client.app.log()` (service `"agent-memory"`, level `"error"`) instead of `process.stderr`. The log message SHALL include the child-process stderr output (from `ShellError.stderr`) when present, appended after the primary error description. `client.app.log()` SHALL be called fire-and-forget; if the call itself throws, the plugin SHALL fall back to writing to `process.stderr` so the error is not silently swallowed.

#### Scenario: Successful log via client.app.log
- **WHEN** a plugin error occurs (e.g. `distil: read failed`)
- **THEN** `client.app.log` is called with `service: "agent-memory"`, `level: "error"`, and a message string — and `process.stderr` is NOT written

#### Scenario: child-process stderr is included in the log message
- **WHEN** a `ShellError` with a non-empty `.stderr` Buffer is logged
- **THEN** the log message contains both the high-level description and the child-process stderr text

#### Scenario: fallback to stderr when client.app.log throws
- **WHEN** `client.app.log()` itself throws
- **THEN** the plugin writes the error to `process.stderr` as a fallback (error is not lost)

### Requirement: Critical plugin failures show a TUI toast notification
The plugin SHALL call `client.tui.showToast()` (variant `"error"`) fire-and-forget for errors that cause a session's memory operation to be silently skipped: `distil: read failed`, `inject: read failed`, and the top-level `event handler error` catch. Lower-severity degradation (e.g. `distil: session.get failed`, LLM call failures) SHALL NOT produce a toast.

#### Scenario: distil read failure triggers toast
- **WHEN** the `memory.js read` child process exits non-zero during `doDistil`
- **THEN** `client.tui.showToast` is called with `variant: "error"` and a message identifying the failure

#### Scenario: inject read failure triggers toast
- **WHEN** the `memory.js read` child process exits non-zero during `loadMemoryForSession`
- **THEN** `client.tui.showToast` is called with `variant: "error"`

#### Scenario: unhandled event handler error triggers toast
- **WHEN** an unexpected exception escapes the `switch` inside the `event` handler
- **THEN** `client.tui.showToast` is called with `variant: "error"`

#### Scenario: lower-severity distil failure does not trigger toast
- **WHEN** `client.session.get` fails during `doDistil` (session lookup error)
- **THEN** `client.tui.showToast` is NOT called

### Requirement: memory.js reports uncaught dispatch errors to stderr before exiting
The `memory.js` CLI dispatch `switch` SHALL be wrapped in a try/catch. Any uncaught exception SHALL cause the process to write a structured error message to `process.stderr` and exit with code 1, so the parent plugin can surface the failure via `ShellError.stderr`.

#### Scenario: uncaught exception produces stderr output
- **WHEN** any dispatch command throws an unexpected error (e.g. SQLite exception)
- **THEN** `process.stderr` receives a message containing the command name and error description before the process exits 1

### Requirement: SQLite busy_timeout is set before journal_mode WAL
The `openDb()` function in `src/lib/db.js` SHALL execute `PRAGMA busy_timeout = 5000` before `PRAGMA journal_mode = WAL` so that concurrent-access timeouts are active during the WAL-mode acquisition step, closing the startup race window.

#### Scenario: DB opens successfully with concurrent access at startup
- **GIVEN** two processes attempt to open the database simultaneously for the first time
- **WHEN** the second process attempts the WAL pragma
- **THEN** it waits up to 5 000 ms for the write lock rather than failing immediately

