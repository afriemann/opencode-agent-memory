## MODIFIED Requirements

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

### Requirement: atom-patch performs a content-preserving partial metadata update

The `atom-patch` command SHALL accept `always_include` as a patchable field in the patch object. An explicit `always_include: true` SHALL set the column to `1`; an explicit `always_include: false` SHALL set it to `0`; an omitted `always_include` key SHALL leave the column unchanged. When `always_include` is changed, `updated_at` SHALL be bumped to the current timestamp.

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

## ADDED Requirements

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
