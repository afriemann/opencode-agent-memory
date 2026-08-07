## Why

When an agent opens opencode from a non-git directory (e.g. `~/`), memory distillation writes hot_state with `project = '~/'` — creating a spurious project-scoped entry rather than falling through to the shared/unattached store. This makes cross-session memory unreliable for non-project sessions and conflates "this repo" with "any directory". In addition, the existing "global" naming for unattached atoms is confusing: `scope: "global"` in the read tools means "atoms not attached to any project" rather than what agents expect ("search everywhere"), and the primer header says "Global atoms" where "Shared atoms" would be clearer.

## What Changes

- **Git-root normalisation via `findGitRoot`** — `workspace.js` already exports a pure-filesystem `findGitRoot(start)` function (no shell spawn required). This is used by `doDistil`, `loadMemoryForSession`, and the write-tool auto-detect to resolve the canonical project identity for any directory.
- **Distillation and injection scoping** — both `doDistil` and `loadMemoryForSession` now resolve `findGitRoot(session.directory)` before calling memory.js subcommands. Found → project = git root, `scope='project'`. Not found → project = `''`, `scope='global'` (shared store). Both paths must agree or primer injection returns nothing for the session.
- **`memory.js` subcommand scope parameterisation** — `accrue`, `read`, `inspect`, `distil-write`, `correct`, prune, and the post-distil signal cleanup all currently hardcode `scope='project'`. These must be updated to accept (or derive) the scope/project pair. Convention: `project=''` → `scope='global'` (non-git sessions write to the shared hot_state bucket and signal bucket just as shared atoms write to `scope='global', project=''`).
- **`workspace` param becomes optional on write tools** — `memory_atom_write`, `memory_atom_append`, `memory_atom_patch`, `memory_atom_delete` no longer require an explicit workspace. When omitted: `findGitRoot(context.directory)` found → current project; not found → shared. `workspace: null` still explicitly targets shared. `workspace: "<path>"` still works for cross-project override. For agents that want to read/search shared atoms specifically, the equivalent is `workspace: null + scope: "workspace"`.
- **Scope semantics for read tools** — `scope: "workspace"` (default) now includes shared atoms alongside the current project (no longer opt-in). `scope: "global"` is repurposed to mean "search entire space, all projects" (replaces old `scope: "all"`). Old `scope: "all"` kept as a backwards-compat alias.
- **Rename "global" → "shared" everywhere in user-facing text** — `globalAtoms` parameter → `sharedAtoms`; `[global]` label → `[shared]`; "Global atoms" primer sections → "Shared atoms"; all tool descriptions, `MEMORY_PROTOCOL`, and agent instructions updated. DB values (`scope='global'`, `project=''`) are unchanged — no migration.
- **Known limitation — existing hot_state key drift**: rows distilled before this change used `project = session.directory` (e.g. `/myrepo/src/`); after normalisation the plugin writes `project = '/myrepo/'`. These are different keys, so old rows are orphaned in place (never pruned by the new prune path, never returned by the new read path). No data-loss risk; they will be overwritten by new distilations once the new path runs. This is accepted as a no-migration policy.

## Capabilities

### New Capabilities

None — `findGitRoot` already exists in `workspace.js`; this change adds usage of it, not a new function.

### Modified Capabilities

- `memory-atom-tools`: `resolveScope` semantics change (scope: "workspace" includes shared, scope: "global" = entire space, scope: "all" kept as alias); `workspace` becomes optional on all write tools (omit = auto-detect via git root).
- `plugin-lifecycle`: `doDistil` and `loadMemoryForSession` resolve git root before calling memory.js; renames primer section references from "global atoms" to "shared atoms".
- `signal-processing`: `assemblePrimer` parameter rename (`globalAtoms` → `sharedAtoms`); "Global atoms" primer heading → "Shared atoms".
- `workspace-discovery`: tool footer note updated to reference `scope: "global"` for searching the entire space (consistent with new semantics).

## Impact

- **`src/lib/workspace.js`** — no change; `findGitRoot` already exported.
- **`src/plugin.js`** — import `findGitRoot` from `./lib/workspace.js`; update `doDistil` (scope/project resolution); update `loadMemoryForSession` (scope/project resolution); update `resolveScope` (scope semantics); update write-tool `workspace` handling (optional + auto-detect); all tool descriptions and `MEMORY_PROTOCOL`; primer assembly `globalAtoms` → `sharedAtoms` call.
- **`src/memory.js`** — all hot_state subcommands affected: `accrue` (signal insert scope/project), `read` (three WHERE scope='project' queries), `inspect` (two WHERE scope='project' queries), `distil-write` (upsert scope/project + signal cleanup WHERE clause), `correct` (upsert scope/project), `prune` (WHERE scope='project'). CLI subcommand signatures for these may need scope/project params or derive scope from whether project is empty string.
- **`src/lib/signal-utils.js`** — `assemblePrimer` parameter name, primer heading text.
- **`test/signal-utils.test.js`**, **`test/plugin.test.js`** — update `globalAtoms` → `sharedAtoms` in all call sites; add distil-scope and workspace-auto-detect scenarios.
- **No DB schema migration** — DB column values are unchanged; only user-facing text changes.
- **`workspace` param on write tools: BREAKING** — previously described as "Required"; schema changes from required to optional. Agents that always pass it are unaffected.
