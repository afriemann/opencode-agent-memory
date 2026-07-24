## MODIFIED Requirements

### Requirement: assemblePrimer includes atom directory sections with cap and overflow
The primer SHALL render a `### Project atoms` section from `projectAtoms` and a `### Global atoms` section from `globalAtoms`. Before any partitioning, atoms in each section SHALL be filtered to `status === 'active'` only — `resolved` and `deprecated` atoms SHALL be excluded from the primer regardless of their `pinned` flag. Within each section, the remaining active atoms SHALL be partitioned into **pinned** and **non-pinned** groups. Pinned atoms SHALL be listed first (ordered by topic, no cap); non-pinned atoms SHALL follow (ordered by topic, capped independently at `cap` entries). A pinned atom SHALL appear exactly once per section — it SHALL be excluded from the non-pinned capped list. The `(+N more)` overflow count and the cap SHALL be computed from the non-pinned set only. Each atom entry SHALL be in the format `<topic> [<relative time>] — "<description>" — <first-80-chars-of-content>…`; pinned atom entries SHALL be prefixed with `[pinned]`. A sub-section whose non-pinned set exceeds the cap SHALL end with `(+N more — call memory_atom_list to see all)`. Each sub-section SHALL include the no-action framing `(Fetch atoms on demand when relevant — do not pre-fetch at session start)`. An empty sub-section SHALL display a one-liner placeholder instead of an empty heading.

#### Scenario: Resolved atoms are excluded from the primer
- **GIVEN** projectAtoms contains one atom with `status='active'` and one with `status='resolved'`
- **WHEN** assemblePrimer is called
- **THEN** only the active atom appears in the ### Project atoms section; the resolved atom is absent

#### Scenario: Deprecated atoms are excluded from the primer
- **GIVEN** projectAtoms contains one atom with `status='active'` and one with `status='deprecated'`
- **WHEN** assemblePrimer is called
- **THEN** only the active atom appears in the ### Project atoms section; the deprecated atom is absent

#### Scenario: Pinned but resolved atom is excluded from the primer
- **GIVEN** projectAtoms contains a pinned atom with `status='resolved'`
- **WHEN** assemblePrimer is called
- **THEN** the resolved atom does NOT appear in the ### Project atoms section (active-only filter takes precedence over pin)

#### Scenario: Active-only filter applied before pinned/non-pinned partition
- **GIVEN** projectAtoms contains 3 active atoms (1 pinned, 2 non-pinned) and 2 resolved atoms
- **WHEN** assemblePrimer is called
- **THEN** the primer contains exactly the 3 active atoms, with the pinned one listed first; the resolved atoms are absent
