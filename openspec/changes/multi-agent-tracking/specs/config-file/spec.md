## MODIFIED Requirements

### Requirement: Plugin loads config from ~/.config/opencode/agent-memory.jsonc on startup

The system SHALL attempt to read `~/.config/opencode/agent-memory.jsonc` (resolving `~` via `os.homedir()`) synchronously at module load time and use its values as defaults for `targetAgents`, `distilMinIntervalMs`, and `distillerModel`.

#### Scenario: Config file present with valid values

- **WHEN** `~/.config/opencode/agent-memory.jsonc` exists and contains valid JSONC with one or more of the keys `targetAgents`, `distilMinIntervalMs`, or `distillerModel`
- **THEN** the plugin uses those values (subject to env-var override)

#### Scenario: Config file absent

- **WHEN** `~/.config/opencode/agent-memory.jsonc` does not exist
- **THEN** the plugin starts without error and uses hardcoded defaults

### Requirement: Config file values are overridden by environment variables

The system SHALL apply the precedence order `env var > config file value > hardcoded default` **per key and independently**: for each of the three tuneable config keys the resolver takes the env var if set, else the file value if present and valid, else the hardcoded default. There is no all-or-nothing coupling between keys.

For `targetAgents`, the env var `MEMORY_TARGET_AGENTS` is a comma-separated string; the resolver splits on `,`, trims each element, and discards empty strings to produce a `string[]`. An env var that resolves to an empty array after splitting is a valid, silent "nothing tracked" outcome and does not fall back to the file value.

#### Scenario: Env var set alongside config file

- **WHEN** `MEMORY_TARGET_AGENTS=navigator,architect` is set in the environment AND `~/.config/opencode/agent-memory.jsonc` contains `"targetAgents": ["engineer"]`
- **THEN** the resolved `targetAgents` is `["navigator", "architect"]` (env var wins)

#### Scenario: Only config file set

- **WHEN** `MEMORY_TARGET_AGENTS` is not set in the environment AND `~/.config/opencode/agent-memory.jsonc` contains `"targetAgents": ["planner"]`
- **THEN** the resolved `targetAgents` is `["planner"]`

#### Scenario: Neither env var nor config file

- **WHEN** `MEMORY_TARGET_AGENTS` is not set AND the config file is absent or does not include `targetAgents`
- **THEN** the resolved `targetAgents` is `[]` (hardcoded default — no agents tracked)

#### Scenario: Env var set to empty string

- **WHEN** `MEMORY_TARGET_AGENTS` is set to an empty string or a string of only commas/whitespace
- **THEN** the resolved `targetAgents` is `[]` (env var wins with empty result; no fallback to file value)

### Requirement: Per-key value validation with per-key fallback

The system SHALL validate each file-supplied config value against its expected type. An invalid value for one key MUST cause that key to fall back to its hardcoded default and emit a `console.warn` with the `[agent-memory]` prefix naming the affected key; other valid keys from the same file are still applied.

Validation rules:
- `targetAgents` — MUST be an array. A non-array value falls back to `[]` with a warning. An array value is accepted as-is after dropping any element that is not a non-empty string (with a warning naming `targetAgents` if any element was dropped). An array that is empty — either supplied or after dropping invalid elements — is **valid and silent** (it is the documented "no agents tracked" state).
- `distilMinIntervalMs` — MUST yield a finite, positive number via `Number(...)`. Values that produce `NaN`, values ≤ 0, and non-numeric strings are rejected.
- `distillerModel` — MUST be a non-empty string.

#### Scenario: `distilMinIntervalMs` is non-numeric

- **WHEN** `~/.config/opencode/agent-memory.jsonc` contains `"distilMinIntervalMs": "fast"` and `"targetAgents": ["builder"]`
- **THEN** the plugin emits a `[agent-memory]` warning for `distilMinIntervalMs` and uses `60000`; `targetAgents` is resolved to `["builder"]` (other key unaffected)

#### Scenario: `distilMinIntervalMs` is zero or negative

- **WHEN** `~/.config/opencode/agent-memory.jsonc` contains `"distilMinIntervalMs": 0`
- **THEN** the plugin emits a `[agent-memory]` warning for `distilMinIntervalMs` and uses `60000`

#### Scenario: `targetAgents` is a string instead of an array

- **WHEN** `~/.config/opencode/agent-memory.jsonc` contains `"targetAgents": "engineer"`
- **THEN** the plugin emits a `[agent-memory]` warning for `targetAgents` and uses `[]`

#### Scenario: `targetAgents` array contains an invalid element

- **WHEN** `~/.config/opencode/agent-memory.jsonc` contains `"targetAgents": ["engineer", 42, ""]`
- **THEN** the plugin emits a `[agent-memory]` warning for `targetAgents`, drops `42` and `""`, and resolves `targetAgents` to `["engineer"]`

#### Scenario: `targetAgents` is an empty array

- **WHEN** `~/.config/opencode/agent-memory.jsonc` contains `"targetAgents": []`
- **THEN** the plugin starts without warning with `targetAgents` resolved to `[]`

### Requirement: Unknown config keys are ignored silently

The system SHALL silently ignore any key in `~/.config/opencode/agent-memory.jsonc` that is not one of `targetAgents`, `distilMinIntervalMs`, or `distillerModel`. No warning is emitted for unknown keys.

#### Scenario: Config file contains an unrecognised key

- **WHEN** `~/.config/opencode/agent-memory.jsonc` contains `"unknownKey": "value"` alongside valid known keys
- **THEN** the unknown key is ignored and the known keys are applied normally

#### Scenario: Config file contains the obsolete targetAgent key

- **WHEN** `~/.config/opencode/agent-memory.jsonc` contains `"targetAgent": "engineer"` (the old singular key)
- **THEN** the key is silently ignored; `targetAgents` resolves to `[]` unless also supplied
