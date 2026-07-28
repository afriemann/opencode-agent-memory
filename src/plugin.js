// src/plugin.js — opencode-agent-memory plugin.
//
// Components implemented here:
//   1. Event router + in-flight guard + serialized queue
//   2. Continuous signal accumulator (in-memory buffer, no LLM)
//   3. Idle-distil worker (throttle + watermark via CLI)
//   4. Injection module (session.created + fallback on message.updated)
//   5. Plugin tools (ten tool registrations)
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
import { homedir } from 'node:os';
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
  formatRelativeTime,
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
      'Summarise the work session. Return ONLY a JSON object with exactly these three keys: ' +
      'last_worked_summary (string), next_action (string), open_questions (array of strings). ' +
      'No prose, no code fence.';
    console.error(`[agent-memory] distiller prompt file missing — using inline fallback: ${err}`);
  }
  return _distillerPrompt;
}

// Title used for ephemeral distil sub-sessions.
const EPHEMERAL_TITLE = 'agent-memory distil';

// Usage protocol injected into every tracked session's system prompt.
const MEMORY_PROTOCOL = `## Memory tools — usage protocol

You have persistent memory via the \`memory_atom_*\` and \`memory_state_*\` tools.

**Write an atom** (\`memory_atom_write\`) when you discover:
- A non-obvious architectural decision or design constraint for this project
- A fact that would take real effort to re-discover: API quirks, undocumented behaviour, environment specifics
- A reality correction — something that contradicts what documentation or prior assumptions suggest

**Read before re-investigating**: before exploring a familiar domain, call \`memory_atom_search\` or \`memory_atom_list\` — previous findings may already be recorded. Use \`memory_atom_get\` to retrieve the full content of a specific atom.

**Scope**: use \`workspace\` (default) for project-specific facts; use \`global\` for facts true across all projects (host config, tool versions, cross-repo conventions).

**Update atom metadata** (\`memory_atom_patch\`) when you need to correct description, tags, created_at, or pin state without rewriting content — e.g. re-dating a migrated atom or pinning it. Use \`memory_atom_write\` when content itself changes.

**Atom lifecycle** (\`memory_atom_patch\` with \`status\`): use status to manage visibility without deleting:
- \`active\` (default) — appears in primer, list, and search
- \`resolved\` — hidden from primer; appears in list and search by default (work completed but record kept)
- \`deprecated\` — hidden from all surfaces by default; retrieve explicitly with \`includeDeprecated: true\`

Prefer \`status="deprecated"\` or \`status="resolved"\` over \`memory_atom_delete\` — it preserves history. \`memory_atom_list\` and \`memory_atom_search\` exclude deprecated atoms by default.

**Standing context** (\`always_include\`): set \`always_include: true\` on an atom to inject its **full content** into every session primer under \`### Standing context\` — the agent reads it without a \`memory_atom_get\` call. Use only for short (≤500-word) content that must be available before the user's first message: persistent project conventions, user preferences, or global coding rules. Do NOT mark long documents, spec files, or code samples as \`always_include\`. Limit: at most 5 always_include atoms per scope (workspace and global independently) are rendered; excess atoms are named in an overflow note. The \`always_include\` flag is INSERT-only on \`memory_atom_write\`; toggle it via \`memory_atom_patch\` with \`patch: { always_include: true/false }\`. Distinguish from \`pinned\`: \`pinned\` keeps the atom at the top of the compact directory listing (one line); \`always_include\` injects the full body and removes the atom from the compact directory entirely.

**Hot-state** (\`memory_state_*\`) is managed automatically — it distils on session idle. Call \`memory_state_distil\` to force an immediate save when finishing a meaningful chunk of work.`;

const MAX_IN_FLIGHT = 5000;

// ── D1 message-classification keywords ──────────────────────────────────────
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
    agentMessages: [],   // Array<string> — substantive assistant turns (≤400 chars)
  };
}

function bufferIsEmpty(buf) {
  return buf.files.size === 0 && buf.todos.length === 0 && buf.messages.length === 0 && buf.agentMessages.length === 0;
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

// ── Scope resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a user-facing scope string to { scope, project } positional args.
 *
 * @param {string|undefined} scope — 'workspace' | 'global' | 'all' | undefined
 * @param {string} directory — session working directory
 * @returns {{ scope: string, project: string }}
 */
function resolveScope(scope, directory) {
  if (scope === 'global') return { scope: 'global', project: '' };
  if (scope === 'all')    return { scope: 'all',    project: '' };
  return { scope: 'project', project: directory };
}

// ── Plugin factory ───────────────────────────────────────────────────────────

const AgentMemory = async ({ client, $ }) => {
  // ── Config (read fresh per factory call for testability) ──────────────────
  const _fileCfg = loadConfigFile();
  const {
    targetAgents,
    distilMinIntervalMs: DISTIL_MIN_INTERVAL_MS,
    distillerModel: DISTILLER_MODEL,
    atomInjectCap: ATOM_INJECT_CAP,
  } = resolveConfig(process.env, _fileCfg);
  const TARGET_AGENTS = new Set(targetAgents);

  // Fire-and-forget; never throws into opencode.
  spawnMemory($, ['prune']).catch(() => {});

  // ── Per-process mutable state ──────────────────────────────────────────────
  const inFlight = new Set();       // sessionIDs with a pending distil queued/running
  const primerLoaded = new Set();   // sessionIDs where a memory load has been attempted
  const primers = new Map();        // sessionId → assembled primer text (warm sessions only)
  const ephemerals = new Set();     // distiller sub-session IDs (skip injection + idle)
  const buffers = new Map();        // sessionId → { files, todos, messages }
  const sessionAgents = new Map();  // sessionId → resolved agent name
  const sessionNames = new Map();   // sessionId → session title (from session.created)
  // Last active session for file.edited attribution (heuristic — see I5).
  let lastActiveSessionId = null;
  let queue = Promise.resolve(); // Serialized promise chain

  /**
   * Log a message to the opencode session log via client.app.log.
   * @param {string} msg
   * @param {Error|unknown} [err] — when provided, appends stack/message and stderr; forces level='error'
   * @param {'info'|'error'} [level]
   */
  const log = (msg, err, level = err ? 'error' : 'info') => {
    const errDetail = err
      ? `: ${err instanceof Error ? err.stack ?? err.message : err}`
      : '';
    const stderrDetail = err?.stderr
      ? `\n${err.stderr.toString().trim()}`
      : '';
    const message = `[agent-memory] ${msg}${errDetail}${stderrDetail}`;
    try {
      const result = client.app.log({ body: { service: 'agent-memory', level, message } });
      result?.catch?.(() => process.stderr.write(message + '\n'));
    } catch {
      process.stderr.write(message + '\n');
    }
  };

  /**
   * Surface a critical plugin error as an in-TUI toast notification.
   */
  const notify = (msg) => {
    try {
      const result = client.tui.showToast({ body: { message: `agent-memory: ${msg}`, variant: 'error' } });
      result?.catch?.(() => {});
    } catch {
      // Intentionally silent — toast is best-effort.
    }
  };

  // ── Injection module (component 4) ────────────────────────────────────────

  /**
   * Load the memory primer for a session into the in-process `primers` Map.
   * Populates the cache exactly once per session (guarded by `primerLoaded`).
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

      const rows = state.recent ?? [];

      // Fetch atom directory: current workspace + global, and standing atoms
      let projectAtoms = [];
      let globalAtoms = [];
      let standingAtoms = [];
      let crossProjectRows = [];
      try {
        const [wOut, gOut, sOut] = await Promise.all([
          spawnMemory($, ['atom-list', 'project', project]),
          spawnMemory($, ['atom-list', 'global', '']),
          spawnMemory($, ['atom-list-full', 'project', project]),
        ]);
        projectAtoms = JSON.parse(wOut.trim());
        globalAtoms = JSON.parse(gOut.trim());
        standingAtoms = JSON.parse(sOut.trim());
      } catch (err) {
        log(`inject: atom-list failed for ${sessionId}`, err);
      }

      // Fetch cross-project activity independently so a failure here does not degrade
      // the established atom-list / standings data.
      try {
        const since24h = Date.now() - 24 * 60 * 60 * 1000;
        const cpOut = await spawnMemory($, ['hot-state-cross-project', project, String(since24h)]);
        crossProjectRows = JSON.parse(cpOut.trim());
      } catch (err) {
        log(`inject: cross-project query failed for ${sessionId}`, err);
      }

      // Cold start: no prior memory, no atoms, no cross-project activity → no primer
      if (rows.length === 0 && projectAtoms.length === 0 && globalAtoms.length === 0 && standingAtoms.length === 0 && crossProjectRows.length === 0) return;

      const storedSha = rows.length > 0 ? (rows[0].anchored_git_sha ?? null) : null;
      const staleness = await gitStaleness($, project, storedSha);
      const primer = assemblePrimer({
        rows,
        projectAtoms,
        globalAtoms,
        standingAtoms,
        crossProjectRows,
        agent,
        project,
        homeDir: homedir(),
        staleness,
        cap: ATOM_INJECT_CAP,
      });

      if (primer) {
        primers.set(sessionId, primer);
        log(`inject: primer ready for ${sessionId} (${rows.length} sessions, ${projectAtoms.length} workspace atoms, ${globalAtoms.length} global atoms, ${standingAtoms.length} standing, ${crossProjectRows.length} cross-project)`);
      } else {
        log(`inject: cold start for ${sessionId} — no prior memory or atoms, no primer`);
      }
    } catch (err) {
      log(`inject: failed for ${sessionId}`, err);
    } finally {
      // Mark load-attempted regardless of outcome.
      primerLoaded.add(sessionId);
    }
  }

  /**
   * Resolve the tracked agent name for a session.
   */
  async function resolveSessionAgent(sessionId) {
    if (sessionAgents.has(sessionId)) return sessionAgents.get(sessionId);
    try {
      const got = await client.session.get({ path: { id: sessionId } });
      const data = got && got.data;
      const agent = data && data.agent;
      if (!agent || !TARGET_AGENTS.has(agent)) return null;
      sessionAgents.set(sessionId, agent);
      return agent;
    } catch (err) {
      log(`resolveSessionAgent: session.get failed for ${sessionId}`, err);
      return null;
    }
  }

  // ── Idle-distil worker (component 3) ──────────────────────────────────────

  async function doDistil(sessionId, { force = false } = {}) {
    if (ephemerals.has(sessionId)) return;

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

    if (!agent || !TARGET_AGENTS.has(agent)) return;
    if (!project) return;

    sessionAgents.set(sessionId, agent);

    if (!primerLoaded.has(sessionId)) {
      await loadMemoryForSession(sessionId, agent, project);
    }

    let state;
    try {
      const out = await spawnMemory($, ['read', sessionId, agent, project]);
      state = JSON.parse(out.trim());
    } catch (err) {
      log(`distil: read failed for ${sessionId}`, err);
      notify(`distil read failed for session ${sessionId}`);
      return;
    }

    const { prior, signals: storedSignals, watermark } = state;

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
      return;
    }

    if (buf && !bufferIsEmpty(buf)) {
      const delta = {
        files: [...buf.files],
        todos: buf.todos.slice(),
        messages: buf.messages.slice(),
        agentMessages: buf.agentMessages.slice(),
      };
      buf.files.clear();
      buf.todos.length = 0;
      buf.messages.length = 0;
      buf.agentMessages.length = 0;
      try {
        await spawnMemory($, ['accrue', sessionId, agent, project], delta);
      } catch (err) {
        log(`distil: accrue flush failed for ${sessionId}`, err);
      }
    }

    let allSignals;
    try {
      const out2 = await spawnMemory($, ['read', sessionId, agent, project]);
      const state2 = JSON.parse(out2.trim());
      allSignals = state2.signals ?? [];
    } catch {
      allSignals = storedSignals ?? [];
    }

    const reducedSignals = reduceSignals(allSignals);

    const lastSignalMs = allSignals.reduce(
      (max, s) => Math.max(max, s.created_at ?? 0),
      0
    );

    let ephId;
    try {
      const created = await client.session.create({ body: { title: EPHEMERAL_TITLE, agent: 'distiller' } });
      ephId = created && created.data && created.data.id;
      if (!ephId) throw new Error('no session id in create response');
      ephemerals.add(ephId);
    } catch (err) {
      log(`distil: create ephemeral session failed`, err);
      return;
    }

    try {
      const distilPrompt = buildDistilPrompt(prior, reducedSignals);

      let distilled = null;
      let distilCostUsd = null;
      let distilTokensIn = null;
      let distilTokensOut = null;
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
        // Extract cost from res.data.info (AssistantMessage shape)
        const info = res && res.data && res.data.info;
        if (info) {
          if (typeof info.cost === 'number') distilCostUsd = info.cost;
          if (info.tokens) {
            if (typeof info.tokens.input === 'number') distilTokensIn = info.tokens.input;
            if (typeof info.tokens.output === 'number') distilTokensOut = info.tokens.output;
          }
        }
      } catch (err) {
        log(`distil: json_schema call failed for ${sessionId}, trying text fallback`, err);
      }

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
          if (distilled) {
            log(`distil: json_schema failed, text fallback succeeded for ${sessionId}`);
            // Extract cost from fallback response
            const info2 = res2 && res2.data && res2.data.info;
            if (info2) {
              if (typeof info2.cost === 'number') distilCostUsd = info2.cost;
              if (info2.tokens) {
                if (typeof info2.tokens.input === 'number') distilTokensIn = info2.tokens.input;
                if (typeof info2.tokens.output === 'number') distilTokensOut = info2.tokens.output;
              }
            }
          }
        } catch (err) {
          log(`distil: text fallback call failed for ${sessionId}`, err);
        }
      }

      if (!distilled) {
        log(`distil: could not parse distil reply for ${sessionId}; keeping prior state`);
        return;
      }

      const anchoredSha = await gitRevParse($, project);
      const sessionName = sessionNames.get(sessionId) ?? null;

      try {
        await spawnMemory($, ['distil-write', agent, project], {
          distilled,
          anchoredSha,
          lastSignalMs,
          sessionId,
          sessionName,
          distilCostUsd,
          distilTokensIn,
          distilTokensOut,
        });
      } catch (err) {
        log(`distil: distil-write failed for ${sessionId}`, err);
        return;
      }

      log(`distil: complete for ${sessionId} — ${reducedSignals.length} signal(s) consumed, summary: "${(distilled.last_worked_summary ?? '').slice(0, 100)}"`);
    } finally {
      try {
        await client.session.delete({ path: { id: ephId } });
      } catch { /* non-fatal */ }
      ephemerals.delete(ephId);
    }
  }

  // ── Plugin tools (component 5) ────────────────────────────────────────────

  /**
   * memory_state_inspect — non-destructive read of current hot state + signals.
   */
  const memory_state_inspect = tool({
    description:
      'Read the current agent memory hot state for this session: recent session threads, ' +
      'current signals, and the loaded primer. Does not list durable atoms — use ' +
      'memory_atom_list for the atom directory or memory_atom_get to fetch a specific atom by topic.',
    args: {},
    async execute(_args, context) {
      const agent = await resolveSessionAgent(context.sessionID);
      if (!agent) {
        return {
          title: 'memory_state_inspect',
          output: 'Session agent is not tracked by agent-memory.',
        };
      }
      try {
        const out = await spawnMemory($, ['inspect', agent, context.directory]);
        const result = JSON.parse(out.trim());
        const activePrimer = primers.get(context.sessionID) ?? null;
        return {
          title: 'memory_state_inspect',
          output: JSON.stringify({ ...result, active_primer: activePrimer }, null, 2),
        };
      } catch (err) {
        return {
          title: 'memory_state_inspect',
          output: `Error reading memory: ${err && err.message ? err.message : String(err)}`,
        };
      }
    },
  });

  /**
   * memory_state_patch — apply a partial patch to the hot state.
   */
  const memory_state_patch = tool({
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
      }).describe('Partial patch. Include only the fields you want to change.'),
    },
    async execute({ patch }, context) {
      const agent = await resolveSessionAgent(context.sessionID);
      if (!agent) {
        return {
          title: 'memory_state_patch',
          output: 'Session agent is not tracked by agent-memory.',
        };
      }
      try {
        const patchJson = JSON.stringify(patch);
        const out = await spawnMemory($, ['correct', agent, context.directory, context.sessionID, patchJson]);
        const result = JSON.parse(out.trim());
        return {
          title: 'memory_state_patch',
          output: result.created ? 'Memory patch applied (new session row created).' : 'Memory corrected successfully.',
        };
      } catch (err) {
        return {
          title: 'memory_state_patch',
          output: `Error correcting memory: ${err && err.message ? err.message : String(err)}`,
        };
      }
    },
  });

  /**
   * memory_state_distil — force an immediate distillation.
   */
  const memory_state_distil = tool({
    description:
      'Force an immediate memory distillation for the current session, bypassing the idle ' +
      'throttle window. All other guards (ephemeral skip, tracked-agent check) still apply. ' +
      'The distil-force subcommand has no CLI form; only this plugin tool triggers it.',
    args: {},
    async execute(_args, context) {
      const agent = await resolveSessionAgent(context.sessionID);
      if (!agent) {
        return {
          title: 'memory_state_distil',
          output: 'Session agent is not tracked by agent-memory.',
        };
      }
      try {
        await doDistil(context.sessionID, { force: true });
        return {
          title: 'memory_state_distil',
          output: 'Distillation triggered.',
        };
      } catch (err) {
        return {
          title: 'memory_state_distil',
          output: `Error during forced distil: ${err && err.message ? err.message : String(err)}`,
        };
      }
    },
  });

  /**
   * memory_state_delete — delete a hot_state session row by session_id.
   */
  const memory_state_delete = tool({
    description:
      'Delete a hot_state session row by session_id. ' +
      'Pass the full session_id visible in the primer\'s Recent sessions section. ' +
      'Pass an empty string "" to delete all orphaned rows (session_id IS NULL or empty) for the current project. ' +
      'Cannot delete the calling session\'s own row. ' +
      'Returns { deleted: N } — count of rows removed.',
    args: {
      sessionId: {
        type: 'string',
        description: 'The session_id of the row to delete, or "" to delete all nameless rows.',
      },
    },
    async execute({ sessionId }, context) {
      if (sessionId === context.sessionID) {
        return {
          title: 'memory_state_delete',
          output: 'Cannot delete the calling session\'s own row.',
        };
      }
      try {
        const out = await spawnMemory($, ['hot-state-delete', context.directory, sessionId ?? '']);
        return {
          title: 'memory_state_delete',
          output: out.trim(),
        };
      } catch (err) {
        return {
          title: 'memory_state_delete',
          output: `Error: ${err && err.message ? err.message : String(err)}`,
        };
      }
    },
  });

  /**
   * memory_atom_write — upsert a durable named atom.
   */
  const memory_atom_write = tool({
    description:
      'Write (upsert) a durable named memory atom. ' +
      'The `description` field is required and describes what the atom is for. ' +
      'Returns confirmation of whether the atom was created or an existing one was overwritten. ' +
      'Optional `pinned: true` marks the atom so it always appears at the top of the session primer regardless of the cap. ' +
      'Pin state is set on the first insert and is NOT overwritten by subsequent content updates — use memory_atom_patch to change the pin state of an existing atom. ' +
      'Optional `always_include: true` injects the atom\'s full content into every session primer under ### Standing context — use only for short (≤500-word) content needed before the user\'s first message (project conventions, user preferences). ' +
      'At most 5 always_include atoms per scope are rendered; excess are named in an overflow note. ' +
      'always_include is INSERT-only: re-writing an existing atom does not change it — use memory_atom_patch to toggle it. ' +
      'Status is always `active` for new atoms and is preserved on re-write — use memory_atom_patch to change an atom\'s status.',
    args: {
      topic: tool.schema.string().describe('Hierarchical key, e.g. "arch/db-layer"'),
      content: tool.schema.string().describe('Full atom content'),
      description: tool.schema.string().describe('What this atom is for (required)'),
      tags: tool.schema.array(tool.schema.string()).optional().describe('Optional tags'),
      scope: tool.schema.string().optional().describe('"workspace" (default), "global"'),
      pinned: tool.schema.boolean().optional().describe(
        'Pin this atom so it always appears in the session primer. ' +
        'Pinned atoms are listed first, before the regular capped list. ' +
        'Default false. INSERT-only: re-writing an existing atom does not change its pin state.'
      ),
      always_include: tool.schema.boolean().optional().describe(
        'Inject the atom\'s full content into the session primer Standing context section. ' +
        'Use only for short (≤500-word) content needed before the user\'s first message. ' +
        'INSERT-only: re-writing an existing atom does not change this flag — use memory_atom_patch to toggle it.'
      ),
      created_at: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional().describe(
        'Optional creation timestamp to preserve when migrating atoms. ' +
        'Accepts an ISO 8601 date string or an epoch-ms integer. ' +
        'When omitted, the current time is used.'
      ),
    },
    async execute({ topic, content, description, tags, scope, pinned, always_include, created_at }, context) {
      if (scope === 'all') {
        return { title: 'memory_atom_write', output: 'Error: scope="all" is not valid for write operations. Use "workspace" or "global".' };
      }
      const { scope: resolvedScope, project } = resolveScope(scope, context.directory);

      // Convert caller-supplied creation timestamp to epoch ms.
      let createdAt;
      if (created_at !== undefined) {
        if (typeof created_at === 'number') {
          createdAt = created_at;
        } else if (typeof created_at === 'string') {
          const parsed = new Date(created_at).getTime();
          if (!Number.isFinite(parsed)) {
            return {
              title: 'memory_atom_write',
              output: `Error: created_at "${created_at}" is not a valid ISO 8601 date string.`,
            };
          }
          createdAt = parsed;
        }
      }

      try {
        const out = await spawnMemory($, ['atom-write', resolvedScope, project],
          { topic, content, description, tags, pinned, alwaysInclude: always_include,
            sessionId: context.sessionID,
            sessionName: sessionNames.get(context.sessionID) ?? null,
            ...(createdAt !== undefined ? { createdAt } : {}) });
        const result = JSON.parse(out.trim());
        return { title: 'memory_atom_write', output: result.message };
      } catch (err) {
        return {
          title: 'memory_atom_write',
          output: `Error writing atom: ${err && err.message ? err.message : String(err)}`,
        };
      }
    },
  });

  /**
   * memory_atom_append — append to an existing atom's content.
   */
  const memory_atom_append = tool({
    description:
      'Append content to an existing memory atom. ' +
      'Uses a "\\n---\\n" separator. Errors if the topic does not exist — ' +
      'use memory_atom_write to create it first.',
    args: {
      topic: tool.schema.string().describe('Topic key of the atom to append to'),
      content: tool.schema.string().describe('Content to append'),
      scope: tool.schema.string().optional().describe('"workspace" (default), "global"'),
    },
    async execute({ topic, content, scope }, context) {
      if (scope === 'all') {
        return { title: 'memory_atom_append', output: 'Error: scope="all" is not valid for write operations. Use "workspace" or "global".' };
      }
      const { scope: resolvedScope, project } = resolveScope(scope, context.directory);
      try {
        const out = await spawnMemory($, ['atom-append', resolvedScope, project], { topic, content });
        const result = JSON.parse(out.trim());
        return { title: 'memory_atom_append', output: result.content };
      } catch (err) {
        return {
          title: 'memory_atom_append',
          output: `Error appending to atom: ${err && err.message ? err.message : String(err)}`,
        };
      }
    },
  });

  /**
   * memory_atom_get — fetch an atom by topic.
   */
  const memory_atom_get = tool({
    description:
      'Fetch a memory atom by topic. ' +
      'Returns the full content of the best match (current workspace → global priority). ' +
      'Also shows atoms at the same topic in other workspaces, including deprecated ones.\n\n' +
      'To fetch full content of an atom from a non-current workspace, supply its directory path ' +
      'as `workspace` — the value shown inside `[workspace: <path>]` in an `alsoIn` entry. ' +
      'With `workspace` set, that path becomes the resolution directory and the atom there is ' +
      'returned as the primary match. `scope="global"` overrides `workspace` when both are set.\n\n' +
      'The output always includes `status:` so you can determine whether the atom needs lifecycle management.',
    args: {
      topic: tool.schema.string().describe('Topic key to look up'),
      scope: tool.schema.string().optional().describe('"workspace" (default), "global"'),
      workspace: tool.schema.string().optional().describe(
        'Directory path of a foreign workspace (from an alsoIn listing). ' +
        'When set, resolves the atom against this path instead of the current session directory.'
      ),
    },
    async execute({ topic, scope, workspace }, context) {
      const effectiveDirectory = workspace ?? context.directory;
      const { scope: resolvedScope, project } = resolveScope(scope, effectiveDirectory);
      try {
        const out = await spawnMemory($, ['atom-get', resolvedScope, project, topic]);
        const result = JSON.parse(out.trim());
        const lines = [];
        if (result.match) {
          lines.push(`## ${result.match.topic}`);
          lines.push(`**Description:** ${result.match.description}`);
          lines.push(`**Status:** ${result.match.status || 'active'}`);
          const createdRel = result.match.created_at ? formatRelativeTime(result.match.created_at) : '';
          const updatedRel = result.match.updated_at ? formatRelativeTime(result.match.updated_at) : '';
          if (createdRel || updatedRel) {
            lines.push(`**Created:** ${createdRel || 'unknown'} | **Updated:** ${updatedRel || 'unknown'}`);
          }
          lines.push('');
          lines.push(result.match.content);
        } else {
          lines.push('No matching atom found in this workspace or globally.');
        }
        if (result.alsoIn && result.alsoIn.length > 0) {
          lines.push('');
          lines.push('**Also in other workspaces:**');
          for (const a of result.alsoIn) {
            const createdRel = a.created_at ? formatRelativeTime(a.created_at) : '';
            const updatedRel = a.updated_at ? formatRelativeTime(a.updated_at) : '';
            const location = (a.scope === 'global' || !a.project)
              ? '[global]'
              : `[workspace: ${a.project}]`;
            const statusLabel = (a.status && a.status !== 'active') ? ` [${a.status}]` : '';
            lines.push(`• ${location}${statusLabel} ${a.topic} — ${a.description} | ${a.preview || ''} [created: ${createdRel || 'unknown'}, updated: ${updatedRel || 'unknown'}]`);
          }
        }
        return { title: 'memory_atom_get', output: lines.join('\n') };
      } catch (err) {
        return {
          title: 'memory_atom_get',
          output: `Error fetching atom: ${err && err.message ? err.message : String(err)}`,
        };
      }
    },
  });

  /**
   * memory_atom_search — full-text search across atoms.
   */
  const memory_atom_search = tool({
    description:
      'Full-text search across memory atoms. ' +
      'Searches all workspaces by default. ' +
      'Use scope="workspace" to restrict to current workspace + global, or scope="global" for global only. ' +
      'By default, returns active and resolved atoms (deprecated excluded). ' +
      'Pass `status` for an exact-match filter on one status value. ' +
      'Pass `includeDeprecated: true` to include all atoms regardless of status.',
    args: {
      query: tool.schema.string().describe('Search query'),
      limit: tool.schema.number().optional().describe('Max results (default 20)'),
      scope: tool.schema.string().optional().describe('"all" (default), "workspace", "global"'),
      status: tool.schema.string().optional().describe(
        'Exact-match status filter. One of: "active", "resolved", "deprecated". ' +
        'Overrides the default active+resolved filter.'
      ),
      includeDeprecated: tool.schema.boolean().optional().describe(
        'When true, returns all atoms regardless of status, including deprecated. ' +
        'Overrides the default active+resolved filter.'
      ),
    },
    async execute({ query, limit, scope, status, includeDeprecated }, context) {
      const { scope: resolvedScope, project } = resolveScope(scope ?? 'all', context.directory);
      if (status !== undefined) {
        const VALID_STATUSES = ['active', 'resolved', 'deprecated'];
        if (!VALID_STATUSES.includes(status)) {
          return { title: 'memory_atom_search', output: `Error: status must be one of: ${VALID_STATUSES.join(', ')}` };
        }
      }
      try {
        const out = await spawnMemory($, ['atom-search', resolvedScope, project], { query, limit, status, includeDeprecated });
        const results = JSON.parse(out.trim());
        if (!results || results.length === 0) {
          return { title: 'memory_atom_search', output: 'No results found.' };
        }
        const lines = results.map((r) => {
          const createdRel = r.created_at ? formatRelativeTime(r.created_at) : 'unknown';
          const updatedRel = r.updated_at ? formatRelativeTime(r.updated_at) : 'unknown';
          const statusPrefix = (r.status && r.status !== 'active') ? `[${r.status}] ` : '';
          return `• ${statusPrefix}[${r.scope}/${r.project || 'global'}] ${r.topic} — ${r.description} | ${r.preview || ''} [created: ${createdRel}, updated: ${updatedRel}]`;
        });
        return { title: 'memory_atom_search', output: lines.join('\n') };
      } catch (err) {
        return {
          title: 'memory_atom_search',
          output: `Error searching atoms: ${err && err.message ? err.message : String(err)}`,
        };
      }
    },
  });

  /**
   * memory_atom_list — list atoms by topic prefix.
   */
  const memory_atom_list = tool({
    description:
      'List memory atoms by topic prefix. ' +
      'Defaults to current workspace + global. ' +
      'Use scope="all" to include all workspaces. ' +
      'Pinned atoms are listed first with a `[pinned]` prefix. ' +
      'By default, returns active and resolved atoms (deprecated excluded). ' +
      'Pass `status` for an exact-match filter on one status value. ' +
      'Pass `includeDeprecated: true` to include all atoms regardless of status. ' +
      'Non-active atoms are shown with a `[resolved]` or `[deprecated]` prefix in the output.',
    args: {
      prefix: tool.schema.string().optional().describe('Topic prefix filter (e.g. "arch/")'),
      scope: tool.schema.string().optional().describe('"workspace" (default), "global", "all"'),
      status: tool.schema.string().optional().describe(
        'Exact-match status filter. One of: "active", "resolved", "deprecated". ' +
        'Overrides the default active+resolved filter.'
      ),
      includeDeprecated: tool.schema.boolean().optional().describe(
        'When true, returns all atoms regardless of status, including deprecated. ' +
        'Overrides the default active+resolved filter.'
      ),
    },
    async execute({ prefix, scope, status, includeDeprecated }, context) {
      const { scope: resolvedScope, project } = resolveScope(scope, context.directory);
      if (status !== undefined) {
        const VALID_STATUSES = ['active', 'resolved', 'deprecated'];
        if (!VALID_STATUSES.includes(status)) {
          return { title: 'memory_atom_list', output: `Error: status must be one of: ${VALID_STATUSES.join(', ')}` };
        }
      }
      try {
        const optionsJson = (status !== undefined || includeDeprecated !== undefined)
          ? JSON.stringify({ ...(status !== undefined ? { status } : {}), ...(includeDeprecated !== undefined ? { includeDeprecated } : {}) })
          : undefined;
        // When optionsJson is present, always emit the prefix slot to preserve the
        // positional contract: atom-list <scope> <project> [<prefix>] [<optionsJson>].
        // Without this guard, an absent prefix would place optionsJson in the prefix
        // slot and leave optionsJson undefined in the CLI handler.
        const out = await spawnMemory($, [
          'atom-list', resolvedScope, project,
          ...(prefix || optionsJson ? [prefix ?? ''] : []),
          ...(optionsJson ? [optionsJson] : []),
        ]);
        const results = JSON.parse(out.trim());
        if (!results || results.length === 0) {
          return { title: 'memory_atom_list', output: 'No atoms found.' };
        }
        const lines = results.map((r) => {
          const createdRel = r.created_at ? formatRelativeTime(r.created_at) : 'unknown';
          const updatedRel = r.updated_at ? formatRelativeTime(r.updated_at) : 'unknown';
          const pinnedPrefix = r.pinned ? '[pinned] ' : '';
          const alwaysIncludePrefix = r.always_include ? '[always-include] ' : '';
          const statusPrefix = (r.status && r.status !== 'active') ? `[${r.status}] ` : '';
          return `• ${pinnedPrefix}${alwaysIncludePrefix}${statusPrefix}[${r.scope}/${r.project || 'global'}] ${r.topic} — ${r.description} | ${r.preview || ''} [created: ${createdRel}, updated: ${updatedRel}]`;
        });
        return { title: 'memory_atom_list', output: lines.join('\n') };
      } catch (err) {
        return {
          title: 'memory_atom_list',
          output: `Error listing atoms: ${err && err.message ? err.message : String(err)}`,
        };
      }
    },
  });

  /**
   * memory_atom_patch — partial metadata update without touching content.
   */
  const memory_atom_patch = tool({
    description:
      'Patch atom metadata (description, tags, created_at, pinned, always_include, status) without rewriting its content. ' +
      'Supply a `patch` object containing the fields to change; absent fields are left unchanged. ' +
      'At least one field inside `patch` must be present. ' +
      'To CLEAR tags, supply `tags: []` explicitly inside `patch` — omitting `tags` leaves existing tags unchanged. ' +
      '`patch.created_at` accepts an ISO 8601 date string or an epoch-ms number. ' +
      'A created_at-only patch does NOT update the atom\'s updated_at timestamp. ' +
      '`patch.pinned` pins or unpins the atom; pinned atoms always appear at the top of the session primer. ' +
      '`patch.always_include` toggles full-content injection into the session primer Standing context section. ' +
      '`patch.status` changes the atom\'s lifecycle visibility: "active" (default, all surfaces), ' +
      '"resolved" (hidden from primer; visible in list/search by default), or ' +
      '"deprecated" (hidden from all surfaces by default; retrieve with includeDeprecated: true). ' +
      'Use memory_atom_write when you need to change the atom\'s content.',
    args: {
      topic: tool.schema.string().describe('Topic key of the atom to patch'),
      scope: tool.schema.string().optional().describe('"workspace" (default), "global"'),
      workspace: tool.schema.string().optional().describe(
        'Directory path of a foreign workspace. When set, resolves the atom against this path instead of the current session directory.'
      ),
      patch: tool.schema.object({
        description: tool.schema.string().optional().describe('New description (must be non-empty if supplied)'),
        tags: tool.schema.array(tool.schema.string()).optional().describe('Replacement tags array; [] clears all tags'),
        created_at: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional().describe(
          'Replacement creation timestamp. Accepts ISO 8601 string or epoch-ms number.'
        ),
        pinned: tool.schema.boolean().optional().describe(
          'Pin or unpin the atom. Pinned atoms appear at the top of the session primer, before the regular capped list.'
        ),
        always_include: tool.schema.boolean().optional().describe(
          'Toggle full-content injection into the session primer Standing context section.'
        ),
        status: tool.schema.string().optional().describe(
          'Atom lifecycle status. One of: "active" (default, all surfaces), ' +
          '"resolved" (hidden from primer; visible in list/search by default), ' +
          '"deprecated" (hidden from all surfaces by default).'
        ),
      }).describe('Fields to patch. At least one field must be present.'),
    },
    async execute({ topic, patch = {}, scope, workspace }, context) {
      // patch = {} is a defensive default; schema requires patch but execute() can be
      // called directly in tests that bypass schema validation — the empty-patch guard below handles the fallback.
      if (scope === 'all') {
        return { title: 'memory_atom_patch', output: 'Error: scope="all" is not valid for patch operations. Use "workspace" or "global".' };
      }

      const { description, tags, created_at, pinned, always_include, status } = patch;

      // tool.schema (Zod) .optional() produces T | undefined — null is rejected at
      // schema validation before execute is called, so `!== undefined` is sufficient
      // to distinguish "caller supplied tags: []" (clear) from "caller omitted tags" (keep).
      const PATCHABLE = ['description', 'tags', 'created_at', 'pinned', 'always_include', 'status'];
      const present = PATCHABLE.filter((f) => patch[f] !== undefined);
      if (present.length === 0) {
        return { title: 'memory_atom_patch', output: 'Error: at least one of description, tags, created_at, pinned, always_include, status is required in `patch`.' };
      }

      // Validate status enum at the tool layer (before passing to CLI)
      if (status !== undefined) {
        const VALID_STATUSES = ['active', 'resolved', 'deprecated'];
        if (!VALID_STATUSES.includes(status)) {
          return {
            title: 'memory_atom_patch',
            output: `Error: status must be one of: ${VALID_STATUSES.join(', ')}`,
          };
        }
      }

      // Normalise created_at to epoch ms (mirrors memory_atom_write)
      let normCreatedAt;
      if (created_at !== undefined) {
        if (typeof created_at === 'number') {
          normCreatedAt = created_at;
        } else if (typeof created_at === 'string') {
          const parsed = new Date(created_at).getTime();
          if (!Number.isFinite(parsed)) {
            return {
              title: 'memory_atom_patch',
              output: `Error: created_at "${created_at}" is not a valid ISO 8601 date string.`,
            };
          }
          normCreatedAt = parsed;
        }
      }

      const effectiveDirectory = workspace ?? context.directory;
      const { scope: resolvedScope, project } = resolveScope(scope, effectiveDirectory);

      // Build the patch JSON with only present fields
      const patchPayload = { topic };
      if (description !== undefined) patchPayload.description = description;
      if (tags !== undefined) patchPayload.tags = tags;
      if (normCreatedAt !== undefined) patchPayload.created_at = normCreatedAt;
      if (pinned !== undefined) patchPayload.pinned = pinned;
      if (always_include !== undefined) patchPayload.always_include = always_include;
      if (status !== undefined) patchPayload.status = status;

      try {
        const out = await spawnMemory($, ['atom-patch', resolvedScope, project], patchPayload);
        const result = JSON.parse(out.trim());
        const changedFields = result.patched ? result.patched.join(', ') : present.join(', ');
        return {
          title: 'memory_atom_patch',
          output: `Patched atom '${result.topic || topic}' (${changedFields}).`,
        };
      } catch (err) {
        return {
          title: 'memory_atom_patch',
          output: `Error patching atom: ${err && err.message ? err.message : String(err)}`,
        };
      }
    },
  });

  /**
   * memory_atom_delete — remove a memory atom.
   */
  const memory_atom_delete = tool({
    description:
      'Delete a memory atom by topic. ' +
      'Errors if the atom does not exist.',
    args: {
      topic: tool.schema.string().describe('Topic key of the atom to delete'),
      scope: tool.schema.string().optional().describe('"workspace" (default), "global"'),
    },
    async execute({ topic, scope }, context) {
      if (scope === 'all') {
        return { title: 'memory_atom_delete', output: 'Error: scope="all" is not valid for delete operations. Use "workspace" or "global".' };
      }
      const { scope: resolvedScope, project } = resolveScope(scope, context.directory);
      try {
        const out = await spawnMemory($, ['atom-delete', resolvedScope, project, topic]);
        const result = JSON.parse(out.trim());
        return { title: 'memory_atom_delete', output: `Deleted atom '${topic}' (${result.deleted} row removed).` };
      } catch (err) {
        return {
          title: 'memory_atom_delete',
          output: `Error deleting atom: ${err && err.message ? err.message : String(err)}`,
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
            const sessionId = event.properties?.sessionID ?? info?.id;
            if (!sessionId) return;

            // Title check: skip ephemeral distil sessions
            if (info?.title === EPHEMERAL_TITLE) {
              ephemerals.add(sessionId);
              return;
            }

            if (ephemerals.has(sessionId)) return;
            if (primerLoaded.has(sessionId)) return;

            // Capture session name from the event; always store, null when absent
            const title = info?.title ?? null;
            sessionNames.set(sessionId, title);

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

            if (!agent || !TARGET_AGENTS.has(agent)) return;
            if (!project) return;

            sessionAgents.set(sessionId, agent);
            await loadMemoryForSession(sessionId, agent, project);
            break;
          }

          // ── session.idle: idle-distil trigger ─────────────────────────────
          case 'session.idle': {
            const sessionId = event.properties?.sessionID;
            if (!sessionId) return;
            if (ephemerals.has(sessionId)) return;
            if (inFlight.has(sessionId)) return;
            if (inFlight.size >= MAX_IN_FLIGHT) {
              log(`in-flight cap reached (${MAX_IN_FLIGHT}); deferring idle for ${sessionId}`);
              return;
            }
            inFlight.add(sessionId);

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
            buffers.get(sessionId).todos.push(JSON.stringify(todos));
            break;
          }

          // ── message.updated: D1 classification + attribution + fallback ───
          case 'message.updated': {
            const msgInfo = event.properties?.info;
            const sessionId = event.properties?.sessionID ?? msgInfo?.sessionID;
            if (!sessionId || !msgInfo) return;
            if (ephemerals.has(sessionId)) return;

            lastActiveSessionId = sessionId;

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
            } else if (msgInfo.role === 'assistant' && msgInfo.finish) {
              // Capture completed assistant turns only (finish is truthy at step-end).
              // Streaming chunks fire this event multiple times; finish is only set
              // on the final event for a completed turn (W: streaming-spam prevention).
              const body =
                typeof msgInfo.text === 'string'
                  ? msgInfo.text
                  : Array.isArray(msgInfo.parts)
                    ? msgInfo.parts
                        .filter((p) => p && p.type === 'text')
                        .map((p) => p.text)
                        .join('')
                    : '';
              if (body && body.length >= 50) {
                if (!buffers.has(sessionId)) buffers.set(sessionId, makeBuffer());
                buffers.get(sessionId).agentMessages.push(body.slice(0, 400));
              }
            }

            // Fallback load (W9 fix / §4)
            if (!primerLoaded.has(sessionId)) {
              try {
                const got = await client.session.get({ path: { id: sessionId } });
                const data = got && got.data;
                const agent = data && data.agent;
                const project = data && data.directory;
                if (agent && TARGET_AGENTS.has(agent) && project) {
                  sessionAgents.set(sessionId, agent);
                  await loadMemoryForSession(sessionId, agent, project);
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
    tool: {
      memory_state_inspect,
      memory_state_patch,
      memory_state_distil,
      memory_state_delete,
      memory_atom_write,
      memory_atom_append,
      memory_atom_get,
      memory_atom_patch,
      memory_atom_search,
      memory_atom_list,
      memory_atom_delete,
    },
    /**
     * Inject the memory primer into the LLM system prompt on every call for
     * sessions with a cached prior record.
     */
    'experimental.chat.system.transform': async (input, output) => {
      let sessionID;
      try {
        ({ sessionID } = input ?? {});
        if (!sessionID) return;
        if (ephemerals.has(sessionID)) return;
        // Inject usage protocol for every tracked session (cold start included).
        if (primerLoaded.has(sessionID)) {
          output.system.push(MEMORY_PROTOCOL);
        }
        // Inject primer data only when warm (prior sessions or atoms exist).
        const primer = primers.get(sessionID);
        if (primer) output.system.push(primer);
      } catch (err) {
        log(`system.transform: error for session ${sessionID ?? '(unknown)'}`, err);
      }
    },
    config: async (cfg) => {
      cfg.agent ??= {};
      cfg.agent['distiller'] ??= {
        mode: 'subagent',
        hidden: true,
        permission: { '*': 'deny', external_directory: 'deny' },
      };
    },
  };
};

export default AgentMemory;
