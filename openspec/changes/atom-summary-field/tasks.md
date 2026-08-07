## 1. Schema — Baseline and Migration

- [x] 1.1 Add `summary TEXT NOT NULL DEFAULT ''` to the `CREATE TABLE memory_atom` baseline in `src/lib/schema.js`
- [x] 1.2 Add v7 migration block to `ensureSchema`: gate on `PRAGMA user_version < 7`, probe `PRAGMA table_info(memory_atom)` for absence of `summary`, `ALTER TABLE memory_atom ADD COLUMN summary TEXT NOT NULL DEFAULT ''` in a transaction that stamps `PRAGMA user_version = 7`; skip `ALTER TABLE` if column already present (shape-probe guards against duplicate-column error)

## 2. Write and Patch Helpers

- [x] 2.1 Add `summary` to the `atomWrite` function signature and JSDoc; include it in the INSERT column list and in the `ON CONFLICT DO UPDATE SET` clause (like `description`); validate non-empty and ≤ 280 chars when the caller supplies it (throw with a descriptive message on violation, matching the `description` check pattern)
- [x] 2.2 Add `summary` to the `PATCHABLE` array in `atomPatch`; add the validation block (non-empty, ≤ 280 chars); add `SET summary = ?` to the dynamic clause builder; ensure patching `summary` bumps `updated_at`
- [x] 2.3 Update the `atomPatch` JSDoc and the error message ("at least one of …") to include `summary`

## 3. Read Queries

- [x] 3.1 Add `summary` to the `SELECT` list in both `atomList` queries (`scope='all'` and default); keep `substr(content, 1, 80) AS preview` in the `SELECT` list (used as a display fallback)
- [x] 3.2 Add `summary` to the `SELECT` list in the `atomGet` `alsoIn` query (alongside the existing `substr(content, 1, 80) AS preview`)
- [x] 3.3 Add `summary` to the `SELECT` list in both FTS and LIKE branches of `atomSearch` (alongside `substr(content, 1, 80) AS preview`)

## 4. CLI Layer

- [x] 4.1 Add `summary` to the `cmdAtomPatch` JSON destructuring in `src/memory.js` and include it in the `patch` object passed to `atomPatch` (guarded by `'summary' in data`)
- [x] 4.2 Update the CLI comment block at the top of `src/memory.js` for `atom-write` to add `summary?` to the JSON payload shape

## 5. Display — Fallback Logic

- [x] 5.1 Update `renderAtomLine` in `src/lib/signal-utils.js`: switch the content source to `atom.summary || atom.preview`; when using `summary` (non-empty), use it verbatim (no truncation to 80, no backtick-repair); when falling back to `preview`, retain the existing truncation and backtick-repair logic; omit the `— …` content segment entirely when both are empty
- [x] 5.2 Update the primer `memory_atom_list` formatter in `src/plugin.js` (the `atom-list` result lines, ~line 958): change `r.preview || ''` to `r.summary || r.preview || ''`; omit the `| ` separator when the resolved value is empty
- [x] 5.3 Update the `memory_atom_search` formatter in `src/plugin.js` (~line 890): same `r.summary || r.preview || ''` fallback with separator guard
- [x] 5.4 Update the `memory_atom_get` `alsoIn` formatter in `src/plugin.js` (~line 835): same `a.summary || a.preview || ''` fallback with separator guard
- [x] 5.5 Update the `renderAtomLine` JSDoc to document `summary` instead of `preview` as the primary field

## 6. Plugin Tool Contract

- [x] 6.1 Add `summary` as a **required** Zod arg to `memory_atom_write` in `src/plugin.js`: `tool.schema.string().min(1).describe('One-sentence digest of what this atom\'s content contains. Shown in directory listings so agents can triage without fetching. Max 280 chars. Distinct from `description` (which says what the atom is for).')` — no `.optional()`
- [x] 6.2 Thread `summary` through the `memory_atom_write` `execute` function: add to the `spawnMemory` JSON payload
- [x] 6.3 Add `summary` to the `memory_atom_patch` `patch` sub-object Zod schema in `src/plugin.js`: optional string, describe as "Replacement one-sentence digest of the atom's content. Max 280 chars. Use to retroactively add or correct a summary without rewriting the full content."; thread through the `patchPayload` construction
- [x] 6.4 Update `memory_atom_patch` tool description string to enumerate `summary` alongside the other patchable fields

## 7. MEMORY_PROTOCOL

- [x] 7.1 Add a `summary` callout to `MEMORY_PROTOCOL` in `src/plugin.js`: required on `memory_atom_write`, one-sentence content digest distinct from `description`, appears in listings, max 280 chars, retroactively addable via `memory_atom_patch`, may become stale after `memory_atom_append`
- [x] 7.2 Update the "Update atom metadata" bullet in `MEMORY_PROTOCOL` to include `summary` in the list of patchable fields and add "or adding a summary to an older atom" as a use-case example

## 8. Tests

- [x] 8.1 Write migration tests: v6→v7 (existing DB gains `summary` column with `''` default; FTS unchanged), fresh install at v7 (baseline CREATE TABLE includes `summary`), v7 re-run is a no-op
- [x] 8.2 Write `atomWrite` tests: valid summary stored; no summary → stored as `''`; empty summary rejected; 281-char summary rejected; re-write updates summary
- [x] 8.3 Write `atomPatch` tests: patch sets summary; patch rejects empty summary; patch rejects over-length summary; omitted summary leaves it unchanged; patching summary bumps `updated_at`
- [x] 8.4 Write read-query tests: `atomList` rows include `summary` and `preview`; `atomGet` `alsoIn` rows include `summary` and `preview`; `atomSearch` rows include `summary` and `preview`
- [x] 8.5 Write display-fallback tests: listing shows summary when non-empty; listing falls back to preview when summary empty; listing omits content segment when both empty
