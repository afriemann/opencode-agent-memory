# opencode V2 Compatibility Audit — `opencode-agent-memory`

**Date:** 2026-09-17
**Status:** fact-finding audit only — no port planned or scoped yet.

This document records the findings of two independent architectural reviews
conducted in the same session: an initial general-purpose review, and a
second pass by an `engineer` subagent specifically to re-verify rigor before
anything was written down. Both converged on the same verdict. Per explicit
user instruction, this audit is **not** an implementation plan — it exists
so a future decision to port this plugin to V2 starts from verified facts
instead of re-deriving them.

## Verdict: MAJOR REDESIGN

This plugin has never been ported to opencode V2. `src/plugin.js` is a
single 1597-line file, V1-only (`export default AgentMemory`). Unlike six
sibling plugins already ported this session (a straightforward hook-rename
job in each case), this plugin's core event-capture pipeline depends on V1
event types that are either dead on the real V2 server or never existed
there at all. A future port is not a mechanical translation exercise; it
requires new designs for several of the plugin's core responsibilities.

## Framing for this document: dropped means dropped

Per explicit user instruction ("let's drop anything that already doesn't
work"): for every V1 signal below confirmed dead or nonexistent on V2, this
document records it as a **dropped capability**, full stop — not as a
problem with a proposed reconstruction. A theoretical reconstruction idea is
noted only as a footnote where one exists, explicitly framed as *not*
committed work. The actual recommendation for every dropped item is: accept
the gap, do not build a workaround, until an actual V2 port is scoped and
someone decides the reconstruction is worth the engineering effort.

## Dropped signals (dead or nonexistent on V2 — no reconstruction planned)

### 1. `session.idle` — this plugin's own distil trigger

Dead on V2. The event's schema is marked `// deprecated`, confirmed by a
direct read of `packages/core/src` showing nothing on V2 ever publishes it.

**Drop this signal.** If a future port happens, the real live replacement
to design against *at that time* is `session.execution.succeeded|failed|interrupted`
— but that substitution is a future decision, not something to build now.

### 2. `file.edited` and `todo.updated` — no live V2 publisher

`file.edited` has no live V2 publisher. `todo.updated` never existed on V2
at all.

**Drop both signals.** File-touch accumulation (`src/plugin.js:1459`,
used for session-scoped file-edit attribution) and todo-state accumulation
(`src/plugin.js:1471`, used for the latest-todo-list capture) are gone in
any hypothetical V2 port, full stop.

> Footnote (not a plan): it is theoretically possible to reconstruct
> file-touch data by hooking `ctx.tool.hook("execute.after")` on built-in
> edit/write tool calls. This is explicitly **not** written up as a
> committed workaround — see the "needs live verification" section below
> for the one open question that would gate even considering it.

### 3. `message.updated` — three responsibilities, no 1:1 V2 event

`message.updated` (`src/plugin.js:1482`) currently does three distinct
jobs in one handler: D1 keyword classification, completed-turn capture, and
triggering the fallback-injection path. There is no single V2 event that
maps onto this handler as a unit.

**Record as:** this exact signal is gone. A future port would need three
separate designs — one per responsibility — not a translation of the
existing handler. This is not a drop of functionality per se (each
responsibility may still be achievable individually), but the handler as
written has no destination to be ported to.

## Confirmed clean mapping (a genuine positive finding)

### 4. `session.created` — 1:1, confirmed live

`session.created` is the one clean, confirmed-live 1:1 mapping in this
audit. Record as a positive finding, not a gap.

## Open design questions (not drops — core functionality needs a new design)

### 5. `Tool.Context` has no `directory` field

V2's `Tool.Context` has no `directory` field at all. 10 of this plugin's 13
tools depend on directory resolution today. This is **not** a drop — it is
core functionality this plugin needs one way or another — but it is a real,
unresolved design question for any future port: a new per-call directory
resolution mechanism would need to be designed from scratch, since nothing
in the V2 tool-context surface currently provides an equivalent.

### 6. V1 `config` hook → V2 `ctx.agent.transform` is not a safe direct translation

A naive translation of this plugin's V1 `config` hook onto V2's
`ctx.agent.transform` would silently break the `??=` "don't clobber
user/other-plugin config" semantic this plugin currently relies on to
self-register the `distiller` agent's sandboxed permissions without
overwriting a value the user or another plugin already set. This was
verified against the real `editor.update()` implementation, not assumed.

**Record as:** an open design question for a future port, not a drop — the
plugin needs *some* mechanism to self-register `distiller`'s sandboxed
permissions on V2 without clobbering existing config; the V1 approach's
safety property just doesn't carry over unmodified.

## Confirmed no-change items

### 7. `ctx.storage` cannot replace the SQLite backend

`ctx.storage` (V2's flat KV + prefix-scan store) cannot replace this
plugin's own SQLite backend: FTS5 full-text search, transactional guards,
cross-project queries, and schema migration are not expressible via a flat
KV store.

**Record as:** keep the custom SQLite backend unconditionally in any future
port. No gap, no change needed here.

### 8. No V2 equivalent for operator-facing logging or toast notifications

No V2 equivalent exists for this plugin's operator-facing logging
(`client.app.log`) or toast notifications (`client.tui.showToast`).

**Record as:** a real, permanent gap for a future port. The stderr fallback
already present in the code is all that would survive a port as-is.

### 9. Distiller invocation mechanism should stay unchanged

The distiller-invocation mechanism (ephemeral session + prompt) should stay
unchanged in any future port. V2's session-free `ctx.generate.text()` was
checked and rejected as a substitute: it returns only `{ text }` — no
cost/token telemetry, and no agent-identity routing, which the distiller's
sandboxed permissions depend on.

### 10. Peer-dependency floor is below what a future port would need

The current peer-dependency floor (`>=1.15.0`) is below what's needed for
the single-file dual-entrypoint pattern other sibling plugins considered
during their own ports.

**Record as:** a future decision point, not urgent — no action needed until
an actual port is scoped.

### 11. Concurrency guards should be preserved unchanged

The plugin's concurrency guards (in-flight `Set`/queue/throttle) should be
preserved unchanged in any future port. Nothing in V2's API surface provides
an equivalent built-in serialization mechanism.

## Needs live verification before any port begins

These items were identified as open but were **not** resolved live in this
session. They are recorded so a future port doesn't have to rediscover that
they are unresolved:

- Whether `ctx.agent.get()` at plugin `setup()` time reliably reflects agent
  config already set by the user or another plugin (this blocks designing
  a fix for finding 6 — the `config`-hook clobber problem).
- The exact response shape for cost/token data from V2's
  `ctx.session.prompt()`.
- Live confirmation of `ctx.tool.hook("execute.after")`'s actual output
  shape for built-in tools — relevant only if a future port ever decides to
  build the file-touch reconstruction explicitly **not** planned in finding
  2 above.

## Recommendation

No action today. This document is a fact-finding record, not an
implementation plan — per explicit user instruction, no OpenSpec change is
opened and no code is touched as part of this audit. When a V2 port is
actually scoped in the future, treat findings 5 and 6 as the two real open
design questions to resolve first (directory resolution and the
config-clobber problem), and treat every item in the "Dropped signals"
section as an accepted, permanent loss of that specific signal — not
something to re-litigate as a design problem.
