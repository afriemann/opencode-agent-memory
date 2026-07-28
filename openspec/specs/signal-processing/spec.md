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

The primer SHALL emit content in the following order: header → session threads (`### Recent sessions`) → standing context (`### Standing context`) → project atom directory (`### Project atoms`) → global atom directory (`### Global atoms`). The `### Standing context` section SHALL be omitted entirely when no active `always_include` atoms exist. No ADR slot and no teach-back block are emitted.

#### Scenario: Standing context appears between Recent sessions and Project atoms
- **GIVEN** a hot_state row and both project and global atoms with at least one having `always_include = 1`
- **WHEN** `assemblePrimer` is called
- **THEN** the output contains `### Standing context` after `### Recent sessions` and before `### Project atoms`

#### Scenario: Standing context is omitted when no always_include atoms exist
- **GIVEN** atoms exist but none have `always_include = 1`
- **WHEN** `assemblePrimer` is called
- **THEN** the output contains no `### Standing context` heading

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

### Requirement: assemblePrimer includes atom directory sections with cap and overflow

Before applying the pinned/non-pinned partition, `assemblePrimer` SHALL filter atoms with `always_include = 1` out of the `projectAtoms` and `globalAtoms` lists used to render the compact directory sections. A flagged atom SHALL NOT appear in `### Project atoms` or `### Global atoms` even if it is also `pinned`. The `(+N more)` overflow count and the 40-atom cap SHALL be computed from the already-filtered non-flagged sets only, so flagged atoms do not consume the cap.

#### Scenario: always_include atom is excluded from compact Project atoms section
- **GIVEN** a project atom with `always_include = 1` and `status = 'active'`
- **WHEN** `assemblePrimer` is called
- **THEN** that atom's topic does not appear in the `### Project atoms` compact listing

#### Scenario: always_include atom that is also pinned does not double-render
- **GIVEN** an atom with both `always_include = 1` and `pinned = 1`
- **WHEN** `assemblePrimer` is called
- **THEN** the atom appears only in `### Standing context` as a full block and is absent from the `[pinned]` compact directory entry

#### Scenario: 40-cap is unaffected by always_include atoms
- **GIVEN** 40 non-flagged active atoms and 3 atoms with `always_include = 1`
- **WHEN** `assemblePrimer` is called
- **THEN** all 40 non-flagged atoms render in the compact directory and no `(+N more)` overflow appears for the non-flagged set

### Requirement: assemblePrimer cold-start path injects global-only primer or nothing

When `rows` is empty or null (cold start), `assemblePrimer` SHALL omit the `### Recent sessions` section. The null/empty return SHALL only occur when `globalAtoms`, `projectAtoms`, AND `standingAtoms` are all empty or absent; if `standingAtoms` contains entries, a primer SHALL be produced even on cold start.

#### Scenario: Cold start with only always_include atoms produces a primer
- **GIVEN** rows is empty, globalAtoms and projectAtoms are empty, but standingAtoms contains at least one entry
- **WHEN** `assemblePrimer` is called
- **THEN** the output is non-null and contains `### Standing context`

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

### Requirement: agent message capture gates on finish flag
The system SHALL capture `message.updated` events for assistant-role messages only when `msgInfo.finish` is truthy (indicating the message is complete). The system SHALL NOT capture partial or in-progress assistant messages. The captured text SHALL be formed by joining the `text` fields of all `text`-type parts in the message (or `msgInfo.text` if parts are unavailable), then truncating to 400 characters from the start. The system SHALL only capture messages whose body is at least 50 characters after joining.

#### Scenario: Completed assistant message is captured
- **GIVEN** a `message.updated` event arrives for an assistant-role message with `finish` set to a non-empty string and body length >= 50 chars
- **WHEN** the event is processed
- **THEN** the truncated text is pushed to `buf.agentMessages` for that session

#### Scenario: In-progress assistant message is not captured
- **GIVEN** a `message.updated` event arrives for an assistant-role message with `finish` undefined or null
- **WHEN** the event is processed
- **THEN** no entry is added to `buf.agentMessages`

#### Scenario: Short assistant message is not captured
- **GIVEN** a `message.updated` event arrives for an assistant-role message with `finish` set but body length < 50 chars
- **WHEN** the event is processed
- **THEN** no entry is added to `buf.agentMessages`

#### Scenario: Agent message body truncated to 400 chars
- **GIVEN** a completed assistant message whose body exceeds 400 characters
- **WHEN** the event is processed
- **THEN** the stored text is exactly 400 characters, truncated from the start

### Requirement: bufferIsEmpty and makeBuffer include agentMessages
The `makeBuffer()` function SHALL initialise an `agentMessages` field (empty array) alongside `files`, `todos`, and `messages`. The `bufferIsEmpty()` function SHALL return `false` when `agentMessages` is non-empty, even if all other fields are empty. The buffer flush payload SHALL include `agentMessages` in the delta sent to `cmdAccrue`.

#### Scenario: Buffer with only agent messages is not considered empty
- **GIVEN** a buffer where `files`, `todos`, and `messages` are all empty but `agentMessages` has one entry
- **WHEN** `bufferIsEmpty` is called
- **THEN** it returns `false`

#### Scenario: Flush includes agentMessages in delta
- **GIVEN** a buffer with one agent message and no other signals
- **WHEN** the buffer is flushed
- **THEN** the delta sent to `cmdAccrue` contains the `agentMessages` array with that entry

### Requirement: reduceSignals caps agent kind independently with MAX_AGENT_SIGNALS
The `reduceSignals` function SHALL handle signals of `kind='agent'` with an independent cap of `MAX_AGENT_SIGNALS = 10`, selecting the most recent by `created_at`. The `agent` cap SHALL be applied independently of `MAX_SIGNALS_PER_KIND`. Agent signals not handled by an explicit branch SHALL NOT be silently dropped.

#### Scenario: Agent signals capped at MAX_AGENT_SIGNALS
- **GIVEN** more than 10 signals of `kind='agent'` exist
- **WHEN** `reduceSignals` is called
- **THEN** only the 10 most recent agent signals are returned

#### Scenario: Agent cap is independent of other kinds
- **GIVEN** 10 agent signals (at the cap) and 20 message signals (at the cap)
- **WHEN** `reduceSignals` is called
- **THEN** all 10 agent signals and 20 message signals are present in the output (caps applied independently)

#### Scenario: Agent signals appear as [agent] in the distiller prompt
- **GIVEN** a reduced signal set that includes one agent signal with content "I decided to use SSDT"
- **WHEN** `buildDistilPrompt` formats the signals
- **THEN** the formatted prompt contains "[agent] I decided to use SSDT"

### Requirement: assemblePrimer renders standing context section for always_include atoms

`assemblePrimer` SHALL accept a `standingAtoms` parameter containing full-content atom rows (from `atom-list-full`). It SHALL render a `### Standing context` section immediately before `### Project atoms` when at least one active flagged atom exists. Within the section, workspace-scope atoms SHALL render before global-scope atoms; each atom block SHALL use the format `#### <topic> [<relative time>]` followed by `*"<description>"*` on the next line, then a blank line, then the atom's full content verbatim. A blank line SHALL separate consecutive atom blocks. Per scope (workspace and global independently), at most `MAX_STANDING_ATOMS = 5` blocks SHALL be rendered; the 5 with the most recent `updated_at` are selected and rendered in alphabetical topic order. When a scope group holds more than 5 flagged atoms, a compact overflow note SHALL name the excluded topics: `(+N more standing atoms exceed the 5-per-scope cap — fetch with memory_atom_get: <topic1>, <topic2>, …)` where topics are listed alphabetically.

#### Scenario: Single always_include atom renders as full block
- **GIVEN** standingAtoms contains one workspace atom with topic "project/conventions", description "Coding conventions", and multi-line content
- **WHEN** `assemblePrimer` is called
- **THEN** the output contains `#### project/conventions [<time>]`, `*"Coding conventions"*`, and the full content verbatim under `### Standing context`

#### Scenario: Workspace atoms render before global atoms
- **GIVEN** standingAtoms contains one global atom and one workspace atom
- **WHEN** `assemblePrimer` is called
- **THEN** the workspace atom block appears before the global atom block in the output

#### Scenario: Atoms within cap render in alphabetical topic order
- **GIVEN** standingAtoms contains 3 workspace atoms with topics "z/last", "a/first", "m/middle"
- **WHEN** `assemblePrimer` is called
- **THEN** the blocks appear in the order a/first, m/middle, z/last

#### Scenario: Cap selects 5 most recently updated; overflow note names remainder
- **GIVEN** standingAtoms contains 7 workspace atoms, updated at distinct timestamps
- **WHEN** `assemblePrimer` is called
- **THEN** exactly 5 full blocks are rendered (the 5 most recently updated), and a compact note names the 2 remaining topics alphabetically

#### Scenario: Global and workspace caps are independent
- **GIVEN** standingAtoms contains 6 workspace atoms and 6 global atoms
- **WHEN** `assemblePrimer` is called
- **THEN** 5 workspace blocks and 5 global blocks are rendered (total 10), each group has its own overflow note

#### Scenario: Standing context section is omitted when standingAtoms is empty
- **GIVEN** standingAtoms is empty or absent
- **WHEN** `assemblePrimer` is called
- **THEN** no `### Standing context` heading appears in the output

#### Scenario: All atoms flagged still produces a primer
- **GIVEN** every atom in both project and global scope has always_include = 1 (compact directory lists would be empty)
- **WHEN** `assemblePrimer` is called
- **THEN** the output is non-null and the Standing context section contains the flagged atoms' full blocks

