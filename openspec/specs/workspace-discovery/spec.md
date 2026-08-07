# workspace-discovery Specification

## Purpose
Discovery tool that lets agents enumerate which workspace git-root paths have stored atoms, enabling correct `workspace` targeting before performing cross-workspace reads or writes.
## Requirements
### Requirement: memory_workspaces_list tool lists workspace git-root paths with atom counts

The `memory_workspaces_list` registered tool SHALL invoke the `atom-list-workspaces` CLI subcommand and format each result row as `• {workspace} — {count} atom(s)`. When no workspaces have stored atoms, it SHALL return `No workspaces with stored atoms.`. The tool output SHALL end with a note: `Pass workspace: <path> to target a specific workspace. Paths are git roots. Shared atoms are not listed here — use scope: "global" on read tools to search the entire space including shared atoms.` Shared atoms (`scope='global', project=''`) SHALL NOT appear in the results. The tool description SHALL state that results are workspace-scoped only and direct callers to read tools with `scope="global"` for an entire-space search.

#### Scenario: memory_workspaces_list returns workspace paths with counts
- **GIVEN** atoms exist in two project workspaces
- **WHEN** `memory_workspaces_list` is called
- **THEN** the output lists each workspace path with its atom count in the format `• /path — N atom(s)`

#### Scenario: memory_workspaces_list excludes shared atoms
- **GIVEN** atoms exist in both a project workspace and the shared store (`scope='global', project=''`)
- **WHEN** `memory_workspaces_list` is called
- **THEN** the shared atoms do not appear in the output

#### Scenario: memory_workspaces_list returns empty message when no workspaces
- **GIVEN** no atoms exist in any project workspace
- **WHEN** `memory_workspaces_list` is called
- **THEN** the output is `No workspaces with stored atoms.`

#### Scenario: memory_workspaces_list ends with a usage note
- **GIVEN** at least one workspace has atoms
- **WHEN** `memory_workspaces_list` is called
- **THEN** the output ends with guidance referencing workspace targeting and `scope="global"` for entire-space search

