## Why

The plugin's three tuneable values (`targetAgent`, `distilMinIntervalMs`, `distillerModel`) are currently read exclusively from environment variables, which is awkward to set persistently in an opencode environment. A JSONC file at `~/.config/opencode/agent-memory.jsonc` lets users configure the plugin once with a documented, comment-annotated file alongside the rest of their opencode config.

## What Changes

- **New**: Load `~/.config/opencode/agent-memory.jsonc` on plugin startup and use its values as defaults.
- **New**: Parse JSONC (JSON with `//` and `/* */` comments) so users can annotate their config.
- **Existing**: Environment variables (`MEMORY_TARGET_AGENT`, `DISTIL_MIN_INTERVAL_MS`, `MEMORY_DISTILLER_MODEL`) remain supported; they override the config file, preserving all existing usage.
- **Existing**: Hardcoded defaults remain the final fallback when neither source is set.

## Capabilities

### New Capabilities

- `config-file`: Plugin reads `~/.config/opencode/agent-memory.jsonc` on startup; keys `targetAgent`, `distilMinIntervalMs`, and `distillerModel` map to the three existing tuneable values; env vars override file values; missing or malformed file falls back silently to defaults.

### Modified Capabilities

<!-- No existing spec-level requirements change. -->

## Impact

- `src/plugin.js`: Add JSONC loader at module init; update the three `process.env.*` reads to layer env > file > default.
- New helper (or inline): strip JSONC comments before `JSON.parse`.
- No database schema changes, no CLI changes, no breaking changes to env var behaviour.
- Users gain a `~/.config/opencode/agent-memory.jsonc` they can version-control alongside their dotfiles.
