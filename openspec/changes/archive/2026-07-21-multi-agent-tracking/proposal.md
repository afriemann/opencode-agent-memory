## Why

The plugin currently tracks memory for exactly one agent name, hard-wired at startup via `targetAgent`. When multiple agents (e.g. `engineer`, `architect`, `code-reviewer`) run in the same opencode session, only the single configured agent can benefit from hot-state persistence and resume priming. Configuring a list of tracked agents lets each participating agent carry its own independent memory row without any other changes to the DB schema (which is already keyed on `agent`).

## What Changes

- **BREAKING** — `targetAgent` (string) config key replaced by `targetAgents` (array of strings); unconfigured means an empty list → no agents tracked; the old default `"engineer"` is removed.
- **BREAKING** — `MEMORY_TARGET_AGENT` env var replaced by `MEMORY_TARGET_AGENTS` (comma-separated string, e.g. `engineer,architect`).
- The plugin maintains a `Set<string>` of tracked agents and resolves each session to its specific agent from that set when the session becomes known.
- All DB read/write CLI invocations use the per-session resolved agent name rather than a module-level constant.
- The three management tools (`memory_inspect`, `memory_correct`, `memory_distil_force`) use the calling session's resolved agent, so each agent sees and mutates only its own memory row.

## Capabilities

### New Capabilities

_(none — this change widens existing capabilities without introducing new conceptual domains)_

### Modified Capabilities

- `config-file`: `targetAgent` (string) → `targetAgents` (string[]); `MEMORY_TARGET_AGENT` → `MEMORY_TARGET_AGENTS`; no default (empty array when unconfigured); validation rule updated for array of non-empty strings.
- `plugin-lifecycle`: agent filter updated from single-value equality to Set membership; per-session agent resolution via a `sessionAgents` Map added; primer loading and idle-distil dispatch use the resolved per-session agent.
- `memory-inspect`: tool passes the calling session's resolved agent instead of the module-level `TARGET_AGENT` constant.
- `memory-correct`: same as `memory-inspect` — per-session agent used.
- `memory-distil-force`: no-op guard changed from `agent !== TARGET_AGENT` to `!TARGET_AGENTS.has(agent)`.

## Impact

- `src/lib/config.js` — config key and env var renamed; return shape changes.
- `src/plugin.js` — `TARGET_AGENT` constant replaced by `TARGET_AGENTS: Set<string>`; `sessionAgents: Map<string,string>` added (closure-scoped); all internal usages updated.
- `README.md` — config and env var table updated.
- No DB schema changes required (schema is already multi-agent keyed).
- No new npm dependencies.
