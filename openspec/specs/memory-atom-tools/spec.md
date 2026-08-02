# memory-atom-tools Specification

## Purpose
TBD - created by archiving change memory-atoms-and-session-hot-state. Update Purpose after archive.
## Requirements
### Requirement: memory_atom_write tool upserts an atom with required description

The `memory_atom_write` tool SHALL remove the `scope` parameter and instead expose a required `workspace` parameter. `workspace` SHALL accept `null` (global store), `"."` (current project — resolves to git root of `context.directory`), or an absolute path string (foreign project — resolves to its git root). Callers that omit `workspace` SHALL receive a schema validation error. Callers that supply a relative path other than `"."` SHALL receive a tool-output validation error without spawning. The confirmation output SHALL end with the resolved location: `[workspace: /path]` or `[global]`. The tool description SHALL direct callers to use `memory_atom_append` when they need to add content without replacing existing content.

#### Scenario: memory_atom_write accepts always_include on creation
- **GIVEN** no atom exists for the given topic
- **WHEN** `memory_atom_write` is called with `always_include: true`
- **THEN** the created atom has `always_include = 1` and the call succeeds

#### Scenario: memory_atom_write INSERT-only caveat is documented in the tool description
- **GIVEN** the plugin tool definitions are loaded
- **WHEN** the `memory_atom_write` tool description is inspected
- **THEN** it states that `always_include` is set on first creation and a re-write never changes it

#### Scenario: memory_atom_write with workspace="." writes to current project git root
- **GIVEN** opencode is running in `/repo` where `/repo/.git` is a directory
- **WHEN** `memory_atom_write` is called with `workspace: "."`, topic, content, description
- **THEN** the atom is stored at scope='project', project='/repo', and the confirmation ends with `[workspace: /repo]`

#### Scenario: memory_atom_write with workspace=null writes to global store
- **GIVEN** any project context
- **WHEN** `memory_atom_write` is called with `workspace: null`, topic, content, description
- **THEN** the atom is stored at scope='global', project='', and the confirmation ends with `[global]`

#### Scenario: memory_atom_write with workspace omitted is rejected by schema
- **GIVEN** any project context
- **WHEN** `memory_atom_write` is called without a `workspace` argument
- **THEN** a schema validation error is returned and no atom is written

#### Scenario: memory_atom_write with relative path other than "." is rejected
- **GIVEN** any project context
- **WHEN** `memory_atom_write` is called with `workspace: "subdir"`
- **THEN** the tool returns a validation error without spawning

### Requirement: memory_atom_append tool appends to an existing atom

The `memory_atom_append` tool SHALL remove the `scope` parameter and instead expose a required `workspace` parameter with the same null/`"."`/absolute-path semantics and validation as `memory_atom_write`. The tool description SHALL state that the tool is for adding content without replacing existing content, and SHALL direct callers to use `memory_atom_write` to replace content entirely.

#### Scenario: Tool appends content and returns updated full content
- **GIVEN** an atom exists at the given topic
- **WHEN** the agent calls memory_atom_append with additional content
- **THEN** the tool returns the full content of the atom after the append

#### Scenario: Tool surfaces error when topic is missing
- **GIVEN** no atom exists at the given topic
- **WHEN** the agent calls memory_atom_append
- **THEN** the tool returns an error result containing the missing-topic message and does not throw

#### Scenario: memory_atom_append with workspace="." appends to current project atom
- **GIVEN** an atom exists at topic 'work/notes' in the current project workspace
- **WHEN** `memory_atom_append` is called with `workspace: "."` and content
- **THEN** the content is appended and the response ends with the resolved location

### Requirement: memory_atom_get tool returns best-match content and foreign-workspace listing
The `memory_atom_get` registered tool SHALL invoke the `atom-get` CLI subcommand and return the `{ match, alsoIn }` payload. The match section contains the full content of the best-match atom (workspace priority over global) with both creation and update timestamps rendered as human-readable relative strings. The match section SHALL include the atom's `status`. The alsoIn section lists same-topic atoms from other workspaces with the format `• [workspace: <path>] <topic> — <description> | <preview> [created: …, updated: …]` for workspace-scoped entries and `• [global] <topic> — <description> | <preview> [created: …, updated: …]` for global-scoped entries; `alsoIn` entries SHALL show the atom's status when it is not `active`. The tool SHALL accept an optional `workspace` argument (a directory path); when provided, the effective directory for scope resolution SHALL be the given path rather than the current session directory, allowing the named workspace's atom to be promoted to the primary match. When `scope` is `"global"` it SHALL take precedence over the `workspace` argument. `atom-get` applies no status filtering — the match is always returned regardless of `status`. It SHALL NOT propagate exceptions into the host.

#### Scenario: Tool output includes status of the matched atom
- **GIVEN** an atom exists at the given topic with `status='resolved'`
- **WHEN** the agent calls memory_atom_get
- **THEN** the tool output includes the atom's status (e.g. `status: resolved`)

#### Scenario: Tool returns deprecated atom as match
- **GIVEN** an atom exists at the given topic with `status='deprecated'`
- **WHEN** the agent calls memory_atom_get
- **THEN** the tool returns the atom as the match with its full content and `status='deprecated'` visible in the output

#### Scenario: Tool alsoIn labels deprecated foreign atoms
- **GIVEN** the primary match is active and a foreign atom at the same topic is deprecated
- **WHEN** the agent calls memory_atom_get
- **THEN** the foreign atom appears in `alsoIn` and its entry includes a status label indicating deprecated

### Requirement: memory_atom_search tool performs full-text search with optional scope filter

The `memory_atom_search` tool's `query` parameter SHALL be renamed to `keywords`. The tool description SHALL state that search is BM25 keyword-based full-text matching — NOT semantic or vector search — and SHALL instruct callers to use exact terms. The tool description SHALL cross-reference `memory_atom_list` for topic-based browsing. The `scope` parameter description SHALL note that its default is `"all"` and that this differs from `memory_atom_list` which defaults to `"workspace"`.

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

#### Scenario: memory_atom_search accepts keywords (not query)
- **GIVEN** atoms exist with matching content
- **WHEN** `memory_atom_search` is called with `keywords: "auth config"`
- **THEN** matching atoms are returned

#### Scenario: memory_atom_search rejects the legacy query parameter name
- **GIVEN** any atoms exist
- **WHEN** `memory_atom_search` is called with `query: "something"` (old param name)
- **THEN** a parameter error or empty result is returned (old name no longer accepted)

### Requirement: memory_atom_list tool lists atoms by topic prefix with default workspace+global scope
The `memory_atom_list` registered tool SHALL invoke the `atom-list` CLI subcommand. With no scope it returns current-workspace and global atoms. `scope='all'` includes atoms from all workspaces. By default the tool returns only `active` and `resolved` atoms (deprecated atoms are excluded). The tool SHALL accept an optional `status` argument (Zod enum: `'active'`, `'resolved'`, `'deprecated'`) for exact-match filtering; when supplied it SHALL override the default filter and `includeDeprecated`. The tool SHALL accept an optional `includeDeprecated` boolean argument; when `true` (and `status` is absent) it SHALL return all three statuses. Each result line SHALL include both `created_at` and `updated_at` rendered as human-readable relative strings and SHALL show the atom's `status`. Non-active atoms SHALL be marked in their entry with a `[resolved]` or `[deprecated]` prefix as appropriate. Pinned atoms SHALL be marked with a `[pinned]` indicator. It SHALL NOT propagate exceptions into the host.

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

### Requirement: memory_atom_delete tool removes an atom by topic

The `memory_atom_delete` tool SHALL remove the `scope` parameter and instead expose a required `workspace` parameter with the same null/`"."`/absolute-path semantics and validation as `memory_atom_write`. The tool description SHALL instruct callers to prefer `memory_atom_patch` with `status="deprecated"` or `status="resolved"` over deletion, and SHALL reserve deletion for atoms that must be permanently removed. The confirmation output SHALL end with the resolved location.

#### Scenario: Tool removes an existing atom and returns confirmation
- **GIVEN** an atom exists at the given (scope, topic)
- **WHEN** the agent calls memory_atom_delete
- **THEN** the atom is removed and the tool returns a one-line confirmation

#### Scenario: Tool returns error result when topic does not exist
- **GIVEN** no atom exists at the given (scope, topic)
- **WHEN** the agent calls memory_atom_delete
- **THEN** the tool returns an informative error result and does not throw

#### Scenario: memory_atom_delete with workspace="." deletes from current project
- **GIVEN** an atom exists at the given topic in the current project workspace
- **WHEN** `memory_atom_delete` is called with `workspace: "."`
- **THEN** the atom is removed and the confirmation ends with `[workspace: /git-root]`

### Requirement: resolveScope translates the agent-facing scope to the CLI scope/project pair

The plugin SHALL provide a `resolveWorkspace(workspace, contextDirectory)` function that replaces `resolveScope`. The function SHALL map: `workspace === null` → `{ scope: 'global', project: '' }`; `workspace === '.'` → expand to `contextDirectory` (absolute), then resolve to git root; any absolute path string → resolve to git root; any non-null non-absolute non-`"."` string → return a validation error as tool output without spawning. Git-root resolution SHALL walk up from the expanded path looking for a `.git` directory (not file — `.git` files are worktree pointers and SHALL be skipped, causing the walk to continue upward); when the filesystem root is reached with no `.git` directory found the expanded path SHALL be returned as-is. `"."` SHALL be expanded to `contextDirectory` (via `path.resolve`) before any walk-up begins — the literal `"."` string SHALL never be passed to the git-root walk or stored in the database.

For read-only tools (`memory_atom_list`, `memory_atom_search`, `memory_atom_get`) the plugin SHALL retain a `resolveScope(scope, directory)` helper that maps the existing agent-facing scope string to CLI positionals: `'workspace'` or `undefined` → `{scope:'project', project:directory}`; `'global'` → `{scope:'global', project:''}`; `'all'` → `{scope:'all', project:''}`.

#### Scenario: resolveScope maps 'workspace' to project scope with directory
- **GIVEN** the current project directory is '/home/user/my-project'
- **WHEN** resolveScope is called with scope='workspace' and directory='/home/user/my-project'
- **THEN** the result is { scope: 'project', project: '/home/user/my-project' }

#### Scenario: resolveScope maps 'global' to empty project
- **WHEN** resolveScope is called with scope='global'
- **THEN** the result is { scope: 'global', project: '' }

#### Scenario: resolveScope maps 'all' to empty project for read operations
- **WHEN** resolveScope is called with scope='all' for a read operation
- **THEN** the result is { scope: 'all', project: '' }

#### Scenario: resolveWorkspace maps null to global scope
- **GIVEN** `workspace` is `null`
- **WHEN** `resolveWorkspace(null, '/home/user/project')` is called
- **THEN** the result is `{ scope: 'global', project: '' }`

#### Scenario: resolveWorkspace maps "." to git root of contextDirectory
- **GIVEN** `contextDirectory` is `/home/user/project` and `/home/user/project/.git` is a directory
- **WHEN** `resolveWorkspace('.', '/home/user/project')` is called
- **THEN** the result is `{ scope: 'project', project: '/home/user/project' }`

#### Scenario: resolveWorkspace maps absolute path to its git root
- **GIVEN** `/home/user/project/.git` is a directory and `/home/user/project/src` exists
- **WHEN** `resolveWorkspace('/home/user/project/src', '/other')` is called
- **THEN** the result is `{ scope: 'project', project: '/home/user/project' }`

#### Scenario: resolveWorkspace skips .git files and continues walking (worktree)
- **GIVEN** `/repo/.worktrees/branch/.git` is a file and `/repo/.git` is a directory
- **WHEN** `resolveWorkspace('/repo/.worktrees/branch', '/other')` is called
- **THEN** the result is `{ scope: 'project', project: '/repo' }`

#### Scenario: resolveWorkspace falls back to expanded path when no .git directory is found
- **GIVEN** no `.git` directory exists in any ancestor of `/no-git/project`
- **WHEN** `resolveWorkspace('/no-git/project', '/other')` is called
- **THEN** the result is `{ scope: 'project', project: '/no-git/project' }`

### Requirement: atom write tools capture session context at the plugin layer, not as agent arguments
The `memory_atom_write` and `memory_atom_append` tools SHALL capture `session_id` from `ToolContext.sessionID` and look up `session_name` from the in-process `sessionNames` Map (populated at `session.created` from `event.properties.info.title`) before spawning the CLI. These values SHALL be passed as part of the JSON payload to the CLI but SHALL NOT appear in the public tool argument schema visible to the agent.

#### Scenario: Session context is transparently included in atom write
- **GIVEN** a session with sessionID='s1' and session_name='my session' is active
- **WHEN** the agent calls memory_atom_write with topic and content
- **THEN** the stored atom has session_id='s1' and session_name='my session' without the agent specifying them

#### Scenario: Session name is null when session.created info.title was absent
- **GIVEN** a session was created without a title in event.properties.info
- **WHEN** the agent calls memory_atom_write
- **THEN** the stored atom has session_name=null and no error is raised

### Requirement: memory_atom_patch tool performs content-preserving metadata updates

The `memory_atom_patch` tool SHALL remove the `scope` parameter and expose a required top-level `workspace` parameter (source locator — where the atom currently lives) with the same null/`"."`/absolute-path semantics as `memory_atom_write`. The `patch` sub-object SHALL gain an optional `workspace` field (destination) — when `patch.workspace` is supplied, the tool SHALL perform an atomic move: the atom is deleted from the source workspace and re-inserted at the destination in one transaction (BEGIN IMMEDIATE). Combined move + metadata: other patch fields present alongside `patch.workspace` are applied to the atom before it lands at the destination. Source equals destination (resolved locators identical): treated as an in-place patch. Destination conflict: overwritten. `patch.workspace` SHALL follow the same null/`"."`/absolute-path resolution rules as the top-level `workspace`.

#### Scenario: memory_atom_patch toggles always_include via patch sub-object
- **GIVEN** an atom with `always_include = 0`
- **WHEN** `memory_atom_patch` is called with `patch: { always_include: true }`
- **THEN** the atom has `always_include = 1`

#### Scenario: memory_atom_patch clears always_include via patch sub-object
- **GIVEN** an atom with `always_include = 1`
- **WHEN** `memory_atom_patch` is called with `patch: { always_include: false }`
- **THEN** the atom has `always_include = 0`

#### Scenario: memory_atom_patch moves atom to new workspace
- **GIVEN** an atom exists at topic 'arch/db' in project '/repo-a'
- **WHEN** `memory_atom_patch` is called with `workspace: "/repo-a"` and `patch: { workspace: "/repo-b" }`
- **THEN** the atom is absent from '/repo-a' and present at '/repo-b' with all fields preserved, and the confirmation states it was moved

#### Scenario: memory_atom_patch moves atom to global store
- **GIVEN** an atom exists at topic 'work/note' in current workspace
- **WHEN** `memory_atom_patch` is called with `workspace: "."` and `patch: { workspace: null }`
- **THEN** the atom is absent from the workspace and present in the global store

#### Scenario: memory_atom_patch combined move and metadata
- **GIVEN** an atom exists at topic 'arch/db' in '/repo-a' with status='active'
- **WHEN** `memory_atom_patch` is called with `workspace: "/repo-a"`, `patch: { workspace: "/repo-b", status: "resolved" }`
- **THEN** the atom lands at '/repo-b' with status='resolved'

#### Scenario: memory_atom_patch source equals destination is an in-place patch
- **GIVEN** an atom exists at topic 'arch/db' in the current workspace
- **WHEN** `memory_atom_patch` is called with `workspace: "."` and `patch: { workspace: ".", description: "updated" }`
- **THEN** no move occurs; the atom remains in place with the updated description

### Requirement: MEMORY_PROTOCOL teaches agents status lifecycle semantics

The `MEMORY_PROTOCOL` constant SHALL replace the "Scope" guidance paragraph with an "Addressing" paragraph that states: pass `workspace: "."` for the current project (resolves to its git root), `workspace: null` for global — and that `workspace` is always required (there is no default). The constant SHALL include a "Searching" note that states `memory_atom_search` uses BM25 keyword matching and is NOT semantic search. The constant SHALL include a `/migrate-workspace-atoms` procedure that instructs agents to: call `memory_workspaces_list`, check each path against its git root via `git -C <path> rev-parse --show-toplevel`, and for each non-root path move its atoms to the git root using `memory_atom_patch` with `patch.workspace` set to the git root.

#### Scenario: MEMORY_PROTOCOL contains always_include guidance
- **GIVEN** the plugin tool definitions are loaded
- **WHEN** the `MEMORY_PROTOCOL` constant is inspected
- **THEN** it contains a description of `always_include`, the toggle command, the 5-per-scope cap, the misuse warning, and the distinction from `pinned`

#### Scenario: MEMORY_PROTOCOL contains workspace addressing guidance
- **GIVEN** the plugin tool definitions are loaded
- **WHEN** the `MEMORY_PROTOCOL` constant is inspected
- **THEN** it contains guidance stating workspace is required, null=global, "."=current project git root, and there is no default

#### Scenario: MEMORY_PROTOCOL contains BM25 search note
- **GIVEN** the plugin tool definitions are loaded
- **WHEN** the `MEMORY_PROTOCOL` constant is inspected
- **THEN** it contains a note that memory_atom_search uses BM25 keyword matching and is not semantic search

#### Scenario: MEMORY_PROTOCOL contains migration procedure
- **GIVEN** the plugin tool definitions are loaded
- **WHEN** the `MEMORY_PROTOCOL` constant is inspected
- **THEN** it contains the /migrate-workspace-atoms procedure referencing memory_workspaces_list and memory_atom_patch

### Requirement: memory_atom_write confirmation includes resolved location

The `memory_atom_write` tool output SHALL end with the resolved storage location in the format `[workspace: /abs/git-root]` for workspace-scoped atoms or `[global]` for global atoms.

#### Scenario: Write confirmation includes workspace location
- **GIVEN** the atom is written to workspace scope at git root '/repo'
- **WHEN** `memory_atom_write` returns its confirmation
- **THEN** the output ends with `[workspace: /repo]`

#### Scenario: Write confirmation includes global marker
- **GIVEN** the atom is written to the global store
- **WHEN** `memory_atom_write` returns its confirmation
- **THEN** the output ends with `[global]`

