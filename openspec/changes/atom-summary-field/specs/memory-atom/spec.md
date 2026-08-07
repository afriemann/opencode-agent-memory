## MODIFIED Requirements

### Requirement: memory_atom table stores named durable knowledge atoms

The `memory_atom` table SHALL include both an `always_include INTEGER NOT NULL DEFAULT 0` column and a `summary TEXT NOT NULL DEFAULT ''` column. A fresh-install database's `CREATE TABLE` baseline SHALL include both `always_include INTEGER NOT NULL DEFAULT 0` and `summary TEXT NOT NULL DEFAULT ''` so that fresh and migrated databases are schema-identical. The v6 migration block (always_include) SHALL remain unchanged. The v7 migration block SHALL be gated by `PRAGMA user_version < 7`, probe `PRAGMA table_info(memory_atom)` for the absence of `summary`, run `ALTER TABLE memory_atom ADD COLUMN summary TEXT NOT NULL DEFAULT ''` inside a transaction that also stamps `PRAGMA user_version = 7`, rolling back on error. When the `summary` column is already present (shape-probe returns present), the v7 block SHALL stamp `PRAGMA user_version = 7` only and skip the `ALTER TABLE`. Existing rows following a v6→v7 migration SHALL have `summary = ''`. The FTS5 virtual table and its sync triggers SHALL remain unchanged — `summary` is NOT added to the FTS index.

#### Scenario: Existing v6 database gains summary column after v7 migration
- **GIVEN** a database at schema version 6 with existing atoms and no `summary` column
- **WHEN** `ensureSchema` runs
- **THEN** the `memory_atom` table gains a `summary TEXT NOT NULL DEFAULT ''` column, all existing rows have `summary = ''`, and `PRAGMA user_version` is 7

#### Scenario: Fresh database includes summary column without migration
- **GIVEN** a brand-new database with no prior schema
- **WHEN** `ensureSchema` runs
- **THEN** the `memory_atom` table contains `summary TEXT NOT NULL DEFAULT ''` from the baseline CREATE TABLE and `PRAGMA user_version` is 7

#### Scenario: v7 migration is safe to re-run
- **GIVEN** a database already at version 7 with `summary` present
- **WHEN** `ensureSchema` runs again
- **THEN** no `ALTER TABLE` is executed, the schema is unchanged, and `PRAGMA user_version` remains 7

#### Scenario: FTS virtual table is unchanged by v7 migration
- **GIVEN** a database at schema version 6 with `memory_atom_fts` indexing topic, description, content, tags
- **WHEN** `ensureSchema` runs and the v7 migration completes
- **THEN** `memory_atom_fts` still indexes only topic, description, content, tags; `summary` is not present in the FTS schema

### Requirement: atom-get returns best-match full content and a foreign-workspace listing

The system SHALL resolve the single best full-content match for a topic using priority order (current-workspace atom preferred, global atom as fallback). It SHALL separately query other workspaces for atoms at the same topic and return a listing (topic, description, summary, 80-char content preview, project, updated_at, status). The response SHALL have shape `{ match: <full row | null>, alsoIn: <listing rows> }`. When no current-workspace or global atom exists, `match` SHALL be null and only the `alsoIn` listing is populated. The `match` row and each `alsoIn` row SHALL include both `created_at` and `updated_at` (epoch ms integers) and `status`. The `alsoIn` listing SHALL include atoms of all status values (including `deprecated`) and SHALL label each entry with the atom's status when it is not `active`. `atom-get` SHALL apply no status predicate — it always returns the best-match atom regardless of its `status`. When an optional workspace directory path is provided, the system SHALL resolve the atom against that directory instead of the process's current working directory. The `alsoIn` query SHALL include both `summary` and `substr(content, 1, 80) AS preview` for each row. The `alsoIn` listing SHALL be formatted as one line per entry, with the content segment showing `summary` when non-empty, else `preview`; when both are empty the content segment and its separator SHALL be omitted entirely. Format: `• [workspace: <project-path>] <topic> — <description>[  | <summary-or-preview>] [created: …, updated: …]` for workspace-scoped foreign atoms, and `• [global] <topic> — <description>[ | <summary-or-preview>] [created: …, updated: …]` for global-scoped foreign atoms.

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

#### Scenario: alsoIn entry shows summary when non-empty
- **GIVEN** a foreign atom at topic 'arch/db' exists with a non-empty `summary='Key authentication decisions'`
- **WHEN** `atom-get` is called and the foreign atom appears in `alsoIn`
- **THEN** the formatted alsoIn line includes 'Key authentication decisions' and does not show the raw content preview

#### Scenario: alsoIn entry falls back to preview when summary is empty
- **GIVEN** a foreign atom at topic 'arch/db' exists with `summary=''` and content starting with '# Design notes'
- **WHEN** `atom-get` is called and the foreign atom appears in `alsoIn`
- **THEN** the formatted alsoIn line includes the first 80 characters of the content as a preview

#### Scenario: alsoIn entry omits content segment when both summary and preview are empty
- **GIVEN** a foreign atom at topic 'arch/db' exists with `summary=''` and `content=''`
- **WHEN** `atom-get` is called and the foreign atom appears in `alsoIn`
- **THEN** the formatted alsoIn line does not contain a `|` separator or trailing empty segment

### Requirement: atom-list returns current-workspace and global atoms by default

The `atom-list` command SHALL include `always_include` (as a `0` or `1` integer) and `summary` (a TEXT string, possibly empty) in its output for every atom row. The `always_include` value SHALL be the raw integer flag; the `summary` value SHALL be the stored summary string. Full atom content SHALL NOT be returned by `atom-list` regardless of the `always_include` flag value. The `atom-list` query SHALL also include `substr(content, 1, 80) AS preview` in its output for use as a silent display fallback when `summary` is empty.

#### Scenario: atom-list output includes summary field
- **GIVEN** atoms exist with and without a `summary` value set
- **WHEN** `atom-list` is called
- **THEN** each row in the output includes the `summary` field with the stored value (non-empty string when set, empty string when not set)

#### Scenario: atom-list output includes always_include flag
- **GIVEN** atoms exist with mixed `always_include` values (0 and 1)
- **WHEN** `atom-list` is called
- **THEN** each row in the output includes the `always_include` field with the correct value

#### Scenario: atom-list does not return full content
- **GIVEN** an atom with `always_include = 1` and long content, with or without a summary
- **WHEN** `atom-list` is called
- **THEN** the row includes `summary` and `preview` (the 80-character content truncation) but does not contain the full `content` field

### Requirement: atom-search searches all workspaces by default and supports scope narrowing

The system SHALL execute a full-text MATCH query across all atoms when no scope is specified, ordering results by BM25 score and including scope and project context in each result. The optional `scope` parameter SHALL narrow the search to the current workspace (`'workspace'`) or global-only atoms (`'global'`). When FTS5 is unavailable, the system SHALL fall back to a LIKE scan over topic, description, and content. Each result row SHALL include `created_at` and `updated_at` (epoch ms integers), `status`, `summary` (the stored summary string), and `substr(content, 1, 80) AS preview` (for display fallback). By default, `atom-search` SHALL exclude `deprecated` atoms. The search JSON blob SHALL accept optional `status` (exact-match string, one of `active`, `resolved`, or `deprecated`) and `includeDeprecated` (boolean); when `status` is present it SHALL override `includeDeprecated` and the default filter; when only `includeDeprecated` is truthy it SHALL lift all status filtering.

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

#### Scenario: atom-search result rows include summary and preview
- **GIVEN** a matching atom exists with `summary='Concise summary text'` and content starting with '# Full content'
- **WHEN** `atom-search` is called
- **THEN** each result row includes both a `summary` field with the stored value and a `preview` field with the first 80 characters of content

### Requirement: atom-patch performs a content-preserving partial metadata update

The `atom-patch` command SHALL accept `always_include` and `summary` as patchable fields in the patch object. An explicit `always_include: true` SHALL set the column to `1`; an explicit `always_include: false` SHALL set it to `0`; an omitted `always_include` key SHALL leave the column unchanged. When `always_include` is changed, `updated_at` SHALL be bumped to the current timestamp. An explicit `summary` string value SHALL replace the stored summary; when `summary` is patched its value MUST be a non-empty string of at most 280 characters (enforced at the helper level); patching `summary` SHALL bump `updated_at`. An omitted `summary` key SHALL leave the stored summary unchanged.

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

#### Scenario: Patch sets summary on an existing atom
- **GIVEN** an atom exists with `summary = ''`
- **WHEN** `atom-patch` is called with `patch.summary = 'Revised one-line digest'`
- **THEN** the atom has `summary = 'Revised one-line digest'` and `updated_at` is bumped

#### Scenario: Patch rejects empty summary string
- **GIVEN** an atom exists
- **WHEN** `atom-patch` is called with `patch.summary = ''`
- **THEN** the process exits non-zero with an error message and the atom is unchanged

#### Scenario: Patch rejects summary exceeding 280 characters
- **GIVEN** an atom exists
- **WHEN** `atom-patch` is called with a `summary` value of 281 characters
- **THEN** the process exits non-zero with an error message and the atom is unchanged

#### Scenario: Omitting summary in patch leaves it unchanged
- **GIVEN** an atom exists with `summary = 'Existing summary'`
- **WHEN** `atom-patch` is called with a patch that does not include `summary`
- **THEN** the atom still has `summary = 'Existing summary'`

## ADDED Requirements

### Requirement: atom-write accepts and validates an optional summary field

The `atom-write` subcommand SHALL accept an optional `summary` field in its JSON payload. When `summary` is present in the payload, the system SHALL validate that the value is a non-empty string of at most 280 characters (after trim); it SHALL reject calls with an empty or over-length `summary` by exiting non-zero with a descriptive stderr message without writing any row. When `summary` is absent or undefined, it SHALL be stored as the empty string `''`. The `summary` field SHALL be included in the `ON CONFLICT(scope, project, topic) DO UPDATE SET` clause so that re-writing an atom refreshes its summary. Validation is enforced at the `atomWrite` helper in `schema.js`.

#### Scenario: atom-write with valid summary stores the value
- **GIVEN** an agent calls `atom-write` with `summary='One-sentence digest of this atom'`
- **WHEN** the atom is stored
- **THEN** the `summary` column value equals `'One-sentence digest of this atom'`

#### Scenario: atom-write without summary stores empty string
- **GIVEN** an agent calls `atom-write` without a `summary` field
- **WHEN** the atom is stored
- **THEN** the `summary` column value is `''`

#### Scenario: atom-write with empty summary is rejected
- **GIVEN** any database state
- **WHEN** `atom-write` is called with `summary=''`
- **THEN** the process exits non-zero and stderr contains a descriptive error; no row is written or updated

#### Scenario: atom-write with summary exceeding 280 characters is rejected
- **GIVEN** any database state
- **WHEN** `atom-write` is called with a `summary` value that is 281 characters long
- **THEN** the process exits non-zero and stderr contains a descriptive error; no row is written or updated

#### Scenario: Re-writing an atom with a new summary updates the stored summary
- **GIVEN** an atom exists at a topic with `summary='Old digest'`
- **WHEN** `atom-write` is called for the same topic with `summary='Updated digest'`
- **THEN** the atom's `summary` column value is `'Updated digest'`
