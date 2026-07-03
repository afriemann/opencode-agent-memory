# Agent-memory subsystem — build brief (agent-engineer → build)

This brief carries the `agent-engineer`-owned artefacts and addenda that the
runtime design (`docs/design/agent-memory-subsystem.md`) reserves for
`agent-engineer` (see its §6/§8 and §12). It is the hand-off package for the
`build` agent, who implements the plugin package per the design doc's §12 work
breakdown. `agent-engineer` does not write the runnable plugin JS; it reviews
`build`'s generated code against the Success Criteria below.

## Already authored and committed by agent-engineer

- `.agents/skills/adr/SKILL.md` — the ADR authoring convention referenced by the
  primer's ADR slot. Lives in the **`agent-dotfiles` config repo**
  (`~/git/agent-dotfiles`), symlinked into `~/.agents`; it is a general-purpose
  skill, not part of this plugin. `build` must not modify it; changes route
  through `agent-engineer` in `agent-dotfiles`.

> **Superseded:** `.config/opencode/agents/memory-distiller.md` (still committed in
> `agent-dotfiles`) is **no longer the distiller invocation path**. Distillation is
> now performed inline (see next section), not by a named agent. That `.md` file is
> retained only as the source of the distiller instruction *substance* until the
> inline path is built and ownership of the in-repo prompt file is decided; it is
> not deleted yet. Do not wire a `memory-distiller` named agent.

## Distiller invocation — inline system prompt from an in-repo prompt file

The idle-distil worker calls `client.session.prompt` **without** a named `agent`.
Verified against the deployed SDK types (`@opencode-ai/sdk` `SessionPromptData.body`),
the call passes:

- `system` — the distiller instructions, **loaded at runtime from a prompt file
  that lives in this plugin repo** (e.g. `src/prompts/distiller.md` or similar;
  build picks the exact path). This is the "from file in the repo" decision: the
  distiller prompt ships and versions with the plugin, not as an opencode agent.
- `model` — set by the plugin (an env var with a pinned default, e.g.
  `MEMORY_DISTILLER_MODEL` defaulting to `github-copilot/gpt-5-mini`). The model
  is **not** bound via a named agent in `opencode.jsonc`.
- `format: { type: 'json_schema', schema, retryCount }` — native structured
  output enforcing the exact four-key object
  (`last_worked_summary`, `next_action`, `open_questions`, `adr_candidate`).
  build must **confirm `github-copilot/gpt-5-mini` honours structured outputs
  through opencode**; if it does not, fall back to a `format: { type: 'text' }`
  call plus strict `JSON.parse` with the empty-record default.
- `parts` — the untrusted signal batch (PRIOR record + accrued SIGNALS) as text.
  Instruction/data separation is preserved: instructions go in `system`, the
  variable signal payload goes in `parts`.

The distiller instruction substance (role, exact input framing, the four output
keys and their semantics, carry-forward and empty-record rules, "no tools / never
writes DB or files / `adr_candidate` only flags" constraints) is specified by the
retained `memory-distiller.md`. Reuse that substance as the prompt-file body,
trimmed to a lean one-shot system prompt (drop the interactive-agent scaffolding:
the verbatim Methodology preamble and the Escalation section do not apply to a
one-shot structured call). **Ownership/governance of this in-repo prompt file is
deferred** (user will decide later) — do not place it under the
`agent-engineer` / `validate-definition` gate for now.

> **Sub-session capture concern (build must handle):** with no `agent` named on the
> distiller call, the ephemeral distiller session runs as opencode's **default
> agent**, so the `EXCLUDED_AGENTS`-by-name guard in `opencode-session-review` will
> **not** recognise it. build must ensure the distiller sub-session is not itself
> captured — e.g. tag it via its session `title` and have the exclusion match that
> marker, delete the ephemeral session after reading the reply
> (`client.session.delete` if available), or otherwise mark it so neither
> session-review nor the agent-memory plugin acts on it.

## Artefact — primer template (assembled and injected by the plugin)

The plugin assembles this text and injects it once per resumed `build` session
via `client.session.prompt({ path:{ id }, body:{ noReply:true, parts:[{ type:'text', text: primer }] } })`
on `session.created` (with the fallback path in design §4/§6). Fixed wording is
verbatim; `<slots>` are substituted from the latest `hot_state` row and the
plugin-computed staleness flag.

```
[MEMORY — resumed context for <agent> in <project>]

Where we left off: <last_worked_summary>

Next action: <next_action>

Open questions:
- <q>
- <q>

Possible decision to record: <adr_candidate> — if confirmed, capture it as an ADR under docs/adr/ (see the ADR convention).

Staleness: <staleness_flag>

This memory is a hypothesis, not ground truth. Before making any change, replay your understanding of the next action and the open questions back to me, reconcile it against the current code and git state, and get my confirmation first.
```

### Rendering rules (exact, zero-inference)

- `<agent>` — the memory record's `agent` value.
- `<project>` — the **last two segments** of the worktree absolute path
  (`parent/folder`), not the full path.
- `<last_worked_summary>`, `<next_action>` — the corresponding `hot_state`
  strings verbatim.
- Open questions: render one `- <q>` bullet per entry. When `open_questions` is
  empty, replace the heading **and** bullets with the single line
  `Open questions: none`.
- ADR paragraph: include the `Possible decision to record:` paragraph **only when
  `adr_candidate` is non-null**; omit it entirely otherwise. Never inline an ADR
  body — name the `docs/adr/` path only.
- Staleness flag: **exactly one** of these three phrasings, no other text:
  - anchored, `N ≥ 0` commits ahead of the note's SHA →
    `N commits since this note — reconcile before trusting`
  - no git anchor (`anchored_git_sha` NULL) →
    `git anchor unavailable — verify against current code`
  - anchored SHA unreachable / history diverged →
    `history diverged since this note — reconcile before trusting`

The primer stays small (hot state only) for context-rot control; cold ADRs are
referenced by path, never inlined.

## Addendum D1 — message-signal narrowing (design §5 component 2)

The continuous accumulator records a `message` signal **only** for:

1. explicit user corrections,
2. plan or scope changes,
3. stop/park statements.

All other messages are ignored. This keeps the `memory_signal` scratch focused on
state-changing input and bounds distil-prompt size.

## Addendum D2 — pre-distil signal reduction (design §7)

Before building the distil prompt, the idle worker reduces the accrued signals:

- de-duplicate `file` signals by path, keeping only the latest per path;
- cap each `kind` (`file` / `todo` / `message`) to the most-recent-N
  (suggested `N = 20`; finalise at implementation).

This bounds prompt size and cost without losing recency.

## Config wiring (opencode.jsonc — build applies)

- **No `memory-distiller` named-agent model binding** in `opencode.jsonc` — the
  distiller model is set by the plugin (see the inline-invocation section). The
  earlier plan to pin `github-copilot/gpt-5-mini` against a named agent no longer
  applies; the same model ID is now the plugin's `MEMORY_DISTILLER_MODEL` default.
- **No `memory-distiller` entry needed in `EXCLUDED_AGENTS`** — there is no such
  named agent. Instead handle the default-agent distiller sub-session per the
  sub-session capture concern above.
- The agent-memory plugin acts only when `agent === 'build'`
  (`MEMORY_TARGET_AGENT=build`).

## Success Criteria (agent-engineer reviews build's code against these)

**Distiller (inline `system` prompt loaded from the in-repo prompt file; verify
the plugin's prompt/parser/`format` honour it):**

- The distiller call uses `format: { type: 'json_schema', schema }` whose schema
  fixes exactly the four keys (`last_worked_summary`, `next_action`,
  `open_questions`, `adr_candidate`); the returned object has those keys only, no
  prose, no code fence. (Text-fallback path: strict `JSON.parse`, same shape.)
- `next_action` is one concrete, verifiable step.
- Output derives only from the supplied PRIOR record and SIGNALS (passed in
  `parts`, kept separate from the `system` instructions).
- Missing/empty/unparseable input → the defined empty record
  `{"last_worked_summary":"","next_action":"","open_questions":[],"adr_candidate":null}`.
- Empty SIGNALS with a PRIOR record → prior fields echoed unchanged.
- The four keys map onto `hot_state` columns; the distiller never emits
  `anchored_git_sha` or a staleness flag (both are plugin-computed).
- The distiller sub-session is not captured by `opencode-session-review` or by the
  agent-memory plugin itself (see the sub-session capture concern).

**Primer (plugin assembly):**

- Renders the slots in the specified order.
- Emits exactly one of the three staleness phrasings.
- Instructs the agent to replay understanding and get confirmation **before**
  acting, and labels the memory a hypothesis.
- References ADRs by `docs/adr/` path only — never inlines an ADR body.

**ADR (`adr/SKILL.md` — already authored):**

- Unambiguous location (`docs/adr/` in the working repo), filename
  (`NNNN-short-kebab-title.md`), and the five Nygard sections in order.
- The agent writes ADRs with edit tools; the plugin never writes repo files (it
  only flags `adr_candidate`).
