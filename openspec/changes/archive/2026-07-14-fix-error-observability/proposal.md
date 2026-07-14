## Why

Plugin errors are currently logged to stderr, which leaks raw text into the opencode TUI. Additionally, when the `memory.js` child process fails, its actual error message is silently dropped (Bun's `ShellError.stderr` is never read), making failures undiagnosable. A transient SQLite `SQLITE_BUSY` race during DB initialisation can cause silent failures on startup.

## What Changes

- **`src/lib/db.js`**: Move `PRAGMA busy_timeout = 5000` before `PRAGMA journal_mode = WAL` to close the startup race window where WAL-mode acquisition can fail with no timeout active.
- **`src/memory.js`**: Wrap the top-level dispatch `switch` in a try/catch; write a structured message to stderr before exiting so the parent process receives a meaningful error string.
- **`src/plugin.js`**: Replace `process.stderr.write()` in `log()` with `client.app.log()` (writes to the opencode session log file, not TUI stderr); append `err.stderr.toString()` from Bun `ShellError` when present; add a `notify()` helper that calls `client.tui.showToast()` (variant `"error"`) and invoke it on critical failures that silently drop session work.

## Capabilities

### New Capabilities
- `error-observability`: Plugin errors are written to the opencode session log via `client.app.log()` and surfaced in the TUI via `client.tui.showToast()` rather than leaking to stderr.

### Modified Capabilities
<!-- none — the error-logging path has no existing spec; db.js PRAGMA reorder and memory.js error boundary are implementation-level hardening with no existing spec requirement to update -->

## Impact

- `src/lib/db.js` — PRAGMA execution order change (defensive; no schema change).
- `src/memory.js` — new error boundary; adds structured stderr output on uncaught exception.
- `src/plugin.js` — `log()` now calls `client.app.log()` (async, fire-and-forget) and falls back to stderr only if the client call throws; new `notify()` helper uses `client.tui.showToast()`; `err.stderr` from `ShellError` is now appended to log messages.
- No public API, tool schema, or database schema changes.
