## MODIFIED Requirements

### Requirement: memory_atom table stores named durable knowledge atoms
The system SHALL maintain a `memory_atom` table with columns `id` (INTEGER PRIMARY KEY AUTOINCREMENT), `scope`, `project`, `topic`, `description`, `content`, `tags` (JSON), `session_id`, `session_name`, `created_at`, `updated_at`, and `pinned` (INTEGER NOT NULL DEFAULT 0), and a UNIQUE constraint on `(scope, project, topic)`. A new `memory_atom_fts` FTS5 virtual table (external-content) and three sync triggers (`memory_atom_ai`, `memory_atom_ad`, `memory_atom_au`) SHALL be created alongside the base table in `ensureSchema`. The baseline `CREATE TABLE IF NOT EXISTS` definition SHALL include `pinned INTEGER NOT NULL DEFAULT 0` so a fresh database is schema-identical to one that has undergone the v3 migration. The `ensureSchema` function SHALL apply a v3 migration (guarded by `PRAGMA user_version < 3` and a `PRAGMA table_info` column-existence probe) that runs `ALTER TABLE memory_atom ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0` on existing databases and then stamps `PRAGMA user_version = 3`. The `pinned` column SHALL NOT be included in the FTS5 index or its sync triggers.

#### Scenario: Fresh database creates memory_atom table with pinned column
- **WHEN** `ensureSchema` is called on a fresh database
- **THEN** the `memory_atom` table exists with all required columns including `pinned INTEGER NOT NULL DEFAULT 0`, the UNIQUE(scope, project, topic) constraint, and `memory_atom_fts` exists as a virtual FTS5 table

#### Scenario: Migration adds pinned column to an existing v2 database
- **GIVEN** a database at schema version 2 without a `pinned` column
- **WHEN** `ensureSchema` is called
- **THEN** the `memory_atom` table gains a `pinned INTEGER NOT NULL DEFAULT 0` column, all existing atoms have `pinned = 0`, and `PRAGMA user_version` returns 3

#### Scenario: v3 migration is idempotent when pinned column already exists
- **GIVEN** a database where the `pinned` column already exists (shape probe hits)
- **WHEN** `ensureSchema` is called
- **THEN** `ALTER TABLE` is NOT run again (no duplicate-column error) and `PRAGMA user_version` is stamped to 3

#### Scenario: Fresh and migrated databases are schema-identical
- **GIVEN** one fresh database and one v2 database after migration
- **WHEN** `PRAGMA table_info(memory_atom)` is inspected on both
- **THEN** both contain the `pinned` column with the same type and default

### Requirement: atom-list returns current-workspace and global atoms by default
The system SHALL list atoms matching an optional topic prefix, returning current-workspace and global atoms by default. When `scope='all'` is passed, it SHALL include atoms from all workspaces. Each result SHALL include topic, description, 80-char content preview, scope, project, `created_at`, `updated_at`, and `pinned`. The `atom-list` CLI output SHALL prefix each pinned atom entry with `[pinned]`.

#### Scenario: atom-list without scope returns current-workspace and global atoms only
- **GIVEN** atoms exist in the current workspace, globally, and in a second workspace
- **WHEN** atom-list is called with no scope
- **THEN** current-workspace and global atoms are returned; the second workspace's atoms are excluded

#### Scenario: atom-list with scope='all' includes all workspaces
- **GIVEN** atoms exist in multiple workspaces
- **WHEN** atom-list is called with scope='all'
- **THEN** atoms from all workspaces are returned, each showing its project context

#### Scenario: atom-list with prefix filters by normalised topic prefix
- **GIVEN** atoms at topics 'auth/jwt', 'auth/oauth', and 'work/notes' exist
- **WHEN** atom-list is called with prefix='auth/'
- **THEN** only 'auth/jwt' and 'auth/oauth' are returned

#### Scenario: atom-list results include created_at and updated_at
- **GIVEN** atoms with known timestamps exist in the database
- **WHEN** atom-list is called
- **THEN** each result row includes both `created_at` and `updated_at` as epoch ms integers

#### Scenario: atom-list output marks pinned atoms with [pinned]
- **GIVEN** two atoms exist: one pinned and one unpinned
- **WHEN** atom-list is called
- **THEN** the pinned atom's entry is prefixed with `[pinned]` and the unpinned atom's entry has no such prefix

#### Scenario: atom-list result rows include the pinned field
- **GIVEN** a pinned atom exists in the database
- **WHEN** atom-list is called and its JSON rows are inspected
- **THEN** each row includes a `pinned` field with value 1 for pinned atoms and 0 for unpinned atoms

### Requirement: atom-patch performs a content-preserving partial metadata update
The system SHALL implement an `atom-patch` CLI subcommand that updates one or more of `description`, `tags`, `created_at`, and `pinned` for an existing atom without touching its content. The patch argument SHALL be a JSON blob supplied as the third positional argument (consistent with `atom-write`). At least one of `description`, `tags`, `created_at`, or `pinned` MUST be present in the patch; an empty call SHALL be rejected with a non-zero exit and a clear error message. The operation SHALL use `BEGIN IMMEDIATE` to acquire the write lock before reading the current row, preventing check-then-write races. The system SHALL then build and run a single dynamic `UPDATE` statement from only the fields present in the patch. For each present field: `description` is trimmed and stored (empty string after trim SHALL be rejected); `tags` array is stored as JSON (`[]` is stored as `'[]'`, clearing any existing tags); `created_at` is stored as an epoch-ms integer as supplied; `pinned` is coerced to `0` (falsy) or `1` (truthy) and stored. The `updated_at` timestamp SHALL be bumped to the current time if and only if `description`, `tags`, or `pinned` is present in the patch; a `created_at`-only patch SHALL NOT modify `updated_at`. On success, the system SHALL print a JSON object `{ ok: true, topic: <topic>, patched: [<field>, …] }` on stdout and exit 0. If the target atom does not exist, the process SHALL exit non-zero and emit an error message on stderr. FTS re-indexing SHALL occur automatically via the existing `memory_atom_au` AFTER-UPDATE trigger.

#### Scenario: atom-patch with description and tags updates both and bumps updated_at
- **GIVEN** an atom exists at topic 'work/notes' with description='old' and known updated_at
- **WHEN** atom-patch is called with `{"description":"new","tags":["a"]}`
- **THEN** the atom's description is 'new', tags is '["a"]', updated_at is newer than before, content is unchanged, and stdout contains `{ ok: true, topic: 'work/notes', patched: ['description', 'tags'] }`

#### Scenario: atom-patch with created_at only does not bump updated_at
- **GIVEN** an atom exists at topic 'work/notes' with known updated_at T
- **WHEN** atom-patch is called with `{"created_at": <epoch>}` (no description, no tags, no pinned)
- **THEN** the atom's created_at is updated, updated_at remains equal to T, and content is unchanged

#### Scenario: atom-patch with pinned=true pins the atom and bumps updated_at
- **GIVEN** an atom exists at topic 'work/notes' with pinned=0 and known updated_at
- **WHEN** atom-patch is called with `{"pinned": true}`
- **THEN** the atom's pinned field is 1, updated_at is newer than before, and content is unchanged

#### Scenario: atom-patch with pinned=false unpins the atom and bumps updated_at
- **GIVEN** an atom exists at topic 'work/notes' with pinned=1 and known updated_at
- **WHEN** atom-patch is called with `{"pinned": false}`
- **THEN** the atom's pinned field is 0 and updated_at is newer than before

#### Scenario: atom-patch with tags:[] clears existing tags
- **GIVEN** an atom exists at topic 'work/notes' with tags='["old-tag"]'
- **WHEN** atom-patch is called with `{"tags":[]}`
- **THEN** the atom's tags field is stored as '[]'

#### Scenario: atom-patch with absent tags field leaves existing tags unchanged
- **GIVEN** an atom exists at topic 'work/notes' with tags='["keep-me"]'
- **WHEN** atom-patch is called with `{"description":"updated"}` (no tags field)
- **THEN** the atom's tags remain '["keep-me"]'

#### Scenario: atom-patch with absent pinned field leaves existing pinned unchanged
- **GIVEN** a pinned atom exists at topic 'work/notes' (pinned=1)
- **WHEN** atom-patch is called with `{"description":"updated"}` (no pinned field)
- **THEN** the atom's pinned value remains 1

#### Scenario: atom-patch rejects an empty patch
- **GIVEN** an atom exists at topic 'work/notes'
- **WHEN** atom-patch is called with `{}` (no recognised fields)
- **THEN** the process exits non-zero and stderr contains a message indicating at least one field is required

#### Scenario: atom-patch rejects an empty description
- **GIVEN** an atom exists at topic 'work/notes'
- **WHEN** atom-patch is called with `{"description":""}`
- **THEN** the process exits non-zero and stderr contains an error about non-empty description

## ADDED Requirements

### Requirement: atom-write preserves existing pinned state on upsert
The system SHALL include `pinned` in the INSERT column list of the `atom-write` upsert with the caller-supplied value (default `0`). `pinned` SHALL NOT appear in the `ON CONFLICT … DO UPDATE SET` clause; when the topic already exists, the existing `pinned` value SHALL be preserved regardless of what `pinned` value the caller passes. Changing pin state after creation SHALL require an explicit `atom-patch` call.

#### Scenario: atom-write on new topic persists caller-supplied pinned=true
- **GIVEN** no atom exists at topic 'arch/db'
- **WHEN** atom-write is called with `{"topic":"arch/db","pinned":true,...}`
- **THEN** the atom is created with `pinned = 1`

#### Scenario: atom-write on new topic defaults pinned to 0 when omitted
- **GIVEN** no atom exists at topic 'arch/db'
- **WHEN** atom-write is called without a `pinned` field
- **THEN** the atom is created with `pinned = 0`

#### Scenario: atom-write on existing pinned atom preserves pin
- **GIVEN** an atom exists at topic 'arch/db' with `pinned = 1`
- **WHEN** atom-write is called for the same topic with new content and no `pinned` field
- **THEN** the atom's `pinned` value remains 1
