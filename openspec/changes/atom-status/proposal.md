## Why

Memory atoms accumulate over time and some become stale, superseded, or no longer relevant — but deleting them loses their history. A `status` field lets agents mark atoms as `resolved` or `deprecated` so they are filtered from routine surfaces while remaining retrievable when explicitly needed.

The three-tier visibility model:

| status | primer | list/search default | atom-get |
|---|---|---|---|
| active | ✓ | ✓ | ✓ |
| resolved | ✗ | ✓ | ✓ |
| deprecated | ✗ | ✗ | ✓ |

`resolved`: work described is done but the record retains historical value; still appears in routine list/search.
`deprecated`: atom is stale, replaced, or should not surface in normal use; hidden from list/search by default but retrievable explicitly.

## What Changes

- A `status` column (`active` | `resolved` | `deprecated`, default `active`) is added to the `memory_atom` table (schema v4)
- `atom-write` always creates atoms as `active`; `status` is absent from both the INSERT column list (relying on `DEFAULT`) and the `ON CONFLICT DO UPDATE SET` (status is preserved on content re-write — never silently reset)
- `atom-patch` gains `status` as a patchable field; validates against the enum at both the DB level (CHECK constraint) and the tool/CLI layer; bumps `updated_at`
- `atom-list` default: `status IN ('active', 'resolved')`; opt-in flag to include deprecated; optional exact-match filter (any of the three values)
- `atom-search` default: same as `atom-list`; same flags
- `atom-get` always returns regardless of status (no status-constraint param — point lookup semantics are preserved); always shows `status:` in its output
- `assemblePrimer` filters to `status = 'active'` only — `resolved` and `deprecated` atoms are excluded from the session primer regardless of their `pinned` flag (pin and status are independent; a pinned-but-resolved atom does not appear in the primer)
- Plugin tools: `memory_atom_patch.patch` gains `status`; `memory_atom_list` and `memory_atom_search` gain optional `status` (exact-match) and `includeDeprecated: boolean` params; all three tool output formatters show `status` in their output lines
- `MEMORY_PROTOCOL` updated to name the three status values, their visibility semantics, and to teach agents to prefer `status=deprecated`/`status=resolved` over `memory_atom_delete` for lifecycle management

## Capabilities

### New Capabilities

*(none — this change extends existing capabilities only)*

### Modified Capabilities

- `memory-atom`: table schema adds `status` column; `atom-write` INSERT-only (DEFAULT-driven, no explicit column); `atom-patch` gains `status`; `atom-list`, `atom-search` gain status-based filtering; `atom-get` always returns but shows `status:` in output
- `memory-atom-tools`: `memory_atom_write` description updated (status always active, preserved on re-write); `memory_atom_patch` gains `status`; `memory_atom_list` and `memory_atom_search` gain `status` and `includeDeprecated` params; `memory_atom_get` output shows `status:`; `MEMORY_PROTOCOL` updated
- `signal-processing`: `assemblePrimer` filters incoming atoms to `status = 'active'`

## Impact

- `src/lib/schema.js` — baseline `CREATE TABLE` + v4 migration; `atomWrite` (no status column), `atomPatch` (status), `atomList` (filter + SELECT), `atomSearch` (filter + SELECT), `atomGet` (SELECT includes status)
- `src/lib/signal-utils.js` — `assemblePrimer` active-only filter
- `src/memory.js` — CLI `atom-list`, `atom-search`, `atom-get`, `atom-patch` commands updated; argument-passing mechanism for new filters (positional/JSON TBD in design)
- `src/plugin.js` — `memory_atom_patch`, `memory_atom_list`, `memory_atom_search`, `memory_atom_get` tool schemas, descriptions, output formatters; `MEMORY_PROTOCOL`
- `test/` — schema convergence, write/patch/list/search/get/primer scenarios
