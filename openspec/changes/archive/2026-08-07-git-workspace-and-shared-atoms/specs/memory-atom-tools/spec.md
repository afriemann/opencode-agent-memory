## ADDED Requirements

### Requirement: findGitRootOrNull resolves git repo root or returns null for non-git paths

`workspace.js` SHALL export `findGitRootOrNull(start): string|null` — a pure synchronous fs-walk that returns the nearest ancestor directory containing a `.git` directory, or `null` when no such ancestor exists. The existing `findGitRoot(start)` SHALL be refactored to `findGitRootOrNull(start) ?? start` so its external contract (returning `start` unchanged when no root is found) is preserved for all existing callers. `resolveWorkspace` SHALL continue to work as before.

#### Scenario: findGitRootOrNull returns root for a git repo path
- **GIVEN** a path inside a git repository
- **WHEN** `findGitRootOrNull` is called with that path
- **THEN** the function returns the repository root path (the directory containing `.git`)

#### Scenario: findGitRootOrNull returns null for a non-git path
- **GIVEN** a path that has no `.git` ancestor directory
- **WHEN** `findGitRootOrNull` is called with that path
- **THEN** the function returns `null`

#### Scenario: findGitRoot retains graceful fallback behaviour
- **GIVEN** a path that has no `.git` ancestor directory
- **WHEN** `findGitRoot` is called with that path
- **THEN** the function returns `start` unchanged (not null), preserving the existing contract

### Requirement: resolveWorkspace distinguishes undefined (auto-detect) from null (explicit shared)

`resolveWorkspace(workspace, contextDirectory)` SHALL split its `null`/`undefined` handling:
- `undefined` (omitted) → call `findGitRootOrNull(contextDirectory)`; found → `{scope:'project', project:root}`; not found → `{scope:'global', project:''}`.
- `null` → `{scope:'global', project:''}` (unchanged; explicit shared).
- `'.'` or any absolute path → unchanged; resolve git root of that path with graceful fallback.

The `undefined` → auto-detect path is only triggered by the new optional `workspace` argument on write tools (see MODIFIED below). Existing call sites that always pass `null` explicitly are unaffected.

#### Scenario: resolveWorkspace undefined auto-detects project in a git repo
- **GIVEN** the calling session directory is inside a git repository at root `/myrepo`
- **WHEN** `resolveWorkspace(undefined, '/myrepo/src')` is called
- **THEN** the result is `{ scope: 'project', project: '/myrepo' }`

#### Scenario: resolveWorkspace undefined falls back to shared when no git root
- **GIVEN** the calling session directory is `/home/user` which has no `.git` ancestor
- **WHEN** `resolveWorkspace(undefined, '/home/user')` is called
- **THEN** the result is `{ scope: 'global', project: '' }`

#### Scenario: resolveWorkspace null still means explicit shared
- **GIVEN** any session directory
- **WHEN** `resolveWorkspace(null, '/any/dir')` is called
- **THEN** the result is `{ scope: 'global', project: '' }` regardless of whether a git root exists

## MODIFIED Requirements

### Requirement: resolveScope translates the agent-facing scope to the CLI scope/project pair

The plugin SHALL provide a `resolveScope(scope, directory)` helper that maps the agent-facing `scope` parameter to the CLI/DB values before every spawn:
- `'workspace'` or `undefined` → `{scope:'project', project:directory}`. `atomSearch` and `atomList` already union shared atoms (`scope='global', project=''`) into results for `scope='project'` — shared atoms are included in the default workspace scope with no additional mapping.
- `'global'` → `{scope:'all', project:''}` — **search the entire space across all projects and shared atoms** (repurposed from its former meaning of "shared atoms only").
- `'all'` → `{scope:'all', project:''}` (backwards-compatible alias for the new `'global'` meaning).
- To read or search only shared atoms specifically, agents SHALL use `workspace: null` combined with `scope: 'workspace'`.
- Writes SHALL only accept `'workspace'` (or `undefined`) and SHALL error if `'global'` or `'all'` is supplied.

#### Scenario: resolveScope maps 'workspace' to project scope with directory
- **GIVEN** the current project directory is '/home/user/my-project'
- **WHEN** resolveScope is called with scope='workspace' and directory='/home/user/my-project'
- **THEN** the result is { scope: 'project', project: '/home/user/my-project' }

#### Scenario: resolveScope maps 'global' to all-scope (entire space)
- **WHEN** resolveScope is called with scope='global'
- **THEN** the result is { scope: 'all', project: '' }

#### Scenario: resolveScope maps 'all' to all-scope (backwards-compat alias)
- **WHEN** resolveScope is called with scope='all' for a read operation
- **THEN** the result is { scope: 'all', project: '' }

#### Scenario: shared-only search requires workspace:null + scope:'workspace'
- **GIVEN** an agent wants to search only shared (unattached) atoms
- **WHEN** resolveScope is called with scope='workspace' and directory=''
- **THEN** the result is { scope: 'project', project: '' } which atomSearch/atomList map to the shared bucket only

### Requirement: memory_atom_write tool upserts an atom with required description

The `memory_atom_write` tool SHALL accept a required, non-empty `summary` argument (max 280 chars) in addition to the required `description` argument. The `summary` SHALL represent a one-sentence digest of what the atom's content contains, distinct from `description` (which says what the atom is *for*). The tool description SHALL state that `summary` is required, that it appears in directory listings so other agents can triage without fetching, that it must be at most 280 characters, and that it is distinct from `description`. The tool SHALL accept an optional `always_include` boolean argument (default `false`). The tool description SHALL state that `always_include` is INSERT-only: setting it on first creation stores the value; a re-write of the same topic never changes it, and `memory_atom_patch` MUST be used to toggle it after creation.

The `workspace` argument SHALL be **optional**. When omitted, the tool SHALL auto-detect the project: `findGitRootOrNull(context.directory)` found → writes to that git root's project; not found → writes to the shared store (`scope='global', project=''`). When `workspace: null` is supplied explicitly, the tool SHALL write to the shared store. When a path string is supplied, it SHALL resolve as today (git root of that path, graceful fallback).

#### Scenario: memory_atom_write accepts always_include on creation
- **GIVEN** no atom exists for the given topic
- **WHEN** `memory_atom_write` is called with `always_include: true` and a valid `summary`
- **THEN** the created atom has `always_include = 1` and the call succeeds

#### Scenario: memory_atom_write INSERT-only caveat is documented in the tool description
- **GIVEN** the plugin tool definitions are loaded
- **WHEN** the `memory_atom_write` tool description is inspected
- **THEN** it states that `always_include` is set on first creation and a re-write never changes it

#### Scenario: memory_atom_write requires a non-empty summary
- **GIVEN** the plugin tool definitions are loaded
- **WHEN** `memory_atom_write` is called without a `summary` argument or with `summary=''`
- **THEN** the call fails Zod validation with a clear error; no atom is written

#### Scenario: memory_atom_write stores the provided summary
- **GIVEN** no atom exists for the given topic
- **WHEN** `memory_atom_write` is called with `summary='One-sentence digest of what this contains'`
- **THEN** the created atom has the provided summary stored

#### Scenario: summary description is present in the tool schema
- **GIVEN** the plugin tool definitions are loaded
- **WHEN** the `memory_atom_write` tool arg schema for `summary` is inspected
- **THEN** the description states it is a one-sentence content digest, is required, appears in listings, and has a 280-char maximum

#### Scenario: memory_atom_write auto-detects project when workspace omitted in git repo
- **GIVEN** the calling session is inside a git repo at `/myrepo`
- **WHEN** `memory_atom_write` is called with no `workspace` argument
- **THEN** the atom is written to the project scope for `/myrepo`

#### Scenario: memory_atom_write auto-detects shared when workspace omitted outside git
- **GIVEN** the calling session is in a non-git directory
- **WHEN** `memory_atom_write` is called with no `workspace` argument
- **THEN** the atom is written to the shared store (`scope='global', project=''`)

#### Scenario: memory_atom_write workspace null still writes to shared
- **GIVEN** the calling session is inside a git repo
- **WHEN** `memory_atom_write` is called with `workspace: null`
- **THEN** the atom is written to the shared store

### Requirement: memory_atom_append tool appends to an existing atom

The `memory_atom_append` registered tool SHALL invoke the `atom-append` CLI subcommand. It SHALL return the full updated content on success. If the topic does not exist the CLI exits non-zero and the tool SHALL surface the error message ("Atom '<topic>' does not exist — use memory_atom_write to create it first") as a ToolResult. It SHALL NOT propagate exceptions into the host.

The `workspace` argument SHALL be **optional** with the same auto-detect semantics as `memory_atom_write`: omit → auto-detect via git root; `null` → shared explicitly.

#### Scenario: Tool appends content and returns updated full content
- **GIVEN** an atom exists at the given topic
- **WHEN** the agent calls memory_atom_append with additional content
- **THEN** the tool returns the full content of the atom after the append

#### Scenario: Tool surfaces error when topic is missing
- **GIVEN** no atom exists at the given topic
- **WHEN** the agent calls memory_atom_append
- **THEN** the tool returns an error result containing the missing-topic message and does not throw

#### Scenario: memory_atom_append auto-detects project when workspace omitted in git repo
- **GIVEN** the calling session is inside a git repo at `/myrepo`
- **WHEN** `memory_atom_append` is called with no `workspace` argument
- **THEN** the operation targets the project scope for `/myrepo`

### Requirement: memory_atom_delete tool removes an atom by topic

The `memory_atom_delete` registered tool SHALL invoke the `atom-delete` CLI subcommand and return a confirmation on success. It SHALL surface a non-zero CLI exit as an error result and SHALL NOT propagate exceptions into the host.

The `workspace` argument SHALL be **optional** with the same auto-detect semantics as `memory_atom_write`: omit → auto-detect via git root; `null` → shared explicitly.

#### Scenario: Tool removes an existing atom and returns confirmation
- **GIVEN** an atom exists at the given (scope, topic)
- **WHEN** the agent calls memory_atom_delete
- **THEN** the atom is removed and the tool returns a one-line confirmation

#### Scenario: Tool returns error result when topic does not exist
- **GIVEN** no atom exists at the given (scope, topic)
- **WHEN** the agent calls memory_atom_delete
- **THEN** the tool returns an informative error result and does not throw

#### Scenario: memory_atom_delete auto-detects project when workspace omitted
- **GIVEN** the calling session is inside a git repo
- **WHEN** `memory_atom_delete` is called with no `workspace` argument
- **THEN** the deletion targets the current project scope

### Requirement: memory_atom_patch tool performs content-preserving metadata updates

The `memory_atom_patch` tool's `patch` sub-object SHALL accept an optional `always_include` boolean field and an optional `summary` string field. An explicit `always_include: true` SHALL set the flag; an explicit `always_include: false` SHALL clear it; an omitted key SHALL leave the existing value unchanged. An explicit `summary` string SHALL replace the stored summary; the value MUST be non-empty and at most 280 characters; an omitted `summary` key SHALL leave the existing summary unchanged. The tool description SHALL enumerate `summary` as a patchable field and state it is the appropriate way to retroactively add or correct a summary on older atoms without rewriting their full content.

The `workspace` argument SHALL be **optional** with the same auto-detect semantics as `memory_atom_write`: omit → auto-detect via git root; `null` → shared explicitly.

#### Scenario: memory_atom_patch toggles always_include via patch sub-object
- **GIVEN** an atom with `always_include = 0`
- **WHEN** `memory_atom_patch` is called with `patch: { always_include: true }`
- **THEN** the atom has `always_include = 1`

#### Scenario: memory_atom_patch clears always_include via patch sub-object
- **GIVEN** an atom with `always_include = 1`
- **WHEN** `memory_atom_patch` is called with `patch: { always_include: false }`
- **THEN** the atom has `always_include = 0`

#### Scenario: memory_atom_patch sets summary on an older atom
- **GIVEN** an atom exists with `summary = ''`
- **WHEN** `memory_atom_patch` is called with `patch: { summary: 'Backfilled digest' }`
- **THEN** the atom has `summary = 'Backfilled digest'` and `updated_at` is bumped

#### Scenario: memory_atom_patch rejects empty summary in patch
- **GIVEN** an atom exists
- **WHEN** `memory_atom_patch` is called with `patch: { summary: '' }`
- **THEN** the tool returns an error result and the atom's summary is unchanged

#### Scenario: memory_atom_patch rejects summary exceeding 280 characters
- **GIVEN** an atom exists
- **WHEN** `memory_atom_patch` is called with a `summary` value of 281 characters
- **THEN** the tool returns an error result and the atom's summary is unchanged

#### Scenario: memory_atom_patch auto-detects project when workspace omitted
- **GIVEN** an atom exists in the current project and workspace is omitted
- **WHEN** `memory_atom_patch` is called with no `workspace` argument
- **THEN** the patch targets the auto-detected project atom

### Requirement: memory_atom_list tool lists atoms by topic prefix with default workspace+global scope

The `memory_atom_list` registered tool SHALL invoke the `atom-list` CLI subcommand. With no scope it returns current-workspace atoms and shared atoms (atoms with `scope='global', project=''`) together. `scope='all'` or `scope='global'` includes atoms from all workspaces (entire space). By default the tool returns only `active` and `resolved` atoms (deprecated atoms are excluded). The tool SHALL accept an optional `status` argument (Zod enum: `'active'`, `'resolved'`, `'deprecated'`) for exact-match filtering; when supplied it SHALL override the default filter and `includeDeprecated`. The tool SHALL accept an optional `includeDeprecated` boolean argument; when `true` (and `status` is absent) it SHALL return all three statuses. Each result line SHALL include both `created_at` and `updated_at` rendered as human-readable relative strings and SHALL show the atom's `status`. Non-active atoms SHALL be marked in their entry with a `[resolved]` or `[deprecated]` prefix as appropriate. Pinned atoms SHALL be marked with a `[pinned]` indicator. Each result line SHALL display `summary` when non-empty; when `summary` is empty the line SHALL fall back to displaying the 80-character content preview. When both `summary` and preview are empty the content segment and its separator SHALL be omitted. Shared atoms SHALL be labelled `[shared]` in their listing line. It SHALL NOT propagate exceptions into the host.

#### Scenario: Tool default excludes deprecated atoms
- **GIVEN** atoms exist with all three status values
- **WHEN** the agent calls memory_atom_list without status arguments
- **THEN** the tool returns active and resolved atoms; the deprecated atom is excluded

#### Scenario: Tool with includeDeprecated returns all statuses
- **GIVEN** atoms exist with all three status values
- **WHEN** the agent calls memory_atom_list with includeDeprecated=true
- **THEN** atoms of all three status values are returned

#### Scenario: Tool with status='deprecated' returns only deprecated atoms
- **GIVEN** atoms exist with all three status values
- **WHEN** the agent calls memory_atom_list with status='deprecated'
- **THEN** only deprecated atoms are returned

#### Scenario: Tool output labels non-active atoms with their status
- **GIVEN** a resolved atom and a deprecated atom exist (via includeDeprecated=true)
- **WHEN** the agent calls memory_atom_list with includeDeprecated=true
- **THEN** the resolved atom's line includes '[resolved]' and the deprecated atom's line includes '[deprecated]'

#### Scenario: Tool listing shows summary when non-empty
- **GIVEN** an atom exists with `summary='Architectural decisions for the auth flow'`
- **WHEN** the agent calls memory_atom_list
- **THEN** the listing line for that atom includes 'Architectural decisions for the auth flow' instead of a raw content preview

#### Scenario: Tool listing falls back to preview when summary is empty
- **GIVEN** an atom exists with `summary=''` and content starting with '# Auth notes'
- **WHEN** the agent calls memory_atom_list
- **THEN** the listing line for that atom includes the first 80 characters of the content

#### Scenario: Tool listing omits content segment when both summary and preview are empty
- **GIVEN** an atom exists with `summary=''` and `content=''`
- **WHEN** the agent calls memory_atom_list
- **THEN** the listing line for that atom has no `|` separator or trailing empty content segment

#### Scenario: Default scope includes shared atoms alongside project atoms
- **GIVEN** a project atom and a shared atom (scope='global', project='') both exist
- **WHEN** `memory_atom_list` is called with no scope argument
- **THEN** both the project atom and the shared atom appear in the listing

### Requirement: memory_atom_search tool performs full-text search with optional scope filter

The `memory_atom_search` registered tool SHALL invoke the `atom-search` CLI subcommand. With no `scope` argument it searches all workspaces by default. The optional `scope` parameter (`'workspace'` or `'global'`) narrows the search: `'workspace'` searches the current project and shared atoms together; `'global'` searches the entire space across all workspaces. By default the tool excludes `deprecated` atoms from results. The tool SHALL accept an optional `status` argument (Zod enum: `'active'`, `'resolved'`, `'deprecated'`) for exact-match filtering; when supplied it SHALL override the default filter and `includeDeprecated`. The tool SHALL accept an optional `includeDeprecated` boolean argument; when `true` (and `status` is absent) it SHALL include all three statuses. Results include project context, both `created_at` and `updated_at` rendered as human-readable relative strings, and `summary` displayed when non-empty (falling back to preview). Shared atoms SHALL be labelled `[shared]` in results. It SHALL NOT propagate exceptions into the host.

#### Scenario: Tool default excludes deprecated matches
- **GIVEN** matching atoms exist with all three status values
- **WHEN** the agent calls memory_atom_search without status arguments
- **THEN** only active and resolved matching atoms are returned

#### Scenario: Tool with includeDeprecated includes deprecated matches
- **GIVEN** matching atoms exist with all three status values
- **WHEN** the agent calls memory_atom_search with includeDeprecated=true
- **THEN** matching atoms of all three status values are returned

#### Scenario: Tool with status='resolved' returns only resolved matches
- **GIVEN** matching atoms exist with all three status values
- **WHEN** the agent calls memory_atom_search with status='resolved'
- **THEN** only resolved matching atoms are returned

#### Scenario: Tool result includes summary when present
- **GIVEN** a matching atom exists with `summary='Concise content digest'`
- **WHEN** the agent calls memory_atom_search
- **THEN** the result entry for that atom displays 'Concise content digest' instead of a raw content preview

#### Scenario: scope='global' searches entire space
- **GIVEN** atoms exist in three different project workspaces and the shared store
- **WHEN** `memory_atom_search` is called with `scope='global'` (or `scope='all'`)
- **THEN** matching atoms from all workspaces and the shared store are returned

#### Scenario: scope='workspace' searches current project and shared atoms
- **GIVEN** atoms exist in the current project, the shared store, and another project
- **WHEN** `memory_atom_search` is called with `scope='workspace'`
- **THEN** matching atoms from the current project and the shared store are returned; atoms from the other project are excluded

### Requirement: MEMORY_PROTOCOL teaches agents status lifecycle semantics

The `MEMORY_PROTOCOL` constant SHALL include guidance on the `always_include` flag: when to use it; how to toggle it; the 5-per-scope render cap; the misuse warning; and the distinction from `pinned`. The `MEMORY_PROTOCOL` constant SHALL also include guidance on the `summary` field: that `summary` is required on `memory_atom_write`; that it is a one-sentence digest of what the atom's **content** contains, distinct from `description` (which says what the atom is *for*); that it appears in directory listings (session primer, `memory_atom_list`, etc.) so agents can decide whether to fetch the full atom without reading it; that it is at most 280 characters; that it can be retroactively added to older atoms via `memory_atom_patch`; and that it may become stale after `memory_atom_append` operations (content grows but summary is not updated automatically — agents should re-patch the summary when the appended content materially changes what the atom contains).

The `MEMORY_PROTOCOL` constant SHALL describe the workspace auto-detect behaviour: when `workspace` is omitted, the tool detects the git root of the current session directory and writes there; when no git root is found, the atom is written to the shared store. It SHALL state that `workspace: null` explicitly targets the shared store and that `workspace: "."` is always safe for the current project.

The `MEMORY_PROTOCOL` constant SHALL describe the `scope` semantics: `scope: "workspace"` (default) returns the current project's atoms and shared atoms together; `scope: "global"` searches the entire space across all projects and shared atoms; to read only shared atoms, combine `workspace: null` with `scope: "workspace"`. It SHALL NOT state "always pass workspace explicitly — there is no default."

#### Scenario: MEMORY_PROTOCOL contains always_include guidance
- **GIVEN** the plugin tool definitions are loaded
- **WHEN** the `MEMORY_PROTOCOL` constant is inspected
- **THEN** it contains a description of `always_include`, the toggle command, the 5-per-scope cap, the misuse warning, and the distinction from `pinned`

#### Scenario: MEMORY_PROTOCOL contains summary guidance
- **GIVEN** the plugin tool definitions are loaded
- **WHEN** the `MEMORY_PROTOCOL` constant is inspected
- **THEN** it contains a description of `summary`, that it is required on write, that it is a content digest distinct from `description`, that it appears in listings, the 280-char limit, how to backfill via `atom-patch`, and the append-staleness caveat

#### Scenario: MEMORY_PROTOCOL describes workspace auto-detect
- **GIVEN** the plugin tool definitions are loaded
- **WHEN** the `MEMORY_PROTOCOL` constant is inspected
- **THEN** it explains that omitting `workspace` auto-detects the git root, that `null` means shared store, and does NOT say "always pass workspace explicitly"

#### Scenario: MEMORY_PROTOCOL describes scope semantics with shared terminology
- **GIVEN** the plugin tool definitions are loaded
- **WHEN** the `MEMORY_PROTOCOL` constant is inspected
- **THEN** it uses "shared" (not "global") for unattached atoms, explains scope:"workspace" includes shared atoms, and explains scope:"global" means the entire space
