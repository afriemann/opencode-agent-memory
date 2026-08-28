## 1. Tests (red step)

- [x] 1.1 Add failing test: `memory_show_injection` returns both labelled sections for a warm tracked session — verify test fails (red) before implementation
- [x] 1.2 Add failing test: returns protocol-only with cold-start note for a tracked cold-start session — verify red
- [x] 1.3 Add failing test: returns no-injection message for an untracked session — verify red
- [x] 1.4 Add failing test: returns not-tracked message when session agent is not in TARGET_AGENTS — verify red
- [x] 1.5 Update tool-count assertion from 12 → 13 and ALL_TOOLS list — verify this test now fails (red)

## 2. Implementation

- [x] 2.1 Add `memory_show_injection` tool definition in `src/plugin.js` with description, empty args, and execute function that reads `primerLoaded` and `primers` in-closure and assembles the labelled output — verify all red tests go green
- [x] 2.2 Register `memory_show_injection` in the `tool` export map — verify tool-count test goes green

## 3. Verification

- [x] 3.1 Run full test suite (`npm test`) — verify all tests pass with no regressions
