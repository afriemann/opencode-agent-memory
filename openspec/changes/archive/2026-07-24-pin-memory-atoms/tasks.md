## 1. Schema — pinned column

- [ ] 1.1 Add `pinned INTEGER NOT NULL DEFAULT 0` to the Phase 1 baseline `CREATE TABLE IF NOT EXISTS memory_atom` in `src/lib/schema.js`
- [ ] 1.2 Add the v3 migration block (guarded by `PRAGMA user_version < 3` + `PRAGMA table_info` column-existence probe): run `ALTER TABLE memory_atom ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`, then stamp `PRAGMA user_version = 3` — mirrors the v2 idempotency pattern
- [ ] 1.3 Verify that a fresh database and a migrated v2 database both produce identical `pinned` column (same type, default, NOT NULL) via `PRAGMA table_info(memory_atom)`

## 2. Core write/patch/list queries

- [ ] 2.1 Update `atomWrite` in `src/lib/schema.js`: add `pinned` to the INSERT column list (with the caller's value, default `0`); ensure `pinned` is **absent** from the `ON CONFLICT … DO UPDATE SET` clause so existing pin state is preserved on re-write
- [ ] 2.2 Update `atomPatch` in `src/lib/schema.js`: add `'pinned'` to the `PATCHABLE` set; coerce the value to `0`/`1`; include `pinned` in the `updated_at` bump condition (alongside `description` and `tags`)
- [ ] 2.3 Update `atomList` SELECT in `src/lib/schema.js`: add `pinned` to the explicit column list in both the `scope='all'` and default branches

## 3. Primer render — assemblePrimer

- [ ] 3.1 Update `assemblePrimer` in `src/lib/signal-utils.js`: partition each atom array into `pinned` (where `pinned === 1` or `pinned === true`) and `nonPinned`; sort each group by `topic`; render pinned entries first (no cap) then non-pinned entries (capped at `cap`); exclude pinned atoms from the capped non-pinned slice
- [ ] 3.2 Prefix each pinned atom entry with `[pinned]` in the rendered output line
- [ ] 3.3 Derive the `+N more` overflow count and the overflow message from the non-pinned set only (not the combined total)

## 4. CLI — memory.js

- [ ] 4.1 Update the `atom-write` CLI command in `src/memory.js`: accept an optional `--pinned` / `pinned` field from the JSON argument and forward it to `atomWrite`
- [ ] 4.2 Update the `atom-patch` CLI command in `src/memory.js`: accept `pinned` in the JSON patch argument and forward it to `atomPatch`
- [ ] 4.3 Update the `atom-list` CLI output formatter in `src/memory.js`: prefix each pinned atom entry with `[pinned]`

## 5. Plugin tools — plugin.js

- [ ] 5.1 Update `memory_atom_write` tool input schema: add optional `pinned: boolean` (default `false`); forward it to the CLI payload; update the tool description to state that `pinned` is applied only on INSERT and that `memory_atom_patch` must be used to change pin state after creation
- [ ] 5.2 Update `memory_atom_patch` tool input schema: add optional `pinned: boolean` to the `patch` sub-object; include `pinned` in the presence check that gates the CLI call; forward it to the CLI patch payload
- [ ] 5.3 Update `memory_atom_list` tool output formatter: ensure the `[pinned]` marker from the CLI output is passed through to the returned text result

## 6. Tests

- [ ] 6.1 Add schema convergence tests: fresh-DB has `pinned` column; v2-migration adds `pinned` column with `pinned = 0` on all existing rows; `PRAGMA user_version` is 3 after migration; v3 migration is idempotent (no error on re-run)
- [ ] 6.2 Add `atomWrite` INSERT-only-pin tests: new atom with `pinned: true` is stored with `pinned = 1`; new atom without `pinned` stores `pinned = 0`; re-write of pinned atom without `pinned` preserves `pinned = 1`
- [ ] 6.3 Add `atomPatch` pin tests: `pinned: true` pins atom and bumps `updated_at`; `pinned: false` unpins and bumps `updated_at`; omitting `pinned` leaves existing value unchanged
- [ ] 6.4 Add `atomList` tests: result rows include `pinned` field; pinned atom entry is prefixed with `[pinned]`; unpinned atom entry has no such prefix
- [ ] 6.5 Add `assemblePrimer` partition tests: pinned atoms appear before non-pinned; pinned atoms are marked `[pinned]`; pinned atoms not counted against cap (5 pinned + 42 non-pinned → 5 pinned + 40 non-pinned listed + `(+2 more…)`); no atom appears twice; pinned group ordered by topic
- [ ] 6.6 Add plugin tool tests: `memory_atom_write` passes `pinned` to CLI and preserves pin on re-write; `memory_atom_patch` accepts `pinned: true/false` and returns updated confirmation; `memory_atom_list` output includes `[pinned]` for pinned atoms
- [ ] 6.7 Run the full test suite and confirm all existing and new tests pass

## 7. Verification

- [ ] 7.1 Run `openspec validate pin-memory-atoms` and confirm no structural errors
