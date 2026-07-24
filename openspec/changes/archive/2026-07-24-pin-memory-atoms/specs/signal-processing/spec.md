## MODIFIED Requirements

### Requirement: assemblePrimer includes atom directory sections with cap and overflow
The primer SHALL render a `### Project atoms` section from `projectAtoms` and a `### Global atoms` section from `globalAtoms`. Within each section, atoms SHALL be partitioned into **pinned** and **non-pinned** groups. Pinned atoms SHALL be listed first (ordered by topic, no cap); non-pinned atoms SHALL follow (ordered by topic, capped independently at `cap` entries). A pinned atom SHALL appear exactly once per section — it SHALL be excluded from the non-pinned capped list. The `(+N more)` overflow count and the cap SHALL be computed from the non-pinned set only. Each atom entry SHALL be in the format `<topic> [<relative time>] — "<description>" — <first-80-chars-of-content>…`; pinned atom entries SHALL be prefixed with `[pinned]`. A sub-section whose non-pinned set exceeds the cap SHALL end with `(+N more — call memory_atom_list to see all)`. Each sub-section SHALL include the no-action framing `(Fetch atoms on demand when relevant — do not pre-fetch at session start)`. An empty sub-section SHALL display a one-liner placeholder instead of an empty heading.

#### Scenario: Atom section entry format is correct
- **GIVEN** a project atom with topic='arch/db', description='Database config', content='host: localhost...'
- **WHEN** assemblePrimer is called
- **THEN** the ### Project atoms section contains a line like `arch/db [just now] — "Database config" — host: localhost…`

#### Scenario: No-action framing appears in both atom sections
- **WHEN** assemblePrimer is called
- **THEN** the output contains 'Fetch atoms on demand when relevant — do not pre-fetch at session start' in each atom sub-section

#### Scenario: Overflow line is emitted when non-pinned section exceeds cap
- **GIVEN** projectAtoms contains 45 entries (all non-pinned) and cap is 40
- **WHEN** assemblePrimer is called
- **THEN** only 40 non-pinned project atom entries are listed and the line '(+5 more — call memory_atom_list to see all)' follows

#### Scenario: Pinned atoms appear before non-pinned atoms in each section
- **GIVEN** projectAtoms contains both pinned and non-pinned atoms
- **WHEN** assemblePrimer is called
- **THEN** all pinned atom entries appear before any non-pinned atom entries within the ### Project atoms section

#### Scenario: Pinned atoms are marked with [pinned] in the primer
- **GIVEN** a pinned project atom with topic='arch/db' exists
- **WHEN** assemblePrimer is called
- **THEN** the entry for 'arch/db' is prefixed with '[pinned]'

#### Scenario: Pinned atoms are not counted against the cap
- **GIVEN** projectAtoms contains 5 pinned atoms and 42 non-pinned atoms (total 47), and cap is 40
- **WHEN** assemblePrimer is called
- **THEN** all 5 pinned atoms are listed, 40 non-pinned atoms are listed, the overflow line reads '(+2 more — call memory_atom_list to see all)', and no pinned atom appears in the capped non-pinned section

#### Scenario: A pinned atom appears exactly once per section
- **GIVEN** a pinned project atom with topic='arch/db' exists
- **WHEN** assemblePrimer is called
- **THEN** the entry for 'arch/db' appears exactly once in the ### Project atoms section (not duplicated in the non-pinned list)

#### Scenario: Pinned atoms are ordered by topic within the pinned group
- **GIVEN** pinned project atoms exist at topics 'zzz/last', 'aaa/first', 'mmm/middle'
- **WHEN** assemblePrimer is called
- **THEN** the pinned entries appear in order: 'aaa/first', 'mmm/middle', 'zzz/last'
