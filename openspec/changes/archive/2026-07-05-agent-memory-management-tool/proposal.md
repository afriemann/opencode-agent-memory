## Why

Agents using the opencode-agent-memory plugin currently have no way to inspect what has been memorized, correct a wrong fact, or trigger an immediate distillation pass — they can only wait for the plugin's automatic idle-distil cycle or run low-level database operations. A dedicated management tool closes this gap, giving agents full control over their own memory state without bypassing the plugin's safety semantics.

## What Changes

- **New**: `inspect` CLI command — reads and prints the current `hot_state` (distilled summary) and the pending signals in the buffer for the configured agent/project scope.
- **New**: `correct` CLI command — applies a targeted patch to the current `hot_state`, replacing one field or the entire summary with a user/agent-supplied value; the patch is written as a distil-write transaction so monotonic-guard and watermark semantics still apply.
- **New**: `distil-force` CLI command — triggers an immediate distillation pass for the current session, bypassing the idle-throttle; the existing `spawnMemory` / ephemeral-session mechanism is reused.
- **Existing**: `prune` command and the plugin's auto-prune-on-startup behaviour are unchanged.
- **Existing**: `distil` (idle-path) throttle logic is unchanged; `distil-force` is a separate entrypoint, not a flag on the existing path.

## Capabilities

### New Capabilities

- `memory-inspect`: Agents and operators can read the current `hot_state` summary and the count/content of pending signals for a given scope, without modifying any state.
- `memory-correct`: Agents can apply a targeted correction to the current `hot_state` — updating one or more fields (e.g. fixing a wrong fact in `summary` or `next_action`) — through the existing distil-write transaction path.
- `memory-distil-force`: Agents can trigger an immediate (unthrottled) distillation pass that processes pending signals and writes a fresh `hot_state`, regardless of the idle-throttle window.

### Modified Capabilities

- `plugin-lifecycle`: The factory startup sequence will expose a `forceDistil(sessionId)` hook that `distil-force` calls; the idle-throttle path is not affected.

## Impact

- `src/memory.js`: Add `cmdInspect`, `cmdCorrect`, and `cmdDistilForce` command handlers alongside the existing `cmdPrune` and `cmdDistil`.
- `src/plugin.js`: Expose a `forceDistil` method on the plugin instance (or equivalent hook) so the CLI can invoke it without duplicating the distil-spawn logic.
- No schema changes — `inspect` and `correct` operate on the existing `hot_state` and `memory_signal` tables.
- No breaking changes to existing `prune`, `distil`, or env-var configuration.
- Consumers of the CLI gain three new subcommands; the plugin's public API gains one new method.
