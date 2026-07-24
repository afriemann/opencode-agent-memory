## MODIFIED Requirements

### Requirement: memory_atom_write tool upserts an atom with required description
The `memory_atom_write` registered tool SHALL invoke the `atom-write` CLI subcommand, passing a required `description` field and optional `scope` (default `'workspace'`). The tool SHALL accept an optional `created_at` argument (ISO 8601 string or epoch ms integer); when supplied it SHALL be converted to epoch ms and forwarded to the CLI as `createdAt`. The tool SHALL accept an optional `pinned` boolean argument (default `false`); when supplied it SHALL be forwarded to the CLI as `pinned`. The `pinned` value is applied only on INSERT (first creation); on a re-write of an existing atom the existing `pinned` state is preserved — use `memory_atom_patch` to change pin state. The tool description SHALL state this INSERT-only caveat explicitly. The tool SHALL return the create-or-overwrite confirmation line from the CLI. It SHALL return an informative error result on CLI failure and SHALL NOT propagate exceptions into the opencode host.

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

#### Scenario: Tool creates a pinned atom when pinned=true is supplied
- **GIVEN** no atom exists at the given topic
- **WHEN** the agent calls memory_atom_write with pinned=true
- **THEN** the atom is created with pinned=1 and the tool returns 'Created atom at <topic>'

#### Scenario: Tool preserves existing pin on re-write when pinned is omitted
- **GIVEN** an atom exists at the given topic with pinned=1
- **WHEN** the agent calls memory_atom_write with new content and no pinned argument
- **THEN** the atom is updated and the existing pinned=1 is preserved

### Requirement: memory_atom_patch tool performs content-preserving metadata updates
The `memory_atom_patch` registered tool SHALL invoke the `atom-patch` CLI subcommand to update one or more of `description`, `tags`, `created_at`, and `pinned` for an existing atom without modifying its content. At least one of the four patchable fields MUST be supplied; an empty call SHALL be rejected with a clear error result. Setting `tags: []` SHALL clear existing tags; omitting `tags` SHALL leave existing tags unchanged. Omitting `pinned` SHALL leave the existing pin state unchanged; supplying `pinned: false` SHALL unpin the atom. The `created_at` argument SHALL accept either an ISO 8601 date string or an epoch-ms number and be normalised to an epoch-ms integer in the plugin before the CLI is invoked. A `created_at`-only patch SHALL NOT modify the atom's `updated_at` timestamp; a patch that includes `description`, `tags`, or `pinned` SHALL bump `updated_at`. An empty `description` after trimming SHALL be rejected with an error result. `scope="all"` SHALL be rejected. The optional `workspace` argument (a directory path) SHALL substitute the effective directory for scope resolution, mirroring `memory_atom_get`. On success the tool SHALL return a confirmation message naming the topic and the changed fields. It SHALL NOT propagate exceptions into the host.

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

#### Scenario: Tool pins an atom and bumps updated_at
- **GIVEN** an atom exists at topic 'work/notes' with pinned=0 and known updated_at
- **WHEN** the agent calls memory_atom_patch with pinned=true
- **THEN** the atom's pinned is 1, updated_at is bumped, and the tool returns a success message listing 'pinned' among the patched fields

#### Scenario: Tool unpins an atom and bumps updated_at
- **GIVEN** an atom exists at topic 'work/notes' with pinned=1 and known updated_at
- **WHEN** the agent calls memory_atom_patch with pinned=false
- **THEN** the atom's pinned is 0 and updated_at is bumped

#### Scenario: Tool leaves pin unchanged when pinned is omitted
- **GIVEN** a pinned atom exists at topic 'work/notes' (pinned=1)
- **WHEN** the agent calls memory_atom_patch with only description='updated'
- **THEN** the atom's pinned remains 1

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

### Requirement: memory_atom_list tool lists atoms by topic prefix with default workspace+global scope
The `memory_atom_list` registered tool SHALL invoke the `atom-list` CLI subcommand. With no scope it returns current-workspace and global atoms. `scope='all'` includes atoms from all workspaces. Each result line SHALL include both `created_at` and `updated_at` rendered as human-readable relative strings. Pinned atoms SHALL be marked with a `[pinned]` indicator in their entry. It SHALL NOT propagate exceptions into the host.

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

#### Scenario: Tool output marks pinned atoms with [pinned]
- **GIVEN** one pinned atom and one unpinned atom exist
- **WHEN** the agent calls memory_atom_list
- **THEN** the pinned atom's line includes '[pinned]' and the unpinned atom's line does not
