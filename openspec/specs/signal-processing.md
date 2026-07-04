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

### Requirement: assemblePrimer produces a header with the agent name and last-two-path-segments

The primer SHALL begin with a header line of the form `[MEMORY — resumed context for <agent> in <last-two-segments-of-project-path>]`.

### Requirement: assemblePrimer emits slots in a fixed order

The primer SHALL emit content slots in the following order: header → summary → next_action → questions → ADR (only if non-null) → staleness line → teach-back block.

#### Scenario: All slots populated
- GIVEN a hot_state row with summary, next_action, questions, and ADR all non-null
- WHEN `assemblePrimer` is called
- THEN the output contains all slots in the specified order

#### Scenario: ADR slot absent when null
- GIVEN a hot_state row where the ADR field is null
- WHEN `assemblePrimer` is called
- THEN no ADR section appears in the output

### Requirement: assemblePrimer always includes the teach-back block

The system SHALL include the teach-back block at the end of every primer, regardless of which other slots are populated.

### Requirement: assemblePrimer staleness line matches renderStaleness output

The staleness line in the primer SHALL be produced by `renderStaleness` and SHALL match its exact output format.
