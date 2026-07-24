# memory-atom Specification

## Purpose
TBD - created by archiving change memory-atoms-and-session-hot-state. Update Purpose after archive.
## Requirements
### Requirement: memory_atom table stores named durable knowledge atoms
The system SHALL maintain a `memory_atom` table with columns `id` (INTEGER PRIMARY KEY AUTOINCREMENT), `scope`, `project`, `topic`, `description`, `content`, `tags` (JSON), `session_id`, `session_name`, `created_at`, and `updated_at`, and a UNIQUE constraint on `(scope, project, topic)`. A new `memory_atom_fts` FTS5 virtual table (external-content) and three sync triggers (`memory_atom_ai`, `memory_atom_ad`, `memory_atom_au`) SHALL be created alongside the base table in `ensureSchema`.

#### Scenario: Fresh database creates memory_atom table and FTS virtual table
- **WHEN** `ensureSchema` is called on a fresh database
- **THEN** the `memory_atom` table exists with all required columns and the UNIQUE(scope, project, topic) constraint, and `memory_atom_fts` exists as a virtual FTS5 table

#### Scenario: Duplicate topic in the same scope upserts without changing the row id
- **GIVEN** an atom exists at (scope='project', project='/path', topic='arch/db')
- **WHEN** `atom-write` is called for the same scope/project/topic with new content
- **THEN** the row is updated via ON CONFLICT DO UPDATE, the `id` is unchanged, and FTS5 integrity-check passes

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
The system SHALL resolve the single best full-content match for a topic using priority order (current-workspace atom preferred, global atom as fallback). It SHALL separately query other workspaces for atoms at the same topic and return a listing (topic, description, 80-char content preview, project, updated_at). The response SHALL have shape `{ match: <full row | null>, alsoIn: <preview rows> }`. When no current-workspace or global atom exists, `match` SHALL be null and only the `alsoIn` listing is populated. The `match` row and each `alsoIn` row SHALL include both `created_at` and `updated_at` (epoch ms integers).

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

### Requirement: atom-search searches all workspaces by default and supports scope narrowing
The system SHALL execute a full-text MATCH query across all atoms when no scope is specified, ordering results by BM25 score and including scope and project context in each result. The optional `scope` parameter SHALL narrow the search to the current workspace (`'workspace'`) or global-only atoms (`'global'`). When FTS5 is unavailable, the system SHALL fall back to a LIKE scan over topic, description, and content. Each result row SHALL include both `created_at` and `updated_at` (epoch ms integers).

#### Scenario: atom-search without scope includes all workspaces
- **GIVEN** matching atoms exist in the current workspace and in a second workspace
- **WHEN** atom-search is called with no scope argument
- **THEN** results from both workspaces are returned, each including project context

#### Scenario: atom-search with scope='workspace' restricts to current workspace
- **GIVEN** a matching atom exists in both the current workspace and a second workspace
- **WHEN** atom-search is called with scope='workspace'
- **THEN** only the current-workspace result is returned

#### Scenario: atom-search falls back to LIKE scan when FTS5 is absent
- **GIVEN** FTS5 is not available and an atom with matching content exists
- **WHEN** atom-search is called
- **THEN** results are returned via a LIKE scan over topic, description, and content

#### Scenario: atom-search results include created_at and updated_at
- **GIVEN** atoms with known timestamps exist in the database
- **WHEN** atom-search is called
- **THEN** each result row includes both `created_at` and `updated_at` as epoch ms integers

### Requirement: atom-list returns current-workspace and global atoms by default
The system SHALL list atoms matching an optional topic prefix, returning current-workspace and global atoms by default. When `scope='all'` is passed, it SHALL include atoms from all workspaces. Each result SHALL include topic, description, 80-char content preview, scope, project, `created_at`, and `updated_at`.

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

