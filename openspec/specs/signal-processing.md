# Spec: Signal Processing

Behaviour contract for signal reduction and primer assembly.

---

## Signal Reduction

### Requirement: reduceSignals deduplicates file signals by path

The system SHALL retain only the most recently created `memory_signal` row for each unique file path when reducing signals; older duplicates for the same path SHALL be discarded.

#### Scenario: Duplicate file signals
- GIVEN two `memory_signal` rows for the same file path with different `created_at` values
- WHEN `reduceSignals` is called
- THEN only the row with the higher `created_at` is included in the output

### Requirement: reduceSignals caps per-kind signal count

The system SHALL retain at most `MAX_SIGNALS_PER_KIND` signals per kind, selecting the most recent by `created_at`; excess signals SHALL be discarded. The cap is applied independently per kind.

#### Scenario: Signals within the cap
- GIVEN fewer than `MAX_SIGNALS_PER_KIND` signals of a given kind
- WHEN `reduceSignals` is called
- THEN all signals of that kind are returned

#### Scenario: Signals exceeding the cap
- GIVEN more than `MAX_SIGNALS_PER_KIND` signals of a single kind
- WHEN `reduceSignals` is called
- THEN only the `MAX_SIGNALS_PER_KIND` most recent signals of that kind are returned

#### Scenario: Cap applied independently per kind
- GIVEN signals of kind `todo` exceeding the cap and signals of kind `message` within the cap
- WHEN `reduceSignals` is called
- THEN `todo` signals are capped and `message` signals are unaffected

### Requirement: reduceSignals handles empty and null input

The system SHALL return an empty array when `reduceSignals` is called with `null`, `undefined`, or an empty array.

---

## Primer Assembly

### Requirement: assemblePrimer accepts an options object

The system SHALL accept a single options object `{ rows, projectAtoms, globalAtoms, agent, project, staleness, cap }` and SHALL NOT support the legacy positional-argument signature.

### Requirement: assemblePrimer returns null when rows and atoms are all absent

The system SHALL return `null` when `rows` is empty or null AND `projectAtoms` is empty AND `globalAtoms` is empty.

#### Scenario: All inputs empty
- GIVEN rows=[], projectAtoms=[], globalAtoms=[]
- WHEN `assemblePrimer` is called
- THEN the return value is `null`

#### Scenario: Global atoms only (cold start)
- GIVEN rows=[], projectAtoms=[], globalAtoms=[{ topic, description, preview, updated_at }]
- WHEN `assemblePrimer` is called
- THEN the return value is non-null and contains the global atom directory

### Requirement: assemblePrimer produces a header with the last two path segments

The primer SHALL begin with a header line of the form `## Project memory — <last-two-path-segments> (background context — no action required)`.

### Requirement: assemblePrimer renders a Recent sessions section when rows are present

The system SHALL render a `### Recent sessions` section containing one entry per row in the `rows` array, each entry formatted as `▸ <session_name|short_id> — <relative time>`, followed by `  Last: …`, `  Next: …`, and `  Open questions: …` lines.

#### Scenario: Single session row
- GIVEN rows=[{ session_name, last_worked_summary, next_action, open_questions, updated_at }]
- WHEN `assemblePrimer` is called
- THEN the output contains `### Recent sessions` and the row's data under a `▸` line

#### Scenario: Cold start — no Recent sessions section
- GIVEN rows=[] with non-empty projectAtoms or globalAtoms
- WHEN `assemblePrimer` is called
- THEN the output does NOT contain `### Recent sessions`

### Requirement: assemblePrimer renders a Project atoms directory section

The system SHALL render a `### Project atoms — search: memory_atom_search · fetch: memory_atom_get` section. When `projectAtoms` is non-empty it SHALL include a no-action framing line and one bullet per atom (topic · description · 80-char preview · relative time). When `projectAtoms` is empty it SHALL display a placeholder.

#### Scenario: Project atoms present
- GIVEN projectAtoms=[{ topic, description, preview, updated_at }]
- WHEN `assemblePrimer` is called
- THEN the output contains the atom's topic and description under the Project atoms section

#### Scenario: Project atoms empty
- GIVEN projectAtoms=[]
- WHEN `assemblePrimer` is called
- THEN the output contains `No project atoms yet.`

### Requirement: assemblePrimer renders a Global atoms directory section

The system SHALL render a `### Global atoms` section. When `globalAtoms` is non-empty it SHALL include the same entry format as project atoms. When `globalAtoms` is empty it SHALL display a placeholder.

#### Scenario: Global atoms empty
- GIVEN globalAtoms=[]
- WHEN `assemblePrimer` is called
- THEN the output contains `No global atoms yet.`

### Requirement: assemblePrimer includes a no-action framing line when atoms are present

The system SHALL include the line `Fetch atoms on demand when relevant — do not pre-fetch at session start` when the respective atom list is non-empty.

### Requirement: assemblePrimer shows a per-section overflow line when atom count exceeds cap

The system SHALL append a `+ N more` line to a section when the number of atoms in that section exceeds `cap`.

#### Scenario: Atom count exceeds cap
- GIVEN projectAtoms.length > cap
- WHEN `assemblePrimer` is called
- THEN the output contains `+ N more` where N = projectAtoms.length - cap

### Requirement: assemblePrimer appends a staleness line

The primer SHALL end with `Staleness: <renderStaleness(staleness)>` using the exact output of `renderStaleness`.

### Requirement: assemblePrimer does not emit ADR or teach-back content

The system SHALL NOT include any `adr_candidate`, `Possible decision to record`, or teach-back block in the primer output.
