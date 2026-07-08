## Why

The distil sub-session inherits the default agent (typically `engineer`) and therefore receives every tool definition — including all MCP tools — when the LLM is invoked. These tool schemas add unnecessary context tokens and could confuse the model. The distil session is purely a JSON-extraction task; it needs no tools at all.

## What Changes

- The `AgentMemory` plugin factory now returns a `config` hook that registers a hidden `distiller` agent with a deny-all permission ruleset.
- The `session.create` call for the ephemeral distil sub-session now passes `agent: 'distiller'` in the body, binding it to this no-tool agent.

## Capabilities

### New Capabilities

*(none)*

### Modified Capabilities

- `plugin-lifecycle`: `AgentMemory` factory now returns a `config` hook in addition to `event` and `tool`; the ephemeral session creation body includes `agent: 'distiller'`.

## Impact

- `src/plugin.js`: two changes (new `config` hook, modified `session.create` body)
- `test/plugin-safety.test.js`: new assertions for the `config` hook and `session.create` agent field
- No external config files — everything is self-contained in the plugin
