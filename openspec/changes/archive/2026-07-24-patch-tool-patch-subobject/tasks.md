## 1. Restructure `memory_atom_patch` tool schema

- [ ] 1.1 Replace flat `description`, `tags`, `created_at` args with a required `patch` object arg in `src/plugin.js`
- [ ] 1.2 Update `execute` to destructure `patch` from args and read `patch.description`, `patch.tags`, `patch.created_at`
- [ ] 1.3 Update the `PATCHABLE` / `present` validation logic to inspect `patch.*` fields
- [ ] 1.4 Update `normCreatedAt` normalisation to read from `patch.created_at`
- [ ] 1.5 Update `patchPayload` assembly to read from `patch.*`

## 2. Update tool description

- [ ] 2.1 Rewrite the `memory_atom_patch` description string to describe the `patch` sub-object API and remove references to flat field arguments

## 3. Update tests

- [ ] 3.1 Update all `memory_atom_patch.execute(...)` call sites in `test/plugin-safety.test.js` to pass patchable fields inside a `patch: {...}` sub-object (~8 occurrences)

## 4. Update spec

- [ ] 4.1 Apply the delta: replace the `memory_atom_patch tool performs content-preserving metadata updates` requirement in `openspec/specs/memory-atom-tools/spec.md` with the new `patch` sub-object wording (archive step handles this, but verify the main spec is updated after archive)
