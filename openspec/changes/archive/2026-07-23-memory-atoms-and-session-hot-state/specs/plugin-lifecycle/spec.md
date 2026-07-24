## MODIFIED Requirements

### Requirement: Plugin factory returns a tool hook with three management tools
The `AgentMemory` factory SHALL return an object containing both an `event` key and a `tool` key exposing exactly nine tools: `memory_atom_write`, `memory_atom_append`, `memory_atom_get`, `memory_atom_search`, `memory_atom_list`, `memory_atom_delete`, `memory_state_inspect`, `memory_state_patch`, and `memory_state_distil`, each with a description, argument schema, and `execute` function.

#### Scenario: Returned hooks object exposes all nine tools
- **GIVEN** the `AgentMemory` factory is invoked with a valid `{ client, $ }` context
- **WHEN** the factory resolves
- **THEN** the returned object has a `tool` property containing exactly the nine named tools and no others

#### Scenario: Default export contract is unchanged
- **GIVEN** the plugin module is imported
- **WHEN** the default export is inspected
- **THEN** it is the `AgentMemory` factory function with the same signature as before

### Requirement: session.created does not inject for cold-start sessions
The system SHALL skip injection of the multi-row primer when the session has no prior hot_state rows. However, when no hot_state rows exist but one or more global atoms exist, the system SHALL inject a minimal primer containing only the `### Global atoms` section. When there are no hot_state rows AND no global atoms, no injection occurs.

#### Scenario: Cold start with global atoms injects global-only primer
- **GIVEN** no hot_state row exists for the session but at least one global atom exists
- **WHEN** session.created fires
- **THEN** a primer is injected containing the `### Global atoms` section and no `### Recent sessions` section

#### Scenario: Cold start with no global atoms and no hot_state injects nothing
- **GIVEN** no hot_state row exists and no global atoms exist
- **WHEN** session.created fires
- **THEN** no primer injection occurs

#### Scenario: Warm start with hot_state rows injects the full multi-row primer
- **GIVEN** at least one hot_state row exists for the session's agent and project
- **WHEN** session.created fires
- **THEN** the full primer is injected including `### Recent sessions` and atom directory sections

## ADDED Requirements

### Requirement: session.created captures session_name from event properties
The system SHALL capture `event.properties.info.title` at `session.created` and store it in an in-process `sessionNames` Map keyed by session ID. This value SHALL be passed to atom write and distil calls as the session name. When `info.title` is absent or falsy, `session_name` SHALL be stored as null.

#### Scenario: Session name is captured when title is present
- **GIVEN** a session.created event fires with event.properties.info.title = 'my-task'
- **WHEN** the session.created handler runs
- **THEN** sessionNames.get(sessionId) returns 'my-task'

#### Scenario: Session name is null when title is absent
- **GIVEN** a session.created event fires with no info.title in event.properties
- **WHEN** the session.created handler runs
- **THEN** sessionNames.get(sessionId) returns null and no error is raised

### Requirement: Primer inject includes atom directory sections for project and global atoms
The system SHALL query both the current-workspace atoms and global atoms via two separate `atom-list` spawns at `session.created` (inject time) and include the results in the injected primer under `### Project atoms` and `### Global atoms` sub-sections respectively. Each sub-section SHALL be capped independently at `atomInjectCap`. When a sub-section has no atoms it SHALL display a one-liner placeholder. When the atom count exceeds the cap the sub-section SHALL end with `(+N more — call memory_atom_list to see all)`.

#### Scenario: Project and global atom sections both appear in warm-start primer
- **GIVEN** project atoms and global atoms both exist
- **WHEN** session.created fires for a warm start
- **THEN** the injected primer contains `### Project atoms` and `### Global atoms` sections each listing their respective atoms

#### Scenario: Overflow line is emitted when atoms exceed the inject cap
- **GIVEN** more than atomInjectCap project atoms exist
- **WHEN** session.created fires
- **THEN** only atomInjectCap atoms are listed under `### Project atoms` and the overflow line `(+N more — call memory_atom_list to see all)` follows

#### Scenario: Empty atom section collapses to a one-liner
- **GIVEN** no global atoms exist
- **WHEN** session.created fires for a warm start
- **THEN** the `### Global atoms` section shows 'No global atoms yet' (or equivalent) rather than an empty heading

### Requirement: atomInjectCap config key controls the atom directory inject cap
The system SHALL resolve the `atomInjectCap` key from the config file as a positive integer, defaulting to 40 when absent or invalid. The resolved value SHALL be used as the per-section cap in `assemblePrimer`. An invalid value SHALL warn and fall back to 40.

#### Scenario: atomInjectCap from config is used
- **GIVEN** the config file contains atomInjectCap=20
- **WHEN** session.created fires and the primer is assembled
- **THEN** each atom directory sub-section is capped at 20 atoms

#### Scenario: Missing atomInjectCap defaults to 40
- **GIVEN** the config file does not specify atomInjectCap
- **WHEN** the primer is assembled
- **THEN** each sub-section is capped at 40 atoms

#### Scenario: Invalid atomInjectCap warns and falls back to 40
- **GIVEN** the config file contains atomInjectCap='not-a-number'
- **WHEN** the plugin initialises
- **THEN** a warning is logged and the effective cap is 40
