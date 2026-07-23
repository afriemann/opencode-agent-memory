## ADDED Requirements

### Requirement: memory_atom_write tool upserts an atom with required description
The `memory_atom_write` registered tool SHALL invoke the `atom-write` CLI subcommand, passing a required `description` field and optional `scope` (default `'workspace'`). The tool SHALL return the create-or-overwrite confirmation line from the CLI. It SHALL return an informative error result on CLI failure and SHALL NOT propagate exceptions into the opencode host.

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
The `memory_atom_get` registered tool SHALL invoke the `atom-get` CLI subcommand and return the `{ match, alsoIn }` payload. The match section contains the full content of the best-match atom (workspace priority over global). The alsoIn section lists same-topic atoms from other workspaces (topic, description, 80-char preview). It SHALL NOT propagate exceptions into the host.

#### Scenario: Tool returns full content for workspace-priority match
- **GIVEN** an atom exists at the given topic in the current workspace
- **WHEN** the agent calls memory_atom_get
- **THEN** the tool output contains the full content of the current-workspace atom and any alsoIn entries

#### Scenario: Tool reports no match and lists foreign atoms when only other workspaces have the topic
- **GIVEN** no current-workspace or global atom exists but another workspace's atom does
- **WHEN** the agent calls memory_atom_get
- **THEN** the tool output indicates no match and lists the foreign atom with a 80-char preview

### Requirement: memory_atom_search tool performs full-text search with optional scope filter
The `memory_atom_search` registered tool SHALL invoke the `atom-search` CLI subcommand. With no `scope` argument it searches all workspaces by default. The optional `scope` parameter (`'workspace'` or `'global'`) narrows the search. Results include project context. It SHALL NOT propagate exceptions into the host.

#### Scenario: Tool returns results from all workspaces when no scope is specified
- **GIVEN** matching atoms exist in the current workspace and a second workspace
- **WHEN** the agent calls memory_atom_search without a scope argument
- **THEN** the tool returns results from both workspaces, each showing its project context

#### Scenario: Tool restricts results when scope='workspace' is specified
- **GIVEN** matching atoms exist in both the current workspace and another workspace
- **WHEN** the agent calls memory_atom_search with scope='workspace'
- **THEN** only the current-workspace result is returned

### Requirement: memory_atom_list tool lists atoms by topic prefix with default workspace+global scope
The `memory_atom_list` registered tool SHALL invoke the `atom-list` CLI subcommand. With no scope it returns current-workspace and global atoms. `scope='all'` includes atoms from all workspaces. It SHALL NOT propagate exceptions into the host.

#### Scenario: Tool lists current-workspace and global atoms by default
- **GIVEN** atoms exist in the current workspace, globally, and in a second workspace
- **WHEN** the agent calls memory_atom_list without scope
- **THEN** the tool returns current-workspace and global atoms; the second workspace's atoms are excluded

#### Scenario: Tool lists all atoms when scope='all' is passed
- **GIVEN** atoms exist in multiple workspaces
- **WHEN** the agent calls memory_atom_list with scope='all'
- **THEN** atoms from all workspaces are returned

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
