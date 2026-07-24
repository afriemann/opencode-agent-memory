## MODIFIED Requirements

### Requirement: memory_inspect plugin tool delegates to the inspect CLI subcommand using TARGET_AGENT

The `memory_inspect` registered tool SHALL resolve the calling session's agent via `resolveSessionAgent(context.sessionID)`. When null is returned (session not tracked), the tool SHALL return an informative `ToolResult` without making any CLI call (per the plugin-lifecycle not-tracked contract). When an agent is resolved, the tool SHALL invoke `spawnMemory($, ['inspect', agent, directory])` using that agent and the `directory` from `ToolContext`, and SHALL return the result as a `ToolResult` without propagating exceptions into the opencode host. The tool's output SHALL include an `active_primer` field containing the primer text currently cached in the `primers` Map for the calling session's ID, or `null` if no primer was loaded.

#### Scenario: Tool invoked for a tracked agent with existing memory

- **GIVEN** the calling session's agent is a member of `TARGET_AGENTS` AND a `hot_state` row exists for the agent/project
- **WHEN** the agent calls the `memory_inspect` tool
- **THEN** the tool returns the hot state summary, signal list, and `active_primer` set to the cached primer text

#### Scenario: Tool invoked on a cold start

- **GIVEN** the calling session's agent is a member of `TARGET_AGENTS` AND no `hot_state` row exists for the agent/project
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
