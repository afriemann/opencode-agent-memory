## Why

Agents working in a project need certain atoms — project conventions, user preferences, standing instructions — immediately available at session start without having to remember to fetch them. Today every atom appears in the primer as a single compact line (topic, description, and an 80-char preview), requiring a separate `memory_atom_get` call to access the full content. For a handful of high-value atoms that are read on almost every session, this lookup step adds noise and risks the agent simply forgetting to fetch them.

## What Changes

- A new `always_include` boolean flag is added to memory atoms.
- When `always_include` is true, the atom's **complete content** is rendered as a full block directly inside the session primer, in a dedicated section placed **after `### Recent sessions` and before the compact `### Project atoms` directory**.
- Always-included atoms are **excluded from the compact directory listing** — they already appear in full, so the preview line would be pure duplication.
- A **count cap of 5** always-include atoms is enforced per section (workspace scope and global scope independently). When more than 5 atoms carry the flag, the 5 most recently updated are rendered; the rest are listed compactly with a note.
- Multiple always-include atoms within a section are rendered **ordered alphabetically by topic** for stable, predictable output.
- The flag is INSERT-only on write (re-writing an atom never silently clears it); it is togglable via `memory_atom_patch`.
- The `memory_atom_write` and `memory_atom_patch` tool definitions are updated to expose the flag.
- The MEMORY_PROTOCOL text is updated to teach agents when and how to use `always_include`, including an explicit misuse warning.

## Capabilities

### New Capabilities

_(none — this extends existing capabilities)_

### Modified Capabilities

- `memory-atom`: new `always_include` schema column (v6 migration); `atomWrite`, `atomPatch`, `atomList` updated to store, toggle, and return the flag; `atomList` does NOT return full content — the primer fetches content separately for flagged atoms.
- `signal-processing`: `assemblePrimer` renders atoms with `always_include=true` as full content blocks in a new `### Standing context` section (after Recent sessions, before the compact directory); always-include atoms are omitted from the compact directory sections.
- `memory-atom-tools`: `memory_atom_write` tool gains optional `always_include` argument; `memory_atom_patch` `patch` sub-object gains `always_include`; MEMORY_PROTOCOL updated.

## Impact

- `src/lib/schema.js` — schema v6, atomWrite, atomPatch, atomList
- `src/lib/signal-utils.js` — assemblePrimer (new renderAtomBlock helper + standing-context section; exclusion of always-include atoms from compact directory)
- `src/memory.js` — cmdAtomWrite, cmdAtomPatch forward always_include
- `src/plugin.js` — memory_atom_write, memory_atom_patch tool schemas + MEMORY_PROTOCOL text
- Tests — schema, signal-utils, plugin-safety
- No new dependencies; no breaking changes to existing tool APIs (always_include defaults to false)

## MEMORY_PROTOCOL draft (proposed)

> **Atom full-include flag — `always_include`**
>
> Set `always_include: true` on atoms whose **full content** should appear in every session primer without a `memory_atom_get` call — for example: project coding conventions, user preferences, standing task context, or recurring checklists.
>
> **Use sparingly.** Up to 5 always-include atoms render in full per section (workspace + global). Prefer `pinned` for anything that only needs to be findable in the directory at the top of the list; use `always_include` only when you expect to need the **complete text** before the user's first message, and the atom is under ~500 words. Do not mark long-form content (spec documents, logs, large code samples) as `always_include`.
>
> Toggle with: `memory_atom_patch(topic=..., patch={always_include: true})`.
>
> Distinction from `pinned`: a pinned atom appears at the **top of the compact directory listing** (one line, no cap). An always-include atom's **full content is injected before the directory** (no fetch needed, counts toward the 5-atom limit).
