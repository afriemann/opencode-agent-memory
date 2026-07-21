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
| `MEMORY_TARGET_AGENTS` | *(none — no agents tracked)* | Comma-separated list of opencode agent names to track (e.g. `engineer,code-reviewer`). No default: if unset, the plugin is effectively disabled. |
| `DISTIL_MIN_INTERVAL_MS` | `60000` | Minimum milliseconds between distil runs for the same session (throttle). |
| `MEMORY_FLUSH_INTERVAL_MS` | `60000` | Reserved for a future periodic background flush. **Not yet implemented** — Phase 1 flushes the accumulator buffer on `session.idle` only. |

## Config file


As an alternative to environment variables, you can place a JSONC file at:

```
~/.config/opencode/agent-memory.jsonc
```

This file is loaded once at plugin startup. It supports the same three tuneable values as the env vars above, with **per-key independent precedence**:

```
env var  >  config file value  >  hardcoded default
```

Each key falls back independently — setting only `distillerModel` in the file leaves the other two at their defaults.

**Supported keys:**

| Key | Type | Default | Equivalent env var |
|---|---|---|---|
| `targetAgents` | array of non-empty strings | `[]` (no agents tracked) | `MEMORY_TARGET_AGENTS` |
| `distilMinIntervalMs` | finite positive number | `60000` | `DISTIL_MIN_INTERVAL_MS` |
| `distillerModel` | `"providerID/modelID"` string | `"github-copilot/gpt-5-mini"` | `MEMORY_DISTILLER_MODEL` |

**Example** (see also `docs/agent-memory.jsonc`):

```jsonc
{
  // Which agents' sessions to track
  "targetAgents": ["engineer", "code-reviewer"],
  // Minimum distil interval in milliseconds
  "distilMinIntervalMs": 60000,
  // LLM used to distil session signals
  "distillerModel": "github-copilot/gpt-5-mini",
}
```

**Error handling:** invalid values emit a `[agent-memory]` warning to `console.warn` and fall back to the hardcoded default for that key only. A missing or empty file is silently ignored.

**⚠️ Limitation:** string values must not contain `//`, `/*`, or `*/`. These token sequences are stripped by the inline JSONC parser. The three documented keys never need these characters in practice.

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

node src/memory.js inspect <agent> <project>
  stdout: { "prior": {...}|null, "signals": [...] }
  Non-destructive read of hot state and signals. No watermark, no row mutations.
  Used by the memory_inspect plugin tool.

node src/memory.js distil-write <agent> <project>
  stdin: { "distilled": {...}, "anchoredSha": string|null, "lastSignalMs": number, "sessionId": string }
  UPSERT hot_state (monotonic guard), delete consumed signals, advance watermark.
  Runs in a single transaction.

node src/memory.js correct <agent> <project> <patchJson>
  patchJson: partial JSON object — any subset of:
    { "last_worked_summary": string, "next_action": string,
      "open_questions": string[], "adr_candidate": string|null }
  Applies a partial correction to the hot state using BEGIN IMMEDIATE.
  Only supplied fields are changed; all others keep their current values.
  Does NOT delete signals or advance the distil watermark.
  Used by the memory_correct plugin tool.

node src/memory.js prune
  stdout: { "pruned": N }
  Delete memory_signal rows older than 30 days.
```

> **Note:** `distil-force` has **no CLI form**. Forced distillation can only be triggered via the `memory_distil_force` plugin tool (which calls `doDistil` in-process). Passing `distil-force` as a subcommand exits with an error.

## Plugin tools

The plugin exposes three tools under the `tool` key returned by the `AgentMemory` factory. All three tools resolve the agent dimension from the current session via `resolveSessionAgent` (which checks the `TARGET_AGENTS` set). If the session's agent is not tracked, the tool returns an informative message and makes no CLI call.

### `memory_inspect`

Read the current hot state and signals for the current project. Non-destructive — no row is inserted, updated, or deleted.

| — | — |
|---|---|
| Args | *(none)* |
| Returns | JSON string `{ prior: {...}|null, signals: [...] }` |
| CLI equivalent | `node src/memory.js inspect <resolved-agent> <context.directory>` |

### `memory_correct`

Apply a partial correction to the hot state. Only the fields included in `patch` are updated; omitted fields retain their current values. Uses `BEGIN IMMEDIATE` to prevent conflicts with concurrent distil writes.

| Arg | Type | Required | Description |
|---|---|---|---|
| `patch.last_worked_summary` | `string` | No | Summary of work done so far |
| `patch.next_action` | `string` | No | Recommended next action |
| `patch.open_questions` | `string[]` | No | Open questions or blockers |
| `patch.adr_candidate` | `string \| null` | No | Architecture decision candidate, or `null` to clear |

Does **not** delete signals or advance the distil watermark.

### `memory_distil_force`

Force an immediate memory distillation for the current session, bypassing the idle throttle window. All other guards still apply (ephemeral skip, tracked-agent check). The forced distil shares the per-session watermark and may advance `last_distil_ms`.

| — | — |
|---|---|
| Args | *(none)* |
| CLI equivalent | **None.** Only available as a plugin tool (requires in-process `client`). |

## Known limitations

- **File-edit attribution** — `file.edited` events carry no `sessionID`. The plugin attributes them to the last active tracked-agent session in the current process. In environments with multiple concurrent tracked sessions (multiple worktrees), edits may be attributed to the wrong session. This is a Phase-1 trade-off; the distiller still receives the correct file names, just potentially under the wrong session key.
- **Multi-agent tracking** — multiple agents are tracked independently; each session is keyed to its own hot-state row by `(scope, agent, project)`. Sessions whose agent is not in `targetAgents` are silently skipped.

## Development

```bash
npm install          # install jest
npm test             # run the test suite
```

Requires Node.js ≥ 22.5 (`node:sqlite` built-in).
