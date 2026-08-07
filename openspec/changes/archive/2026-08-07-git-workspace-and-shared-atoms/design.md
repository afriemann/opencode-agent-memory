# Design — git-workspace-and-shared-atoms

## Context

Hot-state distillation and injection currently key on raw `session.directory`.
A non-git session (e.g. `~/`) writes `hot_state` rows under `project='~/'`, a
spurious "project" that pollutes the primer. Separately, the "global" vocabulary
for unattached records confuses agents (`scope:"global"` means *unattached*, not
*search everywhere*). This change normalises every hot-state key through git-root
detection, redefines the read-tool scope vocabulary, makes `workspace` optional on
write tools, and renames "global" → "shared" in all user-facing text. DB column
values (`scope='global'`, `project=''`) are unchanged — **no migration**.

### Verified ground truth (read from source, not assumed)

Two facts diverge from the task brief and drive the decisions below:

1. **`findGitRoot(start)` does NOT return `null` on not-found.** It returns
   `start` unchanged (`workspace.js:42`) as a graceful fallback, and
   `resolveWorkspace` depends on that. The plugin therefore *cannot* use
   `findGitRoot`'s return value to distinguish "git repo" from "no git repo" —
   a distinct not-found signal is required. This is the central design
   correction (see **DQ0**).
2. **The hot-state CLI guards reject an empty-string project.** `accrue`, `read`,
   `inspect`, `distil-write`, `correct` all use `if (!project)` (`memory.js:774,
   784, 794, 804, 818`), which is truthy-false for `''` and exits with a usage
   error. The atom subcommands and `hot-state-delete` instead use `project ==
   null` and already tolerate `''`. The `project=''` convention (DQ1) is
   therefore *blocked* by these five guards until they are relaxed — a small,
   enumerable change that makes DQ1 Option A cheap.

Also verified: there are **three** independent call sites that read
`session.directory`/`data.directory` and feed `loadMemoryForSession`
(`plugin.js:384`, `1328/1345`, `1440/1443`). All three must normalise
identically or write- and read-keys drift and the primer silently returns nothing.

---

## DQ0 (prerequisite) — how the plugin detects git vs non-git

`findGitRoot` cannot answer "was a root found?". Rather than change its public
contract (which would ripple into `resolveWorkspace`'s graceful fallback), add an
honest sibling and make `findGitRoot` a thin wrapper:

- **`findGitRootOrNull(start): string | null`** — the real fs-walk; returns the
  repo root or `null` when no `.git` directory ancestor exists.
- **`findGitRoot(start) = findGitRootOrNull(start) ?? start`** — unchanged
  external behaviour; all existing callers keep the graceful fallback.

The plugin derives every hot-state key through **one** helper so the three
injection/distil entry points cannot drift:

```
projectKeyFor(session) = findGitRootOrNull(session.directory) ?? ''
```

`''` is the shared/non-git bucket. `doDistil` and `loadMemoryForSession` both key
off `projectKeyFor(...)`; identical input ⇒ identical key ⇒ primer matches.

---

## DQ1 — hot-state scope for non-git sessions

**Chosen: `scope='project', project=''`** (Option A).

| | Option A: `project='project'`, `project=''` | Option B: `scope='global'`, `project=''` |
|---|---|---|
| memory.js query changes | None to scope predicates; relax 5 `!project` guards → `project === undefined` | Parameterise `scope` in 6+ queries + upsert conflict targets + signal cleanup |
| CLI signature changes | None | New `scope` arg (or JSON-derived) on `read/accrue/inspect/distil-write/correct` |
| Cross-table consistency | Shared *atoms* use `scope='global'`; shared *hot-state* uses `scope='project'` — divergent | Uniform `scope='global'` for "shared" in both tables |
| Reader clarity | "a project with empty path" is a mild novelty | semantically cleaner |
| Blast radius / test surface | Small, localised | Large |

`project=''` is already a valid, distinct bucket key: every hot-state query filters
`project = ?`, so `''` rows and `'/repo'` rows separate naturally with **zero**
scope-predicate changes. The only cost is a convention note and relaxing five arg
guards (verified above). Option B buys cross-table symmetry at the price of a
broad, higher-risk change across memory.js's SQL and CLI surface — a poor trade
against YAGNI and maintainability. The two tables are already independent code
paths, so the divergence is invisible in practice. **Option A.**

Convention to record in `memory.js` header comments: *`project=''` denotes the
shared/unattached bucket; for `hot_state` it pairs with `scope='project'`, for
`memory_atom` it pairs with `scope='global'`. Both are "shared"; the empty
project is the distinguishing signal.*

---

## DQ2 — memory.js CLI interface change

Because Option A was chosen, **CLI signatures do not gain a `scope` argument.** The
only interface change is guard relaxation so the existing signatures accept the
shared bucket:

- `read`, `accrue`, `inspect`, `distil-write`, `correct`: change the project guard
  from `!project` to `project === undefined` (reject only a genuinely missing
  positional, accept `''`). Empty string arrives as a distinct empty argv element
  through `spawnMemory`, so no quoting change is needed.
- No JSON-payload scope field, no derived-scope logic. Scope stays the literal
  `'project'` these subcommands already write and query.

(Contingency, not adopted: had Option B been chosen, the minimal-churn route would
be *deriving* scope from `project === '' → 'global'` inside each command rather
than adding a positional — but Option A removes the need entirely.)

---

## DQ3 — `resolveScope` and `atomGet`

**No change to `atomGet` is required.** Verified against `schema.js:778`:

New mapping: agent `scope:"global"` → `resolveScope` → `{scope:'all', project:''}`.

- **`atomSearch`** (`schema.js:837`) — the caller already normalises via
  `cmdAtomSearch` (`searchScope = scope === 'all' ? 'all' : scope`); the `all`
  branch drops the scope predicate and searches the entire space. Correct for
  "search everywhere".
- **`atomGet`** — with `scope='all'`: the first query `WHERE scope='all' AND
  project=''` matches nothing (no row stores literal `scope='all'`); the fallback
  `if (!match && scope !== 'global')` fires (`'all' !== 'global'`), running the
  `scope='global' AND project=''` shared lookup and returning the shared atom plus
  the full `alsoIn` list. This is observationally identical to today's
  `scope='global'` behaviour — a point lookup with shared fallback and
  cross-workspace `alsoIn`. No edit needed.

`resolveScope` itself changes only its vocabulary mapping (see the scope table).

---

## DQ4 — `findGitRoot` sync vs async

**Keep it synchronous.** The walk is a handful of `statSync` calls bounded by path
depth (microseconds), invoked once per distil/inject. It sits among `await`ed
subprocess and IPC calls that dominate latency by orders of magnitude. Wrapping it
in `fs.promises` adds `await` points and interleaving complexity for no measurable
benefit and a marginally larger surface for races. YAGNI — leave `findGitRootOrNull`
(and thus `findGitRoot`) synchronous.

---

## DQ5 — primer header for non-git sessions

`lastTwoSegments('')` returns `''`, so the current header renders
`## Project memory —  (…)` with a blank segment — the exact pollution this change
targets. Fix in `assemblePrimer`: when `project === ''`, render a distinct header
**`## Shared memory — (background context — no action required)`** (no path
segment) instead of the `## Project memory — <segments>` form. This is display-only
and pairs with the "global → shared" rename. Detection is `project === ''`; no new
parameter is required.

---

## Component changes

### `src/lib/workspace.js`
- **Add** `findGitRootOrNull(start): string|null` (honest walk). **Refactor**
  `findGitRoot` to `findGitRootOrNull(start) ?? start` — external contract
  unchanged.
- **`resolveWorkspace`**: split the `null`/`undefined` case so `undefined`
  (omitted) auto-detects and `null` stays explicit-shared:
  - `undefined` → `findGitRootOrNull(contextDirectory)` found → `{scope:'project',
    project:root}`, else `{scope:'global', project:''}`.
  - `null` → `{scope:'global', project:''}` (unchanged).
  - `'.'` / absolute path → unchanged (git root of the path, graceful fallback).
    Explicit paths remain a deliberate cross-project override and keep
    `scope:'project'` even on non-git paths — the "no git = shared" rule governs
    only *auto-detect*, not an explicitly named target.
- **Contract note:** `undefined` and `null` are no longer interchangeable. JSON
  serialisation preserves the distinction — an omitted key drops to `undefined`,
  an explicit `null` survives — so the plugin→memory.js boundary carries intent
  faithfully.

### `src/plugin.js`
- **Import** `findGitRootOrNull`; add `projectKeyFor(session)` choke point.
- **`doDistil`** and **all three injection entry points** (`384`, `1328/1345`,
  `1440/1443`): replace raw `session.directory`/`data.directory` with
  `projectKeyFor(...)` so write- and read-keys agree.
- **`resolveScope`**: remap vocabulary (see scope table) — `workspace` →
  project+shared, `global` → entire space (`scope:'all'`), `all` → alias of
  `global`. Default argument for the search tool changes from `'all'` to the new
  meaning (`961`, `1020` call sites reviewed).
- **Write tools** (`memory_atom_write/append/patch/delete`): `workspace` schema
  becomes optional (`.optional()`, dropping the `Required` description). Omitted →
  auto-detect; `null` → shared; string → override. `validateWorkspace` already
  admits `null`/`undefined`; keep it.
- **Rename** user-facing text: `formatScopeLabel` `[global]` → `[shared]`
  (`185`); `MEMORY_PROTOCOL` and every tool description "global" → "shared";
  the `globalAtoms` argument at the `assemblePrimer` call (`327`) → `sharedAtoms`.

### `src/memory.js`
- **Relax** the project guard (`!project` → `project === undefined`) on `read`,
  `accrue`, `inspect`, `distil-write`, `correct` so the `''` bucket is accepted
  (DQ2).
- **No scope-predicate changes** — hot-state queries keep `scope='project'`
  (DQ1). Add the convention comment.

### `src/lib/schema.js`
- **`hotStateCrossProject`** (`450`): add `AND project != ''` so a *git* session's
  "Active projects today" list never surfaces the shared bucket as an empty-path
  row. (A non-git session already excludes shared rows via `project != ''` when
  `currentProject=''`; the guard makes both directions correct.)

### `src/lib/signal-utils.js`
- **`assemblePrimer`**: rename the `globalAtoms` parameter → `sharedAtoms`
  (and the derived `activeGlobalAtoms`/`compactGlobalAtoms`/`standingGlobal`
  local names for clarity); heading `### Global atoms` → `### Shared atoms`;
  empty-state `No global atoms yet.` → `No shared atoms yet.`
- **Header (DQ5)**: when `project === ''` emit `## Shared memory — …`; otherwise
  the existing `## Project memory — <segments> …`.
- Standing-context bucket split still keys on `scope === 'global'` (DB value,
  unchanged) — only the surface vocabulary moves to "shared".

---

## Data flow — git-root detection → scope/project → CLI

### Hot-state path (distil + inject)

```
session.directory
      │
      ▼
findGitRootOrNull(dir)
   ├── string root ──▶ project = root ; scope = 'project'
   └── null         ──▶ project = ''   ; scope = 'project'   (shared bucket)
      │
      ▼
spawnMemory(['read'|'distil-write'|'accrue'|'inspect'|'correct', … , project])
      │  (project guard now accepts '')
      ▼
memory.js  WHERE scope='project' AND project = ?   ← '' and '/repo' are distinct buckets
      │
      ▼
assemblePrimer(project)
   ├── project === '' ──▶ "## Shared memory — …"
   └── else            ──▶ "## Project memory — <segments> …"
```

### Write-tool auto-detect path

| tool call `workspace` | resolveWorkspace input | fs check | → `{scope, project}` | primer/label |
|---|---|---|---|---|
| omitted | `undefined` | git root found | `{project, /repo}` | `[workspace: /repo]` |
| omitted | `undefined` | no git root | `{global, ''}` | `[shared]` |
| `null` | `null` | (none) | `{global, ''}` | `[shared]` |
| `"."` | `"."` | git root of ctx dir | `{project, root}` | `[workspace: root]` |
| `"/abs/path"` | `"/abs/path"` | git root of path (graceful) | `{project, root‖path}` | `[workspace: …]` |

---

## Scope semantics — `resolveScope` (read tools)

| agent `scope` | current → `{scope, project}` | new → `{scope, project}` | meaning (new) |
|---|---|---|---|
| `"workspace"` (default) | `{project, dir}` (project only) | `{project, dir}` — search already unions shared via `atomSearch`/`atomList` | current project **+ shared** (shared no longer opt-in) |
| `"global"` | `{global, ''}` (unattached only) | `{all, ''}` | **search entire space, all projects** |
| `"all"` | `{all, ''}` | `{all, ''}` | back-compat alias of `"global"` |
| *(shared-only intent)* | — | `workspace:null` + `scope:"workspace"` | shared bucket explicitly |

"Shared included in workspace scope" is delivered by the existing query shape:
`atomSearch`/`atomList` for `scope='project'|'workspace'` already `OR (scope='global'
AND project='')`. The primer keeps project and shared atoms in separate sections
(`activeProjectAtoms` filters out `scope='global'`), so no duplication results.

---

## Breaking-change analysis

**`workspace` param → optional (write tools).** Schema moves from
`union([string, null])` described "Required" to `.optional()`. Backward-compatible
for callers that always pass it. New behaviour only manifests on omission
(previously a validation-level "required" expectation; now auto-detect). `null`
semantics are unchanged (explicit shared). **Low risk.** `MEMORY_PROTOCOL`'s
"Always pass `workspace` explicitly — there is no default" line must be rewritten,
or agents will keep over-specifying (harmless) but the docs will contradict the
schema.

**`scope:"global"` repurposed (read tools).** *Semantic* breaking change with no
signature change. Before: "atoms unattached to any project". After: "search the
entire space". An agent that used `scope:"global"` to read *only* shared atoms now
gets **all projects**. Mitigations: (1) the new default `scope:"workspace"` already
includes shared atoms, covering the common case; (2) shared-only intent has an
explicit replacement (`workspace:null` + `scope:"workspace"`); (3) `scope:"all"`
is retained as an alias so nothing that meant "everywhere" breaks. Tool
descriptions and `MEMORY_PROTOCOL` must state the new meaning explicitly.

**No DB migration.** Column values are untouched; only vocabulary and routing
change. **Known key drift (accepted):** hot-state rows distilled pre-change under
`project=session.directory` (e.g. `/repo/src`) are orphaned once the plugin writes
the normalised `/repo` (or `''`) key — never read, never pruned by the new path,
overwritten by the next distil. No data-loss risk; documented as a no-migration
policy in the proposal.

---

## Component breakdown (implementation hand-off)

| # | Component | Work kind | Done-criterion |
|---|---|---|---|
| 1 | `workspace.js`: `findGitRootOrNull` + `findGitRoot` wrapper + `resolveWorkspace` undefined/null split | app code | unit tests: null on non-git, root on git, `undefined`→auto-detect, `null`→shared, `'.'`/abs unchanged |
| 2 | `plugin.js`: `projectKeyFor` choke point wired into `doDistil` + 3 injection sites | app code | distil and all injection paths key off the same normalised project; non-git session writes `project=''` |
| 3 | `plugin.js`: `resolveScope` vocabulary remap + search-tool default | app code | `workspace`→project+shared, `global`→entire space, `all`→alias; verified against `atomGet`/`atomSearch` |
| 4 | `plugin.js`: write-tool `workspace` optional + descriptions/`MEMORY_PROTOCOL`/`formatScopeLabel` rename | app code + docs | schema optional; omit auto-detects; `[shared]` label; protocol text matches schema |
| 5 | `memory.js`: relax 5 hot-state project guards to accept `''` + convention comment | app code | `read/accrue/inspect/distil-write/correct` accept `''`; reject only a missing positional |
| 6 | `schema.js`: `hotStateCrossProject` `AND project != ''` guard | app code | git session's cross-project list never shows an empty-path row |
| 7 | `signal-utils.js`: `globalAtoms`→`sharedAtoms`, headings, shared-memory header for `project===''` | app code | primer renders `## Shared memory …` for non-git; `### Shared atoms`; no empty segment |
| 8 | Tests: `test/signal-utils.test.js`, `test/plugin.test.js` | tests | rename call sites; add non-git distil/inject scenario, auto-detect write scenario, cross-project empty-bucket exclusion |

No new user-facing surface warrants a `ui-designer` pass — all changes are to
injected-primer text and tool schemas within the established format.

---

## Resilience & failure modes

- **Key-agreement invariant:** distil and inject must share `projectKeyFor`. Blast
  radius of a mismatch: primer silently empty for a session (no crash, no data
  loss). Mitigation: single helper (component 2), covered by test 8.
- **Guard regression:** if a hot-state guard is relaxed to `== null` instead of
  `=== undefined`, a genuinely missing positional would be silently accepted as
  the shared bucket. Prefer `=== undefined`; a missing positional arrives as
  `undefined`, an intentional `''` arrives as an empty argv element.
- **Recovery:** the change is stateless and additive at the DB level; reverting the
  code restores prior behaviour with no schema rollback. Orphaned pre-change rows
  self-heal on next distil.
</content>
</invoke>
