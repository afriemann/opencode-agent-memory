# Design: atom-summary-field

## Context

Memory atoms are durable named knowledge records stored in the `memory_atom`
table (SQLite, `src/lib/schema.js`). Each atom carries a required `description`
(what the atom is *for*) and a `content` body. Directory listings — the session
primer, `memory_atom_list`, `memory_atom_search`, and the `alsoIn` block of
`memory_atom_get` — currently show `description` plus a raw
`substr(content, 1, 80)` preview. That preview is a mechanical truncation of the
content's first line (usually a Markdown heading), so it is noisy and gives an
agent no reliable signal for deciding whether to fetch the full atom.

This change adds an optional, **manually authored** `summary`: a one-sentence
digest of *what the content contains*, distinct from `description`'s *what it is
for*. `summary` replaces the preview in listings when present, and the preview
remains as a silent fallback for atoms written before the field existed.

The design is deliberately small: one nullable-by-default column, one linear
migration, one validation point per write path, and one display-fallback rule
applied uniformly. Everything below optimises for that minimal surface.

## Component overview

The field threads through four layers. Each layer has a single responsibility;
no layer duplicates another's enforcement or fallback logic.

| Layer | File | Responsibility for `summary` |
|-------|------|------------------------------|
| Storage | `src/lib/schema.js` — CREATE TABLE + v7 migration | Persist the column; migrate existing DBs |
| Persistence helpers | `src/lib/schema.js` — `atomWrite`, `atomPatch` | **Sole** validation point; upsert/patch semantics |
| Read queries | `src/lib/schema.js` — `atomList`, `atomSearch`, `atomGet` | Select `summary` alongside `preview` |
| Display | `src/lib/signal-utils.js` `renderAtomLine`; `src/plugin.js` list/search/get formatters | Apply `summary || preview` fallback |
| Tool contract | `src/plugin.js` — `memory_atom_write`, `memory_atom_patch` Zod schemas; `MEMORY_PROTOCOL` | Require/accept `summary`; document it |

## Schema design

### Column type — `summary TEXT NOT NULL DEFAULT ''`

The column mirrors the existing `description` column exactly: `TEXT NOT NULL
DEFAULT ''`, with the empty string (not `NULL`) representing "unset".

*Option A — `TEXT` nullable (`NULL` = unset).* Rejected. It would introduce a
second "absent" sentinel (`NULL`) alongside the codebase's established empty-string
convention, forcing every read site to handle both `NULL` and `''`. No behavioural
gain.

*Option B (chosen) — `TEXT NOT NULL DEFAULT ''`.* Consistent with `description`,
so the display fallback (`summary || preview`) and the non-empty helper check work
identically to the patterns already in the code. Existing rows acquire `''`
automatically on migration and fall through to the preview path.

### Migration v7 — `ALTER TABLE ADD COLUMN`, no FTS change

v7 follows the exact shape of the v3 (`pinned`) and v6 (`always_include`)
migrations, which are the established precedent for adding a non-nullable-with-
default column to `memory_atom`:

1. Gate on `PRAGMA user_version < 7`.
2. Shape-probe `PRAGMA table_info(memory_atom)` for the absence of `summary`
   (`ALTER TABLE ADD COLUMN` is not idempotent in SQLite — the probe prevents a
   duplicate-column error if the version marker and the physical schema ever
   drift).
3. If absent: `BEGIN` → `ALTER TABLE memory_atom ADD COLUMN summary TEXT NOT NULL
   DEFAULT ''` → `PRAGMA user_version = 7` → `COMMIT` (with `ROLLBACK` on error).
4. If already present (fresh install, whose baseline CREATE TABLE includes
   `summary`): bump the version marker only.

The fresh-install baseline `CREATE TABLE memory_atom (...)` must also list
`summary`, so a new database is born at the target shape and the v7 phase simply
stamps the marker.

### Decision: `summary` is NOT FTS-indexed

The `memory_atom_fts` virtual table and its three sync triggers
(`memory_atom_ai/ad/au`) index `topic, description, content, tags`. `summary` is
deliberately **excluded**.

*Option A — add `summary` to FTS.* The FTS table and triggers are created with
`CREATE … IF NOT EXISTS` guards, so they are never re-evaluated on an existing
database. Adding a column to the FTS schema therefore requires an imperative
migration: `DROP TRIGGER ×3` + `DROP TABLE memory_atom_fts` + recreate both with
the new column + `INSERT INTO memory_atom_fts(memory_atom_fts) VALUES('rebuild')`
to repopulate. That is the single largest complexity and failure-surface item in
the whole change — and it must run under the FTS5-may-be-absent `try/catch` the
codebase already carries. The recall benefit is marginal: `summary` is a digest
of `content`, which is *already* indexed, so the terms an agent would search for
are almost always present in the indexed `content` anyway.

*Option B (chosen) — do not index `summary`.* Reduces v7 to a single
`ALTER TABLE ADD COLUMN` with no FTS DDL, no rebuild, and no interaction with the
FTS5-availability fallback. Search recall is unchanged in practice because the
underlying content is still indexed. This is the YAGNI outcome: the indexing cost
is real and present; the recall need is speculative.

**Trade-off accepted:** a term that appears *only* in a hand-written `summary`
and nowhere in `content` will not match an FTS query. This is judged negligible
because a faithful digest draws its vocabulary from the content it summarises.

## Data flow

```mermaid
flowchart TD
  subgraph Write path
    W[memory_atom_write tool] -->|summary required, non-empty, ≤280| WV{atomWrite<br/>validate}
    WV -->|reject empty / >280| WErr[throw]
    WV -->|ok| UP[INSERT … ON CONFLICT DO UPDATE SET<br/>summary = excluded.summary]
  end
  subgraph Patch path
    P[memory_atom_patch tool] -->|summary optional| PV{atomPatch<br/>validate}
    PV -->|reject empty / >280| PErr[throw]
    PV -->|ok| PU[UPDATE … SET summary = ?]
  end
  subgraph Append path
    A[memory_atom_append] --> AU[UPDATE content only<br/>summary untouched → may go stale]
  end
  UP --> DB[(memory_atom)]
  PU --> DB
  AU --> DB
  subgraph Read path
    DB --> R[atomList / atomSearch / atomGet.alsoIn<br/>SELECT summary, substr content,1,80 AS preview]
    R --> F[renderAtomLine / tool formatters<br/>summary || preview]
    F --> OUT[directory listing line]
  end
```

**Write.** `summary` joins the `ON CONFLICT(scope, project, topic) DO UPDATE SET`
clause — the same treatment as `description`, and deliberately *unlike*
`pinned`/`always_include`/`status`, which are INSERT-only. Re-writing an atom is a
content refresh, and the summary describes the content, so a re-write must be able
to refresh the summary too.

**Patch.** `summary` is added to the `PATCHABLE` array so agents can retroactively
add or correct a summary on an older atom without rewriting its content. Patching
`summary` bumps `updated_at` (it is a substantive metadata change), consistent
with how `description` patches behave.

**Append.** `atomAppend` touches only `content`. It does **not** re-derive
`summary`. See Known limitations.

**Read.** The three listing queries add `summary` to their `SELECT` lists,
keeping the existing `substr(content, 1, 80) AS preview` alongside it. `atomGet`'s
primary `match` still returns full `content` and is unaffected; only its `alsoIn`
sibling rows carry the `summary`/`preview` pair.

## Validation — single source of truth

Validation lives in the persistence helpers `atomWrite` and `atomPatch` in
`schema.js`, mirroring the existing `description` non-empty check. Both enforce:

- **non-empty** (after trim), and
- **≤ 280 characters**.

*Why the helper, not a SQLite `CHECK` constraint.* A `CHECK(length(summary) <=
280 AND length(trim(summary)) > 0)` would split enforcement across two layers and
break the existing convention — `description`'s non-empty rule is enforced in JS,
not in the schema. A single JS enforcement point yields uniform, testable error
messages and keeps the migration a plain `ADD COLUMN`. The `CHECK` is rejected for
consistency, not capability.

The tool layer does **not** re-validate length; it surfaces the 280-character
limit as a **UX hint** in the Zod field's `.describe()` text so the authoring
agent sees the constraint, while the helper remains the authority that actually
rejects violations. The write path makes the Zod arg **required** (non-optional)
so a missing `summary` fails fast at the tool boundary with a clear schema error;
the emptiness/length checks still ultimately rest in `atomWrite`.

## Display fallback strategy

One rule, applied at every display site:

> Show `summary` when non-empty; otherwise fall back silently to `preview`
> (`substr(content, 1, 80)`). When both are empty, omit the content segment and
> its `| ` / `— …` separator entirely.

`renderAtomLine` (`signal-utils.js`) switches its content source from
`atom.preview` to `atom.summary || atom.preview`. Critically, the truncation-to-80
and unclosed-backtick-repair logic is **removed from the summary branch**:
`summary` is author-controlled and already ≤ 280 characters, so it needs neither
slicing nor Markdown-corruption defence. Those guards remain only on the
preview-fallback branch, where the raw content slice can still cut mid-token.

The same fallback is applied in the `plugin.js` formatters for `memory_atom_list`,
`memory_atom_search`, and the `memory_atom_get` `alsoIn` block, so a reader sees
identical behaviour regardless of which surface produced the line.

## Breaking change

`memory_atom_write` requires a non-empty `summary` argument. Existing callers that
omit it fail Zod validation. This is intentional and documented:

- Making `summary` optional would let agents keep writing atoms with no digest,
  leaving the listing-quality problem unsolved for all new atoms — the field would
  decay into an ignored option.
- Requiring it on write, while allowing `memory_atom_patch` to backfill older
  atoms, is the smallest forcing function that guarantees every *newly* written
  atom is actionable in the directory, without a bulk data migration of historical
  rows.
- The blast radius is confined to the write tool's callers (agents), not to stored
  data: no existing row is invalidated — pre-`summary` atoms simply keep using the
  `preview` fallback until patched.

`MEMORY_PROTOCOL` is updated to document `summary` as: a content digest, required
on write, patchable, ≤ 280 chars, shown in listings, distinct from `description`,
and potentially stale after `atom-append`.

## Known limitations

- **Append staleness.** `atomAppend` intentionally does not update `summary`, so a
  summary can under-describe content that has grown via append. Re-summarising on
  append would require the tool to author new prose, which the append path (a cheap
  content concatenation) has no basis to do. The accepted resolution is
  documentation (`MEMORY_PROTOCOL` notes the staleness) plus the existing
  `memory_atom_patch` path for an agent to refresh the summary when it matters.
- **FTS gap.** Summary-only vocabulary is not searchable (see the FTS decision
  above); accepted as negligible.

## Component breakdown

Each item states *what*, the *work-kind*, and its *done-criterion*. No agent is
assigned; sequencing and task planning belong to the implementing agent.

1. **Schema baseline + v7 migration** — *application code (SQLite DDL in JS)*.
   Add `summary` to the fresh-install `CREATE TABLE`; add the v7 phase
   (`user_version < 7` gate, column-absence probe, `ALTER TABLE ADD COLUMN`,
   version stamp, transactional). *Done when:* a fresh DB and a v6 DB both end at
   `user_version = 7` with a `summary` column, and re-running `ensureSchema` is a
   no-op.
2. **`atomWrite` validation + upsert** — *application code*. Enforce non-empty and
   ≤ 280; add `summary` to INSERT columns and to `ON CONFLICT DO UPDATE SET`.
   *Done when:* empty/over-length summaries throw; a re-write refreshes the summary.
3. **`atomPatch` validation + patchability** — *application code*. Add `summary`
   to `PATCHABLE`; enforce non-empty and ≤ 280; bump `updated_at`. *Done when:* an
   older atom can acquire a summary via patch, and invalid values are rejected.
4. **Read queries** — *application code*. Add `summary` to the `SELECT` lists of
   `atomList`, `atomSearch`, and `atomGet`'s `alsoIn` query. *Done when:* every
   listing row carries both `summary` and `preview`.
5. **Display fallback** — *application code*. Update `renderAtomLine`
   (`summary || preview`, drop truncation/backtick-fix on the summary branch) and
   the three `plugin.js` list/search/get formatters. *Done when:* atoms with a
   summary show it verbatim; atoms without one show the preview; both-empty shows
   no content segment.
6. **Tool contract** — *application code*. Make `summary` a required Zod arg on
   `memory_atom_write` (with the 280-char UX hint in `.describe()`); add optional
   `summary` to `memory_atom_patch`; thread `summary` through the CLI
   `atom-write`/`atom-patch` payloads. *Done when:* the write tool rejects a
   missing summary at the schema boundary and the patch tool accepts one.
7. **`MEMORY_PROTOCOL` doc** — *application code (doc string)*. Document `summary`
   per the breaking-change section. *Done when:* the protocol text describes the
   field, its constraints, and its append-staleness caveat.
8. **Tests** — *application code (tests)*. Migration idempotency (v6→v7, fresh
   install), CRUD carrying `summary`, validation (empty/over-length rejected),
   patch backfill, and the display-fallback matrix (summary / preview / both-empty).
   *Done when:* all paths above are covered and green.

## Research needs

None required. All decisions rest on facts verified directly in
`src/lib/schema.js`, `src/lib/signal-utils.js`, and `src/plugin.js` (migration
pattern, FTS trigger structure, `description` validation precedent, upsert
semantics, and the preview-render logic). No external version, API, or service
fact is relied upon.
