## Why

Agents cannot tell where a memory atom was written — `scope` silently defaults to workspace on write tools and confirmations omit the resolved location. `memory_atom_search` is named and described as if it performs semantic/vector retrieval, but it executes keyword-based FTS (BM25 token matching); agents over-rely on it for conceptual queries that fail when exact tokens are absent. Additionally, agents have no way to discover which workspaces have stored atoms, or to write atoms into a workspace other than the current session's directory. More broadly, memory tool descriptions have grown incrementally and are inconsistent — the `workspace` targeting parameter is ambiguous (agents may read it as "move to" rather than "target for read/write"), and descriptions across tools use different conventions for the same concepts.

## What Changes

- **BREAKING** — `scope` parameter **removed** from all write/mutate tools (`memory_atom_write`, `memory_atom_append`, `memory_atom_patch`, `memory_atom_delete`); callers must migrate to the new `workspace` addressing model
- **BREAKING** — `workspace` becomes a **required** parameter on all write/mutate tools, replacing `scope` as the sole addressing mechanism:
  - `workspace: null` → write to the global store
  - `workspace: "."` → resolve to git root of `context.directory`, then write to that workspace
  - `workspace: "/abs/path"` → resolve to git root of that path, then write to that workspace
- **BREAKING** — `memory_atom_search` parameter renamed from `query` to `keywords`; callers using the old name will receive a parameter error
- **Workspace resolution (git-root normalisation):** before any write or move, supplied paths are walked up to find the nearest `.git` directory (not file — `.git` files are worktree pointers and are skipped so all worktrees resolve to the main repo root); if no `.git` directory is found, the expanded absolute path is used as-is; `"."` is always expanded to the absolute `context.directory` before the walk-up runs; the resolved path is what is stored in and queried against the database
- `memory_atom_patch` move semantics: `patch.workspace` (null=global, `"."` or path=resolved git root) triggers an atomic move (DELETE from source + UPSERT at destination in one SQLite transaction); `patch.scope` is removed; destination conflicts are overwritten, consistent with write upsert semantics
- All write/mutate tool confirmations now include the resolved storage location: `[workspace: /path/to/git-root]` or `[global]`
- New tool `memory_workspaces_list` lists all workspace git-root paths that have at least one non-deprecated atom, with per-workspace atom counts; workspace-scoped results only (global excluded); named per `memory_<noun>_<verb>` convention
- New `/migrate-workspace-atoms` slash command provides an agent-driven workflow to re-key existing atoms from legacy paths (e.g. subdirectory paths stored before git-root normalisation) to their resolved git roots, using `memory_workspaces_list` → `memory_atom_list` → `memory_atom_patch` — no new tool required
- `memory_atom_search` tool description updated to clearly state keyword-based FTS (BM25 token matching — NOT semantic/vector search); `query` parameter renamed to `keywords`
- `scope` filter semantics on read tools (`memory_atom_get`, `memory_atom_list`, `memory_atom_search`) preserved; `workspace` parameters on read tools updated to reflect that paths are git-root normalised
- All memory tool descriptions reviewed and updated in one pass: `workspace` parameter explicitly states targeting-not-moving semantics, git-root resolution rule, `"."` sentinel, and null=global; cross-tool references added; MEMORY_PROTOCOL header comment updated to reflect workspace-as-address model

## Capabilities

### New Capabilities

- `workspace-discovery`: the `memory_workspaces_list` tool — lists distinct workspace git-root paths with atom counts; excludes deprecated atoms by default; workspace-scoped only (global excluded); enables agents to discover valid `workspace` values before targeting foreign workspaces

### Modified Capabilities

- `memory-atom-tools`: `scope` removed from write/mutate tools; `workspace` required (null=global, `"."`=current git root, path=foreign git root) with git-root normalisation; `memory_atom_patch` move via `patch.workspace`; write/mutate output includes resolved location; `memory_atom_search` `query` → `keywords`; `scope` filter preserved on read tools; all tool descriptions reviewed and updated
- `memory-atom`: new `atomListWorkspaces` DB query; `atomPatch` updated (move via `patch.workspace`, no `patch.scope`); workspace resolution utility (git-root walk-up, worktree detection, `"."` expansion); write result returns resolved path; `atom-list-workspaces` CLI subcommand added; `/migrate-workspace-atoms` slash command instruction added

## Impact

- `src/plugin.js` — `scope` param removed from 4 write/mutate tools; `workspace` made required with null/path/`"."` semantics; `memory_atom_patch` `patch` schema updated (remove `scope`, keep `workspace`); new `memory_workspaces_list` tool registration; all tool descriptions updated; MEMORY_PROTOCOL header updated; `/migrate-workspace-atoms` slash command instruction added
- `src/memory.js` — `resolveWorkspace` function (git-root walk-up, `"."` expansion, worktree skip, no-git fallback); write command output includes resolved location; `atom-patch` move uses `patch.workspace`; new `atom-list-workspaces` subcommand
- `src/lib/schema.js` — new `atomListWorkspaces` export; `atomPatch` move logic uses `workspace` not `scope`; `resolveWorkspace` integrated into all write/mutate paths; write result returns resolved git root path
- Tests — updated for removed `scope`, required `workspace`, git-root resolution (worktree skip, no-git fallback, `"."` expansion), renamed `keywords`, location in output, patch move behaviour, new tool behaviour
- Agent instructions (`src/plugin.js` MEMORY_PROTOCOL header) — updated to reflect workspace-as-address model, required `workspace`, and git-root normalisation rule
