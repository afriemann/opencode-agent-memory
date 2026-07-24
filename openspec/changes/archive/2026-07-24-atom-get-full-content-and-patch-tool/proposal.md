## Why

Agents working across multiple workspaces see only an 80-char preview for atoms that live in a non-current workspace: `memory_atom_get` surfaces those as `alsoIn` entries rather than a primary match. Once an agent identifies the workspace containing the atom they need (from the `alsoIn` listing), there is no way to fetch its full content — or update its metadata — without opening a new session from that directory. Separately, there is no way to update atom metadata (`description`, `tags`, `created_at`) without a full content rewrite via `memory_atom_write`, making tasks like re-dating migrated atoms fragile.

## What Changes

### `memory_atom_get` — add optional `workspace` parameter

When `workspace` (a project directory path) is provided, the tool resolves scope against that directory directly instead of `context.directory`. The targeted atom is returned as `result.match` with full content — the same code path used for current-workspace atoms. Default behaviour (no `workspace`) is unchanged: current workspace → global fallback, with `alsoIn` preview-only listing for other workspaces.

The `alsoIn` formatted-output line is restructured so the path is unambiguously extractable:
- **Before:** `• project//home/user/repo: topic — desc | preview [created…]`
- **After:** `• [workspace: /home/user/repo] topic — desc | preview [created…]`

**Tool description draft (updated section):**
> "Fetch a memory atom by topic. Returns the full content of the best match (current workspace → global priority). Also shows atoms at the same topic in other workspaces as a preview listing.
>
> To fetch the full content of a foreign-workspace atom from an `alsoIn` entry, pass its directory path (the value inside `[workspace: …]`) as the `workspace` argument — the atom will then be returned as the primary match with complete content."

### `memory_atom_patch` — new tool

Updates atom metadata — `description`, `tags`, `created_at` — in-place on an existing atom without replacing its content. Supports `scope="workspace"` (default) and `scope="global"`. Also accepts an optional `workspace` path override (same as `memory_atom_get`) to target atoms in a specific project directory.

Partial-update semantics:
- Any field absent from the call → left unchanged
- `tags: []` explicitly → tags cleared; `tags` absent or `null` → tags unchanged
- `created_at` accepts ISO 8601 string or epoch ms (same contract as `memory_atom_write`)
- Zero recognised patch fields → error (at least one of `description`, `tags`, or `created_at` must be present)
- Non-empty `description` invariant enforced: `description: ""` → error
- `updated_at` bumped **only** when `description` or `tags` change; a `created_at`-only patch leaves `updated_at` untouched (preserves recency ordering in primer assembly)
- Errors if no matching atom is found

**Tool description draft:**
> "Apply a partial metadata update to an existing memory atom. Updates `description`, `tags`, and/or `created_at` in-place without replacing the atom's content. At least one field must be provided. Errors if the atom does not exist.
>
> Partial-update rules: omitting a field leaves it unchanged; `tags: []` clears tags (omitting `tags` or passing `null` keeps existing tags); `created_at` accepts ISO 8601 or epoch-ms (same as `memory_atom_write`).
>
> To patch an atom in a specific workspace (e.g. one seen in a `memory_atom_get` `alsoIn` listing), pass its directory path as `workspace`. Cross-workspace patching is intentionally limited to `workspace` path or `scope=\"global\"` — you cannot patch all workspaces at once."

### `MEMORY_PROTOCOL` update — proposed blurb (2 lines)

> **Update atom metadata** (`memory_atom_patch`) when you need to correct `description`, `tags`, or `created_at` without rewriting content — e.g. re-dating a migrated atom. Use `memory_atom_write` when content itself changes.

### `atom-patch` CLI command and `atomPatch` schema function

New `cmdAtomPatch` in `memory.js`; new `case 'atom-patch'` in CLI dispatch; new `atomPatch(db, { scope, project, topic, patch })` in `schema.js`. Uses `BEGIN IMMEDIATE` transaction. Validates non-empty `description`. Updates `updated_at` conditionally. Errors on missing atom.

## Capabilities

### New Capabilities

- `memory-atom-patch-tool`: The `memory_atom_patch` plugin tool plus its `atom-patch` CLI command and `atomPatch` schema function. Partial-update semantics for atom metadata without content replacement. Supports `workspace` path override.

### Modified Capabilities

- `memory-atom`: New `atomPatch` function. `alsoIn` query result unchanged; rendering updated to `[workspace: …]` format.
- `memory-atom-tools`: `memory_atom_get` accepts optional `workspace` arg and updates `alsoIn` rendering. New `memory_atom_patch` tool added and registered.

## Impact

- `src/plugin.js`: `memory_atom_get` tool args extended with optional `workspace`; scope resolution overridden when `workspace` is present; `alsoIn` rendering updated to `[workspace: /path]` format. New `memory_atom_patch` tool defined and added to `tool` export. `MEMORY_PROTOCOL` constant updated.
- `src/lib/schema.js`: new `atomPatch(db, { scope, project, topic, patch })` function.
- `src/memory.js`: new `cmdAtomPatch`; new `case 'atom-patch'` in CLI dispatch; usage string updated.
- Tests: `test/schema.test.js` — `atomPatch` cases: happy path (description-only, tags-only, created_at-only, all fields); missing atom error; empty-description error; `updated_at` not bumped on `created_at`-only; `tags: []` clears; absent `tags` keeps; ISO/epoch `created_at`. `test/memory-cli.test.js` — `atom-patch` CLI. `test/plugin-safety.test.js` — `memory_atom_patch` registration + arg validation; `memory_atom_get` with `workspace` arg; `alsoIn` rendering format.
- No DB schema changes, no new dependencies, no breaking changes to existing tool signatures.
