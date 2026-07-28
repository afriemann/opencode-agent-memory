## Why

Three small but noticeable rough edges in the session primer degrade the agent's experience at the start of every session: migrated/nameless sessions display as "unknown" (confusing), work done in sub-project repos is invisible to the home-directory primer (a blind spot), and the staleness footer says "git anchor unavailable" for situations that are either expected or meaningless.

## What Changes

- **"unknown" session label**: sessions with an empty `session_id` and NULL `session_name` (produced by schema migrations and sessions that never received a title) now fall back to a human-readable date string derived from `updated_at` instead of "unknown".
- **Cross-project activity section**: the primer gains an "Active projects today" section listing all projects with session activity in the last 24 hours, so the agent can see what was worked on across repos without querying each project's primer individually.
- **Staleness description**: `renderStaleness` now distinguishes `no-anchor` (project is a git repo but no SHA was recorded yet) from `no-git` (project directory is not a git repo). The `no-git` case omits the staleness line entirely; the `no-anchor` case uses "not yet anchored to a commit".

## Capabilities

### New Capabilities

- `primer-cross-project-activity`: a new primer section showing projects active in the last 24 hours, drawn from `hot_state` across all project scopes

### Modified Capabilities

- `signal-processing`: requirements for session-label rendering (fallback label), staleness-line rendering (`no-git` omission, `no-anchor` text), and primer section composition (new cross-project section)

## Impact

- `src/lib/signal-utils.js` — session label fallback logic; staleness-line conditional omission; new cross-project section renderer
- `src/lib/git-helper.js` — `renderStaleness` text for `no-anchor` and `no-git` cases
- `src/memory.js` — new `read` query variant (or reuse of existing) to fetch today's hot_state rows across all projects for a given agent
- No schema changes; no new dependencies
