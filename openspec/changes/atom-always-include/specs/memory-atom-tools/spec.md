## MODIFIED Requirements

### Requirement: memory_atom_write tool upserts an atom with required description

The `memory_atom_write` tool SHALL accept an optional `always_include` boolean argument (default `false`). The tool description SHALL state that `always_include` is INSERT-only: setting it on first creation stores the value; a re-write of the same topic never changes it, and `memory_atom_patch` MUST be used to toggle it after creation.

#### Scenario: memory_atom_write accepts always_include on creation
- **GIVEN** no atom exists for the given topic
- **WHEN** `memory_atom_write` is called with `always_include: true`
- **THEN** the created atom has `always_include = 1` and the call succeeds

#### Scenario: memory_atom_write INSERT-only caveat is documented in the tool description
- **GIVEN** the plugin tool definitions are loaded
- **WHEN** the `memory_atom_write` tool description is inspected
- **THEN** it states that `always_include` is set on first creation and a re-write never changes it

### Requirement: memory_atom_patch tool performs content-preserving metadata updates

The `memory_atom_patch` tool's `patch` sub-object SHALL accept an optional `always_include` boolean field. An explicit `true` SHALL set the flag; an explicit `false` SHALL clear it; an omitted key SHALL leave the existing value unchanged.

#### Scenario: memory_atom_patch toggles always_include via patch sub-object
- **GIVEN** an atom with `always_include = 0`
- **WHEN** `memory_atom_patch` is called with `patch: { always_include: true }`
- **THEN** the atom has `always_include = 1`

#### Scenario: memory_atom_patch clears always_include via patch sub-object
- **GIVEN** an atom with `always_include = 1`
- **WHEN** `memory_atom_patch` is called with `patch: { always_include: false }`
- **THEN** the atom has `always_include = 0`

### Requirement: MEMORY_PROTOCOL teaches agents status lifecycle semantics

The `MEMORY_PROTOCOL` constant SHALL include guidance on the `always_include` flag: when to use it (atoms whose full content is needed at session start without a fetch — project conventions, user preferences, standing checklists under ~500 words); how to toggle it (`memory_atom_patch` with `patch: { always_include: true/false }`); the 5-per-scope render cap; the misuse warning (do not use for long-form content such as spec documents, logs, or large code samples); and the explicit distinction from `pinned` (pinned → compact line at top of directory; always_include → full content injected before the directory, no fetch needed).

#### Scenario: MEMORY_PROTOCOL contains always_include guidance
- **GIVEN** the plugin tool definitions are loaded
- **WHEN** the `MEMORY_PROTOCOL` constant is inspected
- **THEN** it contains a description of `always_include`, the toggle command, the 5-per-scope cap, the misuse warning, and the distinction from `pinned`
