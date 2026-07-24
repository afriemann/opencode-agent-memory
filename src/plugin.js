// src/plugin.js — opencode-agent-memory plugin.
//
// Components implemented here:
//   1. Event router + in-flight guard + serialized queue
//   2. Continuous signal accumulator (in-memory buffer, no LLM)
//   3. Idle-distil worker (throttle + watermark via CLI)
//   4. Injection module (session.created + fallback on message.updated)
//   5. Plugin tools (nine tool registrations)
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
      'Summarise the work session. Return ONLY a JSON object with exactly these three keys: ' +
      'last_worked_summary (string), next_action (string), open_questions (array of strings). ' +
      'No prose, no code fence.';
    console.error(`[agent-memory] distiller prompt file missing — using inline fallback: ${err}`);
  }
  return _distillerPrompt;
}

// Title used for ephemeral distil sub-sessions.
const EPHEMERAL_TITLE = 'agent-memory distil';

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
   * Log an error-level message to the opencode session log via client.app.log.
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

      // Fetch atom directory: current workspace + global
      let projectAtoms = [];
      let globalAtoms = [];
      try {
        const [wOut, gOut] = await Promise.all([
          spawnMemory($, ['atom-list', 'project', project]),
          spawnMemory($, ['atom-list', 'global', '']),
        ]);
        projectAtoms = JSON.parse(wOut.trim());
        globalAtoms = JSON.parse(gOut.trim());
      } catch (err) {
        log(`inject: atom-list failed for ${sessionId}`, err);
      }

      // Cold start: no prior memory and no atoms → no primer
      if (rows.length === 0 && projectAtoms.length === 0 && globalAtoms.length === 0) return;

      const storedSha = rows.length > 0 ? (rows[0].anchored_git_sha ?? null) : null;
      const staleness = await gitStaleness($, project, storedSha);
      const primer = assemblePrimer({
        rows,
        projectAtoms,
        globalAtoms,
        agent,
        project,
        staleness,
        cap: ATOM_INJECT_CAP,
      });

      if (primer) {
        primers.set(sessionId, primer);
        log(`inject: primer ready for ${sessionId} (${rows.length} sessions, ${projectAtoms.length} workspace atoms, ${globalAtoms.length} global atoms)`);
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
      };
      buf.files.clear();
      buf.todos.length = 0;
      buf.messages.length = 0;
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
        });
      } catch (err) {
        log(`distil: distil-write failed for ${sessionId}`, err);
        return;
      }
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
   * memory_atom_write — upsert a durable named atom.
   */
  const memory_atom_write = tool({
    description:
      'Write (upsert) a durable named memory atom. ' +
      'The `description` field is required and describes what the atom is for. ' +
      'Returns confirmation of whether the atom was created or an existing one was overwritten.',
    args: {
      topic: tool.schema.string().describe('Hierarchical key, e.g. "arch/db-layer"'),
      content: tool.schema.string().describe('Full atom content'),
      description: tool.schema.string().describe('What this atom is for (required)'),
      tags: tool.schema.array(tool.schema.string()).optional().describe('Optional tags'),
      scope: tool.schema.string().optional().describe('"workspace" (default), "global"'),
    },
    async execute({ topic, content, description, tags, scope }, context) {
      if (scope === 'all') {
        return { title: 'memory_atom_write', output: 'Error: scope="all" is not valid for write operations. Use "workspace" or "global".' };
      }
      const { scope: resolvedScope, project } = resolveScope(scope, context.directory);
      try {
        const out = await spawnMemory($, ['atom-write', resolvedScope, project],
          { topic, content, description, tags, sessionId: context.sessionID,
            sessionName: sessionNames.get(context.sessionID) ?? null });
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
      'Also shows atoms at the same topic in other workspaces.',
    args: {
      topic: tool.schema.string().describe('Topic key to look up'),
      scope: tool.schema.string().optional().describe('"workspace" (default), "global"'),
    },
    async execute({ topic, scope }, context) {
      const { scope: resolvedScope, project } = resolveScope(scope, context.directory);
      try {
        const out = await spawnMemory($, ['atom-get', resolvedScope, project, topic]);
        const result = JSON.parse(out.trim());
        const lines = [];
        if (result.match) {
          lines.push(`## ${result.match.topic}`);
          lines.push(`**Description:** ${result.match.description}`);
          lines.push('');
          lines.push(result.match.content);
        } else {
          lines.push('No matching atom found in this workspace or globally.');
        }
        if (result.alsoIn && result.alsoIn.length > 0) {
          lines.push('');
          lines.push('**Also in other workspaces:**');
          for (const a of result.alsoIn) {
            lines.push(`• ${a.scope}/${a.project || '(global)'}: ${a.topic} — ${a.description} | ${a.preview || ''}`);
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
      'Use scope="workspace" to restrict to current workspace + global, or scope="global" for global only.',
    args: {
      query: tool.schema.string().describe('Search query'),
      limit: tool.schema.number().optional().describe('Max results (default 20)'),
      scope: tool.schema.string().optional().describe('"all" (default), "workspace", "global"'),
    },
    async execute({ query, limit, scope }, context) {
      const { scope: resolvedScope, project } = resolveScope(scope ?? 'all', context.directory);
      try {
        const out = await spawnMemory($, ['atom-search', resolvedScope, project], { query, limit });
        const results = JSON.parse(out.trim());
        if (!results || results.length === 0) {
          return { title: 'memory_atom_search', output: 'No results found.' };
        }
        const lines = results.map((r) =>
          `• [${r.scope}/${r.project || 'global'}] ${r.topic} — ${r.description} | ${r.preview || ''}`
        );
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
      'Use scope="all" to include all workspaces.',
    args: {
      prefix: tool.schema.string().optional().describe('Topic prefix filter (e.g. "arch/")'),
      scope: tool.schema.string().optional().describe('"workspace" (default), "global", "all"'),
    },
    async execute({ prefix, scope }, context) {
      const { scope: resolvedScope, project } = resolveScope(scope, context.directory);
      try {
        const out = await spawnMemory($, ['atom-list', resolvedScope, project, ...(prefix ? [prefix] : [])]);
        const results = JSON.parse(out.trim());
        if (!results || results.length === 0) {
          return { title: 'memory_atom_list', output: 'No atoms found.' };
        }
        const lines = results.map((r) =>
          `• [${r.scope}/${r.project || 'global'}] ${r.topic} — ${r.description} | ${r.preview || ''}`
        );
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
      memory_atom_write,
      memory_atom_append,
      memory_atom_get,
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
        const primer = primers.get(sessionID);
        if (!primer) return;
        output.system.push(primer);
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
