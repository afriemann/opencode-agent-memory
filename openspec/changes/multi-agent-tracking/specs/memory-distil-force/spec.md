## MODIFIED Requirements

### Requirement: memory_distil_force is a no-op for sessions whose agent does not match TARGET_AGENT

When the caller's session agent (resolved via `session.get` or `sessionAgents`) is not a member of `TARGET_AGENTS` (or is null), `doDistil` SHALL return early without performing any distillation. The tool SHALL return a successful `ToolResult` in this case; the no-op is the accepted contract, consistent with the idle-path behaviour.

#### Scenario: Force distil from a non-target-agent session

- **GIVEN** the calling session's agent is not a member of `TARGET_AGENTS`
- **WHEN** the agent calls `memory_distil_force`
- **THEN** the tool returns a successful result without performing distillation

#### Scenario: Force distil from a session with null agent

- **GIVEN** the calling session's agent is null or undefined after sessionAgents lookup and session.get fallback
- **WHEN** the agent calls `memory_distil_force`
- **THEN** the tool returns a successful result without performing distillation
