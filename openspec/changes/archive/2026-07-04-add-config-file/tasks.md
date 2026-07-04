## 1. JSONC Config Loader

- [x] 1.1 Add `os` (or `{ homedir }`) import from `node:os` to `src/plugin.js`
- [x] 1.2 Write inline `stripJsonc(str)` helper that removes `//` line comments, then `/* */` block comments, then trailing commas (`/,(\s*[}\]])/g → '$1'`), returning the cleaned string
- [x] 1.3 Write `loadConfigFile()` that:
  - Reads `~/.config/opencode/agent-memory.jsonc` via `os.homedir()` (sync)
  - If the file does not exist, returns `{}` silently
  - Calls `stripJsonc()`; if the result is empty/whitespace after stripping, returns `{}` silently (no warning)
  - Calls `JSON.parse()`; on any parse error, emits `console.warn('[agent-memory] …')` naming the file and error, and returns `{}`
  - If the parsed result is not a non-null plain object, emits `console.warn('[agent-memory] …')` and returns `{}`
  - Otherwise returns the parsed object

## 2. Wire Config Into Existing Tuneable Values

- [x] 2.1 Call `loadConfigFile()` once at module init and store the result as `_fileCfg`
- [x] 2.2 Update `TARGET_AGENT` resolution:
  - Take `process.env.MEMORY_TARGET_AGENT` if set, else `_fileCfg.targetAgent`
  - Validate file value: if present but not a non-empty string, emit `console.warn('[agent-memory] …')` and use `'engineer'`
  - Fallback default: `'engineer'`
- [x] 2.3 Update `DISTIL_MIN_INTERVAL_MS` resolution:
  - Take `process.env.DISTIL_MIN_INTERVAL_MS` if set (env path: `Number(...)` as before), else `_fileCfg.distilMinIntervalMs`
  - Validate file value: if present, apply `Number(...)`; if result is not a finite positive number, emit `console.warn('[agent-memory] …')` naming the key and use `60_000`
  - Fallback default: `60_000`
- [x] 2.4 Update `DISTILLER_MODEL` resolution:
  - Resolve the raw string via `process.env.MEMORY_DISTILLER_MODEL ?? _fileCfg.distillerModel ?? 'github-copilot/gpt-5-mini'`
  - Validate file value before using: if `_fileCfg.distillerModel` is present but not a non-empty string, emit `console.warn('[agent-memory] …')` and use `'github-copilot/gpt-5-mini'`
  - The existing first-`/` split runs once on the resolved string (no second split path)

## 3. Tests

- [x] 3.1 Add `test/config-file.test.js` with unit tests for `stripJsonc`:
  - Line comment removed
  - Block comment removed
  - Trailing comma removed
  - No comment passes through unchanged
  - Empty input returns empty string
- [x] 3.2 Test: config file absent → defaults used, no warning
- [x] 3.3 Test: config file comments-only / empty → defaults used, no warning
- [x] 3.4 Test: config file present with valid `targetAgent` → value used
- [x] 3.5 Test: config file present with valid `distilMinIntervalMs` → value used
- [x] 3.6 Test: config file present with valid `distillerModel` string → correct `{ providerID, modelID }` resolved
- [x] 3.7 Test: env var set + config file set → env var wins (per-key)
- [x] 3.8 Test: config file contains JSONC line comments + trailing comma → parses successfully
- [x] 3.9 Test: config file malformed (invalid JSON) → `[agent-memory]` warning emitted, defaults used
- [x] 3.10 Test: config file parses to non-object root (e.g. `42`) → `[agent-memory]` warning emitted, defaults used
- [x] 3.11 Test: `distilMinIntervalMs` non-numeric in file → warning for that key, default `60000`, other keys unaffected
- [x] 3.12 Test: `distilMinIntervalMs` zero or negative in file → warning, default used
- [x] 3.13 Test: `targetAgent` empty string in file → warning, default `engineer` used
- [x] 3.14 Test: unknown keys in file → silently ignored, no warning

## 4. Documentation

- [x] 4.1 Add a sample `docs/agent-memory.jsonc` documenting all three keys with inline JSONC comments (including trailing comma to show the style works)
- [x] 4.2 Update `README.md` to mention the config file path, key names, precedence order, and the documented limitation (string values must not contain `//`, `/*`, `*/`)
