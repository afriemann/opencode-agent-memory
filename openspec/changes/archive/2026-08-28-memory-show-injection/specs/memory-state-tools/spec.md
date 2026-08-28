## ADDED Requirements

### Requirement: memory_show_injection returns the verbatim system prompt injection for the current session
The `memory_show_injection` registered tool SHALL return the exact text that `experimental.chat.system.transform` pushes to `output.system` for the calling session, formatted as a human-readable string with each injected block clearly labelled. When the session is tracked and a usage protocol block would be injected, it SHALL be included as a labelled section. When a memory primer exists for the session, it SHALL be included as a second labelled section. When neither block exists (session not yet tracked), the tool SHALL return a message indicating no injection is active. The tool SHALL return a not-tracked message for sessions whose agent is not in `TARGET_AGENTS`.

#### Scenario: Returns both protocol and primer for a warm tracked session
- **GIVEN** a session that is tracked (primerLoaded) and has a non-null memory primer
- **WHEN** the agent calls memory_show_injection
- **THEN** the output contains a labelled "Memory usage protocol" section with the protocol text and a labelled "Memory primer" section with the primer text

#### Scenario: Returns protocol only for a cold-start tracked session
- **GIVEN** a session that is tracked (primerLoaded) but has no memory primer (cold start)
- **WHEN** the agent calls memory_show_injection
- **THEN** the output contains the "Memory usage protocol" section and a note that no prior memory exists (no primer section)

#### Scenario: Returns no-injection message for an untracked session
- **GIVEN** a session for which primerLoaded has not been set (the session was never processed by the plugin)
- **WHEN** the agent calls memory_show_injection
- **THEN** the output indicates that no injection is active for this session

#### Scenario: Returns not-tracked message when session agent is not in TARGET_AGENTS
- **GIVEN** a session whose agent is not in TARGET_AGENTS
- **WHEN** the agent calls memory_show_injection
- **THEN** the output states that the session is not tracked by agent-memory
