# Design — atom-get-full-content-and-patch-tool

## Context

Two capabilities are added to the atom subsystem:

1. `memory_atom_get` gains an optional `workspace` path argument so an agent can
   promote a foreign-workspace atom (previously visible only as a truncated
   `alsoIn` preview) into a full-content primary match.
2. A new `memory_atom_patch` tool performs a partial, content-preserving metadata
   update (`description`, `tags`, `created_at`).

Both slot into the established 3-layer atom pattern with **no** DB schema change,
**no** new dependency, and **no** change to any existing tool signature. This
document records only the decisions that are *not* mechanically derivable from
that pattern; anything not discussed here follows the existing atom commands
verbatim.

### The 3-layer pattern (given, unchanged)

```mermaid
flowchart LR
  A["plugin.js tool<br/>(resolveScope, arg validation,<br/>output formatting)"]
    -->|spawnMemory $, ['atom-cmd', scope, project, …]| B["memory.js<br/>cmdAtom* (sole-writer CLI,<br/>JSON stdout / stderr+exit1)"]
  B -->|"atom*(db, {scope,project,…})"| C["schema.js<br/>pure SQLite op<br/>(BEGIN IMMEDIATE for writes)"]
  C -->|"AFTER UPDATE trigger memory_atom_au"| D["memory_atom_fts<br/>(auto re-index)"]
```

Layer boundaries are load-bearing: the plugin owns agent-facing shape and scope
resolution; the CLI owns process/exit-code contract and JSON serialisation; the
schema function owns the transaction and the SQL. Each new piece is added at all
three layers, mirroring `atom-append` / `atomAppend` for the write path and
`atom-get` / `atomGet` for the read path.

---

## Decision 1 — `workspace` override is a plugin-layer scope resolution, orthogonal to `scope`

`scope` and `workspace` are **independent axes** and never conflict:

- `scope` selects *which resolution rule* runs (`global`, `all`, or
  project-relative). Today `resolveScope(scope, directory)` maps `project` to
  `context.directory`.
- `workspace` only substitutes a *different directory* into the one rule that
  already consumes a directory — the `project` branch. It answers "resolve
  against **this** path instead of the session's cwd".

### Options considered

- **A — Substitute the directory at the plugin, before `resolveScope` (chosen).**
  In `memory_atom_get.execute`, compute the effective directory as
  `workspace ?? context.directory` and pass it as the second argument:
  `resolveScope(scope, workspace ?? context.directory)`. The CLI positional
  contract `atom-get <scope> <project> <topic>` is untouched — `project` simply
  carries the overridden path. `atomGet`'s existing workspace→global fallback
  then runs against that path for free, so a foreign atom returns via
  `result.match` on the identical code path as a local one (satisfying the
  "full content, same path" requirement with zero new schema logic).

- **B — Add a `--workspace` flag threaded through CLI and schema.** Rejected:
  introduces a new positional/flag into three layers and a second directory
  concept in `atomGet`, for a value that is semantically *just the project
  directory*. Pure overhead — the CLI already accepts an arbitrary `project`
  string.

**Recommendation: A.** It reuses the existing `project` positional as the sole
carrier of "which workspace", keeps `resolveScope` the single point of scope
truth, and adds no cross-layer surface.

### Interaction rules to encode

- `workspace` present + `scope` absent/`workspace` → resolve `project` against
  the given path (the intended use).
- `workspace` present + `scope='global'` → **`global` wins**; the override is
  inert, because `resolveScope` short-circuits `global` before it ever reads the
  directory. Document this precedence in the tool description rather than
  erroring — it is harmless and predictable.
- `workspace` absent → today's behaviour, byte-for-byte.

Apply the identical `workspace ?? context.directory` substitution in
`memory_atom_patch` (Decision 5) so the two tools share one mental model.

---

## Decision 2 — `alsoIn` rendering: make the path a single extractable token

The `alsoIn` **query result is unchanged** (`atomGet` still returns
`scope, project, topic, description, preview, created_at, updated_at`). Only the
plugin's render loop changes.

- **Before:** `• ${a.scope}/${a.project || '(global)'}: ${a.topic} — …`
  → `• project//home/user/repo: topic — …` (double slash, path fused to scope,
  not machine-extractable).
- **After:** `• [workspace: ${a.project}] ${a.topic} — ${a.description} | ${a.preview || ''} [created: …, updated: …]`
  → `• [workspace: /home/user/repo] topic — …`

The `[workspace: <path>]` delimiter is deliberate: it is exactly the string the
tool description tells the agent to copy into the `workspace` argument, closing
the get→identify→re-get loop without a second session.

### Edge case the implementer must handle

`alsoIn` can contain a **global** atom (scope `global`, `project=''`) — this
happens only when no primary match was found (see the `? IS NULL` guard in
`atomGet`). Rendering `[workspace: ]` for it would be an un-actionable hint (you
cannot pass an empty path as `workspace`). Render such entries as `• [global] …`
instead, so the displayed hint maps to a real follow-up (`scope="global"`). This
is the one branch in the new render logic.

---

## Decision 3 — `atomPatch` transaction discipline and free FTS re-index

`atomPatch` is a read-modify-write (it must read the current row to enforce the
non-empty-description invariant and to decide `updated_at`), so it uses the same
`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`-on-throw envelope as `atomAppend`.
`BEGIN IMMEDIATE` takes the write lock up front, preventing a check-then-write
race against a concurrent sole-writer invocation.

**FTS needs no explicit handling.** `memory_atom_fts` is an external-content FTS5
table kept in sync by the `memory_atom_au` trigger (`AFTER UPDATE ON
memory_atom`), which deletes the old shadow row and inserts the new
`topic/description/content/tags`. Because `atomPatch` mutates the base table with
an ordinary `UPDATE`, the trigger fires automatically and re-indexes the changed
`description`/`tags`. Writing to `memory_atom_fts` directly, or re-implementing
the delete+insert, would duplicate the trigger and risk index drift — do **not**
do it.

---

## Decision 4 — `updated_at` is bumped only on description/tags change

Rule: `updated_at = Date.now()` **iff** the patch changes `description` or
`tags`. A `created_at`-only patch leaves `updated_at` untouched.

**Why:** primer assembly orders atoms by recency using `updated_at`. Re-dating a
migrated atom (the motivating use case) sets a *historical* `created_at` and must
not masquerade as fresh activity — bumping `updated_at` there would jump the atom
to the top of the recency ordering, the opposite of intent. Conversely, editing
`description`/`tags` *is* a real content-of-record edit and should refresh
recency, matching `atomWrite`/`atomAppend`.

Compute this inside `atomPatch` (the layer that already knows which fields are
present), not in the plugin — keeping the temporal policy next to the SQL that
applies it.

---

## Decision 5 — Partial-update semantics: build the `UPDATE` from present fields, in JS

"Absent = keep" must distinguish three states per field: **absent** (keep),
**present-and-empty** (e.g. `tags: []` → clear), and **present-and-set**
(replace). A plain SQL `COALESCE(?, col)` cannot express this — it collapses
"absent" and "explicit null/empty" into one, and it cannot conditionally skip the
`updated_at` bump.

### Options considered

- **A — SQL `COALESCE(?, col)` per column.** Rejected: cannot tell `tags: []`
  (clear) from `tags` absent (keep), and cannot gate `updated_at`.
- **B — Read the row, then build a dynamic `UPDATE` from only the present patch
  keys, inside the `BEGIN IMMEDIATE` transaction (chosen).** The plugin passes a
  `patch` object containing *only* the keys the caller supplied. `atomPatch`
  inspects presence with `Object.prototype.hasOwnProperty`/`in` (not truthiness —
  `''` and `[]` are meaningful), appends a `col = ?` fragment + bound value for
  each present field, conditionally appends `updated_at = ?` per Decision 4, and
  runs one `UPDATE … WHERE scope=? AND project=? AND topic=?`.

**Recommendation: B.** It is the only shape that honours all three states and the
conditional `updated_at`, and it stays a single UPDATE (one trigger firing).

### Guards (in `atomPatch`, order matters)

1. **At least one recognised field.** If the patch carries none of
   `description` / `tags` / `created_at`, throw before touching the DB
   ("at least one of description, tags, created_at required").
2. **Existence.** `SELECT … WHERE scope/project/topic`; if no row, `ROLLBACK`
   and throw `Atom '<topic>' does not exist` (mirrors `atomAppend`'s message).
3. **Non-empty description invariant.** If `description` is present, it must be a
   non-empty trimmed string (reuse `atomWrite`'s check); `description: ""`
   throws. Store `description.trim()`.
4. **`tags` normalisation.** Present `tags` array → `JSON.stringify(tags)` (same
   `[]`-default encoding as `atomWrite`); `tags: []` therefore stores `'[]'`.

The "at least one field" guard is enforced at **both** the plugin (fast, clear
agent-facing error) and the schema function (authoritative, protects the CLI as a
standalone entry point) — cheap and consistent with the layered validation
already present.

---

## Decision 6 — `created_at` type normalisation happens in the plugin

`created_at` accepts an ISO 8601 string **or** epoch-ms number. Normalise it to
epoch ms in the **plugin**, reusing `memory_atom_write`'s exact block: number →
pass through; string → `new Date(str).getTime()` with a `Number.isFinite` guard
returning a friendly `Error: created_at "…" is not a valid ISO 8601 date string.`
on failure.

**Why the plugin, not the schema:** it is where the write tool already does this,
so the two tools present an identical `created_at` contract; it keeps the
CLI/schema boundary carrying a single normalised integer type (the JSON crossing
`spawnMemory` stays `{ createdAt: <number> }`); and validation failure returns as
a tool-result string without spawning the CLI at all. `atomPatch` then treats
`created_at` as "present → set the `created_at` column to this integer" with no
`updated_at` side effect (Decision 4).

---

## Decision 7 — Error contract and exit codes

Follow the `atom-append` / `atom-delete` precedent exactly:

- **Schema layer** (`atomPatch`) throws `Error` for: missing atom, empty
  description, zero patch fields. On throw inside the transaction it `ROLLBACK`s
  first.
- **CLI layer** (`cmdAtomPatch`): parse the JSON arg (invalid JSON →
  `stderr` + `exit(1)`); on success `process.stdout.write(JSON.stringify({ ok:
  true, … }))`; on caught `Error` → `stderr` `[agent-memory/atom-patch] <msg>` +
  `db.close()` + `exit(1)`. Success is exit 0 with a single JSON line.
- **Plugin layer**: `spawnMemory` rejects on non-zero exit; the tool's
  `try/catch` returns `Error patching atom: <message>` as the tool output. The
  validation guards that run *before* spawning (zero fields, bad `created_at`,
  `scope='all'` rejection like write/delete) return their own tool-result
  strings.

Return payload from a successful patch should name the topic and, usefully, which
fields changed (e.g. `Patched atom '<topic>' (description, tags).`) so the agent
gets confirmation of exactly what was altered.

---

## Decision 8 — `MEMORY_PROTOCOL` blurb is capped at 2 lines

`MEMORY_PROTOCOL` is injected into **every** targeted session's system prompt, so
its length is a per-session token cost paid indefinitely. The new tool earns only
a 2-line mention — what it does (correct `description`/`tags`/`created_at` without
rewriting content) and the one disambiguation an agent needs (`memory_atom_patch`
for metadata; `memory_atom_write` when content itself changes). No examples, no
partial-update rules — those live in the tool's own `description`, which the model
sees only when it inspects the tool, not on every turn. Resist expanding this
blurb; detail belongs in the tool description, not the always-on protocol.

---

## Resilience & failure modes

- **Concurrency:** `BEGIN IMMEDIATE` serialises `atomPatch` against other writers;
  the sole-writer CLI model already funnels all writes through one process class.
  Blast radius of a failed patch is one row and one transaction — `ROLLBACK`
  leaves the atom and its FTS shadow untouched.
- **FTS unavailability:** if SQLite lacks FTS5 the triggers were never created
  (graceful `try/catch` in `ensureSchema`); the base-table `UPDATE` still
  succeeds and search degrades to the existing LIKE fallback. No new failure mode.
- **Recovery:** all error paths are non-destructive — bad input, missing atom, or
  empty description abort before or during the transaction with a clear message;
  no partial write is possible.
- **Scaling:** single-row UPDATE keyed on the `(scope, project, topic)` unique
  index; O(1), no scan.

---

## YAGNI — deliberately excluded

- **No `scope="all"` patch / no bulk cross-workspace patch.** Multi-workspace
  targeting is served by the explicit `workspace` path or `scope="global"`. A
  "patch everywhere" mode is unrequested and dangerous (fan-out write with no
  clear intent). Reject `scope="all"` at the plugin, as write/delete already do.
- **No new `--workspace` CLI flag / schema parameter** (Decision 1B) — the
  existing `project` positional carries it.
- **No `content` field in patch** — that is exactly what `memory_atom_write` /
  `memory_atom_append` are for; adding it would blur the tool's one purpose.
- **No dynamic ORM / query builder** — one hand-built parameterised `UPDATE`
  string from a fixed 3-field allowlist is sufficient and keeps the raw-SQLite,
  no-ORM constraint.
- **No direct FTS writes** (Decision 3) — the trigger already covers it.

---

## Component breakdown

| # | Component | Work kind | Done when |
|---|-----------|-----------|-----------|
| 1 | `resolveScope` call sites in `memory_atom_get` (+ new `workspace` arg) | Application code (plugin) | `workspace` arg declared optional; effective directory = `workspace ?? context.directory`; existing no-`workspace` behaviour unchanged; tool description updated per proposal. |
| 2 | `alsoIn` render loop reformat | Application code (plugin) | Emits `• [workspace: <project>] …`; global entries render `• [global] …`; created/updated suffix preserved. |
| 3 | `atomPatch(db, {scope, project, topic, patch})` | Application code (schema) | `BEGIN IMMEDIATE`; present-field detection via `in`/`hasOwnProperty`; guards (≥1 field, existence, non-empty description, tags→JSON); conditional `updated_at`; single dynamic `UPDATE`; throws documented errors with `ROLLBACK`. |
| 4 | `cmdAtomPatch` + `case 'atom-patch'` + usage string | Application code (CLI) | Parses JSON arg; calls `atomPatch`; JSON stdout on success; stderr+`exit(1)` on error; `db.close()` on both paths; usage/dispatch list updated. |
| 5 | `memory_atom_patch` tool (define + register in `tool` export) | Application code (plugin) | Args `topic`, `description?`, `tags?`, `created_at?`, `scope?`, `workspace?`; `created_at` normalised as in `memory_atom_write`; `scope="all"` rejected; ≥1-field pre-check; spawns `atom-patch`; returns confirmation naming changed fields; added to exported `tool` map. |
| 6 | `MEMORY_PROTOCOL` 2-line addition | Docs (in-code constant) | ≤2 lines; states patch-vs-write distinction; no examples. |
| 7 | Tests | Application code (test) | Per proposal Impact: `schema.test.js` (all `atomPatch` cases incl. `updated_at`-not-bumped-on-`created_at`-only, `tags:[]` clears, absent `tags` keeps, ISO/epoch, missing-atom, empty-description); `memory-cli.test.js` (`atom-patch`); `plugin-safety.test.js` (`memory_atom_patch` registration + arg validation, `memory_atom_get` `workspace` arg, `alsoIn` format). |

> UI note: no user-facing visual surface — the only rendered output is the plain
> `alsoIn` text line (Component 2). No `ui-designer` pass required.

---

## Research needs

None required. Every fact this design relies on — the 3-layer atom pattern, the
`BEGIN IMMEDIATE` envelope, the `memory_atom_au` FTS trigger behaviour, the
`created_at` normalisation block, `resolveScope` semantics, and the CLI
exit-code/JSON contract — was read directly from the current source
(`src/plugin.js`, `src/memory.js`, `src/lib/schema.js`) during this design.
