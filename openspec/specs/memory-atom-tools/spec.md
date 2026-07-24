# memory-atom-tools Specification

## Purpose
TBD - created by archiving change memory-atoms-and-session-hot-state. Update Purpose after archive.
## Requirements
### Requirement: memory_atom_write tool upserts an atom with required description
The `memory_atom_write` registered tool SHALL invoke the `atom-write` CLI subcommand, passing a required `description` field and optional `scope` (default `'workspace'`). The tool SHALL accept an optional `created_at` argument (ISO 8601 string or epoch ms integer); when supplied it SHALL be converted to epoch ms and forwarded to the CLI as `createdAt`. The tool SHALL return the create-or-overwrite confirmation line from the CLI. It SHALL return an informative error result on CLI failure and SHALL NOT propagate exceptions into the opencode host.

#### Scenario: Tool creates a new atom and reports Created
- **GIVEN** no atom exists at the given topic in the current workspace
- **WHEN** the agent calls memory_atom_write with topic, content, and description
- **THEN** the tool returns 'Created atom at <topic>'

#### Scenario: Tool overwrites an existing atom and reports Updated
- **GIVEN** an atom already exists at the given topic
- **WHEN** the agent calls memory_atom_write with the same topic and new content
- **THEN** the tool returns 'Updated existing atom at <topic> (previous content overwritten)'

#### Scenario: Tool failure is caught and returned as a ToolResult
- **GIVEN** the CLI call fails (e.g. malformed args or DB locked)
- **WHEN** the agent calls memory_atom_write
- **THEN** the tool returns an informative error result and does not propagate an unhandled rejection into the opencode host

#### Scenario: Tool passes created_at through to CLI when supplied as ISO string
- **GIVEN** the agent calls memory_atom_write with created_at='2024-01-01T00:00:00.000Z'
- **WHEN** the CLI payload is assembled
- **THEN** the payload contains `createdAt` equal to `new Date('2024-01-01T00:00:00.000Z').getTime()` (epoch ms)

#### Scenario: Tool passes created_at through to CLI when supplied as epoch ms integer
- **GIVEN** the agent calls memory_atom_write with created_at=1000 (number)
- **WHEN** the CLI payload is assembled
- **THEN** the payload contains `createdAt=1000`

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
The `memory_atom_get` registered tool SHALL invoke the `atom-get` CLI subcommand and return the `{ match, alsoIn }` payload. The match section contains the full content of the best-match atom (workspace priority over global) with both creation and update timestamps rendered as human-readable relative strings. The alsoIn section lists same-topic atoms from other workspaces with the format `• [workspace: <path>] <topic> — <description> | <preview> [created: …, updated: …]` for workspace-scoped entries and `• [global] <topic> — <description> | <preview> [created: …, updated: …]` for global-scoped entries. The tool SHALL accept an optional `workspace` argument (a directory path); when provided, the effective directory for scope resolution SHALL be the given path rather than the current session directory, allowing the named workspace's atom to be promoted to the primary match. When `scope` is `"global"` it SHALL take precedence over the `workspace` argument. It SHALL NOT propagate exceptions into the host.

#### Scenario: Tool returns full content for workspace-priority match
- **GIVEN** an atom exists at the given topic in the current workspace
- **WHEN** the agent calls memory_atom_get
- **THEN** the tool output contains the full content of the current-workspace atom and any alsoIn entries

#### Scenario: Tool reports no match and lists foreign atoms when only other workspaces have the topic
- **GIVEN** no current-workspace or global atom exists but another workspace's atom does
- **WHEN** the agent calls memory_atom_get
- **THEN** the tool output indicates no match and lists the foreign atom with a 80-char preview formatted as `• [workspace: <path>] …`

#### Scenario: Tool output includes created and updated timestamps for the match
- **GIVEN** an atom exists with known created_at and updated_at values
- **WHEN** the agent calls memory_atom_get
- **THEN** the tool output includes both a creation timestamp and an update timestamp rendered as human-readable relative strings

#### Scenario: Tool with workspace arg promotes foreign atom to primary match
- **GIVEN** an atom exists at the given topic in workspace B but not in the current workspace
- **WHEN** the agent calls memory_atom_get with workspace=<path-to-B>
- **THEN** the tool output contains the full content of workspace B's atom as the primary match

#### Scenario: Tool alsoIn renders workspace entries with bracketed path and global entries with [global] label
- **GIVEN** a current-workspace match exists and both a workspace-B atom and a global atom exist at the same topic
- **WHEN** the agent calls memory_atom_get
- **THEN** the workspace-B alsoIn entry is formatted as `• [workspace: <path>] …` and the global entry as `• [global] …`

### Requirement: memory_atom_search tool performs full-text search with optional scope filter
The `memory_atom_search` registered tool SHALL invoke the `atom-search` CLI subcommand. With no `scope` argument it searches all workspaces by default. The optional `scope` parameter (`'workspace'` or `'global'`) narrows the search. Results include project context and both `created_at` and `updated_at` rendered as human-readable relative strings. It SHALL NOT propagate exceptions into the host.

#### Scenario: Tool returns results from all workspaces when no scope is specified
- **GIVEN** matching atoms exist in the current workspace and a second workspace
- **WHEN** the agent calls memory_atom_search without a scope argument
- **THEN** the tool returns results from both workspaces, each showing its project context

#### Scenario: Tool restricts results when scope='workspace' is specified
- **GIVEN** matching atoms exist in both the current workspace and another workspace
- **WHEN** the agent calls memory_atom_search with scope='workspace'
- **THEN** only the current-workspace result is returned

#### Scenario: Tool output includes created and updated timestamps per result
- **GIVEN** matching atoms with known timestamps exist
- **WHEN** the agent calls memory_atom_search
- **THEN** each result line includes both a creation timestamp and an update timestamp as human-readable relative strings

### Requirement: memory_atom_list tool lists atoms by topic prefix with default workspace+global scope
The `memory_atom_list` registered tool SHALL invoke the `atom-list` CLI subcommand. With no scope it returns current-workspace and global atoms. `scope='all'` includes atoms from all workspaces. Each result line SHALL include both `created_at` and `updated_at` rendered as human-readable relative strings. It SHALL NOT propagate exceptions into the host.

#### Scenario: Tool lists current-workspace and global atoms by default
- **GIVEN** atoms exist in the current workspace, globally, and in a second workspace
- **WHEN** the agent calls memory_atom_list without scope
- **THEN** the tool returns current-workspace and global atoms; the second workspace's atoms are excluded

#### Scenario: Tool lists all atoms when scope='all' is passed
- **GIVEN** atoms exist in multiple workspaces
- **WHEN** the agent calls memory_atom_list with scope='all'
- **THEN** atoms from all workspaces are returned

#### Scenario: Tool output includes created and updated timestamps per result
- **GIVEN** atoms with known timestamps exist
- **WHEN** the agent calls memory_atom_list
- **THEN** each result line includes both a creation timestamp and an update timestamp as human-readable relative strings

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
The `memory_atom_patch` registered tool SHALL invoke the `atom-patch` CLI subcommand to update one or more of `description`, `tags`, and `created_at` for an existing atom without modifying its content. The patchable fields SHALL be supplied as a required `patch` sub-object; the lookup keys `topic`, `scope`, and `workspace` remain top-level arguments. At least one field inside `patch` MUST be present; an empty `patch` object (no fields supplied) SHALL be rejected with a clear error result. Setting `patch.tags: []` SHALL clear existing tags; omitting `patch.tags` SHALL leave existing tags unchanged. `patch.created_at` SHALL accept either an ISO 8601 date string or an epoch-ms number and be normalised to an epoch-ms integer in the plugin before the CLI is invoked. A `created_at`-only patch SHALL NOT modify the atom's `updated_at` timestamp; a patch that includes `description` or `tags` SHALL bump `updated_at`. An empty `patch.description` after trimming SHALL be rejected with an error result. `scope="all"` SHALL be rejected. The optional `workspace` argument (a directory path) SHALL substitute the effective directory for scope resolution, mirroring `memory_atom_get`. On success the tool SHALL return a confirmation message naming the topic and the changed fields. It SHALL NOT propagate exceptions into the host.

#### Scenario: Tool patches description and tags, returns confirmation naming changed fields
- **GIVEN** an atom exists at topic 'work/notes' with description='old' and tags=['old-tag']
- **WHEN** the agent calls memory_atom_patch with patch={ description='new', tags=['new-tag'] }
- **THEN** the tool returns a success message containing 'work/notes' and listing 'description' and 'tags' among the patched fields

#### Scenario: Tool patches created_at only and leaves updated_at unchanged
- **GIVEN** an atom exists at topic 'work/notes' with a known updated_at
- **WHEN** the agent calls memory_atom_patch with patch={ created_at=<timestamp> } only
- **THEN** the atom's created_at is updated and updated_at is not changed

#### Scenario: Tool accepts ISO 8601 string for created_at and normalises to epoch ms
- **GIVEN** an atom exists at topic 'work/notes'
- **WHEN** the agent calls memory_atom_patch with patch={ created_at="2025-01-01T00:00:00.000Z" }
- **THEN** the atom's created_at is stored as the equivalent epoch-ms integer (1735689600000)

#### Scenario: Tool rejects empty patch call
- **GIVEN** an atom exists at topic 'work/notes'
- **WHEN** the agent calls memory_atom_patch with an empty patch object (no fields inside patch)
- **THEN** the tool returns an error result indicating at least one field is required and does not throw

#### Scenario: Tool rejects empty description
- **GIVEN** an atom exists at topic 'work/notes'
- **WHEN** the agent calls memory_atom_patch with patch={ description='' }
- **THEN** the tool returns an error result about non-empty description and does not throw

#### Scenario: Tool rejects scope='all'
- **GIVEN** any atom exists
- **WHEN** the agent calls memory_atom_patch with scope='all'
- **THEN** the tool returns an error result about unsupported scope and does not throw

#### Scenario: Tool surfaces error when atom does not exist
- **GIVEN** no atom exists at topic 'arch/missing'
- **WHEN** the agent calls memory_atom_patch with patch={ description='x' } for that topic
- **THEN** the tool returns an error result containing the missing-atom message and does not throw

