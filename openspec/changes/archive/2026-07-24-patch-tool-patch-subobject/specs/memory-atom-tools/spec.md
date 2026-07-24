## MODIFIED Requirements

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
