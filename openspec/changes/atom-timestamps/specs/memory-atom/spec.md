## ADDED Requirements

### Requirement: atom-write accepts an optional caller-supplied creation timestamp
The system SHALL accept an optional `createdAt` field (epoch ms integer) in the JSON payload of an `atom-write` call. When `createdAt` is supplied, it SHALL be used as the `created_at` column value instead of `Date.now()`. The `updated_at` column SHALL always be set to `Date.now()` regardless of `createdAt`. When `createdAt` is absent or `undefined`, the system SHALL behave as before and use `Date.now()` for `created_at`.

#### Scenario: atom-write with explicit createdAt stores that timestamp
- **GIVEN** an agent calls atom-write with `createdAt=1000`
- **WHEN** the atom is stored
- **THEN** the `created_at` column value is `1000`

#### Scenario: atom-write without createdAt uses current time
- **GIVEN** an agent calls atom-write without a `createdAt` field
- **WHEN** the atom is stored
- **THEN** the `created_at` column value is approximately `Date.now()` at the time of the call

## MODIFIED Requirements

### Requirement: atom-get returns best-match full content and a foreign-workspace listing
The system SHALL resolve the single best full-content match for a topic using priority order (current-workspace atom preferred, global atom as fallback). It SHALL separately query other workspaces for atoms at the same topic and return a listing (topic, description, 80-char content preview, project, updated_at). The response SHALL have shape `{ match: <full row | null>, alsoIn: <preview rows> }`. When no current-workspace or global atom exists, `match` SHALL be null and only the `alsoIn` listing is populated. The `match` row and each `alsoIn` row SHALL include both `created_at` and `updated_at` (epoch ms integers).

#### Scenario: atom-get returns current-workspace atom when it exists alongside a global one
- **GIVEN** an atom exists at topic 'arch/db' in the current workspace AND globally
- **WHEN** atom-get is called for the current workspace
- **THEN** the current-workspace atom is returned as match and the global atom appears in alsoIn with a 80-char preview

#### Scenario: atom-get falls back to global when no current-workspace match exists
- **GIVEN** no current-workspace atom exists at 'arch/db' but a global one does
- **WHEN** atom-get is called
- **THEN** the global atom is returned as match and alsoIn is empty

#### Scenario: atom-get returns null match and foreign listing when only other-workspace atoms exist
- **GIVEN** no current-workspace or global atom at 'arch/db', but an atom in workspace B exists
- **WHEN** atom-get is called
- **THEN** match is null and workspace-B atom appears in alsoIn with a 80-char content preview; no foreign content is loaded as match

#### Scenario: atom-get match row includes created_at and updated_at
- **GIVEN** an atom exists at topic 'arch/db' in the current workspace with a known created_at value
- **WHEN** atom-get is called
- **THEN** the match row includes both `created_at` and `updated_at` as epoch ms integers

### Requirement: atom-search searches all workspaces by default and supports scope narrowing
The system SHALL execute a full-text MATCH query across all atoms when no scope is specified, ordering results by BM25 score and including scope and project context in each result. The optional `scope` parameter SHALL narrow the search to the current workspace (`'workspace'`) or global-only atoms (`'global'`). When FTS5 is unavailable, the system SHALL fall back to a LIKE scan over topic, description, and content. Each result row SHALL include both `created_at` and `updated_at` (epoch ms integers).

#### Scenario: atom-search without scope includes all workspaces
- **GIVEN** matching atoms exist in the current workspace and in a second workspace
- **WHEN** atom-search is called with no scope argument
- **THEN** results from both workspaces are returned, each including project context

#### Scenario: atom-search with scope='workspace' restricts to current workspace
- **GIVEN** a matching atom exists in both the current workspace and a second workspace
- **WHEN** atom-search is called with scope='workspace'
- **THEN** only the current-workspace result is returned

#### Scenario: atom-search falls back to LIKE scan when FTS5 is absent
- **GIVEN** FTS5 is not available and an atom with matching content exists
- **WHEN** atom-search is called
- **THEN** results are returned via a LIKE scan over topic, description, and content

#### Scenario: atom-search results include created_at and updated_at
- **GIVEN** atoms with known timestamps exist in the database
- **WHEN** atom-search is called
- **THEN** each result row includes both `created_at` and `updated_at` as epoch ms integers

### Requirement: atom-list returns current-workspace and global atoms by default
The system SHALL list atoms matching an optional topic prefix, returning current-workspace and global atoms by default. When `scope='all'` is passed, it SHALL include atoms from all workspaces. Each result SHALL include topic, description, 80-char content preview, scope, project, `created_at`, and `updated_at`.

#### Scenario: atom-list without scope returns current-workspace and global atoms only
- **GIVEN** atoms exist in the current workspace, globally, and in a second workspace
- **WHEN** atom-list is called with no scope
- **THEN** current-workspace and global atoms are returned; the second workspace's atoms are excluded

#### Scenario: atom-list with scope='all' includes all workspaces
- **GIVEN** atoms exist in multiple workspaces
- **WHEN** atom-list is called with scope='all'
- **THEN** atoms from all workspaces are returned, each showing its project context

#### Scenario: atom-list with prefix filters by normalised topic prefix
- **GIVEN** atoms at topics 'auth/jwt', 'auth/oauth', and 'work/notes' exist
- **WHEN** atom-list is called with prefix='auth/'
- **THEN** only 'auth/jwt' and 'auth/oauth' are returned

#### Scenario: atom-list results include created_at and updated_at
- **GIVEN** atoms with known timestamps exist in the database
- **WHEN** atom-list is called
- **THEN** each result row includes both `created_at` and `updated_at` as epoch ms integers
