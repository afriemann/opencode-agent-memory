## 1. Dependencies & scaffolding

- [x] 1.1 Add `ink@^7`, `react@^19.2` (and `react-devtools-core` if `npm ls react-devtools-core` after install shows it is not already satisfied transitively — verify per design.md Risk (d) before adding it explicitly) to `package.json` dependencies; add `ink-testing-library` to devDependencies. Verify: `npm install` succeeds and `node -e "require('ink')"` (or ESM equivalent) resolves without error.
- [x] 1.2 Add a `bin` entry (`"agent-memory-tui": "bin/agent-memory-tui"`) to `package.json`; create `bin/agent-memory-tui` as a `#!/usr/bin/env node` shim requiring `src/tui.js`; create `src/tui.js` as the entry point. Verify: `node bin/agent-memory-tui` and `node src/tui.js` both start without throwing (may render a placeholder screen at this point).
- [x] 1.3 Create the `src/tui/` directory skeleton per design.md's file layout (`App.jsx`, `state/AppStateContext.jsx`, `spawn/memoryClient.js`, `screens/*.jsx`, `components/*.jsx`). Verify: directory structure exists and each file exports a placeholder that does not error on import.

## 2. `memory.js`: `hot-state-list-pairs` subcommand

- [x] 2.1 Write a failing test for `hotStateListPairs(db)` in `src/lib/schema.js` covering scenarios "Listing pairs" and "No pairs recorded" (spec: Hot-state pair enumeration subcommand). Verify: test fails (function does not exist yet).
- [x] 2.2 Implement `hotStateListPairs(db)` in `src/lib/schema.js` (new export, `GROUP BY agent, project` query per design.md Decision 3) to make the tests green. Verify: schema.js test suite passes.
- [x] 2.3 Add the `hot-state-list-pairs` case branch to `src/memory.js`'s subcommand dispatch, printing `{pairs}` JSON on success and following the existing stderr+exit(1) error pattern on failure. Write/extend a `memory.js` CLI test covering the same two scenarios via subprocess or direct dispatch invocation. Verify: test passes.

## 3. `memory.js`: `primer-preview` subcommand

- [x] 3.1 Write a failing test covering "Returns assembled primer text", "Non-git project is accepted", and "Unknown agent+project pair" (spec: Primer preview subcommand). Verify: test fails (subcommand does not exist yet).
- [x] 3.2 Implement the non-Bun git-staleness helper (`gitStalenessNode(project, storedSha)` per design.md Decision 3, using `node:child_process` `execFileSync`, degrading to "staleness unknown" on a non-git or inaccessible `project`). Verify: a unit test covering a git repo, a non-git directory, and an inaccessible path all resolve without throwing.
- [x] 3.3 Implement the `primer-preview` composition (gathering the same inputs `plugin.js` gathers via existing `schema.js` exports, `resolveConfig`'s `cap`, and the new git-staleness helper, then calling `assemblePrimer`) and wire it into `src/memory.js`'s dispatch, printing `{primerText}` JSON. Verify: the tests from 3.1 pass, and `primerText` for a known fixture agent+project matches a snapshot of `assemblePrimer`'s direct output for the same fixture inputs (fidelity check).

## 4. TUI spawn/IO layer

- [x] 4.1 Write failing tests for `src/tui/spawn/memoryClient.js` covering "Successful invocation", "Non-zero exit surfaces the raw message", "Malformed stdout is treated as failure", "Hung invocation times out", and "Database path is passed through" (spec: Spawn/IO error and timeout surfacing) with `child_process.execFile` mocked. Verify: tests fail (module not implemented).
- [x] 4.2 Implement `memoryClient.js` per design.md Decision 2 (`execFile`-based, 8s timeout, 10 MB maxBuffer, `{ok, data|message}` contract, `AGENT_MEMORY_DB` passthrough, no stderr-prefix classification). Verify: tests from 4.1 pass.

## 5. App shell & navigation

- [x] 5.1 Write a failing test for `AppStateContext`'s reducer covering `PUSH_SCREEN`/`POP_SCREEN` stack behavior and the other actions' state transitions (`SET_PRIMER_TARGET`, `SET_SCOPE`, `SET_SELECTED_ATOM`, `SET_STATUS`). Verify: test fails.
- [x] 5.2 Implement `AppStateContext.jsx`'s reducer and provider per design.md Decision 1. Verify: test from 5.1 passes.
- [x] 5.3 Write a failing `ink-testing-library` test for `App.jsx` + `MainMenu.jsx` covering "Navigate to Primer Inspector", "Navigate to project-scoped Atom Browser", "Navigate to global-scoped Atom Browser", "Quit", and "Escape always returns toward the Main Menu" (spec: Main Menu navigation). Verify: test fails.
- [x] 5.4 Implement `App.jsx` (screen router + global key handling) and `MainMenu.jsx`. Verify: tests from 5.3 pass; `node src/tui.js` renders the Main Menu and each keybinding navigates as expected in a manual smoke test.

## 6. Primer Inspector screen

- [x] 6.1 Write a failing `ink-testing-library` test for `PrimerInspector.jsx` with `memoryClient` mocked, covering "Agent+project picker is populated", "Selecting a pair shows the assembled primer" (asserting exact text equality per design.md Decision 6), "No sessions recorded", and "Read-only, no cross-visit caching" (spec: Primer Inspector fidelity). Verify: test fails.
- [x] 6.2 Implement `PrimerInspector.jsx` (picker pane + preview pane, `hot-state-list-pairs` and `primer-preview` calls, loading/empty/error states via `StatusLine`). Verify: tests from 6.1 pass.

## 7. Atom Browser screen

- [x] 7.1 Write a failing `ink-testing-library` test for `AtomBrowser.jsx` with `memoryClient` mocked, covering "Listing atoms in project scope", "Listing atoms in global scope", "Toggling scope", "Selecting an atom shows a preview", "Empty scope", and "Opening an atom" (spec: Atom Browser). Verify: test fails.
- [x] 7.2 Implement `AtomBrowser.jsx` (scope toggle, `ListPane`/`PreviewPane` composition, atom-list fetch per scope, empty-state message). Verify: tests from 7.1 pass.

## 8. Atom Detail & Actions — display

- [x] 8.1 Write a failing `ink-testing-library` test for `AtomDetail.jsx` covering "Metadata is shown" and "Action bar reflects available actions" (spec: Atom Detail & Actions display). Verify: test fails.
- [x] 8.2 Implement `AtomDetail.jsx`'s display (metadata strip, content pane, action bar) without wiring the actions yet. Verify: tests from 8.1 pass.

## 9. Lifecycle actions: pin, always_include, status cycle

- [x] 9.1 Write failing tests for the toggle-pin, toggle-always_include, and cycle-status actions in `AtomDetail.jsx` with `memoryClient` mocked, covering all six scenarios under "Pinned toggle", "Always-include toggle", and "Status cycle" (spec). Verify: tests fail.
- [x] 9.2 Wire the three actions to `spawnMemory('atom-patch', ...)` calls and post-success state refresh. Verify: tests from 9.1 pass.

## 10. `$EDITOR` edit flow

- [x] 10.1 Write failing unit tests (decoupled from Ink rendering, per design.md Decision 6) for the temp-file write/diff/cleanup helper, with `suspendTerminal`, `execFile`/`spawn`, and `fs` mocked, covering "Editing and saving a change", "Exiting the editor without changes", "Editor exits with a non-zero code", "$EDITOR is unset", and "Terminal is suspended and resumed around the edit" (spec: Edit content via $EDITOR). Verify: tests fail.
- [x] 10.2 Implement the edit-flow helper per design.md Decision 4 (per-edit temp directory via `mkdtemp`, try/finally cleanup, diff-before-write, re-send existing description/summary/tags on `atom-write`). Verify: tests from 10.1 pass.
- [x] 10.3 Wire the `[e] Edit` action in `AtomDetail.jsx` to the helper and re-fetch the atom fresh after resume. Verify: a manual smoke test (real `$EDITOR`, e.g. `EDITOR=cat` or a scriptable editor) round-trips a content change end-to-end against a scratch `AGENT_MEMORY_DB`.

## 11. Delete confirmation flow

- [x] 11.1 Write a failing `ink-testing-library` test for `ConfirmOverlay.jsx` + `AtomDetail.jsx`'s delete action asserting the three-way behavior from spec "Delete confirmation": pressing delete alone does not call `atom-delete`; confirming calls it with the exact `{workspace, topic}` of the selected atom; cancelling calls it zero times and leaves the atom unmodified. Verify: test fails.
- [x] 11.2 Implement `ConfirmOverlay.jsx` and wire the delete action (open overlay → confirm/cancel → on confirm, `spawnMemory('atom-delete', ...)` then navigate back to Atom Browser). Verify: tests from 11.1 pass.

## 12. Error/loading/empty states (cross-cutting)

- [x] 12.1 Verify (may already be covered by prior screen tests; add any missing cases here) that every screen's loading, empty, and error states render via the shared `StatusLine` component per design.md's state table, and that the "disabled" state correctly ignores action keybindings while `ConfirmOverlay` has focus. Verify: a combined test run of all screen tests shows every state-table row exercised at least once across the suite.

## 13. Documentation & final verification

- [x] 13.1 Update `README.md` to document the new `bin` entry, direct `node src/tui.js` invocation, and a brief description of the four screens. Verify: README renders correctly and mentions `agent-memory-tui`.
- [x] 13.2 Run the full existing Jest suite (`npm test`) and confirm no regressions; run through the sole-writer boundary check (spec: Sole-writer boundary) by grepping the new `src/tui/` tree for any import of `src/lib/db.js` or `src/lib/schema.js` and confirming none exist outside `src/memory.js`/existing lib code. Verify: `npm test` passes and the grep finds zero matches.
- [x] 13.3 Confirm `engines.node >=24` in `package.json` still satisfies Ink 7's `>=22` floor (design.md Migration Plan) and that no `files` allowlist change is needed (or add one per design.md's conditional guidance if a publish flow exists). Verify: manual inspection of `package.json`, noted in the PR/commit description.
