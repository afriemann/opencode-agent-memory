## MODIFIED Requirements

### Requirement: memory_correct plugin tool delegates to the correct CLI subcommand using TARGET_AGENT

The `memory_correct` registered tool SHALL resolve the calling session's agent via `resolveSessionAgent(context.sessionID)`. When null is returned (session not tracked), the tool SHALL return an informative `ToolResult` without making any CLI call (per the plugin-lifecycle not-tracked contract). When an agent is resolved, the tool SHALL invoke `spawnMemory($, ['correct', agent, directory, patchJson])` using that agent and the `directory` from `ToolContext`, and SHALL return a `ToolResult` without propagating exceptions into the opencode host.

#### Scenario: Tool applies a correction for the calling session's scope

- **GIVEN** the calling session's agent is a member of `TARGET_AGENTS` AND a `hot_state` row exists for the agent/project
- **WHEN** the agent calls `memory_correct` with a partial patch
- **THEN** the specified field is updated and all other fields are preserved

#### Scenario: Underlying CLI failure

- **GIVEN** the `correct` CLI call fails (e.g. DB locked or malformed patch)
- **WHEN** the agent calls the `memory_correct` tool
- **THEN** the tool returns an informative error result and does not propagate an unhandled rejection into the opencode host
