## Why

Inspecting and modifying stored memories today requires hand-constructing `memory.js` CLI invocations (or querying the SQLite DB directly) — there is no way to browse what an agent's session primer will actually look like, browse project or shared atoms, or change an atom's lifecycle state (pin, always_include, status, delete) without knowing the exact subcommand and JSON payload shape. This makes routine memory maintenance (finding stale atoms, correcting a wrong `always_include`, deleting a test atom) slow and error-prone for a human operator.

## What Changes

- Add a new terminal UI (TUI), built with Ink 7 (React ≥19.2, ESM), invoked via a new `bin` entry (e.g. `agent-memory-tui`) — a thin wrapper around the same `src/tui.js` entry point that can also be run directly (`node src/tui.js`); these are two invocations of one code path, not two contracts. It runs as a separate manual process from the opencode plugin runtime.
- The TUI provides four views:
  1. **Main Menu** — entry point, routes to the other three views.
  2. **Primer Inspector** — pick an agent + project pair (from the new `hot-state-list-pairs` subcommand, see below) and preview the exact primer text a real session would receive. This screen is read-only: it never mutates state, and it always reflects a fresh read at open time (no caching across screen visits).
  3. **Atom Browser** — browse atoms scoped to a project or to the global/shared store, with a live preview pane (description, summary, tags, timestamps). Handles the empty-list case (no atoms, no `hot_state` rows) with an explicit empty-state message rather than a blank pane.
  4. **Atom Detail & Actions** — full atom content, and lifecycle actions: edit content via `$EDITOR`, toggle `pinned`, toggle `always_include`, cycle `status` (active/resolved/deprecated), and delete (behind a confirmation step).
- **Corrected spawn mechanism** (this replaces an earlier draft's inaccurate claim): `src/plugin.js` spawns `memory.js` via opencode's Bun-provided `$` tagged-template shell, which is only available inside the opencode plugin runtime. The standalone TUI process has no such shell — it will spawn `memory.js` via Node's own `node:child_process` (`execFile`), passing `AGENT_MEMORY_DB` through from its own environment so both processes agree on which database file they operate against. All mutations (`atom-write`, `atom-patch`, `atom-delete`) go exclusively through these spawned `memory.js` subcommand invocations — the TUI never opens the SQLite database directly (never imports `src/lib/db.js` or `src/lib/schema.js`), preserving `memory.js` as the sole writer. This was an explicit, confirmed architectural decision (over an alternative of allowing the TUI a read-only direct DB connection, which WAL would technically support) — kept for simplicity: exactly one code path ever opens the database file, so its `PRAGMA` configuration and locking behavior never needs to stay in sync across two implementations.
- **Primer fidelity**: assembling `assemblePrimer()`'s exact inputs client-side is not achievable from existing subcommands (`read` needs a session ID the TUI doesn't have and truncates to the 3 most recent rows; `inspect` returns all rows — a different result). Instead, `memory.js` gains a new `primer-preview <agent> <project>` subcommand that performs the same assembly `src/plugin.js` does server-side (gathering hot_state rows, atoms, cross-project rows, git staleness, and the configured atom-injection cap) and returns the finished primer text in one call. This is one code path shared by the real plugin runtime's assembly logic and the TUI's preview, eliminating any risk of the preview drifting from the real primer. `src/plugin.js` is not required to change for this — the new subcommand is additive — though a future refactor could have it call the same subcommand to remove its own duplicate assembly logic; that consolidation is out of scope here.
- $EDITOR handoff is implemented via Ink's `suspendTerminal()` API (v7.1.0+): the TUI suspends rendering, writes the atom's content to a temp file (cleaned up after use, including on crash), spawns `$EDITOR` on it (falling back to a sane default such as `vi` if `$EDITOR` is unset), waits for exit, reads the file back, and — if the content changed and the editor exited 0 — calls `memory.js atom-write` with the edited content plus the atom's existing `description`/`summary`/`tags` re-sent unchanged (required because `atom-write` validates `description` as non-empty and content is not independently patchable) before resuming and repainting. A non-zero editor exit discards the edit.
- Any other read-oriented data the TUI needs beyond `primer-preview` and `hot-state-list-pairs` will be added as new `memory.js` subcommands during design/implementation, following the same capability placement as these two (see Capabilities below).

## Out of Scope (this change)

- Creating a brand-new atom from scratch (only editing existing atoms' content/metadata is supported).
- Full-text search/filter beyond simple scrollable list browsing.
- `atom-append` (append-only content growth) from the TUI.
- Direct `hot_state` row editing (only the read-only Primer Inspector preview).
- Wiring the TUI to `atom-patch`'s existing cross-workspace move capability (deferred to a follow-up change).
- Optimistic-concurrency / compare-and-swap guards on `atom-patch`/`atom-write` (both remain last-write-wins, matching their existing behavior for every other caller — e.g. two people or an agent and the TUI toggling the same atom's `pinned` flag concurrently, or an edit racing a session's own writes, can silently overwrite each other). Accepted as a pre-existing constraint of the underlying schema, not introduced by this change.
- A long-lived "server mode" `memory.js` child process (to avoid per-screen spawn cost) — considered and deferred; the simpler one-spawn-per-screen-load model (not one spawn per keystroke: in-memory list navigation does not re-spawn) is used for this MVP.

## Capabilities

### New Capabilities
- `memory-tui`: the terminal UI application itself — bin entry, Ink app shell, the four screens (Main Menu, Primer Inspector, Atom Browser, Atom Detail & Actions), navigation between them, the `$EDITOR` edit flow, and the lifecycle-action flows (pin/always_include toggle, status cycle, delete with confirmation), all driven exclusively through `memory.js` subcommands. This capability's delta also covers the two new `memory.js` subcommands the TUI requires (`primer-preview`, `hot-state-list-pairs`) — following this repo's existing precedent that a CLI-subcommand's behavior is its own capability (e.g. `hot-state-session-delete`, `memory-inspect`), distinct from the `*-tools` capabilities, which specifically describe the *registered opencode tools*, not the underlying CLI.

### Modified Capabilities
_None._

## Impact

- **New files**: `src/tui.js` (or `src/tui/` entry), an Ink component tree, `bin/agent-memory-tui` (a `bin` field in `package.json` pointing at `src/tui.js`).
- **New runtime dependencies**: `ink@^7`, `react@^19.2`, `react-devtools-core@^6.1` (Ink peer dep); optionally `fullscreen-ink` for the full-screen shell helper. This package currently has zero runtime dependencies — this is a deliberate, acknowledged increase in dependency footprint, accepted because these packages are required for the `bin` script to run under a normal `npm install` (they cannot be partitioned as "TUI-only" without a separate package).
- **New dev dependency**: `ink-testing-library`, for testing the Ink component tree.
- **`package.json`**: add `bin` entry, add the dependencies above, confirm `engines.node >=24` still satisfies Ink 7's `>=22` floor (it does), check whether a `files` allowlist is needed so the new `bin`/TUI files are included in what gets published (the package currently has none).
- **Modification to `src/memory.js`**: two new subcommands, `primer-preview <agent> <project>` and `hot-state-list-pairs` (or similar; exact name/shape finalized in `design.md`), both read-only.
- **Architectural boundary (explicit)**: TUI code may import pure `src/lib/*` modules it needs (e.g. `config.js` for shared constants) but MUST NOT import `src/lib/db.js` or `src/lib/schema.js` — all data access and mutation goes through spawned `memory.js` subcommands.
- **No change** to `src/lib/db.js` or `src/lib/schema.js`.
- **No change required** to the opencode plugin runtime (`src/plugin.js`) — the TUI is a separate, manually-invoked process, and the new `primer-preview` subcommand is additive.
- **Documentation**: README updated to document the new `bin` entry and TUI usage.
