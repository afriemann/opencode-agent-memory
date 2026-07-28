## MODIFIED Requirements

### Requirement: assemblePrimer accepts an options object and formats multiple hot_state rows as session threads
The `assemblePrimer` function SHALL accept a single options object `{ rows, projectAtoms, globalAtoms, agent, project, staleness, cap }` instead of positional arguments. Up to 3 hot_state rows (newest first) SHALL each be rendered as a session thread entry under `### Recent sessions` in the format:

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
