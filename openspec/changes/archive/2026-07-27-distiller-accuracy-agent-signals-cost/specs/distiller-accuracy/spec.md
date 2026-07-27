## ADDED Requirements

### Requirement: distiller prompt applies contradiction-not-absence precedence
The distiller prompt SHALL include a PRIOR vs SIGNALS precedence section stating that SIGNALS represent the most recent session state and take precedence over PRIOR where they conflict. The rule SHALL be framed as a *contradiction rule*: where SIGNALS describe work that conflicts with or supersedes what PRIOR states (e.g. PRIOR says approach X is pending; SIGNALS show work on approach Y instead), the distiller MUST favour SIGNALS. PRIOR content about domains that SIGNALS do not address SHALL remain valid background context and MUST NOT be dropped from the summary.

#### Scenario: SIGNALS contradict PRIOR approach
- **GIVEN** PRIOR contains "next action: apply acpi_osi='Windows 2019' parameter" and SIGNALS contain messages about SSDT ACPI override work with no mention of acpi_osi
- **WHEN** the distiller produces the summary
- **THEN** `next_action` reflects the SSDT approach and does not mention acpi_osi

#### Scenario: PRIOR content not addressed by SIGNALS is preserved
- **GIVEN** PRIOR describes two parallel tasks (task A and task B) and SIGNALS only mention activity on task A
- **WHEN** the distiller produces the summary
- **THEN** the summary preserves context about task B from PRIOR alongside the updated task A state from SIGNALS

#### Scenario: SIGNALS that expand on PRIOR are merged, not replaced
- **GIVEN** PRIOR says "investigating auth bug" and SIGNALS contain a user correction "actually it's a JWT expiry bug, not the auth middleware"
- **WHEN** the distiller produces the summary
- **THEN** the summary reflects the more specific JWT expiry framing from SIGNALS, not the generic auth bug framing from PRIOR
