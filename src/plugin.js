// src/plugin.js — opencode-agent-memory plugin.
//
// Components implemented here:
//   1. Event router + in-flight guard + serialized queue
//   2. Continuous signal accumulator (in-memory buffer, no LLM)
//   3. Idle-distil worker (throttle + watermark via CLI)
//   4. Injection module (session.created + fallback on message.updated)
//   6. Git reconciliation helper (rev-parse / rev-list)
//
// The plugin NEVER opens the SQLite DB directly. All DB access is
// delegated to src/memory.js (the sole writer), spawned via $.
//
// Safety: every step is wrapped in try/catch; failures degrade to "no
// capture / no injection" for that session and never throw into opencode.

import { tool } from '@opencode-ai/plugin';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  DISTIL_SCHEMA,
  buildDistilPrompt,
  parseDistilReply,
} from './lib/distil-prompt.js';
import { gitRevParse, gitStaleness } from './lib/git-helper.js';
import {
  assemblePrimer,
  reduceSignals,
  lastTwoSegments,
} from './lib/signal-utils.js';
import { loadConfigFile, resolveConfig } from './lib/config.js';

// ── Static config ────────────────────────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));

// Path to the sole-writer CLI
const SCRIPT = join(__dir, 'memory.js');

// Distiller system prompt — lazy-loaded on first use to avoid a hard module-
// init failure if the file is temporarily missing (W4 fix). Falls back to an
// inline summary prompt that preserves the output contract.
let _distillerPrompt = null;
function getDistillerPrompt() {
  if (_distillerPrompt) return _distillerPrompt;
  try {
    const raw = readFileSync(join(__dir, 'prompts', 'distiller.md'), 'utf8');
    _distillerPrompt = raw.replace(/^<!--[\s\S]*?-->\s*/m, '').trim();
  } catch (err) {
    _distillerPrompt =
      'Summarise the work session. Return ONLY a JSON object with exactly these four keys: ' +
      'last_worked_summary (string), next_action (string), open_questions (array of strings), ' +
      'adr_candidate (string or null). No prose, no code fence.';
    console.error(`[agent-memory] distiller prompt file missing — using inline fallback: ${err}`);
  }
  return _distillerPrompt;
}

// Resolve tuneable config: env var > config file > hardcoded default (per key).
const _fileCfg = loadConfigFile();
const {
  targetAgent: TARGET_AGENT,
  distilMinIntervalMs: DISTIL_MIN_INTERVAL_MS,
  distillerModel: DISTILLER_MODEL,
} = resolveConfig(process.env, _fileCfg);

// Title used for ephemeral distil sub-sessions. Used in two places:
// - ephemerals.add(ephId) after session.create (primary guard)
// - title check in session.created handler (race-condition guard: W3 fix)
const EPHEMERAL_TITLE = 'agent-memory distil';

const MAX_IN_FLIGHT = 5000;

// ── D1 message-classification keywords ──────────────────────────────────────
// Deterministic heuristic (no LLM). Only user messages that match at least one
// of these categories are recorded as 'message' signals. Conservative by design:
// false negatives are acceptable; false positives waste a signal slot.

const D1_STOP_PARK    = ['stop', 'pause', 'park', 'hold off', 'cancel', 'abort'];
const D1_PLAN_CHANGE  = ['actually', 'instead', 'scratch that', 'change the plan', 'different approach'];
const D1_CORRECTION   = ['no,', "that's wrong", 'correction:'];

function isD1Message(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    D1_STOP_PARK.some((k) => lower.includes(k)) ||
    D1_PLAN_CHANGE.some((k) => lower.includes(k)) ||
    D1_CORRECTION.some((k) => lower.includes(k))
  );
}

// ── Buffer helpers ───────────────────────────────────────────────────────────

function makeBuffer() {
  return {
    files: new Set(),    // Set<string> — file paths
    todos: [],           // Array<string> — each is JSON.stringify(Todo[])
    messages: [],        // Array<string> — D1-qualifying message text (≤200 chars)
  };
}

function bufferIsEmpty(buf) {
  return buf.files.size === 0 && buf.todos.length === 0 && buf.messages.length === 0;
}

// ── CLI spawn helper ─────────────────────────────────────────────────────────

/**
 * Spawn memory.js with the given args, optionally piping JSON data to stdin.
 * Returns stdout as a string.
 *
 * @param {Function} $ — tagged-template shell from the plugin context
 * @param {string[]} args — CLI sub-command and positional args
 * @param {object|string|undefined} stdinData — appended as a JSON CLI arg if provided
 * @returns {Promise<string>}
 */
async function spawnMemory($, args, stdinData) {
  const [sub, ...rest] = args;
  if (stdinData !== undefined) {
    const input =
      typeof stdinData === 'string' ? stdinData : JSON.stringify(stdinData);
    return await $`node ${SCRIPT} ${sub} ${rest} ${input}`.quiet().text();
  }
  return await $`node ${SCRIPT} ${sub} ${rest}`.quiet().text();
}

// ── Plugin factory ───────────────────────────────────────────────────────────

const AgentMemory = async ({ client, $ }) => {
  // Fire-and-forget; never throws into opencode.
  spawnMemory($, ['prune']).catch(() => {});

  // ── Per-process mutable state ──────────────────────────────────────────────
  const inFlight = new Set();       // sessionIDs with a pending distil queued/running
  const primerLoaded = new Set();   // sessionIDs where a memory load has been attempted
  const primers = new Map();        // sessionId → assembled primer text (warm sessions only)
  const ephemerals = new Set();     // distiller sub-session IDs (skip injection + idle)
  const buffers = new Map();        // sessionId → { files, todos, messages }
  // Last active session for file.edited attribution (heuristic — see I5).
  // NOTE: This is a single-worktree approximation; multi-worktree concurrency
  // may misattribute edits. Acceptable for Phase-1 scope; see README limitations.
  let lastActiveSessionId = null;
  let queue = Promise.resolve(); // Serialized promise chain

  /**
   * Log an error-level message to the opencode session log via client.app.log.
   * Falls back to process.stderr.write if the client call throws synchronously
   * or rejects asynchronously (e.g. during startup or when the server is
   * unavailable).
   *
   * When `err` is a Bun ShellError (or any Error-like with a `.stderr` Buffer),
   * the child-process stderr is appended to the message so failures in
   * memory.js are fully visible without a separate stderr scan.
   *
   * Fire-and-forget: never awaited so it cannot block the plugin's hot paths.
   */
  const log = (msg, err) => {
    const errDetail = err
      ? `: ${err instanceof Error ? err.stack ?? err.message : err}`
      : '';
    const stderrDetail = err?.stderr
      ? `\n${err.stderr.toString().trim()}`
      : '';
    const message = `[agent-memory] ${msg}${errDetail}${stderrDetail}`;
    try {
      const result = client.app.log({ body: { service: 'agent-memory', level: 'error', message } });
      // client.app.log is an HTTP call and may return a rejected Promise; ensure
      // any async rejection also falls back to stderr rather than going unhandled.
      result?.catch?.(() => process.stderr.write(message + '\n'));
    } catch {
      process.stderr.write(message + '\n');
    }
  };

  /**
   * Surface a critical plugin error as an in-TUI toast notification so the
   * user sees it without needing to inspect log files.
   *
   * Prepends "agent-memory: " to every message so toast consumers can identify
   * the source without the call site needing to repeat the prefix.
   *
   * Fire-and-forget and never throws — a toast failure must not propagate.
   */
  const notify = (msg) => {
    try {
      const result = client.tui.showToast({ body: { message: `agent-memory: ${msg}`, variant: 'error' } });
      // showToast is an HTTP call; suppress any async rejection silently.
      result?.catch?.(() => {});
    } catch {
      // Intentionally silent — toast is best-effort.
    }
  };

  // ── Injection module (component 4) ────────────────────────────────────────

  /**
   * Load the memory primer for a session into the in-process `primers` Map.
   * Populates the cache exactly once per session (guarded by `primerLoaded`).
   * Cold-start sessions (no prior hot_state) are added to `primerLoaded` but
   * receive no `primers` entry — preserving the `primerLoaded ⊇ keys(primers)`
   * invariant so repeated message.updated events don't re-spawn the DB read.
   *
   * No `session.prompt` call is made. Injection is handled by the
   * `experimental.chat.system.transform` hook on every subsequent LLM call.
   */
  async function loadMemoryForSession(sessionId, agent, project) {
    if (primerLoaded.has(sessionId)) return;

    try {
      // Read prior hot_state + watermark from CLI (never opens DB directly).
      let state;
      try {
        const out = await spawnMemory($, ['read', sessionId, agent, project]);
        state = JSON.parse(out.trim());
      } catch (err) {
        log(`inject: read failed for ${sessionId}`, err);
        notify(`inject read failed for session ${sessionId}`);
        return;
      }

      // Cold start: no prior memory → no primer cached; session proceeds normally.
      if (!state.prior) return;

      const storedSha = state.prior.anchored_git_sha ?? null;
      const staleness = await gitStaleness($, project, storedSha);
      const primer = assemblePrimer(state.prior, agent, project, staleness);

      primers.set(sessionId, primer);
    } catch (err) {
      log(`inject: failed for ${sessionId}`, err);
    } finally {
      // Mark load-attempted regardless of outcome — prevents re-read on cold start.
      primerLoaded.add(sessionId);
    }
  }

  // ── Idle-distil worker (component 3) ──────────────────────────────────────

  async function doDistil(sessionId, { force = false } = {}) {
    // Skip known ephemeral distil sessions.
    if (ephemerals.has(sessionId)) return;

    // Resolve session agent + project via session.get (authoritative, per §6).
    let session;
    try {
      const got = await client.session.get({ path: { id: sessionId } });
      session = got && got.data;
    } catch (err) {
      log(`distil: session.get failed for ${sessionId}`, err);
      return;
    }

    const agent = session && session.agent;
    const project = session && session.directory;

    // Only distil for the target agent; undefined agent = default = TARGET_AGENT.
    if (agent && agent !== TARGET_AGENT) return;
    if (!project) return;

    // Fallback load: cache the primer for this session if not yet attempted.
    if (!primerLoaded.has(sessionId)) {
      await loadMemoryForSession(sessionId, TARGET_AGENT, project);
    }

    // Read prior + signals + watermark (watermark is returned by the CLI, no
    // DB access here — B1 fix).
    let state;
    try {
      const out = await spawnMemory($, ['read', sessionId, TARGET_AGENT, project]);
      state = JSON.parse(out.trim());
    } catch (err) {
      log(`distil: read failed for ${sessionId}`, err);
      notify(`distil read failed for session ${sessionId}`);
      return;
    }

    const { prior, signals: storedSignals, watermark } = state;

    // Throttle check (in-memory only, no DB). Skipped when force === true.
    const now = Date.now();
    const buf = buffers.get(sessionId);
    const bufEmpty = !buf || bufferIsEmpty(buf);
    const lastDistilMs = watermark ? (watermark.last_distil_ms ?? 0) : 0;
    if (
      !force &&
      now - lastDistilMs < DISTIL_MIN_INTERVAL_MS &&
      (storedSignals ?? []).length === 0 &&
      bufEmpty
    ) {
      return; // Within throttle window and no new signals — skip.
    }

    // Flush in-memory buffer to scratch (accrue).
    if (buf && !bufferIsEmpty(buf)) {
      const delta = {
        files: [...buf.files],
        todos: buf.todos.slice(),
        messages: buf.messages.slice(),
      };
      buf.files.clear();
      buf.todos.length = 0;
      buf.messages.length = 0;
      try {
        await spawnMemory($, ['accrue', sessionId, TARGET_AGENT, project], delta);
      } catch (err) {
        log(`distil: accrue flush failed for ${sessionId}`, err);
        // Continue — use whatever signals are already in the DB.
      }
    }

    // Re-read signals after flush.
    let allSignals;
    try {
      const out2 = await spawnMemory($, ['read', sessionId, TARGET_AGENT, project]);
      const state2 = JSON.parse(out2.trim());
      allSignals = state2.signals ?? [];
    } catch {
      allSignals = storedSignals ?? [];
    }

    // D2: reduce signals before building the prompt.
    const reducedSignals = reduceSignals(allSignals);

    // Determine highest signal created_at for the watermark advance.
    const lastSignalMs = allSignals.reduce(
      (max, s) => Math.max(max, s.created_at ?? 0),
      0
    );

    // Create ephemeral distil sub-session.
    let ephId;
    try {
      const created = await client.session.create({ body: { title: EPHEMERAL_TITLE, agent: 'distiller' } });
      ephId = created && created.data && created.data.id;
      if (!ephId) throw new Error('no session id in create response');
      // Add to ephemerals IMMEDIATELY after receiving the ID — before any
      // subsequent await that could allow session.created to fire for this
      // ephemeral and bypass the title check (W3 fix).
      ephemerals.add(ephId);
    } catch (err) {
      log(`distil: create ephemeral session failed`, err);
      return;
    }

    try {
      const distilPrompt = buildDistilPrompt(prior, reducedSignals);

      // Primary attempt: json_schema structured output.
      let distilled = null;
      try {
        const res = await client.session.prompt({
          path: { id: ephId },
          body: {
            model: DISTILLER_MODEL,
            system: getDistillerPrompt(),
            format: { type: 'json_schema', schema: DISTIL_SCHEMA, retryCount: 1 },
            parts: [{ type: 'text', text: distilPrompt }],
          },
        });
        const parts = (res && res.data && res.data.parts) || [];
        const text = parts
          .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text)
          .join('\n');
        distilled = parseDistilReply(text);
      } catch (err) {
        log(`distil: json_schema call failed for ${sessionId}, trying text fallback`, err);
      }

      // Fallback: plain text prompt + strict JSON.parse.
      if (!distilled) {
        try {
          const res2 = await client.session.prompt({
            path: { id: ephId },
            body: {
              model: DISTILLER_MODEL,
              system: getDistillerPrompt(),
              format: { type: 'text' },
              parts: [{ type: 'text', text: distilPrompt }],
            },
          });
          const parts = (res2 && res2.data && res2.data.parts) || [];
          const text = parts
            .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text)
            .join('\n');
          distilled = parseDistilReply(text);
        } catch (err) {
          log(`distil: text fallback call failed for ${sessionId}`, err);
        }
      }

      // Both calls failed or returned unparseable output — keep prior, keep
      // scratch signals (folded on the next cycle), log and return.
      if (!distilled) {
        log(`distil: could not parse distil reply for ${sessionId}; keeping prior state`);
        return;
      }

      // Anchor the distilled state to current HEAD.
      const anchoredSha = await gitRevParse($, project);

      // Write via CLI (sole writer — never touches DB here).
      try {
        await spawnMemory($, ['distil-write', TARGET_AGENT, project], {
          distilled,
          anchoredSha,
          lastSignalMs,
          sessionId,
        });
      } catch (err) {
        log(`distil: distil-write failed for ${sessionId}`, err);
        return;
      }
    } finally {
      // Delete the ephemeral session (fire-and-forget — non-fatal if unavailable).
      try {
        await client.session.delete({ path: { id: ephId } });
      } catch { /* non-fatal */ }
      ephemerals.delete(ephId);
    }
  }

  // ── Plugin tools (component 5) ────────────────────────────────────────────

  /**
   * memory_inspect — non-destructive read of the current hot state + signals.
   * The agent dimension is always TARGET_AGENT (single-agent store invariant).
   */
  const memory_inspect = tool({
    description:
      'Read the current agent memory state (hot state + signals) for the current project. ' +
      'Non-destructive — does not insert, update, or delete any database row.',
    args: {},
    async execute(_args, context) {
      try {
        const out = await spawnMemory($, ['inspect', TARGET_AGENT, context.directory]);
        const result = JSON.parse(out.trim());
        const activePrimer = primers.get(context.sessionID) ?? null;
        return {
          title: 'memory_inspect',
          output: JSON.stringify({ ...result, active_primer: activePrimer }, null, 2),
        };
      } catch (err) {
        return {
          title: 'memory_inspect',
          output: `Error reading memory: ${err && err.message ? err.message : String(err)}`,
        };
      }
    },
  });

  /**
   * memory_correct — apply a partial patch to the hot state.
   * Only supplied fields are updated; all others keep their current values.
   * The agent dimension is always TARGET_AGENT.
   */
  const memory_correct = tool({
    description:
      'Apply a partial correction to the agent memory hot state. ' +
      'Only fields included in `patch` are updated; omitted fields are unchanged. ' +
      'Does not delete signals or advance the distil watermark.',
    args: {
      patch: tool.schema.object({
        last_worked_summary: tool.schema.string().optional().describe('Summary of work done so far'),
        next_action: tool.schema.string().optional().describe('Recommended next action'),
        open_questions: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe('Open questions or blockers'),
        adr_candidate: tool.schema
          .string()
          .nullable()
          .optional()
          .describe('Architecture decision candidate, or null to clear'),
      }).describe('Partial patch. Include only the fields you want to change.'),
    },
    async execute({ patch }, context) {
      try {
        const patchJson = JSON.stringify(patch);
        await spawnMemory($, ['correct', TARGET_AGENT, context.directory, patchJson]);
        return {
          title: 'memory_correct',
          output: 'Memory corrected successfully.',
        };
      } catch (err) {
        return {
          title: 'memory_correct',
          output: `Error correcting memory: ${err && err.message ? err.message : String(err)}`,
        };
      }
    },
  });

  /**
   * memory_distil_force — force an immediate distillation, bypassing the throttle.
   * There is no CLI form for this tool; it can only be invoked in-process.
   */
  const memory_distil_force = tool({
    description:
      'Force an immediate memory distillation for the current session, bypassing the idle ' +
      'throttle window. All other guards (ephemeral skip, TARGET_AGENT check) still apply. ' +
      'The distil-force subcommand has no CLI form; only this plugin tool triggers it.',
    args: {},
    async execute(_args, context) {
      try {
        await doDistil(context.sessionID, { force: true });
        return {
          title: 'memory_distil_force',
          output: 'Distillation triggered.',
        };
      } catch (err) {
        return {
          title: 'memory_distil_force',
          output: `Error during forced distil: ${err && err.message ? err.message : String(err)}`,
        };
      }
    },
  });

  // ── Event router (component 1) ─────────────────────────────────────────────

  return {
    event: async ({ event }) => {
      if (!event) return;

      try {
        switch (event.type) {

          // ── session.created: primary injection trigger ─────────────────────
          case 'session.created': {
            const info = event.properties?.info;
            // v1 SDK: sessionID lives at info.id; v2 SDK: also at properties.sessionID
            const sessionId = event.properties?.sessionID ?? info?.id;
            if (!sessionId) return;

            // Title check: skip ephemeral distil sessions even before ephemerals.add
            // fires, guarding the session.create→session.created race (W3 fix).
            if (info?.title === EPHEMERAL_TITLE) {
              ephemerals.add(sessionId);
              return;
            }

            // Skip sessions we already know are ephemeral.
            if (ephemerals.has(sessionId)) return;
            // Skip sessions where memory load has already been attempted.
            if (primerLoaded.has(sessionId)) return;

            // Resolve agent + directory from the event payload.
            // The SDK's Session type carries both fields on EventSessionCreated.
            // Fall back to session.get() if either is absent (W2 fix).
            let agent = info?.agent;
            let project = info?.directory;

            if (!agent || !project) {
              try {
                const got = await client.session.get({ path: { id: sessionId } });
                const data = got && got.data;
                if (!agent) agent = data && data.agent;
                if (!project) project = data && data.directory;
              } catch (err) {
                log(`session.created: session.get fallback failed for ${sessionId}`, err);
              }
            }

            // Only handle the target agent; undefined = default = TARGET_AGENT.
            if (agent && agent !== TARGET_AGENT) return;
            if (!project) return;

            await loadMemoryForSession(sessionId, TARGET_AGENT, project);
            break;
          }

          // ── session.idle: idle-distil trigger ─────────────────────────────
          case 'session.idle': {
            const sessionId = event.properties?.sessionID;
            if (!sessionId) return;
            if (ephemerals.has(sessionId)) return;
            if (inFlight.has(sessionId)) return;
            if (inFlight.size >= MAX_IN_FLIGHT) {
              log(
                `in-flight cap reached (${MAX_IN_FLIGHT}); deferring idle for ${sessionId}`
              );
              return;
            }
            inFlight.add(sessionId);

            // Chain onto the serialized queue; await only this session's link
            // so a burst of idle events does not make each block on every other
            // session's model round-trip.
            const mine = (queue = queue
              .then(() => doDistil(sessionId))
              .catch((err) => log(`unhandled error in distil for ${sessionId}`, err))
              .finally(() => inFlight.delete(sessionId)));
            await mine;
            break;
          }

          // ── file.edited: accumulate into buffer ───────────────────────────
          case 'file.edited': {
            const file = event.properties?.file;
            // file.edited carries no sessionID; we attribute to the last active
            // session (single-worktree heuristic; see module comment).
            if (!file || !lastActiveSessionId) return;
            if (ephemerals.has(lastActiveSessionId)) return;
            if (!buffers.has(lastActiveSessionId)) {
              buffers.set(lastActiveSessionId, makeBuffer());
            }
            buffers.get(lastActiveSessionId).files.add(file);
            break;
          }

          // ── todo.updated: accumulate latest todo list ─────────────────────
          case 'todo.updated': {
            const sessionId = event.properties?.sessionID;
            const todos = event.properties?.todos;
            if (!sessionId || !todos) return;
            if (ephemerals.has(sessionId)) return;
            if (!buffers.has(sessionId)) buffers.set(sessionId, makeBuffer());
            // Append the full todo list as a JSON string; D2 caps to N most recent.
            buffers.get(sessionId).todos.push(JSON.stringify(todos));
            break;
          }

          // ── message.updated: D1 classification + attribution + fallback ───
          case 'message.updated': {
            const msgInfo = event.properties?.info;
            // v1 SDK: sessionID lives at info.sessionID; v2 SDK: also at properties.sessionID
            const sessionId = event.properties?.sessionID ?? msgInfo?.sessionID;
            if (!sessionId || !msgInfo) return;
            if (ephemerals.has(sessionId)) return;

            // Update attribution for file.edited (heuristic).
            lastActiveSessionId = sessionId;

            // D1 classification: record only qualifying user messages.
            if (msgInfo.role === 'user') {
              const text =
                typeof msgInfo.text === 'string'
                  ? msgInfo.text
                  : Array.isArray(msgInfo.parts)
                    ? msgInfo.parts
                        .filter((p) => p && p.type === 'text')
                        .map((p) => p.text)
                        .join(' ')
                    : '';
              if (text && isD1Message(text)) {
                if (!buffers.has(sessionId)) buffers.set(sessionId, makeBuffer());
                buffers.get(sessionId).messages.push(text.slice(0, 200));
              }
            }

            // Fallback load (W9 fix / §4): if the session was not loaded by
            // session.created (e.g. on resume), load it on the first message.
            if (!primerLoaded.has(sessionId)) {
              try {
                const got = await client.session.get({ path: { id: sessionId } });
                const data = got && got.data;
                const agent = data && data.agent;
                const project = data && data.directory;
                if ((!agent || agent === TARGET_AGENT) && project) {
                  await loadMemoryForSession(sessionId, TARGET_AGENT, project);
                }
              } catch (err) {
                log(`message.updated: fallback load failed for ${sessionId}`, err);
              }
            }
            break;
          }

          default:
            break;
        }
      } catch (err) {
        log(`event handler error for ${event.type}`, err);
        notify(`event handler error for ${event.type}`);
      }
    },
    tool: { memory_inspect, memory_correct, memory_distil_force },
    /**
     * Inject the memory primer into the LLM system prompt on every call for
     * sessions with a cached prior record. Guards in order:
     *   (a) sessionID must be present in hook input (it is optional per SDK)
     *   (b) skip ephemeral distil sessions
     *   (c) skip sessions with no cached primer (cold start or unloaded resume)
     * The whole body is wrapped in try/catch — failures degrade to no-injection
     * (consistent with the plugin's global safety contract).
     *
     * NOTE: output.system is assumed to be a fresh array per LLM call per the
     * transform-hook contract. Confirmed at implementation time (task 3.4) —
     * no idempotent-append guard is needed.
     */
    'experimental.chat.system.transform': async (input, output) => {
      let sessionID;
      try {
        ({ sessionID } = input ?? {});
        if (!sessionID) return;
        if (ephemerals.has(sessionID)) return;
        const primer = primers.get(sessionID);
        if (!primer) return;
        output.system.push(primer);
      } catch (err) {
        log(`system.transform: error for session ${sessionID ?? '(unknown)'}`, err);
      }
    },
    config: async (cfg) => {
      cfg.agent ??= {};
      // Register a hidden no-tool agent used for ephemeral distil sub-sessions.
      // Agent-level permission must be an object; { '*': 'deny' } uses the
      // wildcard key so whollyDisabled() returns true for every tool.
      // ??= avoids clobbering a user-defined 'distiller' agent.
      cfg.agent['distiller'] ??= {
        mode: 'subagent',
        hidden: true,
        permission: { '*': 'deny' },
      };
    },
  };
};

export default AgentMemory;
