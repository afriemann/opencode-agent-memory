## ADDED Requirements

### Requirement: hot_state stores distillation cost and token counts
The `hot_state` table SHALL include three nullable columns: `distil_cost_usd REAL`, `distil_tokens_in INTEGER`, `distil_tokens_out INTEGER`. These SHALL be populated on each `distil-write` with the cost (USD float) and input/output token counts from the `session.prompt()` call that produced the distillation. When the `distil-write` payload does not include cost/token data (e.g. older callers), all three columns SHALL remain NULL without error. `cmdInspect` SHALL include all three columns in its SELECT so they appear in inspect output.

#### Scenario: distil-write stores cost and token counts
- **GIVEN** a `distil-write` payload that includes `distilCostUsd=0.0003`, `distilTokensIn=1200`, `distilTokensOut=80`
- **WHEN** `cmdDistilWrite` executes the UPSERT
- **THEN** the `hot_state` row for that session has `distil_cost_usd=0.0003`, `distil_tokens_in=1200`, `distil_tokens_out=80`

#### Scenario: distil-write without cost data leaves columns NULL
- **GIVEN** a `distil-write` payload that omits `distilCostUsd`, `distilTokensIn`, `distilTokensOut`
- **WHEN** `cmdDistilWrite` executes the UPSERT
- **THEN** the `hot_state` row has NULL for all three cost/token columns and no error is raised

#### Scenario: inspect output includes cost and token columns
- **GIVEN** a `hot_state` row with `distil_cost_usd=0.0005`, `distil_tokens_in=2000`, `distil_tokens_out=120`
- **WHEN** `node memory.js inspect <agent> <project>` is invoked
- **THEN** `prior.distil_cost_usd`, `prior.distil_tokens_in`, and `prior.distil_tokens_out` are present in the JSON output with the stored values

### Requirement: hot_state cost columns added via idempotent ALTER TABLE migration
The `ensureSchema` function SHALL add `distil_cost_usd`, `distil_tokens_in`, and `distil_tokens_out` to `hot_state` via separate `ALTER TABLE hot_state ADD COLUMN` statements, each wrapped in a `try/catch` so that re-running on an already-migrated database is a no-op without error.

#### Scenario: Migration runs on existing database
- **GIVEN** a database where `hot_state` was created without the cost columns
- **WHEN** `ensureSchema` is called
- **THEN** all three columns exist on `hot_state` afterwards and no error is raised

#### Scenario: Migration is idempotent
- **GIVEN** a database where the cost columns already exist on `hot_state`
- **WHEN** `ensureSchema` is called again
- **THEN** no error is raised and the schema is unchanged
