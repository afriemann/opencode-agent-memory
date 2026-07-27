## ADDED Requirements

### Requirement: inspect output includes distillation cost and token fields
The `inspect` CLI subcommand and the `memory_inspect` plugin tool SHALL include `distil_cost_usd`, `distil_tokens_in`, and `distil_tokens_out` in the `prior` object of their output when a `hot_state` row exists. These fields SHALL be `null` when the row was written before cost tracking was introduced (columns are nullable). No change is required to the tool layer beyond including the columns in `cmdInspect`'s SELECT.

#### Scenario: Inspect output contains cost fields when distil recorded them
- **GIVEN** a `hot_state` row with `distil_cost_usd=0.0003`, `distil_tokens_in=1200`, `distil_tokens_out=80`
- **WHEN** `memory_inspect` is called or `node memory.js inspect` is invoked
- **THEN** the returned JSON includes `prior.distil_cost_usd`, `prior.distil_tokens_in`, and `prior.distil_tokens_out` with the stored values

#### Scenario: Inspect output contains null cost fields for legacy rows
- **GIVEN** a `hot_state` row written before cost columns existed (all three columns NULL)
- **WHEN** `memory_inspect` is called or `node memory.js inspect` is invoked
- **THEN** the returned JSON includes `prior.distil_cost_usd: null`, `prior.distil_tokens_in: null`, and `prior.distil_tokens_out: null`
