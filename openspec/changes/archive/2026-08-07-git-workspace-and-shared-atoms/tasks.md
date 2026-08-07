## 1. workspace.js — findGitRootOrNull + resolveWorkspace split

- [x] 1.1 Extract `findGitRootOrNull(start): string|null` from `findGitRoot` — honest fs-walk returning `null` when no `.git` ancestor exists
- [x] 1.2 Refactor `findGitRoot(start)` to `findGitRootOrNull(start) ?? start` — preserve external contract, no caller changes
- [x] 1.3 Export `findGitRootOrNull` from `workspace.js`
- [x] 1.4 Split `resolveWorkspace` null/undefined handling: `undefined` → auto-detect via `findGitRootOrNull`; `null` → explicit shared (unchanged)
- [x] 1.5 Add unit tests for `findGitRootOrNull` (git path → root, non-git path → null)
- [x] 1.6 Add unit tests for `resolveWorkspace` undefined→auto-detect, null→shared cases

## 2. plugin.js — projectKeyFor + hot-state normalisation

- [x] 2.1 Import `findGitRootOrNull` in `plugin.js`; add `projectKeyFor(directory)` helper: `findGitRootOrNull(directory) ?? ''`
- [x] 2.2 Update `doDistil` to use `projectKeyFor(session.directory)` instead of `session.directory`
- [x] 2.3 Update `loadMemoryForSession` to accept/use normalised project key
- [x] 2.4 Update all three injection call sites (`plugin.js:384`, `1328/1345`, `1440/1443`) to pass `projectKeyFor(data.directory)` to `loadMemoryForSession`
- [x] 2.5 Add test: git session distils to normalised root; non-git session distils to `project=''`
- [x] 2.6 Add test: injection uses same key as distil (no silent primer miss due to key drift)

## 3. memory.js — hot-state guard relaxation

- [x] 3.1 Change the `!project` guard to `project === undefined` on `read`, `accrue`, `inspect`, `distil-write`, and `correct` subcommands (5 guards total; verified at lines 774, 784, 794, 804, 818)
- [x] 3.2 Add convention comment in `memory.js` header: `project=''` is the shared/non-git bucket for hot_state (pairs with `scope='project'`; distinct from `project='/repo'` which is a git project)
- [x] 3.3 Add test: `distil-write` and `read` accept empty-string project; reject undefined/missing positional

## 4. schema.js — hotStateCrossProject guard

- [x] 4.1 Add `AND project != ''` predicate to `hotStateCrossProject` query so non-git shared bucket never appears in "Active projects today"
- [x] 4.2 Add test: cross-project list excludes `project=''` rows for a git session

## 5. plugin.js — resolveScope vocabulary remap

- [x] 5.1 Update `resolveScope`: `scope:'global'` → `{scope:'all', project:''}` (entire space); `scope:'all'` → `{scope:'all', project:''}` (backwards-compat alias); `scope:'workspace'` unchanged
- [x] 5.2 Verify search-tool default argument at call sites (line 961, 1020) still produces correct behavior after remap
- [x] 5.3 Add test: resolveScope('global') → {scope:'all', project:''}; resolveScope('all') same; resolveScope('workspace') unchanged

## 6. plugin.js — write-tool workspace optional + auto-detect

- [x] 6.1 Update `memory_atom_write` Zod schema: change `workspace` from `union([string,null])` to `.optional()` + union
- [x] 6.2 Update `memory_atom_append` Zod schema: same optional change
- [x] 6.3 Update `memory_atom_patch` Zod schema: same optional change
- [x] 6.4 Update `memory_atom_delete` Zod schema: same optional change
- [x] 6.5 Update write-tool execute functions to pass `workspace` to `resolveWorkspace` (passes `undefined` when omitted, which triggers auto-detect per workspace.js change)
- [x] 6.6 Add test: write tool with `workspace` omitted in git repo → writes to project; in non-git → writes to shared

## 7. signal-utils.js — rename globalAtoms→sharedAtoms + primer headers

- [x] 7.1 Rename `globalAtoms` parameter to `sharedAtoms` in `assemblePrimer` signature and all internal local names (`activeGlobalAtoms`→`activeSharedAtoms`, `compactGlobalAtoms`→`compactSharedAtoms`, `standingGlobal`→`standingShared`)
- [x] 7.2 Update `### Global atoms` heading → `### Shared atoms`
- [x] 7.3 Update `No global atoms yet.` placeholder → `No shared atoms yet.`
- [x] 7.4 Add conditional header: when `project === ''` emit `## Shared memory — (background context — no action required)` instead of `## Project memory — <segments> …`
- [x] 7.5 Add test: `sharedAtoms` parameter accepted; primer renders `### Shared atoms`; non-git primer header is `## Shared memory —`

## 8. plugin.js — assemblePrimer call site + formatScopeLabel rename

- [x] 8.1 Update the `assemblePrimer` call in plugin.js to pass `sharedAtoms` (previously `globalAtoms`) for the shared atom directory section
- [x] 8.2 Update `formatScopeLabel` (or equivalent) so `scope='global', project=''` renders `[shared]` instead of `[global]`
- [x] 8.3 Update `atom-list` spawn for the shared section to use the correct scope/project pair

## 9. plugin.js — MEMORY_PROTOCOL and tool descriptions (agent-engineer commission)

- [x] 9.1 Commission `agent-engineer` to rewrite `MEMORY_PROTOCOL` constant and all write/read tool descriptions: remove "always pass workspace explicitly", add workspace auto-detect description, rename "global" → "shared" for unattached atoms, update scope semantics
- [x] 9.2 Integrate agent-engineer output into `plugin.js`
- [x] 9.3 Add test: MEMORY_PROTOCOL does not contain "there is no default" for workspace; contains "shared" terminology

## 10. Tests + linter

- [x] 10.1 Update all `test/signal-utils.test.js` call sites: `globalAtoms` → `sharedAtoms`
- [x] 10.2 Update all `test/plugin.test.js` call sites referencing `[global]` → `[shared]` and `### Global atoms` → `### Shared atoms`
- [x] 10.3 Run full test suite: `npm test` — all pass
- [x] 10.4 Run linter: no errors (no lint script configured; node --check passes)

## 11. Review + commit + archive

- [x] 11.1 Spawn `code-reviewer` — resolve all `[BLOCKER]` and `[WARNING]` items
- [ ] 11.2 Commit: `feat: git-root workspace detection and shared-atom naming`
- [ ] 11.3 `openspec archive git-workspace-and-shared-atoms --yes`
- [ ] 11.4 Commit archival: `docs: archive openspec change git-workspace-and-shared-atoms`
- [ ] 11.5 Push to main
