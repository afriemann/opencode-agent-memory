## 1. Schema (src/lib/schema.js)

- [x] 1.1 Rewrite hot_state DDL: add session_id (TEXT NOT NULL DEFAULT ''), session_name (TEXT), change UNIQUE to (scope, agent, project, session_id); remove adr_candidate from the CREATE TABLE statement
- [x] 1.2 Add memory_atom table DDL (IF NOT EXISTS): id, scope, project, topic, description, content, tags, session_id, session_name, created_at, updated_at; UNIQUE(scope, project, topic)
- [x] 1.3 Add memory_atom_fts FTS5 virtual table DDL (try/catch: skip on FTS5-absent runtime): external-content, content_rowid='id', indexing topic/description/content/tags
- [x] 1.4 Add three FTS sync triggers (try/catch block alongside FTS DDL): memory_atom_ai (AFTER INSERT), memory_atom_ad (AFTER DELETE), memory_atom_au (AFTER UPDATE)
- [x] 1.5 Implement normaliseTopic(topic): lowercase, collapse spaces/underscores → hyphens, strip leading/trailing slashes; export as shared helper
- [x] 1.6 Implement rebuildHotState(db): 12-step rebuild inside a transaction (create hot_state_new, INSERT…SELECT preserving rows with session_id='', DROP, RENAME, recreate idx_hot_state_lookup); no adr_candidate in new schema
- [x] 1.7 Implement migrateHotStateToAtoms(db): for each row with non-empty last_worked_summary, upsert atom at topic 'work/migrated-summary' scoped to the row's project
- [x] 1.8 Add user_version-gated migration to ensureSchema phase 2: run rebuildHotState + migrateHotStateToAtoms + PRAGMA user_version=2 in one transaction when user_version < 2 AND session_id column is absent (shape probe)
- [x] 1.9 Implement pruneHotState(db, agent, project): DELETE all but the 5 most recent hot_state rows for the project (ordered by updated_at DESC, id DESC); export helper
- [x] 1.10 Implement atomWrite(db, {scope, project, topic, content, description, tags, sessionId, sessionName}): INSERT … ON CONFLICT(scope,project,topic) DO UPDATE; require non-empty description; report 'created' vs 'overwritten' based on pre-write existence check
- [x] 1.11 Implement atomAppend(db, {scope, project, topic, content}): BEGIN IMMEDIATE read-modify-write; error on missing topic ("Atom '<topic>' does not exist — use memory_atom_write to create it first"); append with '\n---\n'; return updated full content
- [x] 1.12 Implement atomGet(db, {scope, project, topic}): priority query (current workspace → global); alsoIn query (same topic, other workspaces); return { match, alsoIn }; normalise topic input
- [x] 1.13 Implement atomSearch(db, {scope, project, query, limit}): JOIN form FTS5 MATCH for scoped and cross-workspace variants; LIKE fallback when MATCH errors; include scope/project context in results
- [x] 1.14 Implement atomList(db, {scope, project, prefix}): current-workspace + global default; scope='all' drops scope predicate; prefix LIKE match on normalised input; return topic/description/80-char preview/scope/project/updated_at
- [x] 1.15 Implement atomDelete(db, {scope, project, topic}): delete by (scope, project, topic); return count; error if missing
- [x] 1.16 Add FTS5 integrity-check helper for use in tests: a function that runs INSERT INTO memory_atom_fts(memory_atom_fts) VALUES('integrity-check') and does not throw

## 2. CLI (src/memory.js)

- [x] 2.1 Update distil-write subcommand: upsert session row (scope, agent, project, session_id, session_name); change monotonic guard ON CONFLICT target to (scope, agent, project, session_id); call pruneHotState in the same transaction; scope signal DELETE to session_id
- [x] 2.2 Update read subcommand: add session_id param; SELECT prior scoped to session_id; SELECT recent = top-3 rows for (scope, agent, project) ordered by updated_at DESC; scope signal SELECT to session_id
- [x] 2.3 Update correct subcommand CLI signature to 'correct <agent> <project> <sessionId> <patchJson>': ON CONFLICT target becomes (scope,agent,project,session_id); upsert skeleton row (NULL/NULL/'[]') when absent; remove adr_candidate from accepted patch fields; return created/updated indicator
- [x] 2.4 Add atom-write subcommand: parse <scope> <project> <json>; call normaliseTopic on json.topic; validate description; call atomWrite; print create-vs-overwrite confirmation
- [x] 2.5 Add atom-append subcommand: parse <scope> <project> <json>; normalise topic; call atomAppend; print full updated content on success or error message on non-zero exit
- [x] 2.6 Add atom-get subcommand: parse <scope> <project> <topic>; normalise topic; call atomGet; print { match, alsoIn } as JSON to stdout
- [x] 2.7 Add atom-search subcommand: parse <scope> <project> <json>; call atomSearch; print results as JSON (when scope='all' the CLI omits scope/project predicates)
- [x] 2.8 Add atom-list subcommand: parse <scope> <project> [<prefix?>]; normalise prefix; call atomList; print results as JSON (scope='all' drops predicate)
- [x] 2.9 Add atom-delete subcommand: parse <scope> <project> <topic>; normalise topic; call atomDelete; print confirmation or error

## 3. Distil prompt (src/lib/distil-prompt.js)

- [x] 3.1 Remove adr_candidate from DISTIL_SCHEMA, parseDistilReply, and EMPTY_RECORD: distil output is 3 fields only (last_worked_summary, next_action, open_questions)
- [x] 3.2 Update signal READ query (in distil-prompt or wherever getSignals lives) to scope signal SELECT by session_id

## 4. Distiller prompt (src/prompts/distiller.md)

- [x] 4.1 Remove adr_candidate from the distiller instruction text; confirm prompt names exactly three output keys

## 5. Signal utils (src/lib/signal-utils.js)

- [x] 5.1 Add formatRelativeTime(updatedAt, now): returns 'just now' | '<N>m ago' | '<N>h ago' | 'yesterday' | '<N> days ago'
- [x] 5.2 Remove adr_candidate slot from assemblePrimer; remove teach-back block emission
- [x] 5.3 Change assemblePrimer signature to options object: { rows, projectAtoms, globalAtoms, agent, project, staleness, cap }
- [x] 5.4 Implement multi-row session threads rendering under '### Recent sessions': each row as '▸ <session_name||short_id> — <relative time>\n  Last: …\n  Next: …\n  Open questions: …'
- [x] 5.5 Implement project atom directory section: '### Project atoms — search: memory_atom_search · fetch: memory_atom_get'; no-action framing; topic/description/80-char preview/relative time per entry; overflow line when count > cap
- [x] 5.6 Implement global atom directory section: '### Global atoms'; no-action framing; same entry format; independent cap; collapse to placeholder when empty
- [x] 5.7 Implement cold-start path in assemblePrimer: when rows is empty/null, omit ### Recent sessions; inject global-only primer if globalAtoms non-empty; return null/empty string when both empty

## 6. Config (src/config.js)

- [x] 6.1 Add atomInjectCap key: resolve as positive integer; default 40; warn and fall back to 40 on invalid value; follow existing per-key type validation pattern

## 7. Plugin (src/plugin.js)

- [x] 7.1 Add sessionNames Map<sessionId, title>; populate from event.properties.info.title in the session.created handler (null when absent)
- [x] 7.2 Update session.created handler: call two atom-list spawns (workspace + global) for the atom directory; pass { rows, projectAtoms, globalAtoms, cap } to assemblePrimer; handle cold-start global-only primer path
- [x] 7.3 Remove memory_inspect, memory_correct, memory_distil_force tool registrations
- [x] 7.4 Add memory_state_inspect tool (renamed): new description "Read the current agent memory hot state for this session: recent session threads, current signals, and the loaded primer. Does not list durable atoms — use memory_atom_list for the atom directory or memory_atom_get to fetch a specific atom by topic."
- [x] 7.5 Add memory_state_patch tool (renamed): pass context.sessionID as the <sessionId> positional to the correct subcommand; remove adr_candidate from arg schema; surface created/updated indicator
- [x] 7.6 Add memory_state_distil tool (renamed from memory_distil_force): behaviour unchanged
- [x] 7.7 Add resolveScope(scope, directory) helper: workspace|undefined→{scope:'project',project:directory}; global→{scope:'global',project:''}; all→{scope:'all',project:''} (reads only)
- [x] 7.8 Add memory_atom_write tool: arg schema {topic, content, description, tags?, scope?}; call resolveScope; spawn atom-write; return confirmation
- [x] 7.9 Add memory_atom_append tool: arg schema {topic, content, scope?}; call resolveScope; spawn atom-append; return updated content or error message
- [x] 7.10 Add memory_atom_get tool: arg schema {topic, scope?}; call resolveScope; spawn atom-get; return { match, alsoIn } rendered text
- [x] 7.11 Add memory_atom_search tool: arg schema {query, limit?, scope?}; call resolveScope; spawn atom-search; return results list with project context
- [x] 7.12 Add memory_atom_list tool: arg schema {prefix?, scope?}; call resolveScope; spawn atom-list; return topic directory
- [x] 7.13 Add memory_atom_delete tool: arg schema {topic, scope?}; call resolveScope; spawn atom-delete; return confirmation
- [x] 7.14 Update doDistil: pass sessionId and session_name (from sessionNames Map) to distil-write; update inline distiller fallback to 3 keys (remove adr_candidate)
- [x] 7.15 Thread atomInjectCap from config into assemblePrimer cap parameter

## 8. Tests

- [x] 8.1 schema.js — fresh DB: assert memory_atom table columns and UNIQUE constraint; assert FTS virtual table and 3 triggers present (or absent+degraded when FTS5 unavailable)
- [x] 8.2 schema.js — normaliseTopic: unit test all three normalisation rules (uppercase, underscores, slashes)
- [x] 8.3 schema.js — atomWrite: test description-required rejection; test CREATE confirmation; test OVERWRITE confirmation; test rowid stability (ON CONFLICT DO UPDATE)
- [x] 8.4 schema.js — atomAppend: test error on missing topic; test append with '\n---\n' separator; test FTS integrity-check after append
- [x] 8.5 schema.js — atomGet: test workspace-priority resolution; test global fallback; test null-match + alsoIn when only foreign atoms exist
- [x] 8.6 schema.js — atomSearch: test all-workspaces default; test scope='workspace' restriction; test LIKE fallback (mock FTS5 failure)
- [x] 8.7 schema.js — atomList: test workspace+global default; test scope='all' includes all; test prefix filtering with normalisation
- [x] 8.8 schema.js — atomDelete: test removal + FTS integrity-check; test non-zero exit on missing topic
- [x] 8.9 schema.js — migration (populated old-schema DB): assert hot_state rows preserved with session_id=''; assert adr_candidate absent; assert user_version = 2; assert legacy summary migrated to work/migrated-summary atom
- [x] 8.10 schema.js — migration idempotency: assert no rebuild when user_version = 2; assert no rebuild when session_id column already present
- [x] 8.11 schema.js — pruneHotState: assert 6th session evicts the oldest; assert cross-project rows unaffected
- [x] 8.12 memory.js — distil-write: session-scoped row; session-scoped signal delete; keep-last-5 prune; monotonic guard per session_id
- [x] 8.13 memory.js — read: prior scoped to session_id; recent = top-3 project rows; signals scoped to session_id
- [x] 8.14 memory.js — correct: new sessionId positional; skeleton upsert on cold start; adr_candidate not accepted
- [x] 8.15 memory.js — atom-* subcommands: subprocess integration test for each (write, append, get, search, list, delete)
- [x] 8.16 distil-prompt.js — DISTIL_SCHEMA has 3 fields only; parseDistilReply ignores a 4th key; EMPTY_RECORD has no adr_candidate
- [x] 8.17 signal-utils.js — formatRelativeTime: unit tests for each time bucket (just now, Nm ago, Nh ago, yesterday, N days ago)
- [x] 8.18 signal-utils.js — assemblePrimer: multi-row session threads; atom section entry format; per-scope overflow line; no-action framing; cold-start global-only; cold-start empty returns null; no ADR or teach-back in output
- [x] 8.19 config.js — atomInjectCap: valid value used; missing defaults to 40; invalid warns and falls back to 40
- [x] 8.20 plugin.js — tool factory: assert exactly nine tools in the tool hook; assert no memory_inspect/memory_correct/memory_distil_force present
- [x] 8.21 plugin.js — session.created: sessionNames populated; cold-start global-only primer; warm-start full primer with atom directory
- [x] 8.22 plugin.js — resolveScope: unit tests for workspace/global/all mappings

## 9. Spec delta and main spec rebaseline

- [x] 9.1 Rewrite openspec/specs/signal-processing.md to match currently shipped assemblePrimer format (## Project memory — header, no ADR, no teach-back) as the baseline; confirm existing tests pass against the rebaselined spec
- [x] 9.2 Verify openspec/specs/plugin-lifecycle.md and openspec/specs/plugin-lifecycle/spec.md are consistent with the plugin-lifecycle delta spec; update if stale
