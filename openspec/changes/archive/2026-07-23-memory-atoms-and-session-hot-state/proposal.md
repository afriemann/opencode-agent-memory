## Why

The plugin's memory model is a single project-scoped summary row that gets overwritten on each distil cycle — meaning parallel sessions on the same project fight over the same record, and there is no durable knowledge base an agent can explicitly write to and search across sessions. Additionally, workspace-scoped memories are currently invisible from other workspaces (the same silo problem as Serena), blocking the goal of replacing Serena with this plugin.

## What Changes

- **BREAKING** `hot_state` uniqueness changes from `(scope, agent, project)` to `(scope, agent, project, session_id)` — each session maintains its own resumable row; the distil-write monotonic guard is now per-session
- `hot_state` gains two columns: `session_id` (part of the unique key) and `session_name` (human-readable title captured at `session.created`)
- `adr_candidate` fully retired: removed from the distil output struct, from `memory_state_patch` schema, from `assemblePrimer`, and the column dropped from `hot_state` in the migration — all sites changed together
- New `memory_atom` table: named, durable knowledge atoms keyed by `(scope, project, topic)` with a required `description` field and an FTS5 virtual table for full-text search across topic, description, content, and tags; topic is normalised on ingest (lowercase, spaces/underscores → hyphens, strip leading/trailing slashes) via a shared `normaliseTopic` helper; the same normalisation applied on `atom-get` input and `atom-list` prefix input to prevent silent misses
- **Cross-workspace access model**: workspace-scoped atoms are accessible from any session — scope and project tag determine injection priority and context labelling, not access. `memory_atom_search` searches all workspaces by default; `memory_atom_list` shows current-workspace + global atoms by default (use `scope='all'` for all workspaces); both show project context in results. `memory_atom_get` returns the full content of the best match (current workspace → global priority) plus a related listing (topic + description + 80-char preview) of other-workspace atoms with the same topic — agent sees what exists without loading foreign content
- Session inject changes: injects multi-row hot_state section (top-3 recent sessions) followed by an atom directory (topic + description + 80-char preview + relative recency, capped at 40 entries per scope section — configurable via `atomInjectCap`; overflows to "+ N more"); directory shows `### Project atoms` and `### Global atoms` sub-sections independently; includes "Fetch atoms on demand when relevant — do not pre-fetch at session start" framing; cold-start sessions with no hot_state still get global atoms if any exist
- Signal read/delete in distil-write scoped to `session_id` — prevents sessions from consuming each other's signals
- `memory_state_patch` upserts a skeleton row when no session row exists yet (rather than silently no-op) — allows agents to set state before the first distil
- Nine renamed/new tools replacing the previous `memory_inspect`, `memory_correct`, `memory_distil_force` names (see Capabilities)
- Auto-migration on startup: existing `hot_state` rows converted to atoms at `work/migrated-summary`; sentinel atom marks migration complete
- Semantic search (embeddings via `@xenova/transformers`) is out of scope — search is FTS5 only, with semantic search added later as an optional/configurable extension

## Capabilities

### New Capabilities

- `memory-atom`: Durable named knowledge atoms stored in SQLite with FTS5 full-text search. Covers the `memory_atom` table schema, FTS5 virtual table with external-content + trigger-based sync (INSERT/DELETE/UPDATE), CRUD operations, topic normalisation on ingest and on lookup inputs, cross-workspace access model, and startup migration from legacy `hot_state` rows.
- `memory-atom-tools`: Six agent-facing plugin tools:
  - `memory_atom_write(topic, content, description, tags?, scope?)` — upsert; `description` required; returns `"Created atom at <topic>"` or `"Updated existing atom at <topic> (previous content overwritten)"`
  - `memory_atom_append(topic, content, scope?)` — appends to existing atom's content with `\n---\n` separator; **errors if topic does not exist** (no create-on-missing, to preserve the description invariant); returns full updated content
  - `memory_atom_get(topic, scope?)` — fetch by topic; returns full content of best match (current workspace → global priority) plus a "Also in other workspaces" listing of other-workspace atoms at the same topic (topic + description + 80-char preview); if no workspace/global match exists, returns only the cross-workspace listing
  - `memory_atom_search(query, limit?, scope?)` — FTS5 full-text search across all atoms by default (all workspaces); results include project context; `scope` parameter optionally filters to current workspace (`'workspace'`) or global only (`'global'`)
  - `memory_atom_list(prefix?, scope?)` — list atoms by topic prefix; defaults to current-workspace + global atoms; `scope='all'` includes other workspaces; shows topic + description + 80-char preview
  - `memory_atom_delete(topic, scope?)` — remove atom

### Modified Capabilities

- `memory-store`: `hot_state` rebuilt with new UNIQUE constraint (`scope, agent, project, session_id`), two columns added (`session_id`, `session_name`), `adr_candidate` column dropped; `memory_atom` table, FTS5 virtual table, and three sync triggers added to `ensureSchema`; distil-write transaction is session-scoped (writes own row, prunes to keep last 5 per project, deletes only own signals); `memory_state_patch` upserts a skeleton row when session row absent; `PRAGMA user_version` bumped to 2; startup auto-migration from legacy hot_state rows to atoms.
- `memory-state-tools` (replacing `memory-inspect`, `memory-correct`, `memory-distil-force`):
  - `memory_state_inspect` — updated description: "Read the current agent memory hot state for this session: recent session threads, current signals, and the loaded primer. Does not list durable atoms — use `memory_atom_list` for the atom directory or `memory_atom_get` to fetch a specific atom by topic."
  - `memory_state_patch` — drops `adr_candidate` from patchable fields; upserts on missing session row
  - `memory_state_distil` — renamed only, behaviour unchanged
- `plugin-lifecycle`: `session.created` now captures `session_name` from `event.properties.info.title`; inject primer format changes to multi-row hot_state + atom directory with global/project sections.
- `signal-processing`: `assemblePrimer` rewritten to accept multiple hot_state rows + atom listing; new primer format (recent-session threads + atom directory with recency, cap, global sub-section, no-action framing, cold-start global-only path); `adr_candidate` slot removed; `signal-processing.md` spec rewritten to match the currently shipped format as baseline before applying the delta.

## Impact

- **Schema**: `hot_state` rebuilt (new UNIQUE, two columns added, `adr_candidate` dropped); `memory_atom` and `memory_atom_fts` new tables; three FTS5 sync triggers new; `PRAGMA user_version` bumped to 2
- **`src/lib/schema.js`**: `ensureSchema` (migration + new tables + triggers), `distilWrite` (session-scoped, keep-last-5 prune), `atomWrite`/`atomAppend`/`atomGet`/`atomSearch`/`atomList`/`atomDelete` DB helpers
- **`src/lib/signal-utils.js`**: `assemblePrimer` new signature and format; `formatRelativeTime` helper; `normaliseTopic` shared helper; `adr_candidate` removed
- **`src/lib/distil-prompt.js`**: distil schema drops `adr_candidate`; signal read scoped by `session_id`
- **`src/plugin.js`**: session.created handler (session_name capture); inject call site; six `memory_atom_*` + three `memory_state_*` tool registrations replacing existing names
- **`src/memory.js`**: `distil-write` subcommand session-scoped; new `atom-write`, `atom-append`, `atom-get`, `atom-search`, `atom-list`, `atom-delete` subcommands; `inspect`, `correct`, `distil-force` subcommands renamed/updated
- **`src/config.js`**: `atomInjectCap` config key (integer, default 40)
- **Node.js**: still `>=22.5`; zero new runtime dependencies for this change
