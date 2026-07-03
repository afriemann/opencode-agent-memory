# Agent-memory subsystem — build brief (agent-engineer → build)

This brief carries the `agent-engineer`-owned artefacts and addenda that the
runtime design (`docs/design/agent-memory-subsystem.md`) reserves for
`agent-engineer` (see its §6/§8 and §12). It is the hand-off package for the
`build` agent, who implements the plugin package per the design doc's §12 work
breakdown. `agent-engineer` does not write the runnable plugin JS; it reviews
`build`'s generated code against the Success Criteria below.

## Already authored and committed by agent-engineer

These two files live in the **`agent-dotfiles` config repo** (`~/git/agent-dotfiles`),
not in this plugin repo — they are deployed opencode configuration, symlinked into
`~/.config/opencode` and `~/.agents`, and cannot move here:

- `.config/opencode/agents/memory-distiller.md` — the distiller subagent
  (pure text→JSON; no tools; four output keys map onto `hot_state` columns).
- `.agents/skills/adr/SKILL.md` — the ADR authoring convention referenced by the
  primer's ADR slot.

`build` must not modify these two files; any change to them routes back through
`agent-engineer` in the `agent-dotfiles` repo.

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

- Bind the distiller subagent's model to the pinned
  `github-copilot/gpt-5-mini` (cheap, high-frequency structured-JSON
  distillation). The model ID lives in `opencode.jsonc`, never in the portable
  `memory-distiller.md`.
- Add `memory-distiller` to the `opencode-session-review` plugin's
  `EXCLUDED_AGENTS` set (recursion/noise guard), so distiller sub-sessions are
  not themselves captured.
- The agent-memory plugin acts only when `agent === 'build'`
  (`MEMORY_TARGET_AGENT=build`), so distiller sub-sessions are ignored by it
  naturally.

## Success Criteria (agent-engineer reviews build's code against these)

**Distiller (`memory-distiller.md` — already authored; verify the plugin's
prompt/parser honour it):**

- The distiller returns a single JSON object with exactly four keys
  (`last_worked_summary`, `next_action`, `open_questions`, `adr_candidate`), no
  prose, no code fence.
- `next_action` is one concrete, verifiable step.
- Output derives only from the supplied PRIOR record and SIGNALS.
- Missing/empty/unparseable input → the defined empty record
  `{"last_worked_summary":"","next_action":"","open_questions":[],"adr_candidate":null}`.
- Empty SIGNALS with a PRIOR record → prior fields echoed unchanged.
- The four keys map onto `hot_state` columns; the distiller never emits
  `anchored_git_sha` or a staleness flag (both are plugin-computed).

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
