## MODIFIED Requirements

### Requirement: assemblePrimer appends a staleness line
When the staleness status is NOT `no-git`, the primer SHALL end with `Staleness: <text>` where `<text>` is the output of `renderStaleness`. When the staleness status IS `no-git`, the staleness line SHALL be omitted entirely. `renderStaleness` SHALL return `"not yet anchored to a commit"` for status `no-anchor` and SHALL return `"git anchor unavailable"` only for the legacy/fallback path (null input).

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

### Requirement: assemblePrimer accepts an options object and formats multiple hot_state rows as session threads
The `assemblePrimer` function SHALL accept a single options object `{ rows, projectAtoms, globalAtoms, agent, project, staleness, cap }` instead of positional arguments. Up to 3 hot_state rows (newest first) SHALL each be rendered as a session thread entry under `### Recent sessions` in the format:

```
▸ <label> — <relative time>
  Last: <last_worked_summary>
  Next: <next_action>
  Open questions: <q; q>   (or "none")
```

Where `<label>` is derived as: `session_name` if non-empty, else the first 8 characters of `session_id` if non-empty, else `formatRelativeTime(updated_at)`. The label SHALL never be the literal string `"unknown"`.

The staleness indicator SHALL be computed from the newest row's `anchored_git_sha` only.

#### Scenario: Multiple session rows are rendered as threads
- **GIVEN** rows contains three hot_state rows for the same project, newest first
- **WHEN** assemblePrimer is called
- **THEN** the output contains three ▸ thread entries under ### Recent sessions, newest first

#### Scenario: Single session row renders one thread
- **GIVEN** rows contains exactly one hot_state row
- **WHEN** assemblePrimer is called
- **THEN** one thread entry is rendered with the session_name (or short session_id if name is null/empty)

#### Scenario: Session label falls back to relative time when both name and id are absent
- **GIVEN** a hot_state row where session_name is NULL and session_id is an empty string
- **WHEN** assemblePrimer is called
- **THEN** the thread label is a relative time string derived from updated_at (e.g. "4 days ago") and is NOT the literal string "unknown"
