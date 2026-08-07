## 1. Schema — v6 migration and always_include column

- [ ] 1.1 Add `always_include INTEGER NOT NULL DEFAULT 0` to the Phase 1 `CREATE TABLE IF NOT EXISTS memory_atom` baseline in `src/lib/schema.js`
- [ ] 1.2 Add v6 migration block: gate on `PRAGMA user_version < 6`, probe `PRAGMA table_info(memory_atom)` for absence of `always_include`, run `ALTER TABLE memory_atom ADD COLUMN always_include INTEGER NOT NULL DEFAULT 0`, stamp `PRAGMA user_version = 6`
- [ ] 1.3 Verify fresh-install and migrated DBs produce identical schema (both paths carry `always_include`; FTS triggers untouched)

## 2. atomWrite — INSERT-only flag

- [ ] 2.1 Add `always_include` to the `atomWrite` INSERT column list (default `0`)
- [ ] 2.2 Confirm `always_include` is absent from the `ON CONFLICT DO UPDATE SET` clause so re-writes preserve the existing flag

## 3. atomPatch — patchable flag

- [ ] 3.1 Add `always_include` to the `PATCHABLE` set in `atomPatch` in `src/lib/schema.js`
- [ ] 3.2 Coerce the value to `0`/`1` and distinguish explicit `false` from omitted using the existing `'always_include' in patch` machinery
- [ ] 3.3 Ensure `updated_at` is bumped when `always_include` changes

## 4. atomList — flag column (no full content)

- [ ] 4.1 Add `always_include` to the explicit SELECT column list in both branches of `atomList` in `src/lib/schema.js`
- [ ] 4.2 Confirm full content is not returned for flagged atoms (summary contract preserved)

## 5. atomListFull — new query helper

- [ ] 5.1 Add `atomListFull(db, scope, project)` to `src/lib/schema.js` returning `scope, project, topic, description, content, updated_at` for `always_include = 1 AND status = 'active'` atoms in the current workspace + global scope, ordered `updated_at DESC, topic`, no LIMIT

## 6. CLI plumbing — memory.js

- [ ] 6.1 Add `atom-list-full <scope> <project>` subcommand to `src/memory.js` that calls `atomListFull` and prints JSON
- [ ] 6.2 Forward `always_include` from CLI args to `atomWrite` in `cmdAtomWrite`
- [ ] 6.3 Accept `always_include` in the patch object in `cmdAtomPatch` and pass it through to `atomPatch`
- [ ] 6.4 Confirm `atom-list` output carries the `always_include` flag through to stdout

## 7. Primer rendering — signal-utils.js

- [ ] 7.1 Add `MAX_STANDING_ATOMS = 5` constant to `src/lib/signal-utils.js`
- [ ] 7.2 Add `standingAtoms` parameter to `assemblePrimer` options object
- [ ] 7.3 Implement filter: remove `always_include = 1` atoms from `projectAtoms` / `globalAtoms` before the compact directory partition (they must not appear in `### Project atoms` or `### Global atoms`)
- [ ] 7.4 Partition `standingAtoms` by scope (workspace vs global)
- [ ] 7.5 Per scope: select top 5 by `updated_at DESC`, render alphabetically by topic as `#### topic [time]` / `*"desc"*` / full content blocks
- [ ] 7.6 Per scope: if more than 5, emit overflow note naming excess topics alphabetically: `(+N more standing atoms exceed the 5-per-scope cap — fetch with memory_atom_get: topic1, topic2, …)`
- [ ] 7.7 Render workspace blocks before global blocks; render `### Standing context` heading + intro line only when at least one flagged active atom exists; omit the section when empty
- [ ] 7.8 Update the `return null` guard to also account for `standingAtoms` (return null only when rows, projectAtoms, globalAtoms, and standingAtoms are all empty/absent)

## 8. Injector — plugin.js

- [ ] 8.1 Add `atom-list-full` spawn to `loadMemoryForSession` in `src/plugin.js`, using the same try/catch degradation pattern as the existing `atom-list` calls
- [ ] 8.2 Pass the result as `standingAtoms` to `assemblePrimer`

## 9. Plugin tool schemas and MEMORY_PROTOCOL — plugin.js

- [ ] 9.1 Add optional `always_include: boolean` argument to `memory_atom_write` tool definition with INSERT-only caveat in the description
- [ ] 9.2 Add optional `always_include: boolean` to the `patch` sub-object of `memory_atom_patch` tool definition
- [ ] 9.3 Update `MEMORY_PROTOCOL` constant with `always_include` guidance from the proposal draft (when to use, toggle command, 5-per-scope cap, misuse warning, distinction from `pinned`)

## 10. Tests

- [ ] 10.1 Schema: test v5→v6 migration produces `always_include` column with all existing rows = 0
- [ ] 10.2 Schema: test fresh DB includes `always_include` column
- [ ] 10.3 Schema: test v6 migration is idempotent (re-run does not error)
- [ ] 10.4 atomWrite: test INSERT-only — flag is preserved on re-write even when caller passes a different value
- [ ] 10.5 atomWrite: test default value is 0 when `always_include` omitted
- [ ] 10.6 atomPatch: test set to true, clear to false, and omit-leaves-unchanged
- [ ] 10.7 atomList: test output includes `always_include` flag (0 and 1) but not full content
- [ ] 10.8 atomListFull: test returns full content for workspace + global flagged active atoms; excludes resolved/deprecated; excludes non-flagged
- [ ] 10.9 assemblePrimer: test flagged atom appears in Standing context as full block, not in compact directory
- [ ] 10.10 assemblePrimer: test pinned+flagged atom renders only in Standing context (no double-render in pinned directory)
- [ ] 10.11 assemblePrimer: test cap — 7 flagged workspace atoms → 5 full blocks + overflow note naming 2 topics
- [ ] 10.12 assemblePrimer: test render order — 3 flagged atoms render alphabetically by topic
- [ ] 10.13 assemblePrimer: test workspace and global caps are independent (6+6 → 5+5 + two overflow notes)
- [ ] 10.14 assemblePrimer: test Standing context omitted when no flagged atoms
- [ ] 10.15 assemblePrimer: test all-atoms-flagged still produces non-null primer
- [ ] 10.16 assemblePrimer: test 40-cap unaffected by flagged atoms (flagged atoms excluded from cap count)
- [ ] 10.17 plugin.js: test `memory_atom_write` tool definition includes `always_include` argument; test `memory_atom_patch` patch includes `always_include`
