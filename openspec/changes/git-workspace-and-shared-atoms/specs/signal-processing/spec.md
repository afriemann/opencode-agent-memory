## MODIFIED Requirements

### Requirement: assemblePrimer accepts an options object and formats multiple hot_state rows as session threads

The `assemblePrimer` function SHALL accept a single options object `{ rows, projectAtoms, sharedAtoms, agent, project, staleness, cap }` instead of positional arguments. The parameter previously named `globalAtoms` is renamed to `sharedAtoms`. Up to 3 hot_state rows (newest first) SHALL each be rendered as a session thread entry under `### Recent sessions` in the format:

```
▸ <label> — <relTime> [<session_id>]
  Last: <last_worked_summary truncated>
  Next: <next_action>
  Open questions: <open_questions>
```

Where `<label>` is derived as: `session_name` if non-empty, else the first 8 characters of `session_id` if non-empty, else `formatRelativeTime(updated_at)`. The label SHALL never be the literal string `"unknown"`.

The `[<session_id>]` bracket SHALL be appended to the header line when `session_id` is a non-empty string. When `session_id` is null or an empty string, the bracket SHALL be omitted entirely.

#### Scenario: Multiple session rows are rendered as threads
- **GIVEN** multiple hot_state rows for the current project
- **WHEN** assemblePrimer is called
- **THEN** up to 3 entries appear under `### Recent sessions`, each on its own thread block

#### Scenario: Single session row renders one thread
- **GIVEN** one hot_state row with a session_name and a non-empty session_id
- **WHEN** assemblePrimer is called
- **THEN** one thread entry is rendered with the session_name label and `[<session_id>]` in the header

#### Scenario: Both name and id absent falls back to relative-time label with no bracket
- **GIVEN** a hot_state row where session_name is NULL and session_id is an empty string
- **WHEN** assemblePrimer is called
- **THEN** the label is the relative time of updated_at and no `[...]` bracket appears on the header line

#### Scenario: Row with non-empty session_id shows full session_id in bracket
- **GIVEN** a hot_state row with session_id `ses_abc123` and no session_name
- **WHEN** assemblePrimer is called
- **THEN** the header line contains `[ses_abc123]`

### Requirement: assemblePrimer emits slots in a fixed order

The primer SHALL emit content in the following order: header → session threads (`### Recent sessions`) → standing context (`### Standing context`) → project atom directory (`### Project atoms`) → shared atom directory (`### Shared atoms`). The `### Standing context` section SHALL be omitted entirely when no active `always_include` atoms exist. No ADR slot and no teach-back block are emitted.

#### Scenario: Standing context appears between Recent sessions and Project atoms
- **GIVEN** a hot_state row and both project and shared atoms with at least one having `always_include = 1`
- **WHEN** `assemblePrimer` is called
- **THEN** the output contains `### Standing context` after `### Recent sessions` and before `### Project atoms`

#### Scenario: Standing context is omitted when no always_include atoms exist
- **GIVEN** atoms exist but none have `always_include = 1`
- **WHEN** `assemblePrimer` is called
- **THEN** the output contains no `### Standing context` heading

#### Scenario: Shared atoms section uses correct heading
- **GIVEN** shared atoms (scope='global', project='') exist
- **WHEN** `assemblePrimer` is called
- **THEN** the output contains `### Shared atoms` (not `### Global atoms`)

### Requirement: assemblePrimer appends a staleness line

When the staleness status is NOT `no-git`, the primer SHALL end with `Staleness: <text>` where `<text>` is the output of `renderStaleness`. When the staleness status IS `no-git`, the staleness line SHALL be omitted entirely. `renderStaleness` SHALL return `"not yet anchored to a commit"` for status `no-anchor` and SHALL return `"git anchor unavailable"` only for the legacy/fallback path (null input).

When `project === ''` (non-git session / shared bucket), the staleness status SHALL be treated as `no-git` and the staleness line SHALL be omitted.

#### Scenario: Staleness line is appended for a repo with a stored anchor
- **GIVEN** a staleness value with status `ok` and a commit distance
- **WHEN** `assemblePrimer` is called
- **THEN** the output ends with `Staleness: <N> commit(s) since this note`

#### Scenario: Staleness line uses no-anchor text when SHA was never stored
- **GIVEN** a staleness value with status `no-anchor`
- **WHEN** `assemblePrimer` is called
- **THEN** the output ends with `Staleness: not yet anchored to a commit`

#### Scenario: Staleness line is omitted for a non-git project directory
- **GIVEN** a staleness value with status `no-git`
- **WHEN** `assemblePrimer` is called
- **THEN** the output does NOT contain a `Staleness:` line

#### Scenario: Staleness line is omitted for a shared-bucket (non-git) session
- **GIVEN** `project === ''` (non-git session)
- **WHEN** `assemblePrimer` is called
- **THEN** the output does NOT contain a `Staleness:` line

## ADDED Requirements

### Requirement: assemblePrimer renders a shared-memory header for non-git sessions

When `assemblePrimer` is called with `project === ''` (the shared bucket), the primer header SHALL be `## Shared memory — (background context — no action required)` instead of the `## Project memory — <segments> (background context — no action required)` form. This prevents the primer from rendering a blank segment (`## Project memory —  …`) for non-git sessions.

#### Scenario: Non-git session primer uses shared-memory header
- **GIVEN** `project === ''` (non-git session / shared bucket)
- **WHEN** `assemblePrimer` is called
- **THEN** the primer starts with `## Shared memory — (background context — no action required)`

#### Scenario: Git session primer still uses project-memory header
- **GIVEN** `project` is a non-empty path like `/myrepo`
- **WHEN** `assemblePrimer` is called
- **THEN** the primer starts with `## Project memory — myrepo (background context — no action required)` (using last two path segments)
