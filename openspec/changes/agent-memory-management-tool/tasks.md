## 1. `memory.js inspect` subcommand

- [ ] 1.1 Add `cmdInspect(agent, project)` function to `src/memory.js` — reads `hot_state` and `memory_signal` using the existing SELECT queries from `cmdRead`, omitting the session watermark; writes `{ prior, signals }` JSON to stdout
- [ ] 1.2 Wire `case 'inspect':` in the dispatch switch with argument validation (`agent`, `project` required)
- [ ] 1.3 Write unit tests for `inspect`: hot_state + signals present, cold start (null prior), signals absent, and database-unchanged-after-call assertion

## 2. `memory.js correct` subcommand

- [ ] 2.1 Add `cmdCorrect(agent, project, patchJson)` function to `src/memory.js` — parses the patch JSON, opens a `BEGIN IMMEDIATE` transaction (required: deferred BEGIN on a read-first path risks `SQLITE_BUSY_SNAPSHOT` when a concurrent `distil-write` holds a write lock), reads the current `hot_state` row inside the transaction, merges supplied fields (`last_worked_summary`, `next_action`, `open_questions`, `adr_candidate`) onto the row (absent fields keep current values, using `EMPTY_RECORD` defaults for a cold start, cold-start `updated_at` base = 0), UPSERTs with `updated_at = current_updated_at + 1`, and does NOT delete signals or advance the watermark. Note: `open_questions` is stored as a JSON TEXT column — `JSON.parse` the current value before merging and `JSON.stringify` before storing.
- [ ] 2.2 Validate patch field types (strings for `last_worked_summary`, `next_action`, `adr_candidate`; array for `open_questions`) using the same shape checks as `parseDistilReply`; exit non-zero on malformed input
- [ ] 2.3 Wire `case 'correct':` in the dispatch switch with argument validation (`agent`, `project`, `patchJson` required)
- [ ] 2.4 Write unit tests for `correct`: single-field patch preserves other fields, cold-start insert, `updated_at = current + 1`, malformed JSON exits non-zero, signals and watermarks are untouched after correct

## 3. `doDistil` force parameter

- [ ] 3.1 Update `doDistil(sessionId, { force = false } = {})` signature in `src/plugin.js`
- [ ] 3.2 Wrap the throttle early-return block (`now - lastDistilMs < DISTIL_MIN_INTERVAL_MS && ...`) so it is skipped when `force === true`; all other guards and steps are unchanged
- [ ] 3.3 Write regression test confirming the idle throttle behaviour (non-forced call within window with no new signals returns without distilling) is unaffected by the new parameter

## 4. Plugin tool hook

- [ ] 4.1 Add `import { tool } from '@opencode-ai/plugin'` (or use a plain object if `tool()` import fails in the ESM load context — `tool()` is an identity helper; a plain `{ description, args, execute }` object is equivalent)
- [ ] 4.2 Implement `memory_inspect` tool: `execute({ }, context)` calls `spawnMemory($, ['inspect', TARGET_AGENT, context.directory])` (agent dimension is always `TARGET_AGENT`, not `ToolContext.agent`), parses the JSON result, and returns a `ToolResult`; wraps body in try/catch and returns an informative error result on failure
- [ ] 4.3 Implement `memory_correct` tool: `execute({ patch }, context)` serialises the `patch` object to JSON and calls `spawnMemory($, ['correct', TARGET_AGENT, context.directory, patchJson])` (agent dimension is always `TARGET_AGENT`); returns a `ToolResult`; wraps body in try/catch
- [ ] 4.4 Implement `memory_distil_force` tool: `execute({ }, context)` calls `doDistil(context.sessionID, { force: true })`; returns a `ToolResult`; wraps body in try/catch
- [ ] 4.5 Add a `tool: { memory_inspect, memory_correct, memory_distil_force }` key to the object returned by the `AgentMemory` factory alongside the existing `event` key
- [ ] 4.6 Write unit/integration tests for each tool `execute`: inspect tool delegates to CLI, correct tool delegates to CLI, force-distil tool calls doDistil with force flag, each catches and returns on failure without throwing

## 5. Guard: no `distil-force` CLI subcommand

- [ ] 5.1 Confirm (or add a test) that `node src/memory.js distil-force` exits non-zero and prints the existing "unknown command" usage line — no new code required if the existing default case already handles it; otherwise add the test assertion

## 6. Documentation

- [ ] 6.1 Update `README.md`: document the three new plugin tools (`memory_inspect`, `memory_correct`, `memory_distil_force`) with descriptions and argument tables
- [ ] 6.2 Document the two new `memory.js` CLI subcommands (`inspect <agent> <project>`, `correct <agent> <project> <patchJson>`) in the CLI reference section (or header comment in `src/memory.js`)
- [ ] 6.3 Note in the README that `distil-force` has no CLI form (requires in-process `client`) and can only be invoked as the `memory_distil_force` plugin tool
