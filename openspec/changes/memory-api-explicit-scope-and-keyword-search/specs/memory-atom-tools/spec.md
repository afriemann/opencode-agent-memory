## MODIFIED Requirements

### Requirement: resolveScope translates the agent-facing scope to the CLI scope/project pair

The plugin SHALL provide a `resolveWorkspace(workspace, contextDirectory)` function that replaces `resolveScope`. The function SHALL map: `workspace === null` → `{ scope: 'global', project: '' }`; `workspace === '.'` → expand to `contextDirectory` (absolute), then resolve to git root; any absolute path string → resolve to git root; any non-null non-absolute non-`"."` string → return a validation error as tool output without spawning. Git-root resolution SHALL walk up from the expanded path looking for a `.git` directory (not file — `.git` files are worktree pointers and SHALL be skipped, causing the walk to continue upward); when the filesystem root is reached with no `.git` directory found the expanded path SHALL be returned as-is. `"."` SHALL be expanded to `contextDirectory` (via `path.resolve`) before any walk-up begins — the literal `"."` string SHALL never be passed to the git-root walk or stored in the database.

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

### Requirement: memory_atom_write tool upserts an atom with required description

The `memory_atom_write` tool SHALL remove the `scope` parameter and instead expose a required `workspace` parameter. `workspace` SHALL accept `null` (global store), `"."` (current project — resolves to git root of `context.directory`), or an absolute path string (foreign project — resolves to its git root). Callers that omit `workspace` SHALL receive a schema validation error. Callers that supply a relative path other than `"."` SHALL receive a tool-output validation error without spawning. The confirmation output SHALL end with the resolved location: `[workspace: /path]` or `[global]`. The tool description SHALL direct callers to use `memory_atom_append` when they need to add content without replacing existing content.

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

#### Scenario: memory_atom_append with workspace="." appends to current project atom
- **GIVEN** an atom exists at topic 'work/notes' in the current project workspace
- **WHEN** `memory_atom_append` is called with `workspace: "."` and content
- **THEN** the content is appended and the response ends with the resolved location

### Requirement: memory_atom_delete tool removes an atom by topic

The `memory_atom_delete` tool SHALL remove the `scope` parameter and instead expose a required `workspace` parameter with the same null/`"."`/absolute-path semantics and validation as `memory_atom_write`. The tool description SHALL instruct callers to prefer `memory_atom_patch` with `status="deprecated"` or `status="resolved"` over deletion, and SHALL reserve deletion for atoms that must be permanently removed. The confirmation output SHALL end with the resolved location.

#### Scenario: memory_atom_delete with workspace="." deletes from current project
- **GIVEN** an atom exists at the given topic in the current project workspace
- **WHEN** `memory_atom_delete` is called with `workspace: "."`
- **THEN** the atom is removed and the confirmation ends with `[workspace: /git-root]`

### Requirement: memory_atom_patch tool performs content-preserving metadata updates

The `memory_atom_patch` tool SHALL remove the `scope` parameter and expose a required top-level `workspace` parameter (source locator — where the atom currently lives) with the same null/`"."`/absolute-path semantics as `memory_atom_write`. The `patch` sub-object SHALL gain an optional `workspace` field (destination) — when `patch.workspace` is supplied, the tool SHALL perform an atomic move: the atom is deleted from the source workspace and re-inserted at the destination in one transaction (BEGIN IMMEDIATE). Combined move + metadata: other patch fields present alongside `patch.workspace` are applied to the atom before it lands at the destination. Source equals destination (resolved locators identical): treated as an in-place patch. Destination conflict: overwritten. `patch.workspace` SHALL follow the same null/`"."`/absolute-path resolution rules as the top-level `workspace`.

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

### Requirement: memory_atom_search tool performs full-text search with optional scope filter

The `memory_atom_search` tool's `query` parameter SHALL be renamed to `keywords`. The tool description SHALL state that search is BM25 keyword-based full-text matching — NOT semantic or vector search — and SHALL instruct callers to use exact terms. The tool description SHALL cross-reference `memory_atom_list` for topic-based browsing. The `scope` parameter description SHALL note that its default is `"all"` and that this differs from `memory_atom_list` which defaults to `"workspace"`.

#### Scenario: memory_atom_search accepts keywords (not query)
- **GIVEN** atoms exist with matching content
- **WHEN** `memory_atom_search` is called with `keywords: "auth config"`
- **THEN** matching atoms are returned

#### Scenario: memory_atom_search rejects the legacy query parameter name
- **GIVEN** any atoms exist
- **WHEN** `memory_atom_search` is called with `query: "something"` (old param name)
- **THEN** a parameter error or empty result is returned (old name no longer accepted)

### Requirement: MEMORY_PROTOCOL teaches agents status lifecycle semantics

The `MEMORY_PROTOCOL` constant SHALL replace the "Scope" guidance paragraph with an "Addressing" paragraph that states: pass `workspace: "."` for the current project (resolves to its git root), `workspace: null` for global — and that `workspace` is always required (there is no default). The constant SHALL include a "Searching" note that states `memory_atom_search` uses BM25 keyword matching and is NOT semantic search. The constant SHALL include a `/migrate-workspace-atoms` procedure that instructs agents to: call `memory_workspaces_list`, check each path against its git root via `git -C <path> rev-parse --show-toplevel`, and for each non-root path move its atoms to the git root using `memory_atom_patch` with `patch.workspace` set to the git root.

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

## ADDED Requirements

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
