## 1. Rewrite assemblePrimer (passive framing)

- [x] 1.1 In `src/lib/signal-utils.js`, update `assemblePrimer` to open with a passive header: `## Project memory — <project> (background context — no action required)`
- [x] 1.2 Change `"Next action:"` label to `"Suggested next step:"`
- [x] 1.3 Remove the closing investigation-instruction paragraph ("This memory is a hypothesis… reconcile it against the current code and git state, and get my confirmation first")
- [x] 1.4 Add a single passive closing line: `"This is a snapshot from your last session. Wait for the user's request before taking any action."`
- [x] 1.5 Update unit tests in `test/plugin-safety.test.js` (or add to `signal-utils` test if one exists) to assert: header contains "background context", output contains "Suggested next step", output does NOT contain "reconcile" / "replay your understanding" / "get my confirmation"

## 2. Refactor injection path in plugin.js

- [x] 2.1 Rename the in-process `injected` Set to `primerLoaded` (load-attempted guard); remove the `priming` Set (no longer needed — no concurrent `session.prompt` call to guard)
- [x] 2.2 Rename `injectPrimer(sessionId, agent, project)` to `loadMemoryForSession(sessionId, agent, project)`: keep DB read, staleness check, and `assemblePrimer` call; replace the `client.session.prompt(...)` call with `primers.set(sessionId, primer)`
- [x] 2.3 Add the `primers` Map declaration (`const primers = new Map()`) alongside the other per-process state declarations
- [x] 2.4 In `loadMemoryForSession`, after successfully setting `primers.set(sessionId, primer)`, emit: `log(\`primer loaded for session \${sessionId} in \${displayProject} (\${primer.length} chars)\`)` — use `lastTwoSegments(project)` for `displayProject`
- [x] 2.5 Ensure `loadMemoryForSession` still marks `primerLoaded.add(sessionId)` in its `finally` block (idempotency guard)
- [x] 2.6 Update all call-sites: `session.created` handler, `message.updated` fallback, and the `doDistil` fallback inject — replace `injected` references with `primerLoaded`, replace `injectPrimer` calls with `loadMemoryForSession`

## 3. Register experimental.chat.system.transform hook

- [x] 3.1 Add `"experimental.chat.system.transform"` as a key on the object returned by the `AgentMemory` factory
- [x] 3.2 Implement the hook: guards in order — (a) skip if `input.sessionID` is absent, (b) skip if session is in `ephemerals`, (c) skip if `primers` has no entry for the session; otherwise push the cached primer to `output.system`
- [x] 3.3 Wrap the entire hook body in try/catch; on any error, append nothing and log via the existing `log` helper (consistent with the plugin's "degrade to no-injection" rule)
- [x] 3.4 Confirm during implementation that `output.system` is a **fresh array per LLM call** (not reused across calls); if it is reused, add an idempotent-append guard to prevent the primer from compounding across turns — **confirmed by transform-hook contract; no guard needed**
- [x] 3.5 Run `npm test` — verify no existing tests break

## 4. Extend memory_inspect to expose active_primer

- [x] 4.1 In the `memory_inspect` tool `execute` function, read `primers.get(context.sessionID) ?? null` and include it as `active_primer` in the returned output JSON string
- [x] 4.2 Add test assertions in `test/memory-inspect-correct.test.js` for: `active_primer` is `null` when no primer is cached for the session; `active_primer` equals the cached primer text when one exists

## 5. Test coverage and validation

- [x] 5.1 Add or update tests in `test/plugin-safety.test.js`: verify `session.prompt` is NOT called at session start (no injection via prompt); verify the `experimental.chat.system.transform` hook is present on the returned hooks object; verify that a cold-start session (no prior `hot_state`) is added to `primerLoaded` but NOT to `primers` (the `primerLoaded ⊇ keys(primers)` invariant)
- [x] 5.2 Run `npm test` — full suite green
- [x] 5.3 Run `openspec validate system-prompt-memory-injection` — no errors
