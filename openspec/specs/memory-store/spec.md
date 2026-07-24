# memory-store Specification

## Purpose

Behaviour contract for the SQLite-backed persistent store: schema, write transactions, prune, and watermark semantics.
## Requirements
### Requirement: ensureSchema creates three tables and three indexes
The system SHALL create the `hot_state`, `memory_signal`, `distil_watermark`, and `memory_atom` base tables, one `memory_atom_fts` external-content FTS5 virtual table, three FTS sync triggers (`memory_atom_ai`, `memory_atom_ad`, `memory_atom_au`), and all associated indexes when `ensureSchema` is called. The FTS virtual table and trigger DDL SHALL be wrapped in a try/catch so `ensureSchema` does not fail when FTS5 is unavailable.

#### Scenario: Fresh database initialisation
- **GIVEN** a new SQLite database with no tables
- **WHEN** `ensureSchema` is called
- **THEN** all four base tables, the FTS virtual table (when FTS5 is available), three sync triggers, and all indexes exist

#### Scenario: Idempotent re-initialisation
- **GIVEN** a database where `ensureSchema` has already been called
- **WHEN** `ensureSchema` is called again
- **THEN** no error is raised and the schema is unchanged

### Requirement: hot_state uniqueness constraint
The `hot_state` table SHALL enforce a UNIQUE constraint on `(scope, agent, project, session_id)`. Each session maintains its own resumable row; two sessions on the same project do not conflict.

#### Scenario: Two sessions on the same project each write their own row
- **GIVEN** a hot_state row exists for (scope='project', agent='a', project='/p', session_id='s1')
- **WHEN** a distil-write is executed for session_id='s2' on the same project
- **THEN** a second row is inserted with session_id='s2' and the first row is unchanged

### Requirement: distil-write upserts hot_state with monotonic guard
The system SHALL write the distilled summary to the session's own `hot_state` row (keyed by `session_id`) only when the incoming `updated_at` timestamp is strictly greater than the stored value for that session. The monotonic guard protects a single session's row from regressing when two idle distils of the same session race.

#### Scenario: Fresh distil write for a session
- **GIVEN** no hot_state row exists for (scope, agent, project, session_id)
- **WHEN** a distil-write transaction is executed
- **THEN** a new hot_state row is inserted with the given session_id

#### Scenario: Newer distil write for same session
- **GIVEN** hot_state has a row for session_id='s1' with updated_at=T
- **WHEN** a distil-write is executed for session_id='s1' with updated_at=T+1
- **THEN** the row for session_id='s1' is updated and no other session rows are affected

#### Scenario: Same-timestamp distil write is not applied
- **GIVEN** hot_state has a row for session_id='s1' with updated_at=T
- **WHEN** a distil-write is executed for session_id='s1' with updated_at=T
- **THEN** the row for session_id='s1' is NOT updated

### Requirement: distil-write prunes consumed signals
The system SHALL DELETE only the `memory_signal` rows for the current session (WHERE `session_id = ?` AND `created_at <= lastSignalMs`) as part of the distil-write transaction. Signals belonging to other sessions SHALL NOT be deleted.

#### Scenario: Distil prunes only the current session's signals
- **GIVEN** memory_signal rows exist for session_id='s1' (up to lastSignalMs) and session_id='s2'
- **WHEN** distil-write is executed for session_id='s1'
- **THEN** session s1 signals with created_at <= lastSignalMs are deleted and session s2 signals are untouched

#### Scenario: Stale distil still prunes own signals and advances watermark
- **GIVEN** hot_state already has a newer entry for the session (distil is stale)
- **WHEN** a distil-write transaction is executed for the same session
- **THEN** this session's signals up to lastSignalMs are deleted AND the watermark is advanced, but hot_state is NOT changed

### Requirement: distil-write advances the watermark

The system SHALL advance the `distil_watermark` for the session as part of the distil-write transaction, regardless of whether `hot_state` was updated.

#### Scenario: Watermark advanced after write
- **GIVEN** a distil-write transaction is executed with `lastSignalMs = S` and `now = N`
- **WHEN** the transaction completes
- **THEN** the `distil_watermark` row for the session has `last_signal_ms >= S` and `last_distil_ms >= N`

### Requirement: prune removes old signals

The system SHALL DELETE all `memory_signal` rows with `created_at < cutoff` when a prune transaction is executed.

#### Scenario: Old signals are deleted
- **GIVEN** `memory_signal` rows exist with `created_at` both below and at/above the cutoff
- **WHEN** `prune(cutoff)` is called
- **THEN** rows with `created_at < cutoff` are deleted and rows at or above the cutoff remain

### Requirement: prune removes stale watermarks

The system SHALL DELETE all `distil_watermark` rows where `MAX(last_signal_ms, last_distil_ms) < cutoff` when a prune transaction is executed.

#### Scenario: Stale watermarks are deleted
- **GIVEN** `distil_watermark` rows exist with varying `last_signal_ms` and `last_distil_ms`
- **WHEN** `prune(cutoff)` is called
- **THEN** rows where `MAX(last_signal_ms, last_distil_ms) < cutoff` are deleted

### Requirement: prune returns counts

The system SHALL return `{ pruned, prunedWatermarks }` from the prune transaction, where `pruned` is the number of deleted signal rows and `prunedWatermarks` is the number of deleted watermark rows.

#### Scenario: Prune with old data
- **GIVEN** `memory_signal` and `distil_watermark` rows older than the cutoff exist
- **WHEN** `prune(cutoff)` is called
- **THEN** matching rows are deleted and the returned counts are accurate

#### Scenario: Prune with no old data
- **GIVEN** all rows have timestamps at or after the cutoff
- **WHEN** `prune(cutoff)` is called
- **THEN** no rows are deleted and `{ pruned: 0, prunedWatermarks: 0 }` is returned

### Requirement: watermark values are monotonically non-decreasing

The system SHALL ensure that `last_signal_ms` and `last_distil_ms` in `distil_watermark` never decrease for a given `session_id`; any attempt to advance with a lower value SHALL be ignored.

#### Scenario: Advance with higher value
- **GIVEN** a watermark row with `last_signal_ms = 100`
- **WHEN** the watermark is advanced with `last_signal_ms = 200`
- **THEN** `last_signal_ms` is updated to 200

#### Scenario: Advance with lower value
- **GIVEN** a watermark row with `last_signal_ms = 200`
- **WHEN** the watermark is advanced with `last_signal_ms = 100`
- **THEN** `last_signal_ms` remains 200

### Requirement: distil-write keeps at most 5 hot_state rows per project
As part of the distil-write transaction (after upsert, before signal delete), the system SHALL delete all but the 5 most recent `hot_state` rows for the project, ordered by `updated_at DESC, id DESC`. The prune SHALL be implemented in a `pruneHotState(db, agent, project)` helper called from the distil transaction.

#### Scenario: Sixth session evicts the oldest project row
- **GIVEN** hot_state has 5 rows for the same (scope='project', agent, project)
- **WHEN** a distil-write upserts a new session row (the 6th)
- **THEN** the row with the oldest updated_at for that project is deleted and 5 rows remain

#### Scenario: Prune does not affect rows from different projects
- **GIVEN** 6 hot_state rows exist for project='/p1' and 3 rows for project='/p2'
- **WHEN** distil-write runs for project='/p1'
- **THEN** project='/p1' is pruned to 5 rows and project='/p2' rows are unchanged

### Requirement: hot_state schema is rebuilt when user_version is below 2
The system SHALL, when `PRAGMA user_version < 2` AND the `hot_state` table lacks a `session_id` column (shape probe), execute a table rebuild inside one transaction: create `hot_state_new` with the new schema (UNIQUE(scope,agent,project,session_id), no `adr_candidate`), copy all existing rows (session_id='' as default), drop the old table, rename, recreate indexes, migrate summaries to atoms, and set `PRAGMA user_version = 2`. The migration SHALL be skipped when the shape probe shows `session_id` already exists (idempotent on fresh DBs).

#### Scenario: Migration rebuilds hot_state and bumps user_version
- **GIVEN** a database with user_version < 2 and an old-schema hot_state table
- **WHEN** ensureSchema is called
- **THEN** hot_state has the new schema (session_id column present, adr_candidate absent), existing rows are preserved with session_id='', and user_version is 2

#### Scenario: Migration is skipped when user_version is already 2
- **GIVEN** user_version = 2
- **WHEN** ensureSchema is called
- **THEN** no rebuild is executed and no data is altered

#### Scenario: Shape probe prevents rebuild on a fresh database
- **GIVEN** a fresh database initialised with the new schema (session_id present, user_version may be 0 on first run)
- **WHEN** ensureSchema is called
- **THEN** no rebuild is executed because the shape probe finds session_id already present

### Requirement: memory_state_patch upserts a skeleton row when the session row is absent
The system SHALL insert a skeleton `hot_state` row (`last_worked_summary=NULL`, `next_action=NULL`, `open_questions='[]'`) for `(scope, agent, project, session_id)` when no such row exists, then apply the supplied patch, so that agents can set state before the first distil. The tool SHALL return whether the row was created or updated.

#### Scenario: Patch on a missing session row creates a skeleton and applies the patch
- **GIVEN** no hot_state row exists for the calling session
- **WHEN** memory_state_patch is called with a next_action patch
- **THEN** a new hot_state row exists with next_action set to the patched value and other fields at their skeleton defaults

#### Scenario: Patch on an existing session row updates fields
- **GIVEN** a hot_state row already exists for the calling session
- **WHEN** memory_state_patch is called with a last_worked_summary patch
- **THEN** last_worked_summary is updated and all other fields retain their current values

