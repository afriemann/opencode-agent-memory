## Context

The plugin currently reads its three tuneable values exclusively from environment variables at module load time:

- `MEMORY_TARGET_AGENT` → which opencode agent to observe (default: `engineer`)
- `DISTIL_MIN_INTERVAL_MS` → idle-distil throttle in milliseconds (default: `60000`)
- `MEMORY_DISTILLER_MODEL` → LLM model string `providerID/modelID` (default: `github-copilot/gpt-5-mini`)

Setting env vars persistently in an opencode environment is non-obvious. opencode already uses `~/.config/opencode/opencode.jsonc` for its own config, so a sibling file at `~/.config/opencode/agent-memory.jsonc` is the natural home for plugin config.

The three values are consumed differently, which matters for validation:

- `TARGET_AGENT` is used as an opaque string identity comparison.
- `DISTIL_MIN_INTERVAL_MS` is passed through `Number(...)` and used in a numeric throttle comparison. A `NaN` here silently corrupts the throttle (every comparison against `NaN` is `false`), so an invalid value is not inert — it changes behaviour.
- `MEMORY_DISTILLER_MODEL` is a `providerID/modelID` **string** that the current code splits on the first `/` into `{ providerID, modelID }`. Any config-file value for this key must reach that same splitter, or be pre-split.

## Goals / Non-Goals

**Goals:**

- Let users set plugin config once via `~/.config/opencode/agent-memory.jsonc`.
- Support JSONC (comments allowed) so the file can be self-documenting.
- Env vars remain authoritative: `process.env.*` overrides the file when set.
- Missing or unparseable file degrades gracefully to defaults (no startup failure).
- A present-but-invalid **value** for one key degrades to that key's default without discarding the other keys.

**Non-Goals:**

- No project-level config file (per-repo overrides are a separate future concern).
- No new config keys beyond the three that already exist.
- No Windows path support (`%APPDATA%`); plugin targets Linux/macOS.
- No hot-reload; config is read once at module load.
- No schema-validation library; validation is a handful of inline `typeof` checks (see Decision 6).

## Decisions

### 1. Config file path: `~/.config/opencode/agent-memory.jsonc`

Places the plugin config alongside `~/.config/opencode/opencode.jsonc`. The directory already exists on machines running opencode. Alternative considered: `~/.agent-memory.json` — rejected, clutters the home directory.

### 2. JSONC format (JSON with comments)

Users will want to annotate their config (explain model choice, leave defaults commented out). JSONC is what opencode itself uses. Alternative: plain JSON — rejected, inferior UX for a hand-edited file.

Because users will mirror the style of the adjacent `opencode.jsonc`, the accepted dialect must match reasonable JSONC expectations: `//` line comments, `/* */` block comments, **and trailing commas** (see Decision 4). Supporting comments but rejecting trailing commas would fail on files that look correct to a user copying opencode's own style.

### 3. Precedence order: `env > file > hardcoded default`

Env vars are more explicit and scripting-friendly; they should win. The file provides user-level defaults. This preserves 100% backwards compatibility — any existing env-var setup continues to work unchanged.

Precedence is resolved **per key, independently**: for each of the three keys the resolver takes the env var if set, else the file value if present *and valid*, else the hardcoded default. There is no all-or-nothing coupling between keys.

### 4. JSONC parser: inline strip, no new dependency — with documented limits

Strip `//` line comments and `/* */` block comments, then strip trailing commas, then call `JSON.parse`. No `strip-json-comments` / `jsonc-parser` dependency is added — the accepted value space is three keys holding an agent name, an integer, and a single-slash model string, none of which naturally contain comment tokens. Alternative: add a JSONC dependency — rejected, a production dependency for a few lines of stripping.

This decision is sharpened from "a small regex is simple enough" because a naive strip is **not** unconditionally correct, and the design must own the limitation rather than imply safety it does not have:

- A naive line-comment strip truncates any **string value that contains `//`** (e.g. a `https://` URL). A naive block-comment strip corrupts any string containing `/*` or `*/`. A regex strip is not string-aware.
- `JSON.parse` rejects **trailing commas**; comment-stripping alone does not fix this, and trailing commas are idiomatic JSONC.

Resolution: strip comments **and** trailing commas, and **document the accepted subset explicitly** — string values MUST NOT contain the substrings `//`, `/*`, or `*/`. This is acceptable and not a real-world regression because the three known keys never contain those substrings (the model string uses single `/` only). If a fourth key that can hold such values is ever added, this decision must be revisited (that is the trigger to reconsider a real JSONC parser). Any parse failure is caught (Decision 5), so even a value that violates the subset degrades safely rather than crashing.

Illustrative stripping shape (not the implementation — order matters: comments before trailing commas):

```js
// line comments, then block comments, then trailing commas
text.replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,(\s*[}\]])/g, '$1');
```

An empty file, a whitespace-only file, or a comments-only file strips to `''`, which `JSON.parse('')` rejects. This is treated as "no usable config" and MUST resolve to defaults silently (it is the empty-config case, not a malformed-config case — no warning).

### 5. Failure mode: log + fallback, never throw

A missing file is the common case (most users won't have the file yet) and is silent. A parse error (or a root that is not a JSON object — see Decision 7) is surfaced as a **`console.warn`** identifying the file and the error, but MUST NOT prevent the plugin from loading.

Correction to the earlier claim that this "matches the existing distiller-prompt fallback pattern": the existing distiller-prompt fallback in `src/plugin.js` uses **`console.error`** with a `[agent-memory]` prefix, not `console.warn`. The two must be reconciled, not silently diverge:

- **Log channel:** the spec specifies `console.warn` (a bad config file is a recoverable, user-fixable condition, which is arguably more accurately a warning than an error). Keep `console.warn` for config, but use the **same `[agent-memory]` message prefix** as the existing fallback so log lines are consistent and greppable.
- This is a deliberate, documented divergence in channel (warn vs error) justified by severity, not an accidental one. If project convention is that all plugin degradations use `console.error`, that convention wins and both the spec and this decision should move to `console.error`; flag for the engineer to confirm.

### 6. Value validation is per-key and type-checked

Each file-supplied value is validated against the type its consumer requires before it is accepted; an invalid value is discarded (that key falls through to its default) and a `console.warn` is emitted naming the key. Validation is minimal inline checks, not a schema library:

- `targetAgent` — accept only a non-empty `string`.
- `distilMinIntervalMs` — accept only a value that yields a **finite, positive number** after `Number(...)`. Reject `NaN`, `≤ 0`, and non-numeric strings. This is the highest-value check: an unvalidated bad value becomes `NaN` and silently breaks the idle-distil throttle rather than failing loudly.
- `distillerModel` — accept only a non-empty `string` in `providerID/modelID` form (see Decision 8).

Rationale: without per-key validation, "graceful degradation" only covers *file-level* failures (missing/unparseable). A syntactically valid file with a wrongly-typed value would otherwise propagate a bad value into runtime — the worst failure mode because it is silent. Per-key validation makes the value-level failure as safe as the file-level failure.

### 7. Non-object parse result is treated as malformed

`JSON.parse` succeeds on `42`, `"foo"`, `true`, `null`, and `[...]`. Reading config keys off any of these must not throw and must not be mistaken for a valid config. After a successful parse, the result MUST be verified to be a non-null, non-array `object` before keys are read; anything else is treated as a malformed config → `console.warn` + defaults (same path as a parse error, Decision 5).

### 8. `distillerModel` config value is a string, identical to the env var

The config file value for `distillerModel` is the same `providerID/modelID` **string** form as `MEMORY_DISTILLER_MODEL` (e.g. `"github-copilot/gpt-5-mini"`), not a pre-split `{ providerID, modelID }` object. Rationale:

- One normalization path: whether the raw model string comes from the env var or the file, it flows through the single existing first-`/`-split. No second code path, no divergence in how a bare `modelID` (no `/`) is defaulted to `providerID: 'github-copilot'`.
- It matches user expectation — the value users see documented is the `provider/model` string, and it mirrors the env var they may already be setting.
- Alternative considered: accept an object `{ providerID, modelID }` in the file — rejected. It adds a second shape to validate and normalize for no UX gain, and diverges the file format from the env var.

Implication: the resolver should produce the raw model **string** (env var → file string → default string), and the existing split runs **once** on the resolved string. The split must not be duplicated per source.

### 9. Unknown keys are ignored silently

Keys in the file other than the three known keys are ignored with no error and no warning in this change. Rationale: YAGNI — the alternative (warning on unknown keys) requires an allow-list and produces noise for users who legitimately keep commented-out experimental keys. A typo in a *key* name is therefore silently ignored (documented limitation); a typo in a *value* is caught by Decision 6. Logging unknown keys at a debug level remains a possible future pass, explicitly out of scope here.

## Risks / Trade-offs

- **[Risk] Typo in a config key name is silently ignored** → Accepted and documented (Decision 9). A mistyped *value* is caught by per-key type validation (Decision 6); a mistyped *key* is not. Future mitigation: debug-level unknown-key logging.
- **[Risk] Strip regex corrupts a string value containing `//`, `/*`, or `*/`** → Mitigation: document the accepted subset (Decision 4); the three known keys never contain these substrings; any resulting parse failure still degrades safely via Decision 5. Trigger to revisit: adding a key whose value can contain those substrings.
- **[Risk] Trailing commas (idiomatic JSONC, used in the adjacent `opencode.jsonc`) break `JSON.parse`** → Mitigation: strip trailing commas as part of Decision 4, not just comments.
- **[Risk] `Number(distilMinIntervalMs)` yields `NaN` and silently disables the throttle** → Mitigation: per-key finite-positive-number validation (Decision 6); reject and warn, fall back to `60000`.
- **[Risk] `JSON.parse` returns a non-object (number/string/array/null) and key access misbehaves** → Mitigation: post-parse object-shape check (Decision 7).
- **[Risk] Empty / comments-only file strips to `''` and `JSON.parse('')` throws a spurious warning** → Mitigation: treat empty-after-strip as the no-config case and resolve to defaults silently (Decision 4).
- **[Risk] Log-channel inconsistency (warn vs the existing `console.error` fallback)** → Mitigation: deliberate, documented choice of `console.warn` with the shared `[agent-memory]` prefix (Decision 5); flagged for engineer confirmation against project convention.
- **[Risk] `~` expansion not available in all Node runtimes** → Mitigation: use `os.homedir()` instead of a `~` literal.
- **[Risk] Config read before `os` module imported** → Mitigation: import `os` (or `homedir` from `node:os`) at the top of the file alongside the existing imports; config loading is synchronous at module init.
