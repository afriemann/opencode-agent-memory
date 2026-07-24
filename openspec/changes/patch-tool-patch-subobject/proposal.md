## Why

The `memory_atom_patch` tool currently exposes `description`, `tags`, and `created_at` as top-level arguments alongside the lookup keys `topic`, `scope`, and `workspace`. This flat namespace is ambiguous: `created_at` in particular reads like a filter (find atoms created at this time) rather than a value to overwrite, and there is no structural signal distinguishing "how to find the atom" from "what to change". Agents misread the API accordingly.

## What Changes

The three patchable fields (`description`, `tags`, `created_at`) are moved into a required `patch` sub-object. The lookup keys (`topic`, `scope`, `workspace`) remain flat top-level arguments.

**Before:**
```
memory_atom_patch [topic=x, workspace=/path, created_at=2026-07-22]
```

**After:**
```
memory_atom_patch [topic=x, workspace=/path, patch={created_at: "2026-07-22"}]
```

All existing validation rules are preserved unchanged: at least one field in `patch` must be supplied, `tags: []` clears tags, ISO 8601 `created_at` strings are normalised to epoch ms, empty `description` is rejected, `scope="all"` is rejected.

The tool description is updated to reflect the new shape.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `memory-atom-tools`: `memory_atom_patch` tool argument shape — patchable fields moved into a `patch` sub-object

## Impact

- `src/plugin.js` — `memory_atom_patch` tool args schema and `execute` destructuring
- `test/plugin-safety.test.js` — all `memory_atom_patch` call sites updated to the new shape
- `openspec/specs/memory-atom-tools/spec.md` — requirement text and scenario steps updated
- No CLI layer changes (the `atom-patch` subcommand payload is unchanged)
- No backwards compatibility — callers use the old flat shape will receive a schema validation error
