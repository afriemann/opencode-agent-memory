## MODIFIED Requirements

### Requirement: memory_inspect plugin tool delegates to the inspect CLI subcommand using TARGET_AGENT

The `memory_inspect` registered tool SHALL invoke `spawnMemory($, ['inspect', TARGET_AGENT, directory])` using `TARGET_AGENT` (the plugin-configured agent dimension) and the `directory` from `ToolContext`, and SHALL return the result as a `ToolResult` without propagating exceptions into the opencode host. The tool's output SHALL include an `active_primer` field containing the primer text currently cached in the in-process `primers` Map for the calling session's ID, or `null` if no primer was loaded for that session.

#### Scenario: Tool invoked for an agent with existing memory
- **GIVEN** a `hot_state` row and signals exist for the calling session's agent/project
- **WHEN** the agent calls the `memory_inspect` tool
- **THEN** the tool returns the hot state summary, signal list, and `active_primer` set to the cached primer text

#### Scenario: Tool invoked on a cold start
- **GIVEN** no `hot_state` row exists for the calling session's agent/project
- **WHEN** the agent calls the `memory_inspect` tool
- **THEN** the tool returns a cold-start result with `active_primer: null` and does not throw

#### Scenario: active_primer reflects in-process cache, not DB
- **GIVEN** a primer was loaded at session start and cached in the `primers` Map
- **WHEN** the agent calls `memory_inspect`
- **THEN** `active_primer` contains the exact assembled primer text that the system transform hook is injecting into the system prompt

#### Scenario: Underlying CLI failure
- **GIVEN** the `inspect` CLI call fails (e.g. DB locked)
- **WHEN** the agent calls the `memory_inspect` tool
- **THEN** the tool returns an informative error result and does not propagate an unhandled rejection into the opencode host

## ADDED Requirements

### Requirement: assemblePrimer produces passive background-context framing

The `assemblePrimer` function in `src/lib/signal-utils.js` SHALL produce primer text that uses passive, non-imperative language throughout. The output SHALL:
- Open with a header that identifies the block as "background context" and states that no action is required.
- Label the next-action field as "Suggested next step" (not "Next action").
- Contain no instruction directing the agent to investigate the codebase, reconcile state, or perform any action before receiving a user request.

#### Scenario: Primer header is passive
- **WHEN** `assemblePrimer` is called with any prior record
- **THEN** the returned string contains a header phrase that includes "background context" or equivalent passive framing and does not include an imperative verb directed at the agent

#### Scenario: Next-action field uses suggested-step framing
- **WHEN** `assemblePrimer` is called with a prior record where `next_action` is non-empty
- **THEN** the returned string includes "Suggested next step" (case-insensitive) and does not include "Next action:"

#### Scenario: No investigation instruction in primer
- **WHEN** `assemblePrimer` is called with any prior record
- **THEN** the returned string does not contain phrases like "reconcile", "replay your understanding", or "get my confirmation"
