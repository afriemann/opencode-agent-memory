## MODIFIED Requirements

### Requirement: atom-get returns best-match full content and a foreign-workspace listing
The system SHALL resolve the single best full-content match for a topic using priority order (current-workspace atom preferred, global atom as fallback). It SHALL separately query other workspaces for atoms at the same topic and return a listing (topic, description, 80-char content preview, project, updated_at). The response SHALL have shape `{ match: <full row | null>, alsoIn: <preview rows> }`. When no current-workspace or global atom exists, `match` SHALL be null and only the `alsoIn` listing is populated. The `match` row and each `alsoIn` row SHALL include both `created_at` and `updated_at` (epoch ms integers). When an optional workspace directory path is provided, the system SHALL resolve the atom against that directory instead of the process's current working directory, allowing a foreign-workspace atom to be promoted to the primary match. The `alsoIn` listing SHALL be formatted as one line per entry: `• [workspace: <project-path>] <topic> — <description> | <preview> [created: …, updated: …]` for workspace-scoped foreign atoms, and `• [global] <topic> — <description> | <preview> [created: …, updated: …]` for global-scoped foreign atoms.

#### Scenario: atom-get returns current-workspace atom when it exists alongside a global one
- **GIVEN** an atom exists at topic 'arch/db' in the current workspace AND globally
- **WHEN** atom-get is called for the current workspace
- **THEN** the current-workspace atom is returned as match and the global atom appears in alsoIn with a 80-char preview

#### Scenario: atom-get falls back to global when no current-workspace match exists
- **GIVEN** no current-workspace atom exists at 'arch/db' but a global one does
- **WHEN** atom-get is called
- **THEN** the global atom is returned as match and alsoIn is empty

#### Scenario: atom-get returns null match and foreign listing when only other-workspace atoms exist
- **GIVEN** no current-workspace or global atom at 'arch/db', but an atom in workspace B exists
- **WHEN** atom-get is called
- **THEN** match is null and workspace-B atom appears in alsoIn with a 80-char content preview; no foreign content is loaded as match

#### Scenario: atom-get match row includes created_at and updated_at
- **GIVEN** an atom exists at topic 'arch/db' in the current workspace with a known created_at value
- **WHEN** atom-get is called
- **THEN** the match row includes both `created_at` and `updated_at` as epoch ms integers

#### Scenario: atom-get with workspace arg promotes the foreign atom to primary match
- **GIVEN** an atom exists at topic 'arch/db' in workspace B but not in the current workspace
- **WHEN** atom-get is called with the path of workspace B as the workspace argument
- **THEN** the atom from workspace B is returned as the primary match with its full content

#### Scenario: atom-get alsoIn entries for workspace atoms use bracketed path format
- **GIVEN** an atom at topic 'arch/db' exists in workspace B and a global atom also exists
- **WHEN** atom-get is called for the current workspace
- **THEN** the workspace-B entry in alsoIn is rendered as `• [workspace: <path-to-B>] arch/db — …` and the global entry (if in alsoIn) is rendered as `• [global] arch/db — …`

## ADDED Requirements

### Requirement: atom-patch performs a content-preserving partial metadata update
The system SHALL implement an `atom-patch` CLI subcommand that updates one or more of `description`, `tags`, and `created_at` for an existing atom without touching its content. The patch argument SHALL be a JSON blob supplied as the third positional argument (consistent with `atom-write`). At least one of `description`, `tags`, or `created_at` MUST be present in the patch; an empty call SHALL be rejected with a non-zero exit and a clear error message. The operation SHALL use `BEGIN IMMEDIATE` to acquire the write lock before reading the current row, preventing check-then-write races. The system SHALL then build and run a single dynamic `UPDATE` statement from only the fields present in the patch. For each present field: `description` is trimmed and stored (empty string after trim SHALL be rejected); `tags` array is stored as JSON (`[]` is stored as `'[]'`, clearing any existing tags); `created_at` is stored as an epoch-ms integer as supplied. The `updated_at` timestamp SHALL be bumped to the current time if and only if `description` or `tags` is present in the patch; a `created_at`-only patch SHALL NOT modify `updated_at`. On success, the system SHALL print a JSON object `{ ok: true, topic: <topic>, patched: [<field>, …] }` on stdout and exit 0. If the target atom does not exist, the process SHALL exit non-zero and emit an error message on stderr. FTS re-indexing SHALL occur automatically via the existing `memory_atom_au` AFTER-UPDATE trigger.

#### Scenario: atom-patch with description and tags updates both and bumps updated_at
- **GIVEN** an atom exists at topic 'work/notes' with description='old' and known updated_at
- **WHEN** atom-patch is called with `{"description":"new","tags":["a"]}`
- **THEN** the atom's description is 'new', tags is '["a"]', updated_at is newer than before, content is unchanged, and stdout contains `{ ok: true, topic: 'work/notes', patched: ['description', 'tags'] }`

#### Scenario: atom-patch with created_at only does not bump updated_at
- **GIVEN** an atom exists at topic 'work/notes' with known updated_at T
- **WHEN** atom-patch is called with `{"created_at": <epoch>}` (no description, no tags)
- **THEN** the atom's created_at is updated, updated_at remains equal to T, and content is unchanged

#### Scenario: atom-patch with tags:[] clears existing tags
- **GIVEN** an atom exists at topic 'work/notes' with tags='["old-tag"]'
- **WHEN** atom-patch is called with `{"tags":[]}`
- **THEN** the atom's tags field is stored as '[]'

#### Scenario: atom-patch with absent tags field leaves existing tags unchanged
- **GIVEN** an atom exists at topic 'work/notes' with tags='["keep-me"]'
- **WHEN** atom-patch is called with `{"description":"updated"}` (no tags field)
- **THEN** the atom's tags remain '["keep-me"]'

#### Scenario: atom-patch rejects an empty patch
- **GIVEN** an atom exists at topic 'work/notes'
- **WHEN** atom-patch is called with `{}` (no recognised fields)
- **THEN** the process exits non-zero and stderr contains a message indicating at least one field is required

#### Scenario: atom-patch rejects an empty description
- **GIVEN** an atom exists at topic 'work/notes'
- **WHEN** atom-patch is called with `{"description":""}`
- **THEN** the process exits non-zero and stderr contains a message about non-empty description being required

#### Scenario: atom-patch errors when the atom does not exist
- **GIVEN** no atom exists at topic 'arch/missing'
- **WHEN** atom-patch is called for that topic
- **THEN** the process exits non-zero and stderr contains a message indicating the atom does not exist
