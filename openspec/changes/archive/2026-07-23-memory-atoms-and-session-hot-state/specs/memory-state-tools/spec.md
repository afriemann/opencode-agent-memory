## ADDED Requirements

### Requirement: memory_state_inspect reports the session hot_state and signals with updated description
The `memory_state_inspect` registered tool (renamed from `memory_inspect`) SHALL invoke the `inspect` CLI subcommand and return the hot_state row and pending signals for the current session. Its tool description SHALL be: "Read the current agent memory hot state for this session: recent session threads, current signals, and the loaded primer. Does not list durable atoms — use memory_atom_list for the atom directory or memory_atom_get to fetch a specific atom by topic."

#### Scenario: Tool returns session hot state and signals
- **GIVEN** a hot_state row and pending signals exist for the calling session
- **WHEN** the agent calls memory_state_inspect
- **THEN** the tool returns the hot_state summary, signal list, and the active_primer cached for this session

#### Scenario: Tool returns cold-start result when no session row exists
- **GIVEN** no hot_state row exists for the calling session
- **WHEN** the agent calls memory_state_inspect
- **THEN** the tool returns a cold-start result (prior: null, signals: []) and does not throw

#### Scenario: Underlying CLI failure is caught and returned as a ToolResult
- **GIVEN** the inspect CLI call fails
- **WHEN** the agent calls memory_state_inspect
- **THEN** the tool returns an informative error result and does not propagate an unhandled rejection

### Requirement: memory_state_patch applies a partial patch to the session hot_state row
The `memory_state_patch` registered tool (renamed from `memory_correct`) SHALL invoke the `correct <agent> <project> <sessionId> <patchJson>` CLI subcommand, passing `context.sessionID` as the `<sessionId>` positional. Patchable fields SHALL be `last_worked_summary`, `next_action`, and `open_questions` only — `adr_candidate` is no longer a patchable field. The tool SHALL upsert a skeleton row when no session row exists (see the memory-store spec). It SHALL return whether the row was created or updated.

#### Scenario: Tool patches a single field and preserves others
- **GIVEN** a hot_state row exists for the calling session with last_worked_summary='S', next_action='N'
- **WHEN** the agent calls memory_state_patch with {"next_action": "N2"}
- **THEN** next_action is 'N2' and last_worked_summary remains 'S'

#### Scenario: Tool creates a skeleton row when no session row exists
- **GIVEN** no hot_state row exists for the calling session
- **WHEN** the agent calls memory_state_patch with a next_action patch
- **THEN** a new row is created with next_action set and other fields at skeleton defaults

#### Scenario: adr_candidate is not accepted as a patchable field
- **GIVEN** any hot_state state
- **WHEN** the agent calls memory_state_patch with {"adr_candidate": "some decision"}
- **THEN** the patch is rejected or the adr_candidate field is ignored; no adr_candidate column is written

#### Scenario: CLI failure is caught and returned as a ToolResult
- **GIVEN** the correct CLI call fails
- **WHEN** the agent calls memory_state_patch
- **THEN** the tool returns an informative error result and does not throw

### Requirement: memory_state_distil triggers an immediate distil bypassing the idle throttle
The `memory_state_distil` registered tool (renamed from `memory_distil_force`) SHALL call `doDistil(sessionId, { force: true })` for the current session, bypassing the `DISTIL_MIN_INTERVAL_MS` throttle early-return while leaving all other distil steps intact (ephemeral-session check, signal reduction, LLM call, distil-write with monotonic guard).

#### Scenario: Forced distil runs within the throttle window
- **GIVEN** fewer than DISTIL_MIN_INTERVAL_MS milliseconds have elapsed since the last distil
- **WHEN** the agent calls memory_state_distil
- **THEN** a distillation pass is initiated and completes for the current session

#### Scenario: Forced distil advances the watermark
- **GIVEN** a forced distil completes at time T_force
- **WHEN** session.idle fires at T_force + DISTIL_MIN_INTERVAL_MS - 1
- **THEN** the idle-path distil is skipped by the throttle check (watermark advanced by the forced distil)

#### Scenario: Tool execution error is caught and returned as a ToolResult
- **GIVEN** the distil pass fails internally (e.g. LLM call throws)
- **WHEN** the agent calls memory_state_distil
- **THEN** the tool returns an informative error result and does not throw
