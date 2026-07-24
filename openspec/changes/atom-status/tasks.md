## 1. Schema: status column (v4 migration + fresh-DB baseline)

- [x] 1.1 Add `status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','resolved','deprecated'))` to the baseline `CREATE TABLE IF NOT EXISTS memory_atom` in `ensureSchema` Phase 1 (`src/lib/schema.js`)
- [x] 1.2 Append v4 migration block after the v3 block: `PRAGMA user_version < 4` gate → `PRAGMA table_info` `status`-column shape probe → `BEGIN` / `ALTER TABLE memory_atom ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','resolved','deprecated'))` / `PRAGMA user_version = 4` / `COMMIT`, with `ROLLBACK` on error; idempotent branch stamps `user_version = 4` when column already present
- [x] 1.3 Add `status` to the SELECT lists in `atomList`, `atomSearch`, and `atomGet` (`src/lib/schema.js`)

## 2. Core queries: atomWrite, atomPatch, atomList, atomSearch, atomGet

- [x] 2.1 Confirm `atomWrite` does NOT add `status` to the INSERT column list or the `ON CONFLICT DO UPDATE SET` (column DEFAULT handles new rows; re-writes preserve status silently) — no code change expected, verify and add test
- [x] 2.2 Add `'status'` to the `PATCHABLE` allowlist in `atomPatch`; add `if ('status' in patch)` guard with enum validation (`['active','resolved','deprecated'].includes(v)` — reject with a clear error otherwise); include `'status'` in the `bumpUpdatedAt` condition (`src/lib/schema.js`)
- [x] 2.3 Add status filter logic to `atomList`: accept `{ status?, includeDeprecated? }` options; default `WHERE status IN ('active','resolved')`; `status` present → `WHERE status = ?`; `includeDeprecated` truthy → no predicate (`src/lib/schema.js`)
- [x] 2.4 Add identical status filter logic to `atomSearch` (within the FTS join and the LIKE fallback) (`src/lib/schema.js`)
- [x] 2.5 Confirm `atomGet` applies no status predicate — returns match regardless of status; verify `alsoIn` query also includes `status` in its SELECT

## 3. Primer: assemblePrimer active-only filter

- [x] 3.1 In `assemblePrimer` (`src/lib/signal-utils.js`), filter `projectAtoms` and `globalAtoms` to `status === 'active'` before the existing pinned/non-pinned partition (add after incoming arrays are received, before any `filter`/`slice` call)

## 4. CLI dispatch: memory.js

- [x] 4.1 Update `atom-list` dispatch in `src/memory.js` to read an optional 4th positional JSON blob (`filtersJson`); parse `{ status, includeDeprecated }` and forward to `atomList` options
- [x] 4.2 Update `atom-search` dispatch to accept `status` and `includeDeprecated` fields in the existing search JSON blob and forward to `atomSearch` options; add enum validation at parse
- [x] 4.3 Update `atom-patch` dispatch to pass `status` from the patch JSON blob to `atomPatch`
- [x] 4.4 Add enum validation for `status` at the CLI parse layer in `atom-patch` (reject with non-zero exit + stderr message for invalid values)

## 5. Plugin: tool schemas, output formatters, MEMORY_PROTOCOL

- [x] 5.1 Add `status: z.enum(['active','resolved','deprecated']).optional()` and `includeDeprecated: z.boolean().optional()` to `memory_atom_list` tool schema; forward both to CLI as filters JSON blob; update tool description to state default excludes deprecated (`src/plugin.js`)
- [x] 5.2 Update `memory_atom_list` output formatter to prefix non-active atom entries with `[resolved]` or `[deprecated]` as appropriate (`src/plugin.js`)
- [x] 5.3 Add `status: z.enum(['active','resolved','deprecated']).optional()` and `includeDeprecated: z.boolean().optional()` to `memory_atom_search` tool schema; forward to search JSON blob; update tool description (`src/plugin.js`)
- [x] 5.4 Update `memory_atom_search` output formatter to show `status` in result lines (`src/plugin.js`)
- [x] 5.5 Add `status: z.enum(['active','resolved','deprecated']).optional()` to `memory_atom_patch.patch` sub-object Zod schema; forward to CLI; update tool description to name all five patchable fields and describe `resolved`/`deprecated` semantics (`src/plugin.js`)
- [x] 5.6 Update `memory_atom_get` output formatter to show `status:` in the match section and label non-active `alsoIn` entries with their status (`src/plugin.js`)
- [x] 5.7 Update `memory_atom_write` tool description to state: "status is always `active` at creation and is preserved on content re-write — use `memory_atom_patch` to change status" (`src/plugin.js`)
- [x] 5.8 Add lifecycle block to `MEMORY_PROTOCOL` constant: name the three status values and their visibility semantics, state to prefer `memory_atom_patch` with `status='deprecated'`/`status='resolved'` over `memory_atom_delete`, note that `atom-list`/`atom-search` exclude deprecated by default (`src/plugin.js`)

## 6. Tests

- [x] 6.1 Schema convergence test: assert fresh DB and v3-DB-after-migration both have identical `status` column (type, default, CHECK); assert `PRAGMA user_version` = 4; assert v4 migration is idempotent (`test/schema.test.js`)
- [x] 6.2 `atomWrite` status-preservation test: new atom has `status='active'`; re-write of resolved atom keeps `status='resolved'`; re-write of deprecated atom keeps `status='deprecated'` (`test/schema.test.js`)
- [x] 6.3 `atomPatch` status tests: patch to resolved bumps `updated_at`; patch to deprecated succeeds; invalid value rejected with clear error; omitting status leaves it unchanged (`test/schema.test.js`)
- [x] 6.4 `atomList` filtering tests: default excludes deprecated; `includeDeprecated:true` returns all; `status:'active'` exact-match; `status` takes precedence over `includeDeprecated`; result rows include `status` field (`test/schema.test.js`)
- [x] 6.5 `atomSearch` filtering tests: same four scenarios as list plus LIKE-fallback path (`test/schema.test.js`)
- [x] 6.6 `atomGet` status test: returns deprecated atom; match row includes `status`; `alsoIn` includes and labels deprecated foreign atom (`test/schema.test.js`)
- [x] 6.7 `assemblePrimer` active-only filter tests: resolved atom excluded; deprecated atom excluded; pinned-but-resolved excluded (active-only precedes pin partition); mixed active+resolved set shows only active atoms (`test/signal-utils.test.js`)
- [x] 6.8 Plugin tool tests: `memory_atom_patch` with valid `status`; rejection of invalid `status` before CLI; `memory_atom_list` `includeDeprecated` forwarded; `memory_atom_search` status filter forwarded; `memory_atom_get` output includes status; `memory_atom_write` description includes status note (`test/plugin-safety.test.js`)
- [x] 6.9 MEMORY_PROTOCOL test: constant text contains the three status values and the preference for patch-status over delete (`test/plugin-safety.test.js`)

## 7. Verify

- [x] 7.1 Run `openspec validate atom-status` to confirm structural completeness
- [x] 7.2 Run full test suite (`npm test`) — all tests pass, no suppressions
