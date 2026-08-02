## ADDED Requirements

### Requirement: resolveWorkspace normalises workspace param to CLI scope/project pair

The system SHALL provide a `resolveWorkspace(workspace, contextDirectory)` function in `src/lib/workspace.js` that maps the `workspace` parameter to a `{ scope, project }` pair for the database layer. The function SHALL: return `{ scope: 'global', project: '' }` when `workspace` is `null`; expand `"."` to `path.resolve(contextDirectory)` before any git-root walk (the literal string `"."` SHALL never be passed to `findGitRoot`); for any string value, call `findGitRoot(expandedPath)` and return `{ scope: 'project', project: gitRoot }`. The companion function `findGitRoot(startAbsPath)` SHALL walk up from `startAbsPath` looking for a `.git` entry at each directory level: if `.git` is a directory → return that directory (the git root); if `.git` is a file → worktree pointer, continue walking to `path.dirname(dir)`; if the filesystem root is reached with no `.git` directory found → return `startAbsPath` unchanged. Both functions SHALL use `node:fs` only — no `git` binary dependency.

#### Scenario: findGitRoot stops at .git directory
- **GIVEN** `/repo/.git` is a directory
- **WHEN** `findGitRoot('/repo/src/lib')` is called
- **THEN** the result is `/repo`

#### Scenario: findGitRoot skips .git file and continues
- **GIVEN** `/repo/.worktrees/wt/.git` is a file and `/repo/.git` is a directory
- **WHEN** `findGitRoot('/repo/.worktrees/wt/src')` is called
- **THEN** the result is `/repo`

#### Scenario: findGitRoot returns startAbsPath when no .git directory found
- **GIVEN** no `.git` directory exists in any ancestor of `/no-git/project`
- **WHEN** `findGitRoot('/no-git/project')` is called
- **THEN** the result is `/no-git/project`

#### Scenario: resolveWorkspace expands "." before walk
- **GIVEN** `contextDirectory` is `/repo` and `/repo/.git` is a directory
- **WHEN** `resolveWorkspace('.', '/repo')` is called
- **THEN** the result is `{ scope: 'project', project: '/repo' }` (not `{ project: '.' }`)

### Requirement: atom-list-workspaces command lists workspace paths with atom counts

The system SHALL expose an `atom-list-workspaces` CLI subcommand in `src/memory.js` that calls `atomListWorkspaces(db, { includeDeprecated? })` in `src/lib/schema.js`. The `atomListWorkspaces` function SHALL query `memory_atom` for rows where `scope = 'project'` and `project != ''`, group by `project`, count rows per group, exclude `status = 'deprecated'` rows by default (and include them when `includeDeprecated` is true), and return `[{ workspace: project, count }]` ordered by count descending. Global atoms (`scope = 'global'`) SHALL be excluded from results.

#### Scenario: atomListWorkspaces returns workspace paths with counts
- **GIVEN** 3 atoms in project='/repo-a' and 1 atom in project='/repo-b' (all active)
- **WHEN** `atomListWorkspaces(db, {})` is called
- **THEN** the result is `[{ workspace: '/repo-a', count: 3 }, { workspace: '/repo-b', count: 1 }]` ordered by count desc

#### Scenario: atomListWorkspaces excludes global atoms
- **GIVEN** atoms exist in scope='project' and scope='global'
- **WHEN** `atomListWorkspaces(db, {})` is called
- **THEN** no row with scope='global' appears in the results

#### Scenario: atomListWorkspaces excludes deprecated by default
- **GIVEN** 2 active atoms and 1 deprecated atom in project='/repo'
- **WHEN** `atomListWorkspaces(db, {})` is called
- **THEN** the count for '/repo' is 2 (deprecated excluded)

#### Scenario: atomListWorkspaces includes deprecated when requested
- **GIVEN** 2 active atoms and 1 deprecated atom in project='/repo'
- **WHEN** `atomListWorkspaces(db, { includeDeprecated: true })` is called
- **THEN** the count for '/repo' is 3

## MODIFIED Requirements

### Requirement: atom-write reports whether the atom was created or overwritten

The system SHALL append the resolved storage location to each `atom-write` confirmation: `"Created atom at {topic} [workspace: /git-root]"` for workspace-scoped atoms or `"Created atom at {topic} [global]"` for global atoms. The overwrite form SHALL be `"Updated existing atom at {topic} (previous content overwritten) [workspace: /git-root]"` or `"Updated existing atom at {topic} (previous content overwritten) [global]"`. The `memory.js` result JSON SHALL include the resolved `scope` and `project` fields so `plugin.js` can format the location suffix.

#### Scenario: atom-write on new topic reports Created
- **GIVEN** no atom exists at the given topic
- **WHEN** atom-write is called with a valid description
- **THEN** stdout contains 'Created atom at <topic>'

#### Scenario: atom-write on existing topic reports Updated
- **GIVEN** an atom already exists at the given topic
- **WHEN** atom-write is called with updated content
- **THEN** stdout contains 'Updated existing atom at <topic> (previous content overwritten)'

#### Scenario: atom-write created confirmation includes location
- **GIVEN** no atom exists at the given topic
- **WHEN** `atom-write` is called with workspace resolving to project='/repo'
- **THEN** stdout contains `Created atom at <topic> [workspace: /repo]`

#### Scenario: atom-write overwritten confirmation includes location
- **GIVEN** an atom exists at the given topic
- **WHEN** `atom-write` is called for the same topic with workspace resolving to project='/repo'
- **THEN** stdout contains `Updated existing atom at <topic> (previous content overwritten) [workspace: /repo]`

#### Scenario: atom-write global confirmation includes [global]
- **GIVEN** workspace is null (global write)
- **WHEN** `atom-write` is called
- **THEN** stdout contains `Created atom at <topic> [global]`

### Requirement: atom-append appends content with separator and returns updated full content

The `atom-append` result SHALL include the resolved scope and project fields alongside the updated content, so the calling `plugin.js` layer can append the location suffix to its response.

#### Scenario: atom-append appends to existing atom
- **GIVEN** an atom exists at topic 'work/notes' with content='initial content'
- **WHEN** atom-append is called with content='new finding'
- **THEN** the stored content is 'initial content\n---\nnew finding' and the full updated content is printed on stdout

#### Scenario: atom-append result includes resolved location fields
- **GIVEN** an atom exists at topic 'work/notes' in project '/repo'
- **WHEN** `atom-append` is called
- **THEN** the result JSON includes `scope` and `project` fields

### Requirement: atom-delete removes the atom and updates the FTS index

The `atom-delete` result JSON SHALL include the resolved `scope` and `project` so the `plugin.js` layer can append the location suffix `[workspace: /path]` or `[global]` to the confirmation.

#### Scenario: atom-delete removes an existing atom
- **GIVEN** an atom exists at the given (scope, project, topic)
- **WHEN** atom-delete is called
- **THEN** the atom is removed from memory_atom, FTS integrity-check passes, and stdout contains a one-line confirmation

#### Scenario: atom-delete on a missing topic exits non-zero
- **GIVEN** no atom exists at the given (scope, project, topic)
- **WHEN** atom-delete is called
- **THEN** the process exits with a non-zero code and stderr contains an informative message

#### Scenario: atom-delete result includes resolved location fields
- **GIVEN** an atom exists at topic 'arch/db' in project '/repo'
- **WHEN** `atom-delete` is called
- **THEN** the result JSON includes `scope` and `project` fields

### Requirement: atom-search searches all workspaces by default and supports scope narrowing

The `atom-search` CLI subcommand and the `atomSearch` schema function SHALL rename the `query` field to `keywords` in the JSON payload. The SQLite FTS `MATCH` clause binding is unchanged. Callers that supply `query` instead of `keywords` SHALL receive an error or empty result (the old field name is not aliased).

#### Scenario: atom-search default excludes deprecated atoms
- **GIVEN** atoms matching the query exist with `status='active'`, `status='resolved'`, and `status='deprecated'`
- **WHEN** `atom-search` is called with no status options
- **THEN** the active and resolved matching atoms are returned and the deprecated one is excluded

#### Scenario: atom-search with includeDeprecated returns all matching statuses
- **GIVEN** matching atoms exist with all three status values
- **WHEN** `atom-search` is called with `{"includeDeprecated":true}` in the search blob
- **THEN** all three matching atoms are returned

#### Scenario: atom-search with status filter returns only that status
- **GIVEN** matching atoms exist with all three status values
- **WHEN** `atom-search` is called with `{"status":"resolved"}` in the search blob
- **THEN** only the resolved matching atom is returned

#### Scenario: atom-search result rows include status
- **GIVEN** a matching resolved atom exists
- **WHEN** `atom-search` is called with `{"status":"resolved"}`
- **THEN** each result row includes a `status` field equal to `'resolved'`

#### Scenario: atom-search with keywords field returns matching atoms
- **GIVEN** atoms exist with matching content
- **WHEN** `atom-search` JSON payload contains `{ "keywords": "auth" }`
- **THEN** matching atoms are returned

#### Scenario: atom-search with legacy query field returns error or empty
- **GIVEN** atoms exist with matching content
- **WHEN** `atom-search` JSON payload contains `{ "query": "auth" }` (old name)
- **THEN** the command errors (missing required keywords field) or returns empty results

### Requirement: atom-patch performs a content-preserving partial metadata update

When the patch payload contains a `targetWorkspace` field, the `atomPatch` function SHALL execute an atomic move under `BEGIN IMMEDIATE`: SELECT the full source row (error if not found), DELETE from the source (scope, project, topic), INSERT/UPSERT at the destination (targetScope, targetProject, topic) preserving all columns and bumping `updated_at`. The destination UPSERT SHALL use `ON CONFLICT(scope, project, topic) DO UPDATE` (overwrite). When source and destination resolve to the same (scope, project) pair, the move step SHALL be skipped and a normal in-place metadata patch SHALL execute instead. Combined move + metadata: any other present patch fields SHALL be applied to the row before the destination INSERT. The FTS sync triggers fire automatically on the DELETE and INSERT.

#### Scenario: Patch sets always_include to true
- **GIVEN** an atom with `always_include = 0`
- **WHEN** `atom-patch` is called with `patch.always_include = true`
- **THEN** the atom has `always_include = 1` and `updated_at` is updated

#### Scenario: Patch clears always_include
- **GIVEN** an atom with `always_include = 1`
- **WHEN** `atom-patch` is called with `patch.always_include = false`
- **THEN** the atom has `always_include = 0` and `updated_at` is updated

#### Scenario: Omitting always_include in patch leaves it unchanged
- **GIVEN** an atom with `always_include = 1`
- **WHEN** `atom-patch` is called with a patch that does not include `always_include`
- **THEN** the atom still has `always_include = 1`

#### Scenario: atomPatch moves atom to new project
- **GIVEN** an atom exists at (scope='project', project='/repo-a', topic='arch/db')
- **WHEN** `atomPatch` is called with source `{scope:'project', project:'/repo-a'}` and targetWorkspace resolving to `{scope:'project', project:'/repo-b'}`
- **THEN** no atom exists at ('/repo-a', 'arch/db') and one exists at ('/repo-b', 'arch/db') with all fields preserved

#### Scenario: atomPatch move overwrites destination conflict
- **GIVEN** atoms exist at both ('/repo-a', 'arch/db') and ('/repo-b', 'arch/db')
- **WHEN** `atomPatch` moves from '/repo-a' to '/repo-b'
- **THEN** '/repo-b' holds the source atom's content and '/repo-a' has no atom at that topic

#### Scenario: atomPatch source equals destination skips DELETE/INSERT
- **GIVEN** an atom exists at ('/repo', 'arch/db')
- **WHEN** `atomPatch` is called with source and targetWorkspace both resolving to '/repo'
- **THEN** the atom remains at '/repo' and the metadata patch is applied in place

#### Scenario: atomPatch combined move and status change
- **GIVEN** an atom exists at ('/repo-a', 'arch/db') with status='active'
- **WHEN** `atomPatch` is called with targetWorkspace='/repo-b' and patch status='resolved'
- **THEN** the atom lands at ('/repo-b', 'arch/db') with status='resolved'
