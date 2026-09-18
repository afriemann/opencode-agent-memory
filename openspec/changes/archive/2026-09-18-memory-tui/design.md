# Design: memory-tui

See `proposal.md` for motivation and requirements; this document covers only how the TUI, its spawn layer, and the two new `memory.js` subcommands are built.

## Context

`memory.js` (`src/memory.js`) is the sole DB writer, invoked today only by `src/plugin.js` via Bun's `$` tagged-template shell. This change adds a second, independent caller: a standalone Ink-based TUI process that must reach `memory.js` without Bun's `$` (it runs under plain Node) and must never import `src/lib/db.js` / `src/lib/schema.js` directly. It also needs two read-oriented capabilities `memory.js` doesn't currently expose: a faithful primer preview (mirrors `assemblePrimer` fed real `plugin.js`-derived inputs) and a list of agent+project pairs that have `hot_state` rows.

Ground truth used below (see task brief for line numbers): `src/lib/signal-utils.js:106` (`assemblePrimer`), `src/plugin.js` primer-input assembly (~L312–373, incl. `gitStaleness` from `src/lib/git-helper.js:37`, `since24h` window, `resolveConfig`'s `atomInjectCap`), `src/lib/schema.js` exports, `src/lib/config.js`, and `memory.js`'s existing subcommand contracts (positional-argv JSON, inconsistent stderr prefixes, no machine-readable error envelope).

## Goals

- Define the Ink component tree, file layout, and cross-screen state model for the 4 screens.
- Define a TUI-side spawn/IO wrapper around `node:child_process` `execFile` (not Bun `$`), with an explicit contract for return shape, error surfacing, and timeouts.
- Fully specify the two new `memory.js` subcommands' argument/output shapes and how they're implemented without Bun `$`.
- Fully specify the `$EDITOR` flow via `suspendTerminal()`.
- Define error/loading/empty-state handling per screen and the testing strategy.
- Record accepted trade-offs (spawn-per-screen-load, TOCTOU, ARG_MAX) without relitigating them.

## Non-Goals

- Anything listed under proposal.md's "Out of Scope" (atom creation, full-text search, `atom-append`, `hot_state` editing, cross-workspace move wiring, optimistic concurrency, a long-lived server process).
- Changing `src/plugin.js`, `src/lib/db.js`, or `src/lib/schema.js`'s existing exports' behavior.

## Decisions

### 1. Component architecture

**File layout** (new, all under `src/tui/`, entry re-exported at `src/tui.js` for `node src/tui.js` / `bin/agent-memory-tui`):

```
src/tui.js                        # entry: parses AGENT_MEMORY_DB env, renders <App/>
bin/agent-memory-tui               # #!/usr/bin/env node → requires src/tui.js
src/tui/App.jsx                    # app shell: screen router + global key handling (q/Esc)
src/tui/state/AppStateContext.jsx  # React Context + reducer (see below)
src/tui/spawn/memoryClient.js      # spawnMemory() wrapper (Decision 2)
src/tui/screens/MainMenu.jsx
src/tui/screens/PrimerInspector.jsx
src/tui/screens/AtomBrowser.jsx
src/tui/screens/AtomDetail.jsx
src/tui/components/ListPane.jsx        # shared scrollable list w/ focus ring
src/tui/components/PreviewPane.jsx     # shared right-hand preview
src/tui/components/StatusLine.jsx      # loading/error/empty banner
src/tui/components/ConfirmOverlay.jsx  # dashed-border confirmation (delete)
```

**Screen routing**: a plain `useReducer`-driven state machine, not a router library. A `screen` enum (`'menu' | 'primer' | 'browser' | 'detail'`) plus a small navigation stack (array of `{screen, params}`) held in `AppStateContext`, so `Esc` pops the stack (satisfying "Esc always returns to the previous screen") instead of hard-coding each screen's predecessor. This is the smallest mechanism that satisfies the wireframe's linear-with-back-esc flow — no CLI-router package is justified (YAGNI: 4 screens, one shared back gesture).

**Cross-screen state** lives in the reducer, not prop-drilling or per-screen `useState`, because multiple screens read/write the same slice (selected agent+project, selected scope, selected atom, in-flight/error/empty status per screen):

```js
{
  nav: [{screen: 'menu'}],                 // stack; last = current
  primer: { agent: null, project: null },  // set by PrimerInspector picker
  browser: { scope: 'project' },           // 'project' | 'global' toggle
  selectedAtom: null,                      // {workspace, topic} chosen in AtomBrowser
  status: { kind: 'idle'|'loading'|'error'|'empty', message?: string },
}
```

Actions: `PUSH_SCREEN`, `POP_SCREEN`, `SET_PRIMER_TARGET`, `SET_SCOPE`, `SET_SELECTED_ATOM`, `SET_STATUS`. Each screen fetches its own data in a `useEffect` keyed on the relevant state slice, dispatching `SET_STATUS` before/after — this is what guarantees the Primer Inspector's "always a fresh read, no caching across screen visits" requirement: no memoized fetch result is kept once a screen unmounts, and mounting re-fetches.

Local, screen-only concerns (which list row has cursor focus, whether the edit-content diff prompt is showing) stay in `useState` inside that screen component — they don't need to survive navigation and don't need to be in the shared reducer.

### 2. Spawn/IO layer design

New module `src/tui/spawn/memoryClient.js`, wrapping `node:child_process` `execFile` (promisified), **not** Bun's `$`. It is a separate implementation from `plugin.js`'s `spawnMemory` — no code is shared or reused between them, because the two run in fundamentally different runtimes (Bun-plugin-hosted vs plain-Node-process) and reuse would require an abstraction over `$` vs `execFile` that pays for itself only if a third caller appears (YAGNI).

Contract:

```js
// spawnMemory(cmd: string, args: string[]) => Promise<{ok: true, data: unknown} | {ok: false, message: string}>
```

- Resolves `memory.js`'s path relative to the TUI package root (`import.meta.resolve` / `fileURLToPath` sibling lookup — same package, so no separate install-location config needed).
- Invokes `execFile(process.execPath, [memoryJsPath, cmd, ...args], {env: {...process.env, AGENT_MEMORY_DB: process.env.AGENT_MEMORY_DB}, timeout, maxBuffer})`. `AGENT_MEMORY_DB` passthrough is explicit and defensive (it's already inherited via `...process.env`, but naming it makes the requirement visible in the diff and guards against a future `env` shape change that stops spreading `process.env` wholesale).
- **stdout on success** is JSON — `JSON.parse`d and returned as `{ok: true, data}`. A parse failure is treated as `{ok: false, message: 'malformed response from memory.js'}` rather than thrown, so callers never need a try/catch.
- **stderr/non-zero exit**: because `memory.js`'s stderr prefix is inconsistent (`[memory.js] <cmd> failed: …` vs `[agent-memory/<cmd>] …`) and there is no machine-readable error envelope, the wrapper does **not** attempt to parse or classify the message — it returns `{ok: false, message: stderr.trim() || err.message}` verbatim. Screens display this raw string in the `StatusLine` error state; no attempt is made to map it to a typed error taxonomy, since that would require guessing at a contract `memory.js` doesn't actually provide (see Risk/Open Question below on hardening this later).
- **Timeout policy**: `execFile`'s `timeout` option set to **8000ms** — chosen as the existing SQLite `busy_timeout` (5s) plus headroom for process spawn/JSON-serialize overhead, not a new invented constant with its own rationale. On timeout, `execFile` sends `SIGTERM` and the wrapper returns `{ok: false, message: 'memory.js timed out (>8s) — the database may be locked'}`.
- **maxBuffer**: raised to 10 MB (Node's execFile default is 1 MB) since `primer-preview` and `atom-list-full` responses can be larger than typical CLI output; still finite because IPC through argv/stdout is inherently bounded (see ARG_MAX discussion in Risks).
- No retry logic — a failed call surfaces immediately as an error state; the user re-triggers via the same keybinding that caused the fetch.

### 3. New `memory.js` subcommand designs

Both are added as new `case` branches in `src/memory.js`'s existing subcommand dispatch, following the file's established shape (parse argv → call a `schema.js`/helper function → `console.log(JSON.stringify(result))` → catch → stderr + `exit(1)`).

**`primer-preview <agent> <project>`**

- Args: two positionals, `agent` (string) and `project` (string; empty string `''` is valid and means "non-git / no project" — must be accepted, not rejected, to cover the `assemblePrimer` non-git heading edge case).
- Output (stdout JSON): `{ primerText: string }` — deliberately just the rendered text, not a structured breakdown, because the Primer Inspector screen's job is to show *exactly* what a real session would receive, and returning intermediate structure would invite the TUI to re-render it differently from `assemblePrimer` (defeating the fidelity goal). If a future screen needs the structured inputs too, that's a new, additive subcommand — not a shape change to this one.
- Implementation: a new function in `src/memory.js` (or a thin new export added to `src/lib/signal-utils.js` if that's a better home — implementer's call, no behavior difference) that:
  1. Gathers the same 5 inputs `plugin.js` gathers (hot_state rows for the agent+project, project atoms, shared/global atoms, standing (`always_include`) atoms, cross-project rows within the existing `since24h` window) via the existing `schema.js` exports (`hotStateCrossProject`, `atomList`/`atomListFull`, etc. — reuse, don't duplicate).
  2. Computes `cap` via `resolveConfig` from `src/lib/config.js` (pure, already safe to import from `memory.js`, which already resolves config elsewhere).
  3. Computes `staleness` via git, **without Bun `$`**: replaces `gitStaleness`'s `$`-shaped shell parameter with `node:child_process` `execFileSync('git', ['rev-parse', 'HEAD'], {cwd: project, encoding: 'utf8'})` (and whatever other `git` invocations `gitStaleness` performs) wrapped in try/catch — a non-git or inaccessible `project` directory must degrade to "staleness unknown" rather than throwing, matching the non-git-heading edge case above. This is a **new** small helper (`gitStalenessNode(project, storedSha)`) parallel to `git-helper.js`'s existing `gitStaleness`, not a modification of the existing one — `git-helper.js`'s current export stays exactly as `plugin.js` needs it (Bun `$`-based); the two coexist because they run under different shells, not because of redundant design.
  4. Extracts the `since24h` constant: `plugin.js`'s current local constant is duplicated verbatim into wherever `primer-preview`'s implementation lives (or refactored into `src/lib/signal-utils.js` as a shared exported constant, again implementer's call — no observable behavior difference either way, so this is left as an implementation detail, not a design decision that needs to be pinned down now).
  5. Calls the existing pure `assemblePrimer(...)` with these inputs and returns `{primerText: assemblePrimer(...)}`.
- No new `schema.js` function is required beyond what's listed above — everything `primer-preview` needs already exists in `src/lib/schema.js`; it only needs a new *composition* point.

**`hot-state-list-pairs`**

- Args: none.
- Output (stdout JSON): `{ pairs: Array<{agent: string, project: string, sessionCount: number, lastUpdatedAt: string}> }` — `sessionCount` and `lastUpdatedAt` are included (not strictly required by the proposal) because the Primer Inspector's left-pane picker list is far more usable with a recency/activity signal than a bare agent/project tuple list, and both values fall out of the same `GROUP BY` query for free.
- Implementation: **one new `schema.js` export**, `hotStateListPairs(db)`, since this is a new distinct query shape (`SELECT agent, project, COUNT(*) AS sessionCount, MAX(updated_at) AS lastUpdatedAt FROM hot_state GROUP BY agent, project ORDER BY lastUpdatedAt DESC`) that doesn't compose from any existing `schema.js` function (`hotStateCrossProject` is scoped to a single project+window, not a global distinct-pairs enumeration). This keeps the SQL colocated with every other query in `schema.js` rather than leaking raw SQL into `memory.js`, consistent with the existing module boundary (`memory.js` calls `schema.js`; `schema.js` owns SQL).
- `memory.js`'s new `case` branch calls `hotStateListPairs(db)` and prints `{pairs}`.

### 4. `$EDITOR` flow implementation

Sequence, run entirely inside `AtomDetail.jsx`'s `[e] Edit` handler:

1. Fetch current atom content fresh (already loaded for the detail view — no extra spawn needed unless stale, per the same "fresh read" discipline as the Primer Inspector).
2. `await suspendTerminal(async () => { ... })` (Ink ≥7.1.0) wraps the whole edit sub-flow so Ink stops rendering for its duration.
3. Inside: write content to a temp file via `node:fs/promises` `mkdtemp` under `os.tmpdir()` (e.g. `agent-memory-tui-<random>/atom.md`) — a fresh per-edit temp **directory**, not a shared fixed filename, to avoid any collision between concurrent invocations and to make cleanup a single `rm(dir, {recursive: true, force: true})` call.
4. Cleanup-on-crash strategy: register the temp directory for removal via `try { ... } finally { await rm(tmpDir, {recursive: true, force: true}) }` around the whole edit-and-readback block — this covers the editor exiting non-zero or throwing. It does **not** cover the TUI process itself being killed (`SIGKILL`) mid-edit; that residual risk is accepted (stray temp dirs under `os.tmpdir()` are a pre-existing, self-cleaning-by-OS category of risk, not novel to this feature) rather than adding a `process.on('exit', ...)` handler whose reliability against `SIGKILL` is itself limited.
5. Spawn `$EDITOR` (falling back to `vi` if unset) against the temp file via `execFile`/`spawn` with `stdio: 'inherit'` (required for the editor to draw into the now-suspended terminal), `await`ing its exit code.
6. On exit code ≠ 0: discard — skip straight to cleanup, resume, and show an unchanged detail view (no `atom-write` call).
7. On exit code 0: read the temp file back, and diff its content against the original captured in step 1 (a simple string inequality check — no semantic diff needed). If unchanged, skip the write (avoids a needless `atom-write` and its `updated_at` bump). If changed, call `spawnMemory('atom-write', [contextDirectory, JSON.stringify({workspace, normalize_workspace, topic, content: newContent, description: atom.description, summary: atom.summary, tags: atom.tags})])` — re-sending the atom's existing `description`/`summary`/`tags` unchanged, because `atom-write`'s contract requires non-empty `description` on every call and does not support a content-only patch (per the proposal's ground truth; `atom-patch` also cannot carry `content`).
8. `suspendTerminal`'s callback returns; Ink resumes and repaints the detail view, re-fetching the atom fresh (so the on-screen content reflects exactly what `atom-write` persisted, not the locally-held pre-edit copy).

### 5. Error handling & loading/empty states

Each screen owns one `status: {kind, message}` slice (Decision 1) rendered by the shared `StatusLine` component, covering the full state set the `ui-development` skill requires:

| State | Trigger | Rendering |
|---|---|---|
| loading | fetch in flight (`useEffect` start) | `StatusLine` shows a spinner/"Loading…" line in place of the list/preview pane |
| empty | fetch succeeds, result is a zero-length list/no rows (e.g. no atoms in scope, no `hot_state` pairs) | Explicit message per screen — e.g. Atom Browser: "No atoms found in this scope." / Primer Inspector picker: "No sessions recorded yet." — never a blank pane |
| error | `spawnMemory` returns `{ok: false, message}` (spawn failure, `memory.js` exit(1), or timeout) | `StatusLine` renders the raw message in an error style; the triggering keybinding (e.g. `[r] Retry` or re-selecting the row) re-attempts the fetch — no auto-retry loop |
| disabled | an action that's contextually invalid (e.g. `[e] Edit` while a delete-confirmation overlay is open) | Action-bar hint dims/hides the disabled key; `useInput` handler for that screen ignores the key while the overlay has focus |
| focus/selected | list navigation (`ListPane`'s `useFocus`/manual cursor state) | Selected row highlighted (inverse video or a leading marker); preview pane updates to match |

Delete is additionally gated by `ConfirmOverlay` (dashed-border, matching the wireframe) — entering it moves focus/`useInput` handling to the overlay only (`[y]`/`[Enter]` confirm, `[Esc]`/`[n]` cancel), which is what puts every other action into the "disabled" state above for its duration.

### 6. Testing strategy

`ink-testing-library`'s `render()` is used against each screen component in isolation, with `src/tui/spawn/memoryClient.js` mocked at the module boundary (e.g. Jest `jest.unstable_mockModule` given the ESM setup, matching the repo's existing `--experimental-vm-modules` Jest configuration) — no test spawns a real `memory.js` process.

- **MainMenu**: asserts the three menu items render and each numeric key dispatches the correct `PUSH_SCREEN` action (assert on the reducer's dispatched action or resulting `nav` stack, not on process side effects).
- **PrimerInspector**: mock `memoryClient` to return a canned `hot-state-list-pairs` list and a canned `primer-preview` result; assert the picker renders the pairs, selecting one triggers the `primer-preview` call with the right args, and the right-pane shows the mocked `primerText` verbatim (fidelity is the whole point of this screen, so the test should assert exact text equality, not a substring).
- **AtomBrowser**: mock scope-toggle behavior (`[Tab]` or similar flips `browser.scope` and re-fetches with the new scope arg) and the explicit empty-state message when the mock returns an empty list.
- **AtomDetail & Actions**: mock each lifecycle action's `spawnMemory` call and assert the correct subcommand/args are sent for pin-toggle, always_include-toggle, and status-cycle. The `$EDITOR` flow itself is **not** exercised through `ink-testing-library` (it suspends the terminal and shells out) — it's covered by a separate unit test of the temp-file-write/diff/cleanup logic factored into its own pure-ish helper function, decoupled from Ink rendering, with `suspendTerminal`, `execFile`, and `fs` mocked.
- **Delete confirmation** (destructive path): the test must assert (a) pressing `[d]` alone does **not** call `spawnMemory('atom-delete', ...)` — only opens the overlay; (b) confirming (`[y]`/`[Enter]`) calls it with the exact `{workspace, topic}` of the currently selected atom; (c) cancelling (`[Esc]`/`[n]`) closes the overlay with zero `spawnMemory` calls. This three-way assertion is the minimum bar for any destructive action's test — not just "it eventually calls delete."

## Risks & Trade-offs

- **(a) Per-spawn latency, no long-lived server.** Accepted per proposal. Mitigation: spawn only on screen-load / explicit action (fetch effects keyed on state-slice changes, list-cursor navigation is purely in-memory over already-fetched data) — never per-keystroke. Worst case is one `memory.js` cold-start (~tens of ms for Node startup + SQLite open) per screen transition or lifecycle action, which is acceptable for an interactive human-operated tool.
- **(b) TOCTOU / lost-update on toggles and the `$EDITOR` flow.** Accepted pre-existing risk, consistent with `atom-write`/`atom-patch` being last-write-wins everywhere else in the system (per proposal's explicit out-of-scope on optimistic concurrency). Not mitigated further here; a concurrent external writer during an open `$EDITOR` session can be overwritten by the TUI's write-back, exactly as any two racing callers could today.
- **(c) ARG_MAX for `atom-write` content payloads.** `spawnMemory` passes JSON as a positional argv element in both `plugin.js` and this new wrapper (matching existing behavior, not introduced here). For the TUI specifically, content originates from a human editing in `$EDITOR` — practically bounded by what a person writes in one sitting, unlike a bulk/programmatic caller. No stdin-based payload path is introduced in this change: doing so would mean changing `memory.js`'s `atom-write` argument-parsing contract, which every existing caller (including `plugin.js`) also depends on, and that's out of scope for a TUI-only change. Accepted as-is; flagged for a future hardening change if a real ARG_MAX failure is ever observed in practice (this change does not add new large-payload call sites beyond what `atom-write` already supports today).
- **(d) `react-devtools-core` dependency nature.** Listed in the proposal as a "peer dep" of Ink 7. Whether it needs to be a direct `dependencies`/`peerDependencies` entry in this package's own `package.json`, or is satisfied transitively by Ink's own `package.json`, cannot be confirmed without installing and inspecting Ink 7's actual dependency tree — not guessed here. Verify empirically during implementation (`npm ls react-devtools-core` after adding `ink`) and adjust `package.json` accordingly; this does not change the design.

## Migration Plan

Purely additive — no existing runtime behavior changes. `src/plugin.js`, `src/lib/db.js`, and `src/lib/schema.js`'s existing exports are unmodified (schema.js only gains one new export, `hotStateListPairs`, alongside all existing ones). Existing `memory.js` subcommands are unmodified; two new `case` branches are added.

`package.json` changes: add a `bin` entry (`"agent-memory-tui": "bin/agent-memory-tui"`), add the four new runtime dependencies (`ink`, `react`, and whichever of `react-devtools-core`/`fullscreen-ink` implementation lands per Decision above), add `ink-testing-library` as a dev dependency. A `files` allowlist becomes necessary only if this package is published to a registry and currently ships via an implicit "everything not gitignored" default that would otherwise omit `bin/` or `src/tui/` — check the existing `package.json` for a `files` field; if absent, none is required today (Node resolves `bin` from the package root regardless of publish-time filtering, and this codebase does not appear to have a public-registry-publish flow to date). If one is later needed, add `bin/`, `src/tui/`, `src/tui.js`, `src/memory.js`, `src/lib/` to it.

## Open Questions

- **Resolved during implementation:** file extension is `.js`, not `.jsx`, and components are authored with `React.createElement` (aliased as `h`) rather than JSX syntax. Node has no native JSX support, and this repo has no build/transpile step (no bundler, no `@babel/preset-react` — `babel-jest` is present only transitively via Jest and does not transform JSX). Introducing one purely for syntax sugar would work against the "purely additive, minimal footprint" migration plan and the zero-runtime-deps-until-now baseline. This is a syntax-only substitution with no effect on the component tree, state model, screens, or any other design decision above — consistent with this section's existing precedent that implementation syntax choices are left to the implementer. All `src/tui/**` file paths named `*.jsx` elsewhere in this document should be read as `*.js`.
- Whether `assemblePrimer`'s inputs are composed inline inside `memory.js`'s new `case` branch, or factored into a small helper co-located with `assemblePrimer` in `src/lib/signal-utils.js` — no behavioral difference; left to implementation.
- Where the `since24h` window constant ends up living (duplicated vs. extracted to a shared export) — no behavioral difference; left to implementation.
- Whether `react-devtools-core` needs an explicit direct dependency entry (Risk d) — resolve empirically once `ink` is installed; does not change any screen's design or the task breakdown.
- Whether `fullscreen-ink`'s `withFullScreen()` helper is used for the app shell versus a hand-rolled full-screen `Box` — either satisfies the wireframe's full-screen four-frame layout; left to implementation taste, does not affect the component contracts or state shape defined above.
