# memory-atom-tools Specification

## Purpose
TBD - created by archiving change memory-atoms-and-session-hot-state. Update Purpose after archive.
## Requirements
### Requirement: memory_atom_write tool upserts an atom with required description

The `memory_atom_write` tool SHALL accept a required, non-empty `summary` argument (max 280 chars) in addition to the required `description` argument. The `summary` SHALL represent a one-sentence digest of what the atom's content contains, distinct from `description` (which says what the atom is *for*). The tool description SHALL state that `summary` is required, that it appears in directory listings so other agents can triage without fetching, that it must be at most 280 characters, and that it is distinct from `description`. The tool SHALL accept an optional `always_include` boolean argument (default `false`). The tool description SHALL state that `always_include` is INSERT-only: setting it on first creation stores the value; a re-write of the same topic never changes it, and `memory_atom_patch` MUST be used to toggle it after creation.

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

The `memory_atom_get` registered tool SHALL invoke the `atom-get` CLI subcommand and return the `{ match, alsoIn }` payload. The match section contains the full content of the best-match atom (workspace priority over global) with both creation and update timestamps rendered as human-readable relative strings. The match section SHALL include the atom's `status`. The alsoIn section lists same-topic atoms from other workspaces; each `alsoIn` row carries both `summary` and `preview` fields. The `alsoIn` formatted entry SHALL display `summary` when non-empty, else fall back to `preview`; when both are empty the content segment and its `|` separator SHALL be omitted. The `alsoIn` format SHALL be `• [workspace: <path>] <topic> — <description>[ | <summary-or-preview>] [created: …, updated: …]` for workspace-scoped entries and `• [global] <topic> — <description>[ | <summary-or-preview>] [created: …, updated: …]` for global-scoped entries; `alsoIn` entries SHALL show the atom's status when it is not `active`. The tool SHALL accept an optional `workspace` argument (a directory path); when provided, the effective directory for scope resolution SHALL be the given path rather than the current session directory, allowing the named workspace's atom to be promoted to the primary match. When `scope` is `"global"` it SHALL take precedence over the `workspace` argument. `atom-get` applies no status filtering — the match is always returned regardless of `status`. It SHALL NOT propagate exceptions into the host.

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

#### Scenario: Tool alsoIn shows summary when non-empty
- **GIVEN** a foreign atom at the same topic exists with `summary='Key design note'`
- **WHEN** the agent calls memory_atom_get
- **THEN** the alsoIn entry for that atom includes 'Key design note' instead of a raw content preview

#### Scenario: Tool alsoIn falls back to preview when summary is empty
- **GIVEN** a foreign atom at the same topic exists with `summary=''` and non-empty content
- **WHEN** the agent calls memory_atom_get
- **THEN** the alsoIn entry for that atom includes the first 80 characters of the content

### Requirement: memory_atom_search tool performs full-text search with optional scope filter

The `memory_atom_search` registered tool SHALL invoke the `atom-search` CLI subcommand. With no `scope` argument it searches all workspaces by default. The optional `scope` parameter (`'workspace'` or `'global'`) narrows the search. By default the tool excludes `deprecated` atoms from results. The tool SHALL accept an optional `status` argument (Zod enum: `'active'`, `'resolved'`, `'deprecated'`) for exact-match filtering; when supplied it SHALL override the default filter and `includeDeprecated`. The tool SHALL accept an optional `includeDeprecated` boolean argument; when `true` (and `status` is absent) it SHALL include all three statuses. Results include project context, both `created_at` and `updated_at` rendered as human-readable relative strings, and `summary` displayed when non-empty (falling back to preview). It SHALL NOT propagate exceptions into the host.

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

### Requirement: memory_atom_list tool lists atoms by topic prefix with default workspace+global scope

The `memory_atom_list` registered tool SHALL invoke the `atom-list` CLI subcommand. With no scope it returns current-workspace and global atoms. `scope='all'` includes atoms from all workspaces. By default the tool returns only `active` and `resolved` atoms (deprecated atoms are excluded). The tool SHALL accept an optional `status` argument (Zod enum: `'active'`, `'resolved'`, `'deprecated'`) for exact-match filtering; when supplied it SHALL override the default filter and `includeDeprecated`. The tool SHALL accept an optional `includeDeprecated` boolean argument; when `true` (and `status` is absent) it SHALL return all three statuses. Each result line SHALL include both `created_at` and `updated_at` rendered as human-readable relative strings and SHALL show the atom's `status`. Non-active atoms SHALL be marked in their entry with a `[resolved]` or `[deprecated]` prefix as appropriate. Pinned atoms SHALL be marked with a `[pinned]` indicator. Each result line SHALL display `summary` when non-empty; when `summary` is empty the line SHALL fall back to displaying the 80-character content preview. When both `summary` and preview are empty the content segment and its separator SHALL be omitted. It SHALL NOT propagate exceptions into the host.

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

The `memory_atom_patch` tool's `patch` sub-object SHALL accept an optional `always_include` boolean field and an optional `summary` string field. An explicit `always_include: true` SHALL set the flag; an explicit `always_include: false` SHALL clear it; an omitted key SHALL leave the existing value unchanged. An explicit `summary` string SHALL replace the stored summary; the value MUST be non-empty and at most 280 characters; an omitted `summary` key SHALL leave the existing summary unchanged. The tool description SHALL enumerate `summary` as a patchable field and state it is the appropriate way to retroactively add or correct a summary on older atoms without rewriting their full content.

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

### Requirement: MEMORY_PROTOCOL teaches agents status lifecycle semantics

The `MEMORY_PROTOCOL` constant SHALL include guidance on the `always_include` flag: when to use it; how to toggle it; the 5-per-scope render cap; the misuse warning; and the distinction from `pinned`. The `MEMORY_PROTOCOL` constant SHALL also include guidance on the `summary` field: that `summary` is required on `memory_atom_write`; that it is a one-sentence digest of what the atom's **content** contains, distinct from `description` (which says what the atom is *for*); that it appears in directory listings (session primer, `memory_atom_list`, etc.) so agents can decide whether to fetch the full atom without reading it; that it is at most 280 characters; that it can be retroactively added to older atoms via `memory_atom_patch`; and that it may become stale after `memory_atom_append` operations (content grows but summary is not updated automatically — agents should re-patch the summary when the appended content materially changes what the atom contains).

#### Scenario: MEMORY_PROTOCOL contains always_include guidance
- **GIVEN** the plugin tool definitions are loaded
- **WHEN** the `MEMORY_PROTOCOL` constant is inspected
- **THEN** it contains a description of `always_include`, the toggle command, the 5-per-scope cap, the misuse warning, and the distinction from `pinned`

#### Scenario: MEMORY_PROTOCOL contains summary guidance
- **GIVEN** the plugin tool definitions are loaded
- **WHEN** the `MEMORY_PROTOCOL` constant is inspected
- **THEN** it contains a description of `summary`, that it is required on write, that it is a content digest distinct from `description`, that it appears in listings, the 280-char limit, how to backfill via `atom-patch`, and the append-staleness caveat

