## 1. Schema layer (src/lib/schema.js)

- [x] 1.1 Add optional `createdAt` parameter to `atomWrite` signature; use it for `created_at` when provided, fall back to `Date.now()`
- [x] 1.2 Add `created_at` to the SELECT in `atomGet` (both the workspace match query and the global fallback query)
- [x] 1.3 Add `created_at` to the SELECT in `atomSearch` (both the FTS5 query builder and the LIKE fallback query builder)
- [x] 1.4 Add `created_at` to the SELECT in `atomList` (both the `scope='all'` branch and the default workspace+global branch)

## 2. CLI layer (src/memory.js)

- [x] 2.1 Destructure `createdAt` from the JSON payload in `cmdAtomWrite`; pass it through to `atomWrite`

## 3. Plugin tool layer (src/plugin.js)

- [x] 3.1 Add optional `created_at` arg to `memory_atom_write` tool schema; convert ISO string to epoch ms if needed; include `createdAt` in the CLI payload
- [x] 3.2 Update `memory_atom_get` formatter to render `created_at` and `updated_at` as relative timestamps in the output
- [x] 3.3 Update `memory_atom_search` formatter to include `created_at` and `updated_at` as relative timestamps per result line
- [x] 3.4 Update `memory_atom_list` formatter to include `created_at` and `updated_at` as relative timestamps per result line

## 4. Tests (test/schema.test.js)

- [x] 4.1 Add test: atom-write with explicit `createdAt` stores that timestamp
- [x] 4.2 Add test: atom-write without `createdAt` uses current time
- [x] 4.3 Add test: atom-get match row includes `created_at` and `updated_at`
- [x] 4.4 Add test: atom-search results include `created_at` and `updated_at`
- [x] 4.5 Add test: atom-list results include `created_at` and `updated_at`

## 5. Tests (test/plugin-safety.test.js)

- [x] 5.1 Add test: `memory_atom_write` tool passes ISO string `created_at` to CLI payload as epoch ms
- [x] 5.2 Add test: `memory_atom_write` tool passes numeric `created_at` to CLI payload unchanged
