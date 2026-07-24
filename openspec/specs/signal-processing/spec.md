# signal-processing Specification

## Purpose

Behaviour contract for signal reduction and primer assembly.
## Requirements
### Requirement: reduceSignals deduplicates file signals by path

The system SHALL retain only the most recently created `memory_signal` row for each unique file path when reducing signals; older duplicates for the same path SHALL be discarded.

#### Scenario: Duplicate file signals
- **GIVEN** two `memory_signal` rows for the same file path with different `created_at` values
- **WHEN** `reduceSignals` is called
- **THEN** only the row with the higher `created_at` is included in the output

### Requirement: reduceSignals caps per-kind signal count

The system SHALL retain at most `MAX_SIGNALS_PER_KIND` signals per kind, selecting the most recent by `created_at`; excess signals SHALL be discarded. The cap is applied independently per kind.

#### Scenario: Signals within the cap
- **GIVEN** fewer than `MAX_SIGNALS_PER_KIND` signals of a given kind
- **WHEN** `reduceSignals` is called
- **THEN** all signals of that kind are returned

#### Scenario: Signals exceeding the cap
- **GIVEN** more than `MAX_SIGNALS_PER_KIND` signals of a single kind
- **WHEN** `reduceSignals` is called
- **THEN** only the `MAX_SIGNALS_PER_KIND` most recent signals of that kind are returned

#### Scenario: Cap applied independently per kind
- **GIVEN** signals of kind `todo` exceeding the cap and signals of kind `message` within the cap
- **WHEN** `reduceSignals` is called
- **THEN** `todo` signals are capped and `message` signals are unaffected

### Requirement: reduceSignals handles empty and null input

The system SHALL return an empty array when `reduceSignals` is called with `null`, `undefined`, or an empty array.

#### Scenario: Empty input returns empty array
- **GIVEN** `reduceSignals` is called with null, undefined, or []
- **WHEN** the function returns
- **THEN** the result is an empty array

### Requirement: assemblePrimer produces a header with the agent name and last-two-path-segments
The primer SHALL begin with a Markdown heading of the form `## Project memory — <last-two-path-segments> (background context — no action required)` followed by a line instructing the agent to wait for the user's request before acting.

#### Scenario: Primer header uses the correct format
- **GIVEN** a hot_state row for project='/home/user/my-project'
- **WHEN** assemblePrimer is called
- **THEN** the output starts with '## Project memory — user/my-project (background context — no action required)'

#### Scenario: Primer framing tells the agent to wait before acting
- **WHEN** assemblePrimer is called with any prior records
- **THEN** the output contains a line instructing the agent to wait for the user's request before taking action

### Requirement: assemblePrimer emits slots in a fixed order
The primer SHALL emit content in the following order: header → session threads (### Recent sessions) → project atom directory (### Project atoms) → global atom directory (### Global atoms). No ADR slot and no teach-back block are emitted.

#### Scenario: All sections present and in order for warm start
- **GIVEN** multiple hot_state rows and both project and global atoms exist
- **WHEN** assemblePrimer is called
- **THEN** the output contains ### Recent sessions before ### Project atoms, which appears before ### Global atoms, and no ADR or teach-back content is present

#### Scenario: ADR slot is not present in any primer
- **GIVEN** a hot_state row with any content
- **WHEN** assemblePrimer is called
- **THEN** the output contains no 'ADR' label or adr_candidate field reference

### Requirement: assemblePrimer appends a staleness line

The primer SHALL end with `Staleness: <renderStaleness(staleness)>` using the exact output of `renderStaleness`.

#### Scenario: Staleness line is appended
- **GIVEN** a staleness value with status='clean'
- **WHEN** `assemblePrimer` is called
- **THEN** the output ends with a staleness line

### Requirement: assemblePrimer accepts an options object and formats multiple hot_state rows as session threads
The `assemblePrimer` function SHALL accept a single options object `{ rows, projectAtoms, globalAtoms, agent, project, staleness, cap }` instead of positional arguments. Up to 3 hot_state rows (newest first) SHALL each be rendered as a session thread entry under `### Recent sessions` in the format:

```
▸ <session_name || short session_id> — <relative time>
  Last: <last_worked_summary>
  Next: <next_action>
  Open questions: <q; q>   (or "none")
```

The staleness indicator SHALL be computed from the newest row's `anchored_git_sha` only.

#### Scenario: Multiple session rows are rendered as threads
- **GIVEN** rows contains three hot_state rows for the same project, newest first
- **WHEN** assemblePrimer is called
- **THEN** the output contains three ▸ thread entries under ### Recent sessions, newest first

#### Scenario: Single session row renders one thread
- **GIVEN** rows contains exactly one hot_state row
- **WHEN** assemblePrimer is called
- **THEN** one thread entry is rendered with the session_name (or short session_id if name is null)

### Requirement: assemblePrimer includes atom directory sections with cap and overflow
The primer SHALL render a `### Project atoms` section from `projectAtoms` and a `### Global atoms` section from `globalAtoms`, each capped independently at `cap` entries. Each atom entry SHALL be in the format `<topic> [<relative time>] — "<description>" — <first-80-chars-of-content>…`. A sub-section exceeding the cap SHALL end with `(+N more — call memory_atom_list to see all)`. Each sub-section SHALL include the no-action framing `(Fetch atoms on demand when relevant — do not pre-fetch at session start)`. An empty sub-section SHALL display a one-liner placeholder instead of an empty heading.

#### Scenario: Atom section entry format is correct
- **GIVEN** a project atom with topic='arch/db', description='Database config', content='host: localhost...'
- **WHEN** assemblePrimer is called
- **THEN** the ### Project atoms section contains a line like `arch/db [just now] — "Database config" — host: localhost…`

#### Scenario: No-action framing appears in both atom sections
- **WHEN** assemblePrimer is called
- **THEN** the output contains 'Fetch atoms on demand when relevant — do not pre-fetch at session start' in each atom sub-section

#### Scenario: Overflow line is emitted when section exceeds cap
- **GIVEN** projectAtoms contains 45 entries and cap is 40
- **WHEN** assemblePrimer is called
- **THEN** only 40 project atom entries are listed and the line '(+5 more — call memory_atom_list to see all)' follows

### Requirement: assemblePrimer cold-start path injects global-only primer or nothing
When `rows` is empty or null (cold start), `assemblePrimer` SHALL omit the `### Recent sessions` section. If `globalAtoms` contains entries, it SHALL inject a minimal primer with only the `### Global atoms` section. If `globalAtoms` is also empty, `assemblePrimer` SHALL return null or an empty string, and no injection SHALL occur.

#### Scenario: Cold start with global atoms returns global-only primer
- **GIVEN** rows is empty and globalAtoms contains at least one entry
- **WHEN** assemblePrimer is called
- **THEN** the output contains ### Global atoms and no ### Recent sessions section

#### Scenario: Cold start with no atoms returns null
- **GIVEN** rows is empty and globalAtoms is empty
- **WHEN** assemblePrimer is called
- **THEN** the return value is null or empty string (no primer to inject)

### Requirement: formatRelativeTime formats a timestamp as a human-readable relative time string
The `formatRelativeTime(updatedAt, now)` helper in `signal-utils.js` SHALL return a relative time string in the form `just now`, `<N>m ago`, `<N>h ago`, `yesterday`, or `<N> days ago` based on the difference between `updatedAt` and `now` (both in milliseconds).

#### Scenario: Time within one minute returns 'just now'
- **GIVEN** updatedAt is 30 seconds before now
- **WHEN** formatRelativeTime is called
- **THEN** the result is 'just now'

#### Scenario: Time more than a day ago returns 'N days ago'
- **GIVEN** updatedAt is 3 days before now
- **WHEN** formatRelativeTime is called
- **THEN** the result is '3 days ago'

