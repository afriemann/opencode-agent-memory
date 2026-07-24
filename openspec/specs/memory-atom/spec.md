# memory-atom Specification

## Purpose
TBD - created by archiving change memory-atoms-and-session-hot-state. Update Purpose after archive.
## Requirements
### Requirement: memory_atom table stores named durable knowledge atoms
The system SHALL maintain a `memory_atom` table with columns `id` (INTEGER PRIMARY KEY AUTOINCREMENT), `scope`, `project`, `topic`, `description`, `content`, `tags` (JSON), `session_id`, `session_name`, `created_at`, `updated_at`, `pinned` (INTEGER NOT NULL DEFAULT 0), and `status` (TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'resolved', 'deprecated'))), and a UNIQUE constraint on `(scope, project, topic)`. A new `memory_atom_fts` FTS5 virtual table (external-content) and three sync triggers (`memory_atom_ai`, `memory_atom_ad`, `memory_atom_au`) SHALL be created alongside the base table in `ensureSchema`. The baseline `CREATE TABLE IF NOT EXISTS` definition SHALL include the `status` column with its `DEFAULT` and `CHECK` so a fresh database is schema-identical to one that has undergone the v4 migration. The `ensureSchema` function SHALL apply a v4 migration (guarded by `PRAGMA user_version < 4` and a `PRAGMA table_info` column-existence probe) that runs `ALTER TABLE memory_atom ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','resolved','deprecated'))` on existing databases and then stamps `PRAGMA user_version = 4`. The identical `CHECK` constraint SHALL appear on both provisioning paths (fresh `CREATE TABLE` and v4 `ALTER TABLE ADD COLUMN`) to preserve the schema-convergence invariant. The `status` column SHALL NOT be included in the FTS5 index or its sync triggers.

#### Scenario: Fresh database creates memory_atom table with status column
- **GIVEN** `ensureSchema` is called on a fresh database
- **WHEN** `PRAGMA table_info(memory_atom)` is inspected
- **THEN** the `memory_atom` table exists with a `status TEXT NOT NULL DEFAULT 'active'` column carrying the enum CHECK, alongside all previously defined columns including `pinned`

#### Scenario: v4 migration adds status column to an existing v3 database
- **GIVEN** a database at schema version 3 without a `status` column
- **WHEN** `ensureSchema` is called
- **THEN** the `memory_atom` table gains a `status TEXT NOT NULL DEFAULT 'active' CHECK(...)` column, all existing atoms have `status = 'active'`, and `PRAGMA user_version` returns 4

#### Scenario: v4 migration is idempotent when status column already exists
- **GIVEN** a database where the `status` column already exists (shape probe hits)
- **WHEN** `ensureSchema` is called
- **THEN** `ALTER TABLE` is NOT run again (no duplicate-column error) and `PRAGMA user_version` is stamped to 4

#### Scenario: Fresh and migrated databases are schema-identical for the status column
- **GIVEN** one fresh database and one v3 database after v4 migration
- **WHEN** `PRAGMA table_info(memory_atom)` is inspected on both
- **THEN** both contain the `status` column with the same type, default, and CHECK constraint

### Requirement: normaliseTopic normalises a topic string
The system SHALL provide a shared `normaliseTopic(topic)` helper that lowercases the string, collapses spaces and underscores to hyphens, and strips leading and trailing slashes. The resulting string SHALL be the canonical stored form for topic keys.

#### Scenario: Space and uppercase in topic are normalised
- **GIVEN** a raw topic string 'My Auth Config'
- **WHEN** `normaliseTopic` is applied
- **THEN** the result is 'my-auth-config'

#### Scenario: Underscores are normalised to hyphens
- **GIVEN** a raw topic string 'my_auth_config'
- **WHEN** `normaliseTopic` is applied
- **THEN** the result is 'my-auth-config'

#### Scenario: Leading and trailing slashes are stripped
- **GIVEN** a raw topic string '/arch/db/'
- **WHEN** `normaliseTopic` is applied
- **THEN** the result is 'arch/db'

### Requirement: topic normalisation is applied at both ingest and lookup
The system SHALL apply `normaliseTopic` to the topic key at ingest (on `atom-write` and `atom-append`) and to the lookup input on `atom-get` (topic argument) and `atom-list` (prefix argument), so that agent-supplied variants (`My Topic`, `my_topic`, `my-topic`) all resolve to the same stored key.

#### Scenario: Topic normalised at atom-write ingest
- **GIVEN** an agent calls atom-write with topic='My Auth Config'
- **WHEN** the atom is stored
- **THEN** the stored topic column value is 'my-auth-config'

#### Scenario: atom-get lookup normalises input to find stored atom
- **GIVEN** an atom is stored at topic 'my-auth-config'
- **WHEN** atom-get is called with topic='My_Auth_Config'
- **THEN** the atom is returned (lookup resolved 'My_Auth_Config' → 'my-auth-config')

#### Scenario: atom-search does NOT normalise its query argument
- **GIVEN** an atom with content containing 'auth config' is stored
- **WHEN** atom-search is called with query='Auth Config'
- **THEN** FTS5 tokenisation handles case-folding; `normaliseTopic` is not applied to the query string

### Requirement: FTS5 virtual table uses external-content and three sync triggers
The system SHALL create `memory_atom_fts` as an external-content FTS5 virtual table (`content='memory_atom'`, `content_rowid='id'`) indexing the `topic`, `description`, `content`, and `tags` columns. Three triggers SHALL keep the FTS index in sync: `memory_atom_ai` (AFTER INSERT), `memory_atom_ad` (AFTER DELETE), and `memory_atom_au` (AFTER UPDATE). The FTS DDL and trigger DDL SHALL be wrapped in a try/catch so that `ensureSchema` does not fail when FTS5 is unavailable.

#### Scenario: FTS index is populated after atom-write INSERT
- **GIVEN** a fresh database with memory_atom_fts created
- **WHEN** an atom is written via atom-write
- **THEN** `INSERT INTO memory_atom_fts(memory_atom_fts) VALUES('integrity-check')` succeeds and the atom is findable via MATCH on its content

#### Scenario: FTS index is updated after atom-append UPDATE
- **GIVEN** an atom exists at topic 'work/notes' with content='initial'
- **WHEN** atom-append adds 'updated'
- **THEN** FTS5 integrity-check passes and the appended content is indexed

#### Scenario: FTS index is updated after atom-delete
- **GIVEN** an atom exists and is indexed in FTS
- **WHEN** atom-delete removes it
- **THEN** FTS5 integrity-check passes and the atom is no longer returned by MATCH queries

#### Scenario: ensureSchema succeeds even when FTS5 module is unavailable
- **GIVEN** the SQLite runtime was compiled without the fts5 module
- **WHEN** ensureSchema is called
- **THEN** the memory_atom base table and CRUD operations are available; only the FTS virtual table is absent; atom-search falls back to LIKE

### Requirement: atom-write requires a non-empty description
The system SHALL reject an `atom-write` subcommand call with a non-zero exit code and a descriptive stderr message when the `description` field in the JSON argument is absent, null, or an empty string. No row SHALL be written on a rejected call.

#### Scenario: atom-write without description is rejected
- **GIVEN** any database state
- **WHEN** `node memory.js atom-write <scope> <project> '{"topic":"t","content":"c"}'` is called with no description field
- **THEN** the process exits with a non-zero code, stderr contains a descriptive error, and no row is inserted or updated

#### Scenario: atom-write with empty string description is rejected
- **GIVEN** any database state
- **WHEN** atom-write is called with description=''
- **THEN** the process exits non-zero and no row is written

### Requirement: atom-write reports whether the atom was created or overwritten
The system SHALL emit `"Created atom at <topic>"` on stdout when the topic is new, and `"Updated existing atom at <topic> (previous content overwritten)"` when the topic already existed and was overwritten.

#### Scenario: atom-write on new topic reports Created
- **GIVEN** no atom exists at the given topic
- **WHEN** atom-write is called with a valid description
- **THEN** stdout contains 'Created atom at <topic>'

#### Scenario: atom-write on existing topic reports Updated
- **GIVEN** an atom already exists at the given topic
- **WHEN** atom-write is called with updated content
- **THEN** stdout contains 'Updated existing atom at <topic> (previous content overwritten)'

### Requirement: atom-append errors when the topic does not exist
The system SHALL reject an `atom-append` subcommand call with a non-zero exit code and the message `"Atom '<topic>' does not exist — use memory_atom_write to create it first"` when no atom with the given (scope, project, topic) exists. No create-on-missing behaviour SHALL occur, preserving the invariant that every atom is created via atom-write with a required description.

#### Scenario: atom-append on missing topic errors
- **GIVEN** no atom exists at (scope, project, topic)
- **WHEN** `node memory.js atom-append <scope> <project> '{"topic":"t","content":"c"}'` is called
- **THEN** the process exits non-zero and stderr contains "Atom '<topic>' does not exist — use memory_atom_write to create it first"

### Requirement: atom-append appends content with separator and returns updated full content
The system SHALL atomically read the existing atom's content and write back the original content concatenated with `\n---\n` and the new content under `BEGIN IMMEDIATE`. It SHALL return the full updated content on stdout.

#### Scenario: atom-append appends to existing atom
- **GIVEN** an atom exists at topic 'work/notes' with content='initial content'
- **WHEN** atom-append is called with content='new finding'
- **THEN** the stored content is 'initial content\n---\nnew finding' and the full updated content is printed on stdout

### Requirement: atom-get returns best-match full content and a foreign-workspace listing
The system SHALL resolve the single best full-content match for a topic using priority order (current-workspace atom preferred, global atom as fallback). It SHALL separately query other workspaces for atoms at the same topic and return a listing (topic, description, 80-char content preview, project, updated_at, status). The response SHALL have shape `{ match: <full row | null>, alsoIn: <preview rows> }`. When no current-workspace or global atom exists, `match` SHALL be null and only the `alsoIn` listing is populated. The `match` row and each `alsoIn` row SHALL include both `created_at` and `updated_at` (epoch ms integers) and `status`. The `alsoIn` listing SHALL include atoms of all status values (including `deprecated`) and SHALL label each entry with the atom's status when it is not `active`. `atom-get` SHALL apply no status predicate — it always returns the best-match atom regardless of its `status`. When an optional workspace directory path is provided, the system SHALL resolve the atom against that directory instead of the process's current working directory. The `alsoIn` listing SHALL be formatted as one line per entry: `• [workspace: <project-path>] <topic> — <description> | <preview> [created: …, updated: …]` for workspace-scoped foreign atoms, and `• [global] <topic> — <description> | <preview> [created: …, updated: …]` for global-scoped foreign atoms.

#### Scenario: atom-get returns atom regardless of its status
- **GIVEN** an atom exists at topic 'arch/db' with `status='deprecated'`
- **WHEN** `atom-get` is called for that topic
- **THEN** the atom is returned as the match with its full content and `status='deprecated'` in the row

#### Scenario: atom-get match row includes status field
- **GIVEN** an atom exists at topic 'arch/db' with `status='resolved'`
- **WHEN** `atom-get` is called
- **THEN** the match row includes `status` equal to `'resolved'`

#### Scenario: atom-get alsoIn includes and labels deprecated atoms
- **GIVEN** the current-workspace atom at 'arch/db' is active and the global atom at 'arch/db' is deprecated
- **WHEN** `atom-get` is called
- **THEN** the global atom appears in `alsoIn` and its entry indicates `status='deprecated'`

### Requirement: atom-search searches all workspaces by default and supports scope narrowing
The system SHALL execute a full-text MATCH query across all atoms when no scope is specified, ordering results by BM25 score and including scope and project context in each result. The optional `scope` parameter SHALL narrow the search to the current workspace (`'workspace'`) or global-only atoms (`'global'`). When FTS5 is unavailable, the system SHALL fall back to a LIKE scan over topic, description, and content. Each result row SHALL include both `created_at` and `updated_at` (epoch ms integers) and `status`. By default, `atom-search` SHALL exclude `deprecated` atoms. The search JSON blob SHALL accept optional `status` (exact-match string, one of `active`, `resolved`, or `deprecated`) and `includeDeprecated` (boolean); when `status` is present it SHALL override `includeDeprecated` and the default filter; when only `includeDeprecated` is truthy it SHALL lift all status filtering.

#### Scenario: atom-search default excludes deprecated atoms
- **GIVEN** atoms matching the query exist with `status='active'`, `status='resolved'`, and `status='deprecated'`
- **WHEN** `atom-search` is called with no status options
- **THEN** the active and resolved matching atoms are returned and the deprecated one is excluded

#### Scenario: atom-search with includeDeprecated returns all matching statuses
- **GIVEN** matching atoms exist with all three status values
- **WHEN** `atom-search` is called with `{"includeDeprecated":true}` in the search blob
- **THEN** all three matching atoms are returned

#### Scenario: atom-search with status filter returns only that status
- **GIVEN** matching atoms exist with all three status values
- **WHEN** `atom-search` is called with `{"status":"resolved"}` in the search blob
- **THEN** only the resolved matching atom is returned

#### Scenario: atom-search result rows include status
- **GIVEN** a matching resolved atom exists
- **WHEN** `atom-search` is called with `{"status":"resolved"}`
- **THEN** each result row includes a `status` field equal to `'resolved'`

### Requirement: atom-list returns current-workspace and global atoms by default
The system SHALL list atoms matching an optional topic prefix, returning current-workspace and global atoms by default. When `scope='all'` is passed, it SHALL include atoms from all workspaces. By default, `atom-list` SHALL exclude `deprecated` atoms (returning only `active` and `resolved`). When an optional filters JSON blob (`{ status?, includeDeprecated? }`) is supplied as the fourth positional argument: if `status` is present it SHALL be used as an exact-match filter (overriding the default and `includeDeprecated`); if `includeDeprecated` is truthy (and `status` is absent) it SHALL lift all status filtering (all three values returned). Each result SHALL include topic, description, 80-char content preview, scope, project, `created_at`, `updated_at`, `pinned`, and `status`. The `atom-list` CLI output SHALL prefix each pinned atom entry with `[pinned]` and each non-active atom entry with `[resolved]` or `[deprecated]` as appropriate.

#### Scenario: atom-list default excludes deprecated atoms
- **GIVEN** atoms exist with `status='active'`, `status='resolved'`, and `status='deprecated'`
- **WHEN** `atom-list` is called with no filters argument
- **THEN** the active and resolved atoms are returned and the deprecated atom is excluded

#### Scenario: atom-list with includeDeprecated returns all statuses
- **GIVEN** atoms exist with all three status values
- **WHEN** `atom-list` is called with filters `{"includeDeprecated":true}`
- **THEN** all three atoms are returned

#### Scenario: atom-list with status filter returns only that status
- **GIVEN** atoms exist with `status='active'`, `status='resolved'`, and `status='deprecated'`
- **WHEN** `atom-list` is called with filters `{"status":"deprecated"}`
- **THEN** only the deprecated atom is returned

#### Scenario: atom-list status filter takes precedence over includeDeprecated
- **GIVEN** atoms exist with all three status values
- **WHEN** `atom-list` is called with filters `{"status":"active","includeDeprecated":true}`
- **THEN** only the active atom is returned

#### Scenario: atom-list output labels non-active atoms with their status
- **GIVEN** atoms exist with `status='resolved'` and `status='deprecated'` (via includeDeprecated)
- **WHEN** `atom-list` is called with `{"includeDeprecated":true}`
- **THEN** the resolved atom entry is prefixed with `[resolved]` and the deprecated atom entry is prefixed with `[deprecated]`

#### Scenario: atom-list result rows include the status field
- **GIVEN** a deprecated atom exists in the database and is requested via `{"includeDeprecated":true}`
- **WHEN** `atom-list` is called and its JSON rows are inspected
- **THEN** each row includes a `status` field with the correct value

### Requirement: atom-delete removes the atom and updates the FTS index
The system SHALL delete the atom identified by (scope, project, topic) and return a one-line confirmation on stdout. The AFTER DELETE trigger SHALL update the FTS index so the deleted atom is no longer findable via MATCH.

#### Scenario: atom-delete removes an existing atom
- **GIVEN** an atom exists at the given (scope, project, topic)
- **WHEN** atom-delete is called
- **THEN** the atom is removed from memory_atom, FTS integrity-check passes, and stdout contains a one-line confirmation

#### Scenario: atom-delete on a missing topic exits non-zero
- **GIVEN** no atom exists at the given (scope, project, topic)
- **WHEN** atom-delete is called
- **THEN** the process exits with a non-zero code and stderr contains an informative message

### Requirement: startup migration converts legacy hot_state rows to atoms
The system SHALL, as part of the user_version < 2 migration transaction, upsert an atom at topic `work/migrated-summary` (scope='project', project = the row's project path) for each legacy hot_state row that has a non-empty `last_worked_summary`. The migration, hot_state rebuild, and user_version bump to 2 SHALL all execute inside one transaction so that a mid-migration failure rolls back entirely and retries on the next startup.

#### Scenario: Legacy hot_state summary row is migrated to an atom
- **GIVEN** a database with user_version < 2 containing a hot_state row with last_worked_summary='my summary' and project='/my/proj'
- **WHEN** ensureSchema runs
- **THEN** an atom exists at topic 'work/migrated-summary' with scope='project', project='/my/proj', and content containing 'my summary'

#### Scenario: Migration is idempotent when user_version is already 2
- **GIVEN** a database with user_version = 2
- **WHEN** ensureSchema is called
- **THEN** no migration runs and no duplicate atoms are created

#### Scenario: Migration failure rolls back entirely and retries cleanly
- **GIVEN** a database with user_version < 2 and a populated hot_state table
- **WHEN** the migration transaction fails mid-way (simulated)
- **THEN** the hot_state table is unchanged, user_version remains below 2, and the next startup attempts migration again

### Requirement: atom-write accepts an optional caller-supplied creation timestamp
The system SHALL accept an optional `createdAt` field (epoch ms integer) in the JSON payload of an `atom-write` call. When `createdAt` is supplied, it SHALL be used as the `created_at` column value instead of `Date.now()`. The `updated_at` column SHALL always be set to `Date.now()` regardless of `createdAt`. When `createdAt` is absent or `undefined`, the system SHALL behave as before and use `Date.now()` for `created_at`.

#### Scenario: atom-write with explicit createdAt stores that timestamp
- **GIVEN** an agent calls atom-write with `createdAt=1000`
- **WHEN** the atom is stored
- **THEN** the `created_at` column value is `1000`

#### Scenario: atom-write without createdAt uses current time
- **GIVEN** an agent calls atom-write without a `createdAt` field
- **WHEN** the atom is stored
- **THEN** the `created_at` column value is approximately `Date.now()` at the time of the call

### Requirement: atom-patch performs a content-preserving partial metadata update
The system SHALL implement an `atom-patch` CLI subcommand that updates one or more of `description`, `tags`, `created_at`, `pinned`, and `status` for an existing atom without touching its content. The patch argument SHALL be a JSON blob supplied as the third positional argument. At least one of `description`, `tags`, `created_at`, `pinned`, or `status` MUST be present in the patch; an empty call SHALL be rejected with a non-zero exit and a clear error message. The operation SHALL use `BEGIN IMMEDIATE` to acquire the write lock before reading the current row, preventing check-then-write races. The system SHALL then build and run a single dynamic `UPDATE` statement from only the fields present in the patch. For each present field: `description` is trimmed and stored (empty string after trim SHALL be rejected); `tags` array is stored as JSON (`[]` is stored as `'[]'`, clearing any existing tags); `created_at` is stored as an epoch-ms integer as supplied; `pinned` is coerced to `0` (falsy) or `1` (truthy) and stored; `status` SHALL be one of `'active'`, `'resolved'`, or `'deprecated'` and SHALL be rejected with a clear error if any other value is supplied. The `updated_at` timestamp SHALL be bumped to the current time if and only if `description`, `tags`, `pinned`, or `status` is present in the patch; a `created_at`-only patch SHALL NOT modify `updated_at`. On success, the system SHALL print a JSON object `{ ok: true, topic: <topic>, patched: [<field>, …] }` on stdout and exit 0. If the target atom does not exist, the process SHALL exit non-zero and emit an error message on stderr. FTS re-indexing SHALL occur automatically via the existing `memory_atom_au` AFTER-UPDATE trigger.

#### Scenario: atom-patch with status updates status and bumps updated_at
- **GIVEN** an atom exists at topic 'work/notes' with `status='active'` and known `updated_at`
- **WHEN** `atom-patch` is called with `{"status":"resolved"}`
- **THEN** the atom's `status` is `'resolved'`, `updated_at` is newer than before, content is unchanged, and stdout contains `{ ok: true, topic: 'work/notes', patched: ['status'] }`

#### Scenario: atom-patch rejects an invalid status value
- **GIVEN** an atom exists at topic 'work/notes'
- **WHEN** `atom-patch` is called with `{"status":"invalid"}`
- **THEN** the process exits non-zero and stderr contains a message indicating the value must be one of `active`, `resolved`, `deprecated`

#### Scenario: atom-patch with absent status field leaves existing status unchanged
- **GIVEN** an atom exists at topic 'work/notes' with `status='resolved'`
- **WHEN** `atom-patch` is called with `{"description":"updated"}` (no `status` field)
- **THEN** the atom's `status` remains `'resolved'`

#### Scenario: atom-patch with status only does not change content
- **GIVEN** an atom exists at topic 'work/notes' with known content
- **WHEN** `atom-patch` is called with `{"status":"deprecated"}`
- **THEN** the atom's content is unchanged and `status` is `'deprecated'`

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

### Requirement: atom-write preserves existing status on upsert
The system SHALL NOT include `status` in either the INSERT column list or the `ON CONFLICT DO UPDATE SET` clause of the `atom-write` upsert. New atoms receive `status = 'active'` from the column `DEFAULT`; on a content re-write of an existing atom the existing `status` is preserved without any explicit handling.

#### Scenario: New atom receives active status by default
- **GIVEN** no atom exists at the given topic
- **WHEN** `atom-write` is called
- **THEN** the created atom has `status = 'active'`

#### Scenario: Re-writing a resolved atom preserves resolved status
- **GIVEN** an atom exists at topic 'arch/db' with `status = 'resolved'`
- **WHEN** `atom-write` is called for the same topic with new content
- **THEN** the atom's content is updated and `status` remains `'resolved'`

#### Scenario: Re-writing a deprecated atom preserves deprecated status
- **GIVEN** an atom exists at topic 'arch/db' with `status = 'deprecated'`
- **WHEN** `atom-write` is called for the same topic with new content
- **THEN** the atom's content is updated and `status` remains `'deprecated'`

