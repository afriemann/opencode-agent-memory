# opencode-agent-memory

Persistent memory plugin for opencode. Captures work signals (file edits, todo changes, key messages) during a `build` session, distils them into a structured hot-state record when the session goes idle, and injects a context primer at the start of the next session in the same project.

## How it works

1. **Accumulate** — while a `build` session is active, the plugin accumulates file edits, todo updates, and qualifying user messages (corrections, plan changes, stop/park statements) into an in-memory buffer, which is periodically flushed to SQLite scratch storage.
2. **Distil** — when the session goes idle, the plugin calls a cheap LLM (via an ephemeral sub-session) to condense the prior hot state and accrued signals into a four-field record: `last_worked_summary`, `next_action`, `open_questions[]`, `adr_candidate`.
3. **Inject** — at the start of the next `build` session in the same project, the plugin reads the latest hot state, computes a git-staleness flag, and injects a memory primer via `client.session.prompt({ noReply:true })`.

The primer is kept intentionally small (hot state only) for context-rot control. Cold ADRs (`docs/adr/`) are referenced by path only, never inlined.

## Installation

The plugin is auto-discovered by opencode via a symlink created by the bootstrap/update scripts in `agent-dotfiles`:

```
~/.config/opencode/plugins/opencode-agent-memory.js
  → ~/git/opencode-agent-memory/src/plugin.js
```

Run `make bootstrap` (or `make update`) in `agent-dotfiles` to create or refresh the symlink.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `AGENT_MEMORY_DB` | `~/.local/share/opencode/agent-memory.db` | Path to the SQLite database. |
| `MEMORY_DISTILLER_MODEL` | `github-copilot/gpt-5-mini` | Model used for distillation, as `providerID/modelID`. |
| `MEMORY_TARGET_AGENT` | `build` | The opencode agent this plugin tracks. Phase 1: single value only. |
| `DISTIL_MIN_INTERVAL_MS` | `60000` | Minimum milliseconds between distil runs for the same session (throttle). |
| `MEMORY_FLUSH_INTERVAL_MS` | `60000` | Reserved for a future periodic background flush. **Not yet implemented** — Phase 1 flushes the accumulator buffer on `session.idle` only. |

## CLI reference (`src/memory.js`)

`memory.js` is the **sole writer** of the SQLite database. The plugin never opens the DB directly; it always delegates to this CLI.

```
node src/memory.js init
  Create (or verify) the database schema. Idempotent.

node src/memory.js accrue <sessionId> <agent> <project>
  stdin: { "files": [...], "todos": [...], "messages": [...] }
  Flush accumulated in-memory signals to the memory_signal scratch table.

node src/memory.js read <sessionId> <agent> <project>
  stdout: { "prior": {...}|null, "signals": [...], "watermark": {...} }
  Read the latest hot state, all scratch signals, and the session watermark.

node src/memory.js distil-write <agent> <project>
  stdin: { "distilled": {...}, "anchoredSha": string|null, "lastSignalMs": number, "sessionId": string }
  UPSERT hot_state (monotonic guard), delete consumed signals, advance watermark.
  Runs in a single transaction.

node src/memory.js prune
  stdout: { "pruned": N }
  Delete memory_signal rows older than 30 days.
```

## Known limitations

- **File-edit attribution** — `file.edited` events carry no `sessionID`. The plugin attributes them to the last active `build` session in the current process. In environments with multiple concurrent `build` sessions (multiple worktrees), edits may be attributed to the wrong session. This is a Phase-1 trade-off; the distiller still receives the correct file names, just potentially under the wrong session key.
- **Phase 1 scope** — only the `build` agent is tracked (`MEMORY_TARGET_AGENT`). The `scope` and `agent` columns are in the schema to allow a non-breaking additive extension later.

## Development

```bash
npm install          # install jest
npm test             # run the test suite
```

Requires Node.js ≥ 22.5 (`node:sqlite` built-in).
