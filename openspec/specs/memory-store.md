# Spec: Memory Store

Behaviour contract for the SQLite-backed persistent store: schema, write transactions, prune, and watermark semantics.

---

## Schema

### Requirement: ensureSchema creates three tables and three indexes

The system SHALL create the `hot_state`, `memory_signal`, and `distil_watermark` tables, along with their associated indexes, when `ensureSchema` is called.

#### Scenario: Fresh database initialisation
- GIVEN a new SQLite database with no tables
- WHEN `ensureSchema` is called
- THEN all three tables exist and the indexes are present

#### Scenario: Idempotent re-initialisation
- GIVEN a database where `ensureSchema` has already been called
- WHEN `ensureSchema` is called again
- THEN no error is raised and the schema is unchanged

### Requirement: hot_state uniqueness constraint

The `hot_state` table SHALL enforce a UNIQUE constraint on `(scope, agent, project)`.

---

## Distil-Write Transaction

### Requirement: distil-write upserts hot_state with monotonic guard

The system SHALL write the distilled summary to `hot_state` only when the incoming `updated_at` timestamp is strictly greater than the stored value; an equal or older timestamp SHALL NOT overwrite the stored record.

#### Scenario: Fresh distil write
- GIVEN `hot_state` has no row for `(scope, agent, project)`
- WHEN a distil-write transaction is executed
- THEN a new `hot_state` row is inserted

#### Scenario: Newer distil write
- GIVEN `hot_state` has an existing row with `updated_at = T`
- WHEN a distil-write is executed with `updated_at = T+1`
- THEN the `hot_state` row is updated

#### Scenario: Same-timestamp distil write
- GIVEN `hot_state` has an existing row with `updated_at = T`
- WHEN a distil-write is executed with `updated_at = T`
- THEN the `hot_state` row is NOT updated

### Requirement: distil-write prunes consumed signals

The system SHALL DELETE all `memory_signal` rows with `created_at <= lastSignalMs` as part of the distil-write transaction.

### Requirement: distil-write advances the watermark

The system SHALL advance the `distil_watermark` for the session as part of the distil-write transaction, regardless of whether `hot_state` was updated.

#### Scenario: Stale distil still advances watermark and prunes signals
- GIVEN `hot_state` already has a newer entry (distil is stale)
- WHEN a distil-write transaction is executed
- THEN signals up to `lastSignalMs` are deleted AND the watermark is advanced, but `hot_state` is NOT changed

---

## Prune Transaction

### Requirement: prune removes old signals

The system SHALL DELETE all `memory_signal` rows with `created_at < cutoff` when a prune transaction is executed.

### Requirement: prune removes stale watermarks

The system SHALL DELETE all `distil_watermark` rows where `MAX(last_signal_ms, last_distil_ms) < cutoff` when a prune transaction is executed.

### Requirement: prune returns counts

The system SHALL return `{ pruned, prunedWatermarks }` from the prune transaction, where `pruned` is the number of deleted signal rows and `prunedWatermarks` is the number of deleted watermark rows.

#### Scenario: Prune with old data
- GIVEN `memory_signal` and `distil_watermark` rows older than the cutoff exist
- WHEN `prune(cutoff)` is called
- THEN matching rows are deleted and the returned counts are accurate

#### Scenario: Prune with no old data
- GIVEN all rows have timestamps at or after the cutoff
- WHEN `prune(cutoff)` is called
- THEN no rows are deleted and `{ pruned: 0, prunedWatermarks: 0 }` is returned

---

## Watermark

### Requirement: watermark values are monotonically non-decreasing

The system SHALL ensure that `last_signal_ms` and `last_distil_ms` in `distil_watermark` never decrease for a given `session_id`; any attempt to advance with a lower value SHALL be ignored.

#### Scenario: Advance with higher value
- GIVEN a watermark row with `last_signal_ms = 100`
- WHEN the watermark is advanced with `last_signal_ms = 200`
- THEN `last_signal_ms` is updated to 200

#### Scenario: Advance with lower value
- GIVEN a watermark row with `last_signal_ms = 200`
- WHEN the watermark is advanced with `last_signal_ms = 100`
- THEN `last_signal_ms` remains 200
