## ADDED Requirements

### Requirement: doDistil and loadMemoryForSession normalise the project key via git-root detection

The plugin SHALL resolve the canonical project key for every hot-state write and read through a single `projectKeyFor(directory)` helper: `findGitRootOrNull(directory) ?? ''`. `doDistil` and all injection entry points (`loadMemoryForSession`) SHALL use `projectKeyFor(session.directory)` instead of raw `session.directory`. When the session is inside a git repository, the normalised git root is the key. When the session directory has no `.git` ancestor, `projectKeyFor` returns `''` and all hot-state operations use the shared empty-project bucket (`scope='project', project=''`).

The three call sites that read `session.directory` / `data.directory` and pass it to `loadMemoryForSession` SHALL all normalise through `projectKeyFor` identically, so distil-write and read always use the same key and the primer is never silently empty due to key drift.

#### Scenario: git session distils to normalised git root
- **GIVEN** a session is opened from `/myrepo/src/feature` where `/myrepo` is the git root
- **WHEN** distillation runs for that session
- **THEN** the hot_state row is written with `project='/myrepo'` (not `'/myrepo/src/feature'`)

#### Scenario: non-git session distils to empty-project shared bucket
- **GIVEN** a session is opened from `/home/user` which has no `.git` ancestor
- **WHEN** distillation runs for that session
- **THEN** the hot_state row is written with `project=''`

#### Scenario: injection uses the same key as distil for a git session
- **GIVEN** distil has written a hot_state row under `project='/myrepo'`
- **WHEN** `loadMemoryForSession` is called for the same session
- **THEN** the read uses `project='/myrepo'` and the primer is non-empty

#### Scenario: injection uses empty project for a non-git session
- **GIVEN** a non-git session has hot_state rows under `project=''`
- **WHEN** `loadMemoryForSession` is called for that session
- **THEN** the read uses `project=''` and returns those rows

### Requirement: memory.js hot-state subcommands accept empty-string project

The `read`, `accrue`, `inspect`, `distil-write`, and `correct` subcommands in `memory.js` SHALL accept an empty string (`''`) as a valid `project` argument. The current `!project` guard on positional arguments SHALL be changed to `project === undefined` (reject only a genuinely missing positional, not a valid empty string). SQL queries filtering `WHERE scope='project' AND project = ?` correctly distinguish `project=''` (shared bucket) from `project='/myrepo'` (project bucket) — no scope predicate changes are needed.

#### Scenario: distil-write accepts empty-string project for non-git session
- **GIVEN** a non-git session passes `project=''` to `distil-write`
- **WHEN** the subcommand runs
- **THEN** the hot_state row is upserted with `scope='project', project=''` and the process exits 0

#### Scenario: read accepts empty-string project for non-git session
- **GIVEN** a non-git session passes `project=''` to `read`
- **WHEN** the subcommand runs
- **THEN** the rows for `scope='project', project=''` are returned and the process exits 0

#### Scenario: hot-state commands reject a truly missing positional
- **GIVEN** the `read` subcommand is called without a project argument
- **WHEN** the subcommand processes its arguments
- **THEN** the process exits non-zero with a usage error

### Requirement: hotStateCrossProject excludes the shared empty-project bucket

The `hotStateCrossProject` function in `schema.js` SHALL add an `AND project != ''` predicate to its query so that the shared bucket (`project=''`) never appears in the "Active projects today" cross-project primer section. A git session's cross-project list SHALL never render an empty-path row. A non-git session querying with `currentProject=''` will naturally exclude git-project rows via the existing `project != ?` filter; the combined effect is that only named git-project rows appear in cross-project activity.

#### Scenario: Cross-project list excludes empty-project rows for a git session
- **GIVEN** a git session with `project='/myrepo'` and one hot_state row with `project=''` (non-git session)
- **WHEN** `hotStateCrossProject` is called with `currentProject='/myrepo'`
- **THEN** the empty-project row does not appear in the results

#### Scenario: Cross-project list shows only named projects for a non-git session
- **GIVEN** a non-git session with `project=''` and hot_state rows for `/repo-a` and `/repo-b`
- **WHEN** `hotStateCrossProject` is called with `currentProject=''`
- **THEN** `/repo-a` and `/repo-b` appear (they differ from `''`) and no blank-path row appears

## MODIFIED Requirements

### Requirement: Primer inject includes atom directory sections for project and global atoms

The system SHALL query both the current-workspace atoms and shared atoms via two separate `atom-list` spawns at `session.created` (inject time) and include the results in the injected primer under `### Project atoms` and `### Shared atoms` sub-sections respectively. Each sub-section SHALL be capped independently at `atomInjectCap`. When a sub-section has no atoms it SHALL display a one-liner placeholder (`No shared atoms yet.` for the shared section). When the atom count exceeds the cap the sub-section SHALL end with `(+N more — call memory_atom_list to see all)`.

#### Scenario: Project and shared atom sections both appear in warm-start primer
- **GIVEN** project atoms and shared atoms both exist
- **WHEN** session.created fires for a warm start
- **THEN** the injected primer contains `### Project atoms` and `### Shared atoms` sections each listing their respective atoms

#### Scenario: Overflow line is emitted when atoms exceed the inject cap
- **GIVEN** more than atomInjectCap project atoms exist
- **WHEN** session.created fires
- **THEN** only atomInjectCap atoms are listed under `### Project atoms` and the overflow line `(+N more — call memory_atom_list to see all)` follows

#### Scenario: Empty shared atom section collapses to a one-liner
- **GIVEN** no shared atoms exist
- **WHEN** session.created fires for a warm start
- **THEN** the `### Shared atoms` section shows 'No shared atoms yet.' rather than an empty heading

### Requirement: session.created does not inject for cold-start sessions

The system SHALL skip injection of the multi-row primer when the session has no prior hot_state rows. However, when no hot_state rows exist but one or more shared atoms exist, the system SHALL inject a minimal primer containing only the `### Shared atoms` section. When there are no hot_state rows AND no shared atoms, no injection occurs.

#### Scenario: Cold start with shared atoms injects shared-only primer
- **GIVEN** no hot_state row exists for the session but at least one shared atom exists
- **WHEN** session.created fires
- **THEN** a primer is injected containing the `### Shared atoms` section and no `### Recent sessions` section

#### Scenario: Cold start with no shared atoms and no hot_state injects nothing
- **GIVEN** no hot_state row exists and no shared atoms exist
- **WHEN** session.created fires
- **THEN** no primer injection occurs

#### Scenario: Warm start with hot_state rows injects the full multi-row primer
- **GIVEN** at least one hot_state row exists for the session's agent and project
- **WHEN** session.created fires
- **THEN** the full primer is injected including `### Recent sessions` and atom directory sections
