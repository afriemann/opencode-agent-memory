## 1. Config (`src/lib/config.js`)

- [ ] 1.1 Replace `targetAgent` key and `MEMORY_TARGET_AGENT` env var with `targetAgents` (array) and `MEMORY_TARGET_AGENTS` (comma-separated); resolve env var by split → trim → filter(Boolean)
- [ ] 1.2 Update file-value handling: validate `targetAgents` as an array; drop non-string/empty elements with a per-key warn; accept empty array silently; non-array falls back to `[]` with warn
- [ ] 1.3 Update `resolveConfig` return shape to `{ targetAgents: string[], distilMinIntervalMs, distillerModel }`
- [ ] 1.4 Update existing config unit tests to the array shape; ensure all scenarios from the config-file delta spec have red-step tests before fixing

## 2. Plugin data structures (`src/plugin.js`)

- [ ] 2.1 Replace `const TARGET_AGENT = config.targetAgent` with `const TARGET_AGENTS = new Set(config.targetAgents)` at module scope
- [ ] 2.2 Add `const sessionAgents = new Map()` to the plugin factory closure alongside `primers`, `buffers`, `primerLoaded`
- [ ] 2.3 Implement `resolveSessionAgent(sessionId)`: check `sessionAgents` → on miss call `client.session.get` → membership test → populate map → return agent or null

## 3. Event handlers (`src/plugin.js`)

- [ ] 3.1 Update `session.created` handler: change agent filter from `agent && agent !== TARGET_AGENT` to `!agent || !TARGET_AGENTS.has(agent)` (skip on false); on pass call `sessionAgents.set(sessionId, agent)` before `loadMemoryForSession(sessionId, agent, project)`
- [ ] 3.2 Update `message.updated` handler with the same guard and `sessionAgents.set` call
- [ ] 3.3 Update `doDistil`: change the agent guard to `!agent || !TARGET_AGENTS.has(agent)`; populate `sessionAgents.set(sessionId, agent)` on pass; use `agent` variable (not the removed constant) in all `spawnMemory` args and `loadMemoryForSession`

## 4. Management tools (`src/plugin.js`)

- [ ] 4.1 Update `memory_inspect` execute: call `resolveSessionAgent(context.sessionID)`; on null return a "not tracked" ToolResult; on resolved agent pass it to `spawnMemory(['inspect', agent, directory])`
- [ ] 4.2 Update `memory_correct` execute: same pattern — `resolveSessionAgent` → null → "not tracked" result; resolved → `spawnMemory(['correct', agent, directory, patchJson])`
- [ ] 4.3 `memory_distil_force` delegates to `doDistil` which handles the guard in task 3.3; verify no residual `TARGET_AGENT` reference in the tool execute function

## 5. Tests

- [ ] 5.1 Write failing tests for each new/modified scenario in the config-file delta spec (red step before 1.1–1.4)
- [ ] 5.2 Write failing tests for the plugin-lifecycle delta scenarios: session.created filter with tracked/untracked/null agent; sessionAgents map population; resolveSessionAgent cold-miss path
- [ ] 5.3 Write failing tests for memory-inspect/correct not-tracked path (null return from resolveSessionAgent → informative result, no CLI call)
- [ ] 5.4 Run the full test suite; fix all failures

## 6. Proposal touch-up and README

- [ ] 6.1 Remove `TARGET_AGENTS_ARRAY` from the proposal Impact bullet (design dropped it)
- [ ] 6.2 Update `README.md`: rename env var and config key in the configuration table, add array example, note empty-array behaviour and skip-null behaviour

## 7. Validate and review

- [ ] 7.1 Run `openspec validate multi-agent-tracking` and fix any structural issues
- [ ] 7.2 Spawn `code-reviewer` pointing at proposal → delta specs → diff; resolve every BLOCKER and WARNING
