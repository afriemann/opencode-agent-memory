## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: memory_atom_patch tool performs content-preserving metadata updates
The `memory_atom_patch` registered tool SHALL invoke the `atom-patch` CLI subcommand to update one or more of `description`, `tags`, and `created_at` for an existing atom without modifying its content. At least one of the three patchable fields MUST be supplied; an empty call SHALL be rejected with a clear error result. Setting `tags: []` SHALL clear existing tags; omitting `tags` SHALL leave existing tags unchanged. The `created_at` argument SHALL accept either an ISO 8601 date string or an epoch-ms number and be normalised to an epoch-ms integer in the plugin before the CLI is invoked. A `created_at`-only patch SHALL NOT modify the atom's `updated_at` timestamp; a patch that includes `description` or `tags` SHALL bump `updated_at`. An empty `description` after trimming SHALL be rejected with an error result. `scope="all"` SHALL be rejected. The optional `workspace` argument (a directory path) SHALL substitute the effective directory for scope resolution, mirroring `memory_atom_get`. On success the tool SHALL return a confirmation message naming the topic and the changed fields. It SHALL NOT propagate exceptions into the host.

#### Scenario: Tool patches description and tags, returns confirmation naming changed fields
- **GIVEN** an atom exists at topic 'work/notes' with description='old' and tags=['old-tag']
- **WHEN** the agent calls memory_atom_patch with description='new', tags=['new-tag']
- **THEN** the tool returns a success message containing 'work/notes' and listing 'description' and 'tags' among the patched fields

#### Scenario: Tool patches created_at only and leaves updated_at unchanged
- **GIVEN** an atom exists at topic 'work/notes' with a known updated_at
- **WHEN** the agent calls memory_atom_patch with only created_at supplied
- **THEN** the atom's created_at is updated and updated_at is not changed

#### Scenario: Tool accepts ISO 8601 string for created_at and normalises to epoch ms
- **GIVEN** an atom exists at topic 'work/notes'
- **WHEN** the agent calls memory_atom_patch with created_at="2025-01-01T00:00:00.000Z"
- **THEN** the atom's created_at is stored as the equivalent epoch-ms integer (1735689600000)

#### Scenario: Tool rejects empty patch call
- **GIVEN** an atom exists at topic 'work/notes'
- **WHEN** the agent calls memory_atom_patch with no patchable fields
- **THEN** the tool returns an error result indicating at least one field is required and does not throw

#### Scenario: Tool rejects empty description
- **GIVEN** an atom exists at topic 'work/notes'
- **WHEN** the agent calls memory_atom_patch with description=''
- **THEN** the tool returns an error result about non-empty description and does not throw

#### Scenario: Tool rejects scope='all'
- **GIVEN** any atom exists
- **WHEN** the agent calls memory_atom_patch with scope='all'
- **THEN** the tool returns an error result about unsupported scope and does not throw

#### Scenario: Tool surfaces error when atom does not exist
- **GIVEN** no atom exists at topic 'arch/missing'
- **WHEN** the agent calls memory_atom_patch for that topic
- **THEN** the tool returns an error result containing the missing-atom message and does not throw
