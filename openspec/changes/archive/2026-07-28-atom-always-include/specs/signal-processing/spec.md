## MODIFIED Requirements

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

## ADDED Requirements

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
