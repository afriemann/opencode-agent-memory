# memory-atom-tools Specification

## Purpose
TBD - created by archiving change memory-atoms-and-session-hot-state. Update Purpose after archive.
## Requirements
### Requirement: memory_atom_write tool upserts an atom with required description
The `memory_atom_write` registered tool SHALL invoke the `atom-write` CLI subcommand, passing a required `description` field and optional `scope` (default `'workspace'`). The tool SHALL accept an optional `created_at` argument (ISO 8601 string or epoch ms integer); when supplied it SHALL be converted to epoch ms and forwarded to the CLI as `createdAt`. The tool SHALL accept an optional `pinned` boolean argument (default `false`); when supplied it SHALL be forwarded to the CLI as `pinned`. The `pinned` value is applied only on INSERT (first creation); on a re-write of an existing atom the existing `pinned` state is preserved — use `memory_atom_patch` to change pin state. Atom `status` is always `'active'` at creation and is preserved on content re-write — `status` is never an argument to `memory_atom_write`. The tool description SHALL state both the INSERT-only pin caveat and the status preservation rule explicitly. The tool SHALL return the create-or-overwrite confirmation line from the CLI. It SHALL return an informative error result on CLI failure and SHALL NOT propagate exceptions into the opencode host.

#### Scenario: Tool creates a new atom with active status
- **GIVEN** no atom exists at the given topic in the current workspace
- **WHEN** the agent calls memory_atom_write with topic, content, and description
- **THEN** the tool returns 'Created atom at <topic>' and the new atom has `status='active'`

#### Scenario: Tool preserves resolved status on re-write
- **GIVEN** an atom exists at the given topic with `status='resolved'`
- **WHEN** the agent calls memory_atom_write with the same topic and new content
- **THEN** the tool returns 'Updated existing atom at <topic>…' and the atom's `status` remains `'resolved'`

### Requirement: memory_atom_append tool appends to an existing atom
The `memory_atom_append` registered tool SHALL invoke the `atom-append` CLI subcommand. It SHALL return the full updated content on success. If the topic does not exist the CLI exits non-zero and the tool SHALL surface the error message ("Atom '<topic>' does not exist — use memory_atom_write to create it first") as a ToolResult. It SHALL NOT propagate exceptions into the host.

#### Scenario: Tool appends content and returns updated full content
- **GIVEN** an atom exists at the given topic
- **WHEN** the agent calls memory_atom_append with additional content
- **THEN** the tool returns the full content of the atom after the append

#### Scenario: Tool surfaces error when topic is missing
- **GIVEN** no atom exists at the given topic
- **WHEN** the agent calls memory_atom_append
- **THEN** the tool returns an error result containing the missing-topic message and does not throw

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
The `memory_atom_search` registered tool SHALL invoke the `atom-search` CLI subcommand. With no `scope` argument it searches all workspaces by default. The optional `scope` parameter (`'workspace'` or `'global'`) narrows the search. By default the tool excludes `deprecated` atoms from results. The tool SHALL accept an optional `status` argument (Zod enum: `'active'`, `'resolved'`, `'deprecated'`) for exact-match filtering; when supplied it SHALL override the default filter and `includeDeprecated`. The tool SHALL accept an optional `includeDeprecated` boolean argument; when `true` (and `status` is absent) it SHALL include all three statuses. Results include project context and both `created_at` and `updated_at` rendered as human-readable relative strings. It SHALL NOT propagate exceptions into the host.

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
The `memory_atom_delete` registered tool SHALL invoke the `atom-delete` CLI subcommand and return a confirmation on success. It SHALL surface a non-zero CLI exit as an error result and SHALL NOT propagate exceptions into the host.

#### Scenario: Tool removes an existing atom and returns confirmation
- **GIVEN** an atom exists at the given (scope, topic)
- **WHEN** the agent calls memory_atom_delete
- **THEN** the atom is removed and the tool returns a one-line confirmation

#### Scenario: Tool returns error result when topic does not exist
- **GIVEN** no atom exists at the given (scope, topic)
- **WHEN** the agent calls memory_atom_delete
- **THEN** the tool returns an informative error result and does not throw

### Requirement: resolveScope translates the agent-facing scope to the CLI scope/project pair
The plugin SHALL provide a `resolveScope(scope, directory)` helper that maps the agent-facing `scope` parameter to the CLI/DB values before every spawn: `'workspace'` or `undefined` maps to `{scope:'project', project:directory}`; `'global'` maps to `{scope:'global', project:''}`; `'all'` maps to `{scope:'all', project:''}` (read operations only). Writes SHALL only accept `'workspace'` or `'global'` and SHALL error if `'all'` is supplied.

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
The `memory_atom_patch` registered tool SHALL invoke the `atom-patch` CLI subcommand to update one or more of `description`, `tags`, `created_at`, `pinned`, and `status` for an existing atom without modifying its content. The five patchable fields SHALL be supplied inside a required `patch` sub-object; the lookup keys `topic`, `scope`, and `workspace` remain top-level arguments. At least one field inside `patch` MUST be present; an empty `patch` object (no fields supplied) SHALL be rejected with a clear error result. Setting `patch.tags: []` SHALL clear existing tags; omitting `patch.tags` SHALL leave existing tags unchanged. Omitting `patch.pinned` SHALL leave the existing pin state unchanged; supplying `patch.pinned: false` SHALL unpin the atom. Omitting `patch.status` SHALL leave the existing status unchanged. The `patch.status` field SHALL be a Zod enum accepting only `'active'`, `'resolved'`, or `'deprecated'`; other values SHALL be rejected at the schema layer with a descriptive error before the CLI is invoked. `patch.created_at` SHALL accept either an ISO 8601 date string or an epoch-ms number and be normalised to an epoch-ms integer in the plugin before the CLI is invoked. A `created_at`-only patch SHALL NOT modify the atom's `updated_at` timestamp; a patch that includes `description`, `tags`, `pinned`, or `status` SHALL bump `updated_at`. An empty `patch.description` after trimming SHALL be rejected with an error result. `scope="all"` SHALL be rejected. The optional `workspace` argument (a directory path) SHALL substitute the effective directory for scope resolution, mirroring `memory_atom_get`. On success the tool SHALL return a confirmation message naming the topic and the changed fields. It SHALL NOT propagate exceptions into the host.

#### Scenario: Tool patches status to resolved and bumps updated_at
- **GIVEN** an atom exists at topic 'work/notes' with `status='active'` and known `updated_at`
- **WHEN** the agent calls memory_atom_patch with `patch={status: 'resolved'}`
- **THEN** the tool returns a success message containing 'work/notes' and 'status', and `updated_at` is bumped

#### Scenario: Tool rejects invalid status value at the schema layer
- **GIVEN** an atom exists at topic 'work/notes'
- **WHEN** the agent calls memory_atom_patch with `patch={status: 'invalid'}`
- **THEN** the tool returns an error result indicating the value must be one of the allowed enum values and does not invoke the CLI

#### Scenario: Tool leaves status unchanged when status is omitted
- **GIVEN** an atom exists at topic 'work/notes' with `status='resolved'`
- **WHEN** the agent calls memory_atom_patch with only `patch={description: 'updated'}`
- **THEN** the atom's `status` remains `'resolved'`

### Requirement: MEMORY_PROTOCOL teaches agents status lifecycle semantics
The `MEMORY_PROTOCOL` constant injected into tracked-session system prompts SHALL include a lifecycle block that: names the three status values (`active`, `resolved`, `deprecated`) and their visibility semantics (active = all surfaces; resolved = list/search default + atom-get, not primer; deprecated = explicit retrieval only); instructs agents to prefer `memory_atom_patch` with `status='deprecated'` or `status='resolved'` over `memory_atom_delete` when retiring an atom; and clarifies that `atom-list` and `atom-search` exclude deprecated atoms by default.

#### Scenario: MEMORY_PROTOCOL contains status lifecycle guidance
- **GIVEN** the MEMORY_PROTOCOL constant is read from the plugin source
- **WHEN** its text is inspected
- **THEN** it contains the three status values with their visibility semantics, a statement preferring patch-status over delete, and a note that deprecated atoms are excluded from list/search by default

