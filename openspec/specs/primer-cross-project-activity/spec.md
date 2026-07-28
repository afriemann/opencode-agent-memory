# primer-cross-project-activity Specification

## Purpose
TBD - created by archiving change primer-ux-improvements. Update Purpose after archive.
## Requirements
### Requirement: assemblePrimer includes an active-projects-today section
When there are hot_state rows for projects other than the current project that were updated within the last 24 hours, `assemblePrimer` SHALL include an `### Active projects today` section immediately after `### Recent sessions` (or at the top of the primer body when `### Recent sessions` is absent). Each entry SHALL show the project path (relative to `$HOME` when possible), the agent, and the time of last activity. When no other projects were active in the last 24 hours, the section SHALL be omitted entirely. The section SHALL be populated from a cross-scope query of `hot_state` filtered by `updated_at >= now - 24h` and `project != currentProject`.

#### Scenario: Active projects today section appears when other projects were worked on
- **GIVEN** hot_state contains rows for two projects other than the current project, both updated within the last 24 hours
- **WHEN** assemblePrimer is called
- **THEN** the output contains `### Active projects today` with one entry per project showing a relative path and agent

#### Scenario: Active projects today section is omitted when no other projects were active
- **GIVEN** hot_state contains rows only for the current project
- **WHEN** assemblePrimer is called
- **THEN** the output does NOT contain `### Active projects today`

#### Scenario: Active projects today section is omitted when other projects were active more than 24 hours ago
- **GIVEN** hot_state contains a row for a different project with updated_at 25 hours ago
- **WHEN** assemblePrimer is called
- **THEN** the output does NOT contain `### Active projects today`

