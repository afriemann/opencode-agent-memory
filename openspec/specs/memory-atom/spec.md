# memory-atom Specification

## Purpose
TBD - created by archiving change memory-atoms-and-session-hot-state. Update Purpose after archive.
## Requirements
### Requirement: memory_atom table stores named durable knowledge atoms

The `memory_atom` table SHALL include an `always_include INTEGER NOT NULL DEFAULT 0` column. Existing rows following a v5→v6 migration SHALL have `always_include = 0`. The v6 migration block SHALL be gated by `PRAGMA user_version < 6`, probe `PRAGMA table_info(memory_atom)` for the absence of `always_include`, run `ALTER TABLE memory_atom ADD COLUMN always_include INTEGER NOT NULL DEFAULT 0`, then stamp `PRAGMA user_version = 6`. A fresh-install database's `CREATE TABLE` baseline SHALL include `always_include INTEGER NOT NULL DEFAULT 0` so that fresh and migrated databases are schema-identical. The FTS5 virtual table and its sync triggers SHALL remain unchanged.

#### Scenario: Existing database gains always_include column after v6 migration
- **GIVEN** a database at schema version 5 with existing atoms
- **WHEN** `ensureSchema` runs
- **THEN** the `memory_atom` table gains an `always_include` column and all existing rows have `always_include = 0`

#### Scenario: Fresh database includes always_include column without migration
- **GIVEN** a brand-new database with no prior schema
- **WHEN** `ensureSchema` runs
- **THEN** the `memory_atom` table contains `always_include INTEGER NOT NULL DEFAULT 0` from the baseline CREATE TABLE

#### Scenario: v6 migration is safe to re-run
- **GIVEN** a database already at version 6 with always_include present
- **WHEN** `ensureSchema` runs again
- **THEN** no ALTER TABLE is executed and the schema is unchanged

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

The system SHALL append the resolved storage location to each `atom-write` confirmation: `"Created atom at {topic} [workspace: /git-root]"` for workspace-scoped atoms or `"Created atom at {topic} [global]"` for global atoms. The overwrite form SHALL be `"Updated existing atom at {topic} (previous content overwritten) [workspace: /git-root]"` or `"Updated existing atom at {topic} (previous content overwritten) [global]"`. The `memory.js` result JSON SHALL include the resolved `scope` and `project` fields so `plugin.js` can format the location suffix.

#### Scenario: atom-write on new topic reports Created
- **GIVEN** no atom exists at the given topic
- **WHEN** atom-write is called with a valid description
- **THEN** stdout contains 'Created atom at <topic>'

#### Scenario: atom-write on existing topic reports Updated
- **GIVEN** an atom already exists at the given topic
- **WHEN** atom-write is called with updated content
- **THEN** stdout contains 'Updated existing atom at <topic> (previous content overwritten)'

#### Scenario: atom-write created confirmation includes location
- **GIVEN** no atom exists at the given topic
- **WHEN** `atom-write` is called with workspace resolving to project='/repo'
- **THEN** stdout contains `Created atom at <topic> [workspace: /repo]`

#### Scenario: atom-write overwritten confirmation includes location
- **GIVEN** an atom exists at the given topic
- **WHEN** `atom-write` is called for the same topic with workspace resolving to project='/repo'
- **THEN** stdout contains `Updated existing atom at <topic> (previous content overwritten) [workspace: /repo]`

#### Scenario: atom-write global confirmation includes [global]
- **GIVEN** workspace is null (global write)
- **WHEN** `atom-write` is called
- **THEN** stdout contains `Created atom at <topic> [global]`

### Requirement: atom-append errors when the topic does not exist
The system SHALL reject an `atom-append` subcommand call with a non-zero exit code and the message `"Atom '<topic>' does not exist — use memory_atom_write to create it first"` when no atom with the given (scope, project, topic) exists. No create-on-missing behaviour SHALL occur, preserving the invariant that every atom is created via atom-write with a required description.

#### Scenario: atom-append on missing topic errors
- **GIVEN** no atom exists at (scope, project, topic)
- **WHEN** `node memory.js atom-append <scope> <project> '{"topic":"t","content":"c"}'` is called
- **THEN** the process exits non-zero and stderr contains "Atom '<topic>' does not exist — use memory_atom_write to create it first"

### Requirement: atom-append appends content with separator and returns updated full content

The `atom-append` result SHALL include the resolved scope and project fields alongside the updated content, so the calling `plugin.js` layer can append the location suffix to its response.

#### Scenario: atom-append appends to existing atom
- **GIVEN** an atom exists at topic 'work/notes' with content='initial content'
- **WHEN** atom-append is called with content='new finding'
- **THEN** the stored content is 'initial content\n---\nnew finding' and the full updated content is printed on stdout

#### Scenario: atom-append result includes resolved location fields
- **GIVEN** an atom exists at topic 'work/notes' in project '/repo'
- **WHEN** `atom-append` is called
- **THEN** the result JSON includes `scope` and `project` fields

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

The `atom-search` CLI subcommand and the `atomSearch` schema function SHALL rename the `query` field to `keywords` in the JSON payload. The SQLite FTS `MATCH` clause binding is unchanged. Callers that supply `query` instead of `keywords` SHALL receive an error or empty result (the old field name is not aliased).

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

#### Scenario: atom-search with keywords field returns matching atoms
- **GIVEN** atoms exist with matching content
- **WHEN** `atom-search` JSON payload contains `{ "keywords": "auth" }`
- **THEN** matching atoms are returned

#### Scenario: atom-search with legacy query field returns error or empty
- **GIVEN** atoms exist with matching content
- **WHEN** `atom-search` JSON payload contains `{ "query": "auth" }` (old name)
- **THEN** the command errors (missing required keywords field) or returns empty results

### Requirement: atom-list returns current-workspace and global atoms by default

The `atom-list` command SHALL include `always_include` (as a `0` or `1` integer) in its output for every atom row. The `always_include` value SHALL be the raw integer flag; full atom content SHALL NOT be returned by `atom-list` regardless of the flag value.

#### Scenario: atom-list output includes always_include flag
- **GIVEN** atoms exist with mixed `always_include` values (0 and 1)
- **WHEN** `atom-list` is called
- **THEN** each row in the output includes the `always_include` field with the correct value

#### Scenario: atom-list does not return full content for always_include atoms
- **GIVEN** an atom with `always_include = 1` and long content
- **WHEN** `atom-list` is called
- **THEN** the row's content field is the 80-character `preview` and does not contain the full content

### Requirement: atom-delete removes the atom and updates the FTS index

The `atom-delete` result JSON SHALL include the resolved `scope` and `project` so the `plugin.js` layer can append the location suffix `[workspace: /path]` or `[global]` to the confirmation.

#### Scenario: atom-delete removes an existing atom
- **GIVEN** an atom exists at the given (scope, project, topic)
- **WHEN** atom-delete is called
- **THEN** the atom is removed from memory_atom, FTS integrity-check passes, and stdout contains a one-line confirmation

#### Scenario: atom-delete on a missing topic exits non-zero
- **GIVEN** no atom exists at the given (scope, project, topic)
- **WHEN** atom-delete is called
- **THEN** the process exits with a non-zero code and stderr contains an informative message

#### Scenario: atom-delete result includes resolved location fields
- **GIVEN** an atom exists at topic 'arch/db' in project '/repo'
- **WHEN** `atom-delete` is called
- **THEN** the result JSON includes `scope` and `project` fields

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

When the patch payload contains a `targetWorkspace` field, the `atomPatch` function SHALL execute an atomic move under `BEGIN IMMEDIATE`: SELECT the full source row (error if not found), DELETE from the source (scope, project, topic), INSERT/UPSERT at the destination (targetScope, targetProject, topic) preserving all columns and bumping `updated_at`. The destination UPSERT SHALL use `ON CONFLICT(scope, project, topic) DO UPDATE` (overwrite). When source and destination resolve to the same (scope, project) pair, the move step SHALL be skipped and a normal in-place metadata patch SHALL execute instead. Combined move + metadata: any other present patch fields SHALL be applied to the row before the destination INSERT. The FTS sync triggers fire automatically on the DELETE and INSERT.

#### Scenario: Patch sets always_include to true
- **GIVEN** an atom with `always_include = 0`
- **WHEN** `atom-patch` is called with `patch.always_include = true`
- **THEN** the atom has `always_include = 1` and `updated_at` is updated

#### Scenario: Patch clears always_include
- **GIVEN** an atom with `always_include = 1`
- **WHEN** `atom-patch` is called with `patch.always_include = false`
- **THEN** the atom has `always_include = 0` and `updated_at` is updated

#### Scenario: Omitting always_include in patch leaves it unchanged
- **GIVEN** an atom with `always_include = 1`
- **WHEN** `atom-patch` is called with a patch that does not include `always_include`
- **THEN** the atom still has `always_include = 1`

#### Scenario: atomPatch moves atom to new project
- **GIVEN** an atom exists at (scope='project', project='/repo-a', topic='arch/db')
- **WHEN** `atomPatch` is called with source `{scope:'project', project:'/repo-a'}` and targetWorkspace resolving to `{scope:'project', project:'/repo-b'}`
- **THEN** no atom exists at ('/repo-a', 'arch/db') and one exists at ('/repo-b', 'arch/db') with all fields preserved

#### Scenario: atomPatch move overwrites destination conflict
- **GIVEN** atoms exist at both ('/repo-a', 'arch/db') and ('/repo-b', 'arch/db')
- **WHEN** `atomPatch` moves from '/repo-a' to '/repo-b'
- **THEN** '/repo-b' holds the source atom's content and '/repo-a' has no atom at that topic

#### Scenario: atomPatch source equals destination skips DELETE/INSERT
- **GIVEN** an atom exists at ('/repo', 'arch/db')
- **WHEN** `atomPatch` is called with source and targetWorkspace both resolving to '/repo'
- **THEN** the atom remains at '/repo' and the metadata patch is applied in place

#### Scenario: atomPatch combined move and status change
- **GIVEN** an atom exists at ('/repo-a', 'arch/db') with status='active'
- **WHEN** `atomPatch` is called with targetWorkspace='/repo-b' and patch status='resolved'
- **THEN** the atom lands at ('/repo-b', 'arch/db') with status='resolved'

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

### Requirement: atom-write preserves always_include flag on upsert

The `atom-write` command SHALL accept an optional `always_include` argument (default `0`). On first creation the provided value SHALL be written. On a content re-write to an existing topic, `always_include` SHALL NOT be included in the `ON CONFLICT DO UPDATE SET` clause; the existing flag value SHALL be preserved unchanged. To change the flag after creation, callers MUST use `atom-patch`.

#### Scenario: atom-write stores always_include on first creation
- **GIVEN** no atom exists for the given topic
- **WHEN** `atom-write` is called with `always_include = 1`
- **THEN** the created atom has `always_include = 1`

#### Scenario: atom-write preserves always_include on re-write
- **GIVEN** an atom exists with `always_include = 1`
- **WHEN** `atom-write` is called again for the same topic with new content (and `always_include` omitted or set to 0)
- **THEN** the atom retains `always_include = 1` and the content is updated

#### Scenario: atom-write defaults always_include to 0 when omitted
- **GIVEN** no atom exists for the given topic
- **WHEN** `atom-write` is called without specifying `always_include`
- **THEN** the created atom has `always_include = 0`

### Requirement: atom-list-full returns full content for always_include active atoms

The `atom-list-full` command SHALL return full content rows — `scope`, `project`, `topic`, `description`, `content`, `updated_at` — for all atoms where `always_include = 1 AND status = 'active'` in the current workspace scope and the global scope, in a single query, ordered by `updated_at DESC, topic`. Only `status = 'active'` atoms SHALL be included; resolved and deprecated atoms SHALL be excluded even if flagged. The command SHALL NOT apply a row limit.

#### Scenario: atom-list-full returns workspace and global flagged atoms together
- **GIVEN** a workspace atom with `always_include = 1, status = 'active'` and a global atom with `always_include = 1, status = 'active'`
- **WHEN** `atom-list-full` is called for the current workspace
- **THEN** both atoms appear in the output, each carrying their `scope` field

#### Scenario: atom-list-full excludes resolved and deprecated atoms
- **GIVEN** atoms with `always_include = 1` and `status = 'resolved'` or `status = 'deprecated'`
- **WHEN** `atom-list-full` is called
- **THEN** those atoms are absent from the output

#### Scenario: atom-list-full excludes non-flagged atoms
- **GIVEN** an active atom with `always_include = 0`
- **WHEN** `atom-list-full` is called
- **THEN** that atom is absent from the output

### Requirement: resolveWorkspace normalises workspace param to CLI scope/project pair

The system SHALL provide a `resolveWorkspace(workspace, contextDirectory)` function in `src/lib/workspace.js` that maps the `workspace` parameter to a `{ scope, project }` pair for the database layer. The function SHALL: return `{ scope: 'global', project: '' }` when `workspace` is `null`; expand `"."` to `path.resolve(contextDirectory)` before any git-root walk (the literal string `"."` SHALL never be passed to `findGitRoot`); for any string value, call `findGitRoot(expandedPath)` and return `{ scope: 'project', project: gitRoot }`. The companion function `findGitRoot(startAbsPath)` SHALL walk up from `startAbsPath` looking for a `.git` entry at each directory level: if `.git` is a directory → return that directory (the git root); if `.git` is a file → worktree pointer, continue walking to `path.dirname(dir)`; if the filesystem root is reached with no `.git` directory found → return `startAbsPath` unchanged. Both functions SHALL use `node:fs` only — no `git` binary dependency.

#### Scenario: findGitRoot stops at .git directory
- **GIVEN** `/repo/.git` is a directory
- **WHEN** `findGitRoot('/repo/src/lib')` is called
- **THEN** the result is `/repo`

#### Scenario: findGitRoot skips .git file and continues
- **GIVEN** `/repo/.worktrees/wt/.git` is a file and `/repo/.git` is a directory
- **WHEN** `findGitRoot('/repo/.worktrees/wt/src')` is called
- **THEN** the result is `/repo`

#### Scenario: findGitRoot returns startAbsPath when no .git directory found
- **GIVEN** no `.git` directory exists in any ancestor of `/no-git/project`
- **WHEN** `findGitRoot('/no-git/project')` is called
- **THEN** the result is `/no-git/project`

#### Scenario: resolveWorkspace expands "." before walk
- **GIVEN** `contextDirectory` is `/repo` and `/repo/.git` is a directory
- **WHEN** `resolveWorkspace('.', '/repo')` is called
- **THEN** the result is `{ scope: 'project', project: '/repo' }` (not `{ project: '.' }`)

### Requirement: atom-list-workspaces command lists workspace paths with atom counts

The system SHALL expose an `atom-list-workspaces` CLI subcommand in `src/memory.js` that calls `atomListWorkspaces(db, { includeDeprecated? })` in `src/lib/schema.js`. The `atomListWorkspaces` function SHALL query `memory_atom` for rows where `scope = 'project'` and `project != ''`, group by `project`, count rows per group, exclude `status = 'deprecated'` rows by default (and include them when `includeDeprecated` is true), and return `[{ workspace: project, count }]` ordered by count descending. Global atoms (`scope = 'global'`) SHALL be excluded from results.

#### Scenario: atomListWorkspaces returns workspace paths with counts
- **GIVEN** 3 atoms in project='/repo-a' and 1 atom in project='/repo-b' (all active)
- **WHEN** `atomListWorkspaces(db, {})` is called
- **THEN** the result is `[{ workspace: '/repo-a', count: 3 }, { workspace: '/repo-b', count: 1 }]` ordered by count desc

#### Scenario: atomListWorkspaces excludes global atoms
- **GIVEN** atoms exist in scope='project' and scope='global'
- **WHEN** `atomListWorkspaces(db, {})` is called
- **THEN** no row with scope='global' appears in the results

#### Scenario: atomListWorkspaces excludes deprecated by default
- **GIVEN** 2 active atoms and 1 deprecated atom in project='/repo'
- **WHEN** `atomListWorkspaces(db, {})` is called
- **THEN** the count for '/repo' is 2 (deprecated excluded)

#### Scenario: atomListWorkspaces includes deprecated when requested
- **GIVEN** 2 active atoms and 1 deprecated atom in project='/repo'
- **WHEN** `atomListWorkspaces(db, { includeDeprecated: true })` is called
- **THEN** the count for '/repo' is 3

