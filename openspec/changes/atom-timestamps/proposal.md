## Why

When migrating memories from external sources (e.g. Serena), the agent has no way to preserve the original creation date — every atom gets the migration timestamp instead. Additionally, listing or fetching atoms returns no timestamp information, making it impossible for the agent to reason about how fresh or stale a memory is.

## What Changes

- `atomWrite` (schema layer) accepts an optional `createdAt` parameter (epoch ms) so callers can supply a custom creation timestamp instead of `Date.now()`.
- The CLI atom-write command passes `createdAt` through from the JSON payload.
- The `memory_atom_write` plugin tool exposes an optional `created_at` argument (ISO 8601 string or epoch ms integer).
- `atomGet`, `atomSearch`, and `atomList` include `created_at` in their query results.
- The `memory_atom_get`, `memory_atom_search`, and `memory_atom_list` plugin tool formatters render both `created_at` and `updated_at` as human-readable relative timestamps.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `memory-atom`: atom-write now accepts an optional caller-supplied creation timestamp; atom-get, atom-search, and atom-list return `created_at` alongside `updated_at`.
- `memory-atom-tools`: `memory_atom_write` tool exposes an optional `created_at` argument; `memory_atom_get`, `memory_atom_search`, and `memory_atom_list` tool outputs include both creation and update timestamps.

## Impact

- `src/lib/schema.js` — `atomWrite`, `atomGet`, `atomSearch`, `atomList`
- `src/memory.js` — `cmdAtomWrite`
- `src/plugin.js` — `memory_atom_write`, `memory_atom_get`, `memory_atom_search`, `memory_atom_list` tools
- `test/schema.test.js` — new cases for custom `createdAt` and date presence in results
- `test/plugin-safety.test.js` — new case for `memory_atom_write` passing `created_at` through
- No schema migration required: `created_at` column already exists in `memory_atom`.
- No breaking changes: `createdAt` is optional; existing calls without it are unaffected.
