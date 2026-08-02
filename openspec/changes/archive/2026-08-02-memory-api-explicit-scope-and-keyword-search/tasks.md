## 1. Workspace Resolution Library (`src/lib/workspace.js`)

- [x] 1.1 Create `src/lib/workspace.js` exporting `resolveWorkspace(workspace, contextDirectory)` and `findGitRoot(startAbsPath)` — pure `node:fs` functions, no `git` binary dependency
- [x] 1.2 `findGitRoot`: walk up from `startAbsPath`, stop at `.git` directory, skip `.git` files (worktree pointers), return `startAbsPath` as-is when filesystem root reached
- [x] 1.3 `resolveWorkspace`: `null` → `{scope:'global', project:''}`, `"."` → expand via `path.resolve(contextDirectory)` then `findGitRoot`, absolute path → `findGitRoot`, relative non-`"."` → throw validation error
- [x] 1.4 Unit tests for `resolveWorkspace` and `findGitRoot` covering: null, `"."` expansion, absolute path, `.git`-directory stop, `.git`-file skip (worktree), no-git fallback

## 2. CLI Layer (`src/memory.js`)

- [x] 2.1 Change `atom-write` CLI shape from `<scope> <project> <json>` to `<contextDirectory> <json>`; add `workspace` key to JSON payload; call `resolveWorkspace` before any DB operation; return `scope` and `project` in result JSON for location suffix
- [x] 2.2 Change `atom-append` CLI shape identically to `atom-write`; return `scope` and `project` in result JSON
- [x] 2.3 Change `atom-delete` CLI shape: `<contextDirectory> <json>` where JSON carries `workspace` and `topic`; return `scope` and `project` in result JSON
- [x] 2.4 Change `atom-patch` CLI shape: `<contextDirectory> <json>` where JSON carries `workspace` (source) and optional `targetWorkspace`; call `resolveWorkspace` for both; pass resolved source + resolved destination to `atomPatch`
- [x] 2.5 Add `atom-list-workspaces [<optionsJson>]` subcommand that calls `atomListWorkspaces(db, opts)` and prints JSON array to stdout
- [x] 2.6 Update header comment listing all subcommands to reflect new CLI shapes

## 3. Schema Layer (`src/lib/schema.js`)

- [x] 3.1 Rename `query` → `keywords` in `atomSearch` function signature and FTS binding
- [x] 3.2 Add `atomListWorkspaces(db, { includeDeprecated? })` export: SELECT project AS workspace, COUNT(*) AS count WHERE scope='project' AND project!='' [AND status!='deprecated'] GROUP BY project ORDER BY count DESC
- [x] 3.3 Extend `atomPatch` to accept `{ source: {scope,project}, dest: {scope,project}, topic, patch }` shape; when `dest` differs from `source`, execute BEGIN IMMEDIATE → SELECT source row → DELETE source → UPSERT at dest (ON CONFLICT DO UPDATE) → COMMIT; apply metadata patch fields to the row before destination INSERT; when `source === dest` (same scope+project), execute existing in-place metadata patch; FTS sync triggers fire automatically on DELETE and INSERT

## 4. Plugin Layer (`src/plugin.js`)

- [x] 4.1 Remove `resolveScope` function; replace call-sites on write/mutate tools with pre-spawn type validation (null or string; if string then `"."` or `path.isAbsolute`) and `workspace` value embedded in JSON payload
- [x] 4.2 Update `memory_atom_write` tool: remove `scope` arg, add required `workspace` arg, update description and `workspace` arg description from agent-engineer output, format location suffix in confirmation output
- [x] 4.3 Update `memory_atom_append` tool: remove `scope` arg, add required `workspace` arg, update descriptions, format location suffix
- [x] 4.4 Update `memory_atom_delete` tool: remove `scope` arg, add required `workspace` arg, move `topic` into JSON payload, update descriptions, format location suffix
- [x] 4.5 Update `memory_atom_patch` tool: remove `scope` arg, add required `workspace` arg, add `patch.workspace` optional field to patch sub-object, map `patch.workspace` to `targetWorkspace` in JSON payload, format move/patch confirmation, update descriptions
- [x] 4.6 Update `memory_atom_search` tool: rename `query` → `keywords` arg, update tool description and `keywords` arg description from agent-engineer output, update `scope` arg description
- [x] 4.7 Update `memory_atom_get` tool: update `workspace` and `scope` arg descriptions from agent-engineer output (no behavioral change)
- [x] 4.8 Update `memory_atom_list` tool: update `scope` arg description from agent-engineer output (no behavioral change)
- [x] 4.9 Update `memory_state_inspect`, `memory_state_patch`, `memory_state_distil`, `memory_state_delete` descriptions from agent-engineer output
- [x] 4.10 Register `memory_workspaces_list` tool: args `{ includeDeprecated?: boolean }`, spawn `atom-list-workspaces`, format output as `• {workspace} — {count} atom(s)` per line plus usage note, empty → `No workspaces with stored atoms.`
- [x] 4.11 Update `MEMORY_PROTOCOL` constant: replace "Scope" paragraph with "Addressing" paragraph (workspace required, null=global, "."=current git root), add "Searching" BM25 note, add `/migrate-workspace-atoms` procedure

## 5. Tests

- [x] 5.1 Add/update tests for `resolveWorkspace` and `findGitRoot` in `test/schema.test.js` or a new `test/workspace.test.js`
- [x] 5.2 Update `test/plugin-safety.test.js` for required `workspace`, removed `scope`, `keywords` rename, location suffix in output
- [x] 5.3 Add tests for `atomPatch` move (new project, global target, combined move+metadata, source==dest no-op, destination overwrite)
- [x] 5.4 Add tests for `atomListWorkspaces` (counts, deprecated exclusion, global exclusion)
- [x] 5.5 Add tests for `memory_workspaces_list` tool (output format, empty case, usage note)
- [x] 5.6 Add tests for `atom-search` `keywords` rename at CLI level (old `query` name errors or returns empty)
