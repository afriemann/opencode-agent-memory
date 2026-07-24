# Design — pin-memory-atoms

## Context

The session primer (`assemblePrimer` in `src/lib/signal-utils.js`) renders an
atom directory in two scope sections — **Project atoms** and **Global atoms**.
Each section lists atoms ordered by `topic` and truncates to a hard cap
(`cap = 40`). Atoms are fetched by the plugin's session-start injector via two
`atom-list` invocations (`src/plugin.js` ~line 239):

- `atom-list project <project>` → `projectAtoms` (workspace **and** global atoms,
  because `atomList`'s default WHERE matches `(scope=? AND project=?) OR (scope='global' AND project='')`)
- `atom-list global ''` → `globalAtoms`

Consequences of the current design:

- Atoms whose `topic` sorts late alphabetically, or corpora exceeding 40 atoms
  per scope, can be **silently dropped** from the primer. `slice(0, cap)` keeps
  only the first 40 by topic order.
- An agent has **no mechanism** to guarantee a specific atom is always present
  in the primer regardless of topic name or corpus size.

The database is SQLite (schema `user_version = 2`, file `<data-dir>/memory.db`).
The `memory_atom` table has a `UNIQUE(scope, project, topic)` constraint and is
backed by an external-content FTS5 index kept in sync by three triggers
(`memory_atom_ai/ad/au`). `src/memory.js` is the **sole writer**; the plugin
never opens the DB directly, it shells out to the CLI.

This change is a set of **extensions to existing capabilities** (`memory-atom`,
`memory-atom-tools`, `signal-processing`). It introduces no new capability and
no breaking change: everything defaults to the pre-change behaviour.

## Goals / Non-Goals

**Goals**

- Let an agent mark an atom so it **always appears** in the primer's scope
  section, ahead of the regular list and **not counted against the 40-cap**.
- Persist pin state durably as a first-class, filterable column on `memory_atom`.
- Keep fresh-install and migrated databases **schema-identical**.
- Preserve all existing default behaviour: unmarked atoms behave exactly as today.

**Non-Goals**

- **No hard pin limit.** Bounding the pinned set is operator responsibility
  (Decision 3); context-window pressure is a documented trade-off, not an
  enforced constraint.
- **No pin indicator on `atom-get` or `atom-search`.** The `[pinned]` marker is
  scoped to `atom-list` output only (Decision 6).
- **`pinned` is not made searchable.** It is a filter/sort column, deliberately
  excluded from the FTS index and its sync triggers (Decision 8).
- **No change to the primer's pre-existing global-in-project duplication.** That
  is a known limitation, out of scope (see Risks (b)).
- No implementation here — this document is the design; the engineer implements
  and authors the delta specs.

## Decisions

### D1 — Store `pinned` as `INTEGER NOT NULL DEFAULT 0`

Use SQLite's canonical boolean idiom: an integer column, `0`/`1`, defaulting to
`0` (unpinned). `NOT NULL DEFAULT 0` guarantees migrated rows and omitted-value
inserts are unpinned without a nullable tri-state.

- **Alternative — `BOOLEAN`/nullable column:** SQLite has no native boolean type
  (`BOOLEAN` is an alias with `NUMERIC` affinity); a nullable column invites a
  meaningless third state. Rejected for ambiguity.

### D2 — `pinned` is INSERT-only in `atomWrite`; pin state is changed only via `atomPatch`

`atomWrite` upserts via `INSERT … ON CONFLICT(scope, project, topic) DO UPDATE
SET …`. `pinned` is set in the **INSERT column list** but **must NOT appear in
the `ON CONFLICT … DO UPDATE SET` clause**. On first creation the caller's
`pinned` (default `0`) is written; on any subsequent write to the same topic the
**existing `pinned` value is preserved untouched**.

Rationale: `memory_atom_write` is a content-update tool. Most write calls will
not pass `pinned`. If `pinned` were in the SET clause, an absent parameter would
resolve to the default `0` and **silently unpin** a previously pinned atom — a
dangerous, invisible side-effect. Making pin state mutable only through the
explicit `atomPatch` path (D5) is the safe default.

- **Alternative — include `pinned` in the SET clause:** simplest to write, but
  couples pin state to every content update and causes accidental unpinning.
  Rejected.
- **Consequence:** a re-write can never unpin. Unpinning requires a separate
  `memory_atom_patch` call. This is the intended cost of the safe default
  (Risks (c)).

### D3 — No pin limit

No count cap on pinned atoms per scope. Keeping the pinned set small is operator
responsibility and is documented in the tool description and `atom-list` output.

- **Alternative — cap pinned atoms (e.g. max 10):** protects the context window
  but adds enforcement logic, an error path, and an arbitrary threshold that
  differs per agent/workspace. YAGNI: introduce only if unbounded growth proves
  a real problem in practice. Rejected for now; documented as a trade-off.

### D4 — Pinned atoms are excluded from the regular capped list

Within each scope section, `assemblePrimer` partitions the fetched atoms into
**pinned** and **non-pinned**. Pinned atoms render first (ordered by topic, no
cap); non-pinned render after (ordered by topic, capped at 40). A pinned atom
appears **exactly once** per section — never also in the capped remainder, and
the `(+N more)` overflow count is computed from the **non-pinned** set only.

- **Alternative — render pinned atoms and leave them in the capped list too:**
  duplicates entries and wastes primer space. Rejected.

### D5 — `atomPatch` gains `pinned` as a patchable field

Add `pinned` to `atomPatch`'s `PATCHABLE` set (`src/lib/schema.js`) and to the
`memory_atom_patch` tool's args/`present` computation (`src/plugin.js`). This is
the sole path to change pin state after creation, enabling both pin and unpin.

- The tool must distinguish **`pinned: false` (explicit unpin)** from **omitted
  `pinned` (leave unchanged)**. The existing patch machinery already keys on
  `!== undefined` / `'pinned' in patch`, so `false` is a valid, distinct value —
  the same mechanism `tags: []` relies on. The value is coerced to `0`/`1` for
  storage.
- **updated_at on pin change:** treat a `pinned` change like `description`/`tags`
  — it bumps `updated_at` (a real state mutation, and it affects the relative
  time shown in the primer). See Open Questions for the alternative.
- **Alternative — a dedicated `atom-pin`/`atom-unpin` command:** more explicit
  but adds two CLI verbs and two plugin tools for a one-bit toggle already
  expressible as a patch. Rejected for surface-area economy.

### D6 — `[pinned]` indicator on `atom-list` only

`atomList`'s SELECT (`src/lib/schema.js`) must add `pinned` to its explicit
column list (both the `scope='all'` and default branches) so the display layer
can render it. The plugin's `atom-list` tool formatter (`src/plugin.js`) renders
a `[pinned]` marker on pinned entries. `atom-get` and `atom-search` are
unchanged.

- **Alternative — surface `pinned` everywhere:** more consistency but more
  formatter churn for marginal value; `atom-list` is the directory-inspection
  surface where pin state is actionable. Rejected as scope creep.

### D7 — Fresh-DB baseline and v3 migration must converge

Two edits to `ensureSchema` (`src/lib/schema.js`) that must agree:

1. **Phase 1 baseline** — add `pinned INTEGER NOT NULL DEFAULT 0` to the
   `CREATE TABLE IF NOT EXISTS memory_atom (…)` column list, so a fresh database
   is born with the column.
2. **Phase 2 v3 migration** — a new block mirroring the v2 idempotency pattern:
   gate on `PRAGMA user_version < 3`, probe `PRAGMA table_info(memory_atom)` for
   the absence of `pinned`, then `ALTER TABLE memory_atom ADD COLUMN pinned
   INTEGER NOT NULL DEFAULT 0`, and finally `PRAGMA user_version = 3`.

Both paths must yield an **identical** schema. The column-existence probe makes
re-running safe even if `user_version` and physical shape disagree (mirrors the
v2 `session_id` probe).

- **Alternative — migration only, no baseline edit:** fresh installs would be
  created at `user_version = 3` (or bumped) without the column, or would require
  the ALTER to run on an empty table. Divergent schemas between fresh and
  migrated DBs is the exact bug the v2 pattern guards against. Rejected.

### D8 — Explicit column, not a reserved tag

`pinned` is a dedicated column, **not** a magic tag value (e.g. `tags:
["pinned"]`).

- **Reserved-tag alternative — rejected.** Reasons: (1) discoverability — a
  column is self-describing in the schema; a reserved tag is a hidden
  convention; (2) type safety — a column is a typed boolean; a tag is a free
  string prone to typos (`pin`, `Pinned`); (3) FTS coupling — `tags` is indexed
  by FTS5, so a reserved pin-tag would pollute search results and entangle pin
  state with the search index; (4) filter cost — sorting/partitioning on a tag
  requires JSON parsing per row, versus a direct column predicate. The column is
  **not** added to the FTS index or its triggers precisely because pin state is
  filterable, not searchable.

## Risks / Trade-offs

**(a) Unbounded pinned set can fill the context window.** With no hard cap (D3),
an operator who pins many large atoms inflates every primer for that scope,
consuming context budget on every session start. Mitigation is documentation and
operator discipline, not enforcement. Accepted trade-off; revisit a cap only if
this bites in practice.

**(b) Pinned global atoms appear in both Project and Global sections
(pre-existing).** The injector fetches `projectAtoms` via `atom-list project
<project>`, whose WHERE clause **already includes global atoms**. So a pinned
global atom surfaces in the Project section's pinned group *and* the Global
section's pinned group. This duplication exists today for regular atoms too — it
is a **pre-existing behaviour of `atomList`**, not introduced by this change.
Pinning makes it more visible (both copies are now guaranteed present). Declared
a **known limitation, out of scope**; fixing it would mean changing the primer's
fetch/merge strategy, a separate change.

**(c) INSERT-only pin policy means `memory_atom_write` cannot unpin.** Any
re-write of a pinned atom preserves its pin (D2). This is a deliberate
safe-default that prevents accidental unpinning, but it means unpinning is a
distinct, explicit `memory_atom_patch` call — a small ergonomic cost traded for
safety. Must be stated plainly in the `memory_atom_write` tool description.

**(d) Schema-divergence risk if D7 is done by halves.** Editing only the
migration or only the baseline produces fresh-vs-migrated schema drift. The
paired edit plus the column-existence probe are the guard; the delta spec and
tests must assert both paths converge.

## Migration Plan

**Schema v2 → v3 (existing databases):**

1. On next CLI invocation, `ensureSchema` runs. Phase 1 `CREATE TABLE IF NOT
   EXISTS` is a no-op for the existing table.
2. Phase 2 v3 block: `PRAGMA user_version` returns `2` (`< 3`). Probe
   `PRAGMA table_info(memory_atom)`; `pinned` is absent → run `ALTER TABLE
   memory_atom ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`. All existing rows
   become `pinned = 0` (unpinned) — behaviour identical to pre-change.
3. Set `PRAGMA user_version = 3`.
4. Re-running is safe: if `pinned` is already present (shape probe hits) the
   ALTER is skipped and only the version marker advances — mirrors the v2
   `session_id`-present branch.
5. FTS index and triggers are **untouched** (D8); no FTS rebuild needed.

**Fresh install:** Phase 1 baseline already contains `pinned`; the v3 gate then
just stamps `user_version = 3`. Resulting schema is identical to a migrated DB.

**Ordering with future migrations:** the v3 block follows the v2 block; each is
independently gated by its own `user_version` threshold and shape probe, so a DB
at any prior version walks the ladder in order.

**Rollback considerations:**

- The change is **additive and backward-compatible**: an older CLI build opening
  a v3 database ignores the unknown `pinned` column (its `atomWrite`/`atomList`
  SELECTs name columns explicitly and never reference `pinned`), so data is
  readable. The `user_version` marker will read as `3`; an older `ensureSchema`
  gates on `< 2` only and will not attempt to "downgrade".
- SQLite cannot cheaply `DROP COLUMN` on old engines; a true schema rollback
  would be a table rebuild. Not required — leaving the unused column in place is
  harmless. Document "no automated downgrade; the column is inert if unused."
- No data migration of atom content is involved; only a column addition with a
  safe default. Risk of data loss is nil.

## Open Questions

1. **updated_at bump on a `pinned`-only patch.** D5 treats a pin change as a
   real mutation that bumps `updated_at` (consistent with `description`/`tags`,
   and it changes the primer's relative-time display). The alternative — treat
   pin toggling as metadata that leaves `updated_at` untouched (like the
   `created_at`-only patch) — would avoid re-dating an atom merely for pinning.
   Recommendation: **bump** for consistency and honest recency; confirm with the
   engineer before locking the delta spec.
2. **Ordering of the pinned group.** Design fixes pinned-group order to **by
   topic** (D4/D5), consistent with the regular list. If operators would rather
   see pinned atoms in an explicit priority order, that needs a separate ordering
   field — explicitly **not** in scope here. Flagging in case the primer's
   consumers expect a different ordering.

## Component Breakdown

Each part below states *what* it is, the *kind* of work, and its *done-criterion*.
No implementing agent is assigned; the engineer implements all parts.

1. **Schema column + v3 migration** — `src/lib/schema.js`, `ensureSchema`.
   Application/DB code. Done when: Phase 1 baseline `CREATE TABLE` includes
   `pinned INTEGER NOT NULL DEFAULT 0`; a v3 block gated by `user_version < 3` +
   `table_info` probe runs the `ALTER` and stamps `user_version = 3`; fresh and
   migrated DBs are schema-identical.

2. **`atomWrite` INSERT-only pin** — `src/lib/schema.js`, `atomWrite`.
   Application code. Done when: `pinned` is in the INSERT column list (default
   `0`) and **absent** from the `ON CONFLICT … DO UPDATE SET` clause; a re-write
   provably preserves an existing pin.

3. **`atomPatch` pin support** — `src/lib/schema.js`, `atomPatch`. Application
   code. Done when: `pinned` is in `PATCHABLE`, coerced to `0`/`1`, distinguishes
   explicit `false` from omitted, and the `updated_at`-bump rule matches the
   resolved Open Question 1.

4. **`atomList` SELECT** — `src/lib/schema.js`, `atomList`. Application code.
   Done when: `pinned` is added to the explicit column list in **both** the
   `scope='all'` and default branches.

5. **Primer partition/render** — `src/lib/signal-utils.js`, `assemblePrimer`.
   Application code. Done when: each scope section renders pinned atoms first
   (by topic, uncapped) then non-pinned (by topic, capped at 40); no atom appears
   twice; the `(+N more)` count derives from the non-pinned set only.

6. **CLI `atom-write` / `atom-patch` plumbing** — `src/memory.js`. Application
   code. Done when: `atom-write` forwards `pinned` on create; `atom-patch`
   accepts `pinned` in its JSON patch; `atom-list` output carries the field
   through to the display layer.

7. **Plugin tool schemas + descriptions** — `src/plugin.js`. Application code.
   Done when: `memory_atom_write` args gain optional `pinned: boolean`
   (default false) with the "INSERT-only; use patch to unpin" caveat documented;
   `memory_atom_patch` args gain optional `pinned: boolean`; the `atom-list`
   formatter renders a `[pinned]` marker.

8. **Delta specs** — `openspec/changes/pin-memory-atoms/specs/…` for `memory-atom`,
   `memory-atom-tools`, `signal-processing`. Spec authoring (engineer-owned).
   Done when: the three modified capabilities capture the new requirements
   transcribed from this design.

9. **Tests** — `test/`. Application/test code. Done when: schema convergence
   (fresh vs migrated), INSERT-only pin preservation, patch pin/unpin, primer
   partition/exclusion/no-cap, and `atom-list` `[pinned]` rendering are covered,
   including the pre-existing global-in-project duplication acknowledged as a
   known limitation.
