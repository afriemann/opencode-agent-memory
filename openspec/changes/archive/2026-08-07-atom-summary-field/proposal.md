## Why

The atom directory listing (primer, `memory_atom_list`) shows agents a `description` (what an atom is for) and a raw 80-character truncation of the atom's content. That truncation is noisy — it typically renders the start of a Markdown heading — and gives agents no useful signal for deciding whether to fetch the full atom. A manually-authored `summary` lets the writing agent record a one-sentence digest of what the content contains, making the listing actionable without a fetch.

## What Changes

- Add a `summary TEXT NOT NULL DEFAULT ''` column to the `memory_atom` table via a v7 schema migration (simple `ALTER TABLE ADD COLUMN` — `summary` is NOT FTS-indexed to avoid a drop/recreate/rebuild of the FTS virtual table and its three sync triggers).
- **BREAKING**: `memory_atom_write` tool: `summary` is now a required, non-empty argument (max 280 chars). Agents must provide a one-sentence digest of the atom's content; it is distinct from `description` (which says what the atom is *for*).
- `memory_atom_patch` tool: accept `summary` as a patchable field (non-empty, max 280 chars) so agents can retroactively add summaries to older atoms.
- `atom-write` CLI: accept optional `summary` in the JSON payload; validate non-empty and ≤ 280 chars when present. Enforcement lives in the `atomWrite` / `atomPatch` helper functions (mirroring the `description` non-empty check pattern).
- `atom-patch` CLI: accept `summary` in the patch object with the same validation.
- `atom-list`, `atom-get`, `atom-search` CLI: include `summary` in result rows.
- Listing formatter (plugin.js primer lines, signal-utils.js `renderAtomLine`, `memory_atom_list` / `memory_atom_search` / `memory_atom_get` formatters): display `summary` when non-empty; fall back silently to the existing 80-char `preview` truncation for atoms that pre-date this field or have not yet been patched. The `| ` separator is omitted when both are empty.
- `atom-write` upsert semantics: `summary` is included in the `ON CONFLICT DO UPDATE SET` clause (like `description`) so that re-writing an atom updates its summary. Tool-layer enforces non-empty on every call.
- MEMORY_PROTOCOL: document `summary` (content digest, required on write, patchable, max 280 chars, shown in listings, distinct from `description`, may become stale after `atom-append`).

## Capabilities

### New Capabilities

*(none — all changes are modifications to existing capabilities)*

### Modified Capabilities

- `memory-atom`: v7 schema migration (add `summary` column); `atom-write`, `atom-get`, `atom-list`, `atom-patch`, `atom-search` updated to carry `summary`; listing display updated with `summary`-then-preview fallback.
- `memory-atom-tools`: `memory_atom_write` requires non-empty `summary`; `memory_atom_patch` accepts `summary`; `memory_atom_list`, `memory_atom_get`, `memory_atom_search` show `summary` in output; MEMORY_PROTOCOL updated.

## Impact

- **`src/lib/schema.js`**: `ensureSchema` (v7 migration, baseline CREATE TABLE), `atomWrite` (INSERT + DO UPDATE SET, non-empty validation), `atomList` (SELECT includes `summary`), `atomSearch` (SELECT includes `summary`), `atomGet` (SELECT includes `summary`), `atomPatch` (PATCHABLE array, validation).
- **`src/memory.js`**: `cmdAtomPatch` (extract `summary` from patch data); CLI `atom-write` comment.
- **`src/plugin.js`**: `memory_atom_write`, `memory_atom_patch` tool definitions; primer/listing formatters (3 sites); `MEMORY_PROTOCOL` constant.
- **`src/lib/signal-utils.js`**: `renderAtomLine` — switch from `atom.preview` to `atom.summary || atom.preview`; remove truncation/backtick-fix logic from the summary branch (author-controlled, already ≤ 280 chars).
- **Tests** (`test/`): schema migration tests, CRUD tests, and tool integration tests updated.
- No new dependencies.
- **BREAKING**: `memory_atom_write` now requires a non-empty `summary` argument. Existing callers without `summary` will fail Zod validation.
