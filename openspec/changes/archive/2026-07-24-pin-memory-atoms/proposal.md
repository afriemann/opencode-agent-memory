## Why

The session primer's atom directory lists atoms ordered alphabetically by topic and caps each scope at 40 entries. Atoms whose topic names sort late in the alphabet, or projects that accumulate more than 40 atoms, risk critical context being silently dropped from the primer. There is no way to guarantee a specific atom appears in every session regardless of topic name or corpus size.

## What Changes

- Add a `pinned` boolean field to `memory_atom` (stored as `INTEGER NOT NULL DEFAULT 0`), with a schema migration to v3. The baseline `CREATE TABLE` and the migration ALTER must converge so fresh and existing databases produce identical schemas.
- `memory_atom_write` accepts an optional `pinned: boolean` parameter applied only on INSERT; existing `pinned` state is preserved on conflict (upsert does not reset `pinned` to the default when the parameter is absent — use `memory_atom_patch` to change pin state after creation).
- `memory_atom_patch` accepts `pinned` in its `patch` sub-object, allowing pin/unpin at any time.
- `memory_atom_list` output marks pinned atoms with a `[pinned]` indicator in their one-line entry; the underlying `atom-list` SELECT must include the `pinned` column so the display layer can render the indicator. `atom-get` and `atom-search` are out of scope for this indicator.
- `assemblePrimer` renders each scope section with pinned atoms first (ordered by topic, no cap), followed by regular atoms (ordered by topic, capped at 40 as today). Pinned atoms are excluded from the regular capped list so each atom appears exactly once per section.
- No pin limit is enforced — keeping the pinned set small is operator responsibility.

## Capabilities

### New Capabilities

_(none — all changes are extensions to existing capabilities)_

### Modified Capabilities

- `memory-atom`: `memory_atom` table schema gains a `pinned` column; `atom-write` and `atom-patch` commands accept and persist `pinned`; `atom-list` output includes `[pinned]` indicator; `atom-list` SELECT gains the `pinned` column.
- `memory-atom-tools`: `memory_atom_write` and `memory_atom_patch` plugin tools accept `pinned` as an optional field.
- `signal-processing`: `assemblePrimer` renders pinned atoms ahead of the regular capped list in each scope section; pinned atoms excluded from the capped remainder.

## Impact

- **Database**: schema version bumps 2 → 3; baseline `CREATE TABLE` and `ALTER TABLE ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0` migration added; migration guarded by `user_version < 3` + column-existence probe (mirrors v2 idempotency pattern).
- **`src/lib/schema.js`**: baseline CREATE TABLE updated; migration added; `atomWrite` (INSERT-only for `pinned`), `atomPatch`, `atomList` queries updated.
- **`src/lib/signal-utils.js`**: `assemblePrimer` updated to split and render pinned/regular atom sections; pinned atoms ordered by topic, not capped; regular atoms exclude pinned, capped at 40.
- **`src/memory.js`**: CLI `atom-write` and `atom-patch` commands updated to accept `--pinned` flag; `atom-list` output updated.
- **`src/plugin.js`**: `memory_atom_write` and `memory_atom_patch` tool descriptions and input schemas updated.
- **`test/`**: schema, plugin-safety, and signal-utils tests updated; new scenarios for pinned behaviour added.
- No breaking changes to existing callers — `pinned` defaults to `false` everywhere; existing atoms are unpinned by default after migration.
