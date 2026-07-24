## MODIFIED Requirements

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

### Requirement: memory_atom_get tool returns best-match content and foreign-workspace listing
The `memory_atom_get` registered tool SHALL invoke the `atom-get` CLI subcommand and return the `{ match, alsoIn }` payload. The match section contains the full content of the best-match atom (workspace priority over global) with both creation and update timestamps rendered as human-readable relative strings. The alsoIn section lists same-topic atoms from other workspaces (topic, description, 80-char preview) each with its `updated_at` rendered as a relative string. It SHALL NOT propagate exceptions into the host.

#### Scenario: Tool returns full content for workspace-priority match
- **GIVEN** an atom exists at the given topic in the current workspace
- **WHEN** the agent calls memory_atom_get
- **THEN** the tool output contains the full content of the current-workspace atom and any alsoIn entries

#### Scenario: Tool reports no match and lists foreign atoms when only other workspaces have the topic
- **GIVEN** no current-workspace or global atom exists but another workspace's atom does
- **WHEN** the agent calls memory_atom_get
- **THEN** the tool output indicates no match and lists the foreign atom with a 80-char preview

#### Scenario: Tool output includes created and updated timestamps for the match
- **GIVEN** an atom exists with known created_at and updated_at values
- **WHEN** the agent calls memory_atom_get
- **THEN** the tool output includes both a creation timestamp and an update timestamp rendered as human-readable relative strings

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
