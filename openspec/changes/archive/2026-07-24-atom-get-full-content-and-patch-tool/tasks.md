## 1. Schema layer — atomPatch function (src/lib/schema.js)

- [ ] 1.1 Add `atomPatch(db, {scope, project, topic, patch})` — open `BEGIN IMMEDIATE`, check at-least-one-field guard, read existing row (throw if missing), validate non-empty description, build dynamic `UPDATE` from present fields with conditional `updated_at` bump, commit
- [ ] 1.2 Ensure `tags` present + `[]` stores `'[]'`; absent `tags` omitted from UPDATE
- [ ] 1.3 Ensure `created_at`-only patch does not include `updated_at` in the UPDATE clause

## 2. CLI layer — cmdAtomPatch + dispatch (src/memory.js)

- [ ] 2.1 Add `cmdAtomPatch(db, argv)` that parses third positional as JSON, calls `atomPatch`, prints `{ ok: true, topic, patched: [...] }` on stdout, handles errors to stderr + exit(1)
- [ ] 2.2 Add `case 'atom-patch'` to the subcommand dispatch and update the usage string
- [ ] 2.3 Add `db.close()` on both success and error paths (mirroring atom-append)

## 3. Plugin layer — memory_atom_get workspace arg + alsoIn reformat (src/plugin.js)

- [ ] 3.1 Add optional `workspace` argument to `memory_atom_get` tool schema
- [ ] 3.2 In `memory_atom_get.execute`, compute effective directory as `workspace ?? context.directory` before `resolveScope`; pass it as the second arg to `resolveScope`
- [ ] 3.3 Reformat the `alsoIn` render loop: workspace-scoped entries → `• [workspace: ${a.project}] ${a.topic} — …`; global entries → `• [global] ${a.topic} — …`; preserve the preview and timestamp suffix
- [ ] 3.4 Update `memory_atom_get` tool description to explain the `workspace` param and the `[workspace: <path>]` extraction pattern for the get→identify→re-get workflow

## 4. Plugin layer — memory_atom_patch tool (src/plugin.js)

- [ ] 4.1 Define `memory_atom_patch` tool schema: required `topic`, optional `description`, `tags`, `created_at`, `scope`, `workspace`; add to the `tool` export map
- [ ] 4.2 In `memory_atom_patch.execute`: reject `scope='all'`; at-least-one-field pre-check; normalise `created_at` (ISO string or epoch ms) reusing the `memory_atom_write` block; compute effective directory (`workspace ?? context.directory`) and call `resolveScope`; spawn `atom-patch <scope> <project> <topic> <json-patch>`
- [ ] 4.3 Wrap in try/catch; return confirmation string naming changed fields on success; return error string (not throw) on failure

## 5. MEMORY_PROTOCOL update (src/lib/signal-utils.js)

- [ ] 5.1 Append a ≤2-line `memory_atom_patch` blurb to the `MEMORY_PROTOCOL` constant distinguishing patch (metadata correction, re-dating) from write (content change)

## 6. Tests — schema layer (test/schema.test.js)

- [ ] 6.1 Write failing test: `atomPatch with description and tags updates both and bumps updated_at`
- [ ] 6.2 Write failing test: `atomPatch with created_at only does not bump updated_at`
- [ ] 6.3 Write failing test: `atomPatch with tags:[] clears existing tags`
- [ ] 6.4 Write failing test: `atomPatch with absent tags field leaves existing tags unchanged`
- [ ] 6.5 Write failing test: `atomPatch rejects empty patch`
- [ ] 6.6 Write failing test: `atomPatch rejects empty description`
- [ ] 6.7 Write failing test: `atomPatch errors when atom does not exist`
- [ ] 6.8 Implement `atomPatch` (tasks 1.1–1.3) to make all schema tests pass

## 7. Tests — CLI layer (test/memory-cli.test.js)

- [ ] 7.1 Write failing test: `atom-patch CLI patches atom and exits 0 with JSON stdout`
- [ ] 7.2 Write failing test: `atom-patch CLI exits non-zero when atom does not exist`
- [ ] 7.3 Write failing test: `atom-patch CLI exits non-zero on empty patch`
- [ ] 7.4 Implement CLI changes (tasks 2.1–2.3) to make CLI tests pass

## 8. Tests — plugin layer (test/plugin-safety.test.js)

- [ ] 8.1 Write failing test: `memory_atom_patch is registered in tool export`
- [ ] 8.2 Write failing test: `memory_atom_patch rejects scope=all`
- [ ] 8.3 Write failing test: `memory_atom_patch rejects empty patch`
- [ ] 8.4 Write failing test: `memory_atom_patch rejects invalid created_at string`
- [ ] 8.5 Write failing test: `memory_atom_get workspace arg changes resolution directory`
- [ ] 8.6 Write failing test: `memory_atom_get alsoIn renders [workspace: …] format for workspace entries`
- [ ] 8.7 Write failing test: `memory_atom_get alsoIn renders [global] for global entries`
- [ ] 8.8 Implement plugin changes (tasks 3.1–4.3) to make plugin tests pass

## 9. Verification

- [ ] 9.1 Run full test suite; fix any failures
- [ ] 9.2 Run linter / pre-commit checks; fix any issues
- [ ] 9.3 Verify `memory_atom_patch` appears correctly in the plugin tool list
