## Why

Debugging agent behaviour requires knowing exactly what context the plugin injected into the system prompt. Currently there is no direct way to see the verbatim injection text — `memory_state_inspect` returns the primer data as JSON but omits the memory usage protocol block entirely, making it impossible to confirm what the LLM actually received.

## What Changes

- Add a new tool `memory_show_injection` that returns the exact text pushed to `output.system` by `experimental.chat.system.transform` for the current session: the memory usage protocol section and the assembled memory primer (if present), with each block clearly labelled.
- Update the plugin's tool-count from 12 to 13 in tests.

## Capabilities

### New Capabilities

(none — the new tool is an addition to an existing capability domain)

### Modified Capabilities

- `memory-state-tools`: adds the `memory_show_injection` tool as a new requirement

## Impact

- `src/plugin.js`: one new tool definition and one additional entry in the `tool` export map
- `test/plugin-safety.test.js`: new `describe` block for the tool + tool-count assertion updated from 12 → 13
- No CLI, DB, schema, or configuration changes
