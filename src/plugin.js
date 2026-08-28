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
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import {
  buildDistilPrompt,
  parseDistilReply,
} from './lib/distil-prompt.js';
import { gitRevParse, gitStaleness } from './lib/git-helper.js';
import { findGitRootOrNull } from './lib/workspace.js';
import {
  assemblePrimer,
  reduceSignals,
  lastTwoSegments,
  formatRelativeTime,
} from './lib/signal-utils.js';
import { loadConfigFile, resolveConfig } from './lib/config.js';
import { SUMMARY_MAX_LENGTH } from './lib/schema.js';

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

**Write a summary** (\`summary\` required on \`memory_atom_write\`): a one-sentence digest of what the content contains. **Hard limit: ${SUMMARY_MAX_LENGTH} chars — the write fails if exceeded; aim for ~150 chars.** Shown in listings so other agents can triage without fetching the full content. Distinct from \`description\` (which says what the atom is *for*). May go stale after \`memory_atom_append\` — re-patch when content changes significantly.

**Read before re-investigating**: before exploring a familiar domain, call \`memory_atom_search\` or \`memory_atom_list\` — previous findings may already be recorded. Use \`memory_atom_get\` to retrieve the full content of a specific atom.

**Addressing**: \`workspace\` is optional. When omitted, the system auto-detects: in a git repo it writes to that project; outside any git repo it writes to the shared store. Pass \`workspace: "."\` to explicitly target the current project, \`workspace: null\` to explicitly target the shared store, or an absolute path for a cross-project write.

**Update atom metadata** (\`memory_atom_patch\`) when you need to correct description, summary, tags, created_at, or pin state without rewriting content — e.g. re-dating a migrated atom, pinning it, or adding a summary to an older atom that predates the summary field. Use \`memory_atom_write\` when content itself changes.

**Atom lifecycle** (\`memory_atom_patch\` with \`status\`): use status to manage visibility without deleting:
- \`active\` (default) — appears in primer, list, and search
- \`resolved\` — hidden from primer; appears in list and search by default (work completed but record kept)
- \`deprecated\` — hidden from all surfaces by default; retrieve explicitly with \`includeDeprecated: true\`

Prefer \`status="deprecated"\` or \`status="resolved"\` over \`memory_atom_delete\` — it preserves history. \`memory_atom_list\` and \`memory_atom_search\` exclude deprecated atoms by default.

**Standing context** (\`always_include\`): set \`always_include: true\` on an atom to inject its **full content** into every session primer under \`### Standing context\` — the agent reads it without a \`memory_atom_get\` call. Use only for short (≤500-word) content that must be available before the user's first message: persistent project conventions, user preferences, or global coding rules. Do NOT mark long documents, spec files, or code samples as \`always_include\`. Limit: at most 5 always_include atoms per scope (workspace and shared independently) are rendered; excess atoms are named in an overflow note. The \`always_include\` flag is INSERT-only on \`memory_atom_write\`; toggle it via \`memory_atom_patch\` with \`patch: { always_include: true/false }\`. Distinguish from \`pinned\`: \`pinned\` keeps the atom at the top of the compact directory listing (one line); \`always_include\` injects the full body and removes the atom from the compact directory entirely.

**Scope** (\`scope\` on read tools): \`scope: "workspace"\` (default) — current project atoms and shared atoms together. \`scope: "global"\` — entire space, all projects and shared atoms. To read only shared atoms, combine \`workspace: null\` with \`scope: "workspace"\`.

**Searching**: \`memory_atom_search\` uses BM25 keyword matching — NOT semantic search. Use exact terms.

**Hot-state** (\`memory_state_*\`) is managed automatically — it distils on session idle. Call \`memory_state_distil\` to force an immediate save when finishing a meaningful chunk of work.

**Migrate workspace paths to git roots** (\`/migrate-workspace-atoms\`):
If atoms were written before git-root normalisation (e.g. from a subdirectory), run this procedure:
1. Call \`memory_workspaces_list\` to enumerate every stored workspace path.
2. For each path, run \`git -C <path> rev-parse --show-toplevel\`. If it fails (non-git), skip.
3. If path ≠ git root: for each atom in that workspace (via \`memory_atom_list\` with \`scope: "all"\`, filtering by the \`[workspace: <path>]\` label), call \`memory_atom_patch\` with \`workspace: <old-path>\`, \`normalize_workspace: false\` (source — required to target the legacy sub-path without git-root normalization), and \`patch: { workspace: <git-root> }\` (destination) to move it. This is idempotent — atoms already at the git root are skipped.`;

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
    agentMessages: [],   // Array<string> — substantive assistant turns (≤agentSignalChars)
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

/**
 * Extract the best human-readable message from a spawn/tool error.
 *
 * Bun shell errors carry a `stderr` buffer with the child-process output;
 * this is usually the most informative piece.  Falls back to `err.message`
 * then a plain string conversion so the caller always gets a non-empty string.
 *
 * @param {unknown} err
 * @returns {string}
 */
function spawnError(err) {
  const stderrText = err?.stderr ? err.stderr.toString().trim() : '';
  if (stderrText) return stderrText;
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

// ── Workspace validation (plugin-side, pre-spawn) ────────────────────────────

/**
 * Validate a workspace locator at the plugin layer (before spawning).
 * Returns null on success, or a human-readable error string on failure.
 *
 * Accepted values: null (global), "." (current project), or an absolute path.
 * Any other value is rejected with a clear message.
 *
 * @param {unknown} workspace
 * @returns {string|null} — null if valid, error message if invalid
 */
function validateWorkspace(workspace) {
  if (workspace === null || workspace === undefined) return null;
  if (typeof workspace !== 'string') {
    return `workspace must be null or a string — got: ${typeof workspace}`;
  }
  if (workspace === '.') return null;
  if (isAbsolute(workspace)) return null;
  return `workspace must be null, ".", or an absolute path — got: "${workspace}"`;
}

/**
 * Resolve a directory path to the canonical project key used in hot_state and
 * atom storage. In a git repo the key is the repo root; outside any git repo
 * the key is '' (the shared-store bucket).
 *
 * @param {string} directory — absolute path (typically session.directory)
 * @returns {string}
 */
function projectKeyFor(directory) {
  return findGitRootOrNull(directory) ?? '';
}

/**
 * Format the resolved storage location for confirmation output.
 *
 * @param {string} scope — 'global' | 'project'
 * @param {string} project — the git-root path (empty string when shared)
 * @returns {string}
 */
function formatLocation(scope, project) {
  return scope === 'global' ? '[shared]' : `[workspace: ${project}]`;
}

// ── Scope resolution (read-only tools only) ───────────────────────────────────

/**
 * Resolve a user-facing scope string to { scope, project } positional args.
 * Used by read-only tools (atom-get, atom-list, atom-search) that still use
 * the legacy <scope> <project> positional CLI shape.
 *
 * Scope semantics:
 *   'workspace' (default) — current project atoms + shared atoms (atomSearch unions them)
 *   'global'              — entire space, across ALL projects (repurposed from "shared-only")
 *   'all'                 — alias for 'global' (backwards compatibility)
 *   undefined / other     — same as 'workspace'
 *
 * @param {string|undefined} scope — 'workspace' | 'global' | 'all' | undefined
 * @param {string} directory — session working directory (already normalised to git root or '')
 * @returns {{ scope: string, project: string }}
 */
function resolveScope(scope, directory) {
  if (scope === 'global') return { scope: 'all', project: '' };
  if (scope === 'all')    return { scope: 'all', project: '' };
  return { scope: 'project', project: directory };
}

// ── Plugin factory ───────────────────────────────────────────────────────────

const AgentMemory = async ({ client, $, existsSync: _existsSync = existsSync }) => {
  // ── Config (read fresh per factory call for testability) ──────────────────
  const _fileCfg = loadConfigFile();
  const {
    targetAgents,
    distilMinIntervalMs: DISTIL_MIN_INTERVAL_MS,
    distillerModel: DISTILLER_MODEL,
    atomInjectCap: ATOM_INJECT_CAP,
    agentSignalChars: AGENT_SIGNAL_CHARS,
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

      // Fetch atom directory: current workspace + shared, and standing atoms
      let projectAtoms = [];
      let sharedAtoms = [];
      let standingAtoms = [];
      let crossProjectRows = [];
      try {
        const [wOut, gOut, sOut] = await Promise.all([
          spawnMemory($, ['atom-list', 'project', project]),
          spawnMemory($, ['atom-list', 'global', '']),
          spawnMemory($, ['atom-list-full', 'project', project]),
        ]);
        projectAtoms = JSON.parse(wOut.trim());
        sharedAtoms = JSON.parse(gOut.trim());
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
      if (rows.length === 0 && projectAtoms.length === 0 && sharedAtoms.length === 0 && standingAtoms.length === 0 && crossProjectRows.length === 0) return;

      const storedSha = rows.length > 0 ? (rows[0].anchored_git_sha ?? null) : null;
      const staleness = await gitStaleness($, project, storedSha);
      const primer = assemblePrimer({
        rows,
        projectAtoms,
        sharedAtoms,
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
        log(`inject: primer ready for ${sessionId} (${rows.length} sessions, ${projectAtoms.length} workspace atoms, ${sharedAtoms.length} shared atoms, ${standingAtoms.length} standing, ${crossProjectRows.length} cross-project)`);
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
    const rawDir = session && session.directory;
    // Normalise to git root for git-backed sessions; '' for non-git sessions (shared store).
    const project = rawDir ? projectKeyFor(rawDir) : rawDir;
    // Refresh the session name so the primer always shows the final title,
    // not the "New session - <timestamp>" default from session.created.
    const freshTitle = session && session.title;
    if (freshTitle != null) sessionNames.set(sessionId, freshTitle);

    if (!agent || !TARGET_AGENTS.has(agent)) return;
    if (!rawDir) return;

    // Guard: skip silently when the session directory has been deleted from disk
    // (e.g. a worktree removed after a PR merge). Without this check the Bun
    // shell raises a PlatformError at spawn time, surfacing a confusing toast.
    if (!_existsSync(rawDir)) {
      log(`distil: skipping ${sessionId} — session directory no longer exists: ${rawDir}`);
      return;
    }

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
            format: { type: 'text' },
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
        log(`distil: text call failed for ${sessionId}`, err);
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
      'current signals, and the loaded primer. Read-only — does not modify any state, signals, or ' +
      'session records. Does not list durable atoms — use memory_atom_list for the atom directory or ' +
      'memory_atom_get to fetch a specific atom by topic. To correct fields in the hot state, use memory_state_patch.',
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
        throw new Error(spawnError(err));
      }
    },
  });

  /**
   * memory_state_patch — apply a partial patch to the hot state.
   */
  const memory_state_patch = tool({
    description:
      'Apply a partial update to the agent memory hot state. ' +
      'Call memory_state_inspect first to read the current state. ' +
      'Patchable fields: last_worked_summary, next_action, open_questions. ' +
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
        throw new Error(spawnError(err));
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
      'Call when finishing a meaningful chunk of work to ensure the session state is saved before ' +
      'the session ends or before handing off to another agent.',
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
        throw new Error(spawnError(err));
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
      'Cannot delete the calling session\'s own row — doing so would corrupt the current session\'s state. ' +
      'Returns { deleted: N } — count of rows removed.',
    args: {
      sessionId: {
        type: 'string',
        description: 'The session_id of the row to delete, or "" to delete all nameless rows.',
      },
    },
    async execute({ sessionId }, context) {
      if (sessionId === context.sessionID) {
        throw new Error('Cannot delete the calling session\'s own row.');
      }
      try {
        const out = await spawnMemory($, ['hot-state-delete', context.directory, sessionId ?? '']);
        return {
          title: 'memory_state_delete',
          output: out.trim(),
        };
      } catch (err) {
        throw new Error(spawnError(err));
      }
    },
  });

  /**
   * memory_show_injection — show the exact content injected into the system prompt.
   * Mirrors what `experimental.chat.system.transform` would push for this session.
   * Injects the content as a visible session message (noReply) so the user can read it
   * directly in the TUI without the model needing to echo it.
   */
  const memory_show_injection = tool({
    description:
      'Show the exact content injected into this session\'s system prompt by the agent-memory plugin. ' +
      'Returns the verbatim memory usage protocol and memory primer (if present) with clear section labels, ' +
      'or a message explaining why no injection is active. ' +
      'The content is also pushed as a visible message in the session so the user can read it directly ' +
      'without the agent needing to echo it. ' +
      'Use this to verify what the agent is reading about prior work and memory conventions.',
    args: {},
    async execute(_args, context) {
      const agent = await resolveSessionAgent(context.sessionID);
      if (!agent) {
        return {
          title: 'memory_show_injection',
          output: 'Session agent is not tracked by agent-memory.',
        };
      }
      if (!primerLoaded.has(context.sessionID)) {
        return {
          title: 'memory_show_injection',
          output:
            'No injection active for this session — agent-memory has not yet processed this ' +
            'session (session.created may not have fired yet).',
        };
      }
      const sections = [];
      sections.push('--- [Memory usage protocol] ---\n' + MEMORY_PROTOCOL);
      const primer = primers.get(context.sessionID);
      if (primer) {
        sections.push('--- [Memory primer] ---\n' + primer);
      } else {
        sections.push(
          '(No memory primer — cold start: no prior sessions or atoms for this project.)',
        );
      }
      const content = sections.join('\n\n');
      // Inject as a visible session message so the user can read it directly.
      // noReply: true suppresses an LLM response.
      // system: meta-note to the LLM (not shown in UI) explaining the message origin.
      // User messages render as plain text (no markdown), so strip ** and ` markers.
      const plainText = content
        .replace(/\*\*(.*?)\*\*/g, '$1')   // **bold** → bold
        .replace(/`([^`\n]+)`/g, '$1');    // `code` → code
      client.session.promptAsync({
        path: { id: context.sessionID },
        body: {
          noReply: true,
          system:
            'Plugin output injected by memory_show_injection — this message shows the ' +
            'agent-memory system prompt injection for the user to read. ' +
            'It is not a user instruction; no response is needed.',
          parts: [{ type: 'text', text: plainText }],
        },
      }).catch(() => {});
      return {
        title: 'memory_show_injection',
        output: content,
      };
    },
  });

  /**
   * memory_atom_write — upsert a durable named atom.
   */
  const memory_atom_write = tool({
    description:
      'Write (upsert) a durable named memory atom. Returns confirmation including the resolved storage location. ' +
      'The `description` field is required and describes what the atom is for. ' +
      'The `summary` field is required and must be a one-sentence digest of the atom\'s content (distinct from `description`). ' +
      'It appears in listings (memory_atom_list, memory_atom_search, and the session primer) so agents can triage without fetching the full content. Max 280 chars. ' +
      'Optional `pinned: true` marks the atom so it always appears at the top of the session primer regardless of the cap. ' +
      'Pin state is set on the first insert and is NOT overwritten by subsequent content updates — use memory_atom_patch to change the pin state of an existing atom. ' +
      'Optional `always_include: true` injects the atom\'s full content into every session primer under ### Standing context — use only for short (≤500-word) content needed before the user\'s first message (project conventions, user preferences). ' +
      'At most 5 always_include atoms per scope are rendered; excess are named in an overflow note. ' +
      'always_include is INSERT-only: re-writing an existing atom does not change it — use memory_atom_patch to toggle it. ' +
      'Status is always `active` for new atoms and is preserved on re-write — use memory_atom_patch to change an atom\'s status. ' +
      'To add content without replacing existing content, use memory_atom_append instead.',
    args: {
      topic: tool.schema.string().describe('Hierarchical key, e.g. "arch/db-layer"'),
      content: tool.schema.string().describe('Full atom content'),
      description: tool.schema.string().describe('What this atom is for (required)'),
      summary: tool.schema.string().min(1).describe(
        `Hard limit: ${SUMMARY_MAX_LENGTH} chars — the write fails if exceeded. Aim for ~150 chars. ` +
        'One tight sentence summarising what this atom contains (distinct from `description`, which says what the atom is *for*). ' +
        'Shown in atom listings so agents can triage without fetching the full content — make it actionable.'
      ),
      tags: tool.schema.array(tool.schema.string()).optional().describe('Optional tags'),
      workspace: tool.schema.union([tool.schema.string(), tool.schema.null()]).optional().describe(
        'Optional. Pass null for the shared store, "." for the current project (resolves to its git root), ' +
        'or an absolute path for a foreign project (also resolved to its git root). ' +
        'When omitted, auto-detects: writes to the current project when in a git repo, or to the shared store otherwise. ' +
        'Paths are normalised to the nearest .git directory walking upward; .git files (worktree pointers) are skipped ' +
        'so all worktrees resolve to the main repo root. ' +
        '"." is always safe for the current project regardless of which subdirectory opencode was launched from. ' +
        'Pass normalize_workspace: false to use the exact path without normalization.'
      ),
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
      normalize_workspace: tool.schema.boolean().optional().describe(
        'When false, the workspace path is used exactly as given — the git-root walk is skipped. ' +
        'Use to write an atom at a specific sub-path rather than the repository root. ' +
        'Default: true (normalize to nearest .git directory).'
      ),
    },
    async execute({ topic, content, description, summary, tags, workspace, pinned, always_include, created_at, normalize_workspace }, context) {
      const validationError = validateWorkspace(workspace);
      if (validationError) {
        throw new Error(validationError);
      }

      // Convert caller-supplied creation timestamp to epoch ms.
      let createdAt;
      if (created_at !== undefined) {
        if (typeof created_at === 'number') {
          createdAt = created_at;
        } else if (typeof created_at === 'string') {
          const parsed = new Date(created_at).getTime();
          if (!Number.isFinite(parsed)) {
            throw new Error(`created_at "${created_at}" is not a valid ISO 8601 date string.`);
          }
          createdAt = parsed;
        }
      }

      try {
        const out = await spawnMemory($, ['atom-write', context.directory],
          { workspace, topic, content, description, summary, tags, pinned, alwaysInclude: always_include,
            sessionId: context.sessionID,
            sessionName: sessionNames.get(context.sessionID) ?? null,
            ...(createdAt !== undefined ? { createdAt } : {}),
            ...(normalize_workspace !== undefined ? { normalize_workspace } : {}) });
        const result = JSON.parse(out.trim());
        const location = formatLocation(result.scope, result.project);
        const msg = result.action === 'created'
          ? `Created atom at ${topic} ${location}`
          : `Updated existing atom at ${topic} (previous content overwritten) ${location}`;
        return { title: 'memory_atom_write', output: msg };
      } catch (err) {
        throw new Error(spawnError(err));
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
      'use memory_atom_write to create it first. ' +
      'Use when adding information without replacing existing content. ' +
      'To replace content entirely, use memory_atom_write. ' +
      'Returns the full updated content of the atom after appending.',
    args: {
      topic: tool.schema.string().describe('Topic key of the atom to append to'),
      content: tool.schema.string().describe('Content to append'),
      workspace: tool.schema.union([tool.schema.string(), tool.schema.null()]).optional().describe(
        'Optional. Pass null for the shared store, "." for the current project (resolves to its git root), ' +
        'or an absolute path for a foreign project (also resolved to its git root). ' +
        'When omitted, auto-detects: writes to the current project when in a git repo, or to the shared store otherwise. ' +
        'Paths are normalised to the nearest .git directory walking upward; .git files (worktree pointers) are skipped ' +
        'so all worktrees resolve to the main repo root. ' +
        '"." is always safe for the current project regardless of which subdirectory opencode was launched from. ' +
        'Pass normalize_workspace: false to use the exact path without normalization.'
      ),
      normalize_workspace: tool.schema.boolean().optional().describe(
        'When false, the workspace path is used exactly as given — the git-root walk is skipped. ' +
        'Use to append to an atom stored at a specific sub-path rather than the repository root. ' +
        'Default: true (normalize to nearest .git directory).'
      ),
    },
    async execute({ topic, content, workspace, normalize_workspace }, context) {
      const validationError = validateWorkspace(workspace);
      if (validationError) {
        throw new Error(validationError);
      }
      try {
        const out = await spawnMemory($, ['atom-append', context.directory], {
          workspace, topic, content,
          ...(normalize_workspace !== undefined ? { normalize_workspace } : {}),
        });
        const result = JSON.parse(out.trim());
        const location = formatLocation(result.scope, result.project);
        return { title: 'memory_atom_append', output: `${result.content} ${location}` };
      } catch (err) {
        throw new Error(spawnError(err));
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
      'returned as the primary match. `scope="all"` overrides `workspace` when both are set.\n\n' +
      'The output always includes `status:` so you can determine whether the atom needs lifecycle management.',
    args: {
      topic: tool.schema.string().describe('Topic key to look up'),
      scope: tool.schema.string().optional().describe(
        '"workspace" (default), "all". scope="all" overrides the workspace parameter when both are set — returns best match across all projects and shared store.'
      ),
      workspace: tool.schema.string().optional().describe(
        'Directory path of a foreign workspace (from an alsoIn listing). ' +
        'When set, the path is used as-is — no git-root normalization — so it correctly targets atoms ' +
        'stored at legacy sub-paths (ghost atoms). Pass the exact path shown inside [workspace: <path>] ' +
        'in an alsoIn entry. Does NOT move the atom.'
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
              ? '[shared]'
              : `[workspace: ${a.project}]`;
            const statusLabel = (a.status && a.status !== 'active') ? ` [${a.status}]` : '';
            const alsoInContent = a.summary || a.preview || '';
            lines.push(`• ${location}${statusLabel} ${a.topic} — ${a.description}${alsoInContent ? ` | ${alsoInContent}` : ''} [created: ${createdRel || 'unknown'}, updated: ${updatedRel || 'unknown'}]`);
          }
        }
        return { title: 'memory_atom_get', output: lines.join('\n') };
      } catch (err) {
        throw new Error(spawnError(err));
      }
    },
  });

  /**
   * memory_atom_search — full-text search across atoms.
   */
  const memory_atom_search = tool({
    description:
      'BM25 keyword-based full-text search across memory atoms — NOT semantic or vector search. ' +
      'Searches all workspaces by default. ' +
      'Returns active and resolved atoms by default (deprecated excluded). ' +
      'Pass `status` for an exact-match filter on one status value. ' +
      'Pass `includeDeprecated: true` to include all atoms regardless of status. ' +
      'For topic-based browsing rather than keyword search, use memory_atom_list.',
    args: {
      keywords: tool.schema.string().describe(
        'Space-separated keywords to match (BM25 token matching). ' +
        'Use exact terms that appear in atom content, topic, or description. ' +
        'Natural-language phrases return poor results; prefer discrete nouns and identifiers.'
      ),
      limit: tool.schema.number().optional().describe('Max results (default 20)'),
      scope: tool.schema.string().optional().describe(
        '"all" (default — searches all workspaces including shared atoms); note this default differs from memory_atom_list ' +
        'which defaults to "workspace". Use "workspace" to restrict to current project + shared atoms. Use "global" as an alias for "all".'
      ),
      status: tool.schema.string().optional().describe(
        'Exact-match status filter. One of: "active", "resolved", "deprecated". ' +
        'Overrides the default active+resolved filter.'
      ),
      includeDeprecated: tool.schema.boolean().optional().describe(
        'When true, returns all atoms regardless of status, including deprecated. ' +
        'Overrides the default active+resolved filter.'
      ),
    },
    async execute({ keywords, limit, scope, status, includeDeprecated }, context) {
      const { scope: resolvedScope, project } = resolveScope(scope ?? 'all', context.directory);
      if (status !== undefined) {
        const VALID_STATUSES = ['active', 'resolved', 'deprecated'];
        if (!VALID_STATUSES.includes(status)) {
          throw new Error(`status must be one of: ${VALID_STATUSES.join(', ')}`);
        }
      }
      try {
        const out = await spawnMemory($, ['atom-search', resolvedScope, project], { keywords, limit, status, includeDeprecated });
        const results = JSON.parse(out.trim());
        if (!results || results.length === 0) {
          return { title: 'memory_atom_search', output: 'No results found.' };
        }
        const lines = results.map((r) => {
          const createdRel = r.created_at ? formatRelativeTime(r.created_at) : 'unknown';
          const updatedRel = r.updated_at ? formatRelativeTime(r.updated_at) : 'unknown';
          const statusPrefix = (r.status && r.status !== 'active') ? `[${r.status}] ` : '';
          const searchContent = r.summary || r.preview || '';
          const locationLabel = (r.scope === 'global' || !r.project) ? '[shared]' : `[workspace: ${r.project}]`;
          return `• ${statusPrefix}${locationLabel} ${r.topic} — ${r.description}${searchContent ? ` | ${searchContent}` : ''} [created: ${createdRel}, updated: ${updatedRel}]`;
        });
        return { title: 'memory_atom_search', output: lines.join('\n') };
      } catch (err) {
        throw new Error(spawnError(err));
      }
    },
  });

  /**
   * memory_atom_list — list atoms by topic prefix.
   */
  const memory_atom_list = tool({
    description:
      'List memory atoms by topic prefix. ' +
      'Defaults to current workspace + shared atoms. ' +
      'Use scope="all" to include all workspaces. ' +
      'Pinned atoms are listed first with a `[pinned]` prefix. ' +
      'By default, returns active and resolved atoms (deprecated excluded). ' +
      'Pass `status` for an exact-match filter on one status value. ' +
      'Pass `includeDeprecated: true` to include all atoms regardless of status. ' +
      'Non-active atoms are shown with a `[resolved]` or `[deprecated]` prefix in the output. ' +
      'To search by content keywords rather than topic prefix, use memory_atom_search.',
    args: {
      prefix: tool.schema.string().optional().describe('Topic prefix filter (e.g. "arch/")'),
      scope: tool.schema.string().optional().describe(
        '"workspace" (default — current project + shared atoms); "global" (entire space — all workspaces including other projects and shared atoms); "all" (alias for "global").'
      ),
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
          throw new Error(`status must be one of: ${VALID_STATUSES.join(', ')}`);
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
          const listContent = r.summary || r.preview || '';
          const locationLabel = (r.scope === 'global' || !r.project) ? '[shared]' : `[workspace: ${r.project}]`;
          return `• ${pinnedPrefix}${alwaysIncludePrefix}${statusPrefix}${locationLabel} ${r.topic} — ${r.description}${listContent ? ` | ${listContent}` : ''} [created: ${createdRel}, updated: ${updatedRel}]`;
        });
        return { title: 'memory_atom_list', output: lines.join('\n') };
      } catch (err) {
        throw new Error(spawnError(err));
      }
    },
  });

  /**
   * memory_atom_patch — partial metadata update without touching content.
   */
  const memory_atom_patch = tool({
    description:
      'Patch atom metadata (description, tags, created_at, pinned, always_include, status, summary) without rewriting its content. ' +
      'Also supports an atomic workspace move: supply patch.workspace to relocate the atom to a different workspace ' +
      'in one transaction (delete from source, re-insert at destination). ' +
      'Supply a `patch` object containing the fields to change; absent fields are left unchanged. ' +
      'At least one field inside `patch` must be present. ' +
      'To CLEAR tags, supply `tags: []` explicitly inside `patch` — omitting `tags` leaves existing tags unchanged. ' +
      '`patch.created_at` accepts an ISO 8601 date string or an epoch-ms number. ' +
      'A created_at-only patch does NOT update the atom\'s updated_at timestamp. ' +
      '`patch.status` changes the atom\'s lifecycle visibility: "active" (default, all surfaces), ' +
      '"resolved" (hidden from primer; visible in list/search by default), or ' +
      '"deprecated" (hidden from all surfaces by default; retrieve with includeDeprecated: true). ' +
      '`patch.summary` replaces the one-sentence content digest shown in listings. ' +
      `Hard limit: ${SUMMARY_MAX_LENGTH} chars — the write fails if exceeded. Aim for ~150 chars. ` +
      'Use to retroactively add a summary to older atoms that predate the summary field, or to correct a stale summary after significant content appends. ' +
      'Use memory_atom_write when you need to change the atom\'s content.',
    args: {
      topic: tool.schema.string().describe('Topic key of the atom to patch'),
      workspace: tool.schema.union([tool.schema.string(), tool.schema.null()]).optional().describe(
        'Optional. Pass null for the shared store, "." for the current project (resolves to its git root), ' +
        'or an absolute path for a foreign project (also resolved to its git root). ' +
        'When omitted, auto-detects: patches the atom in the current project when in a git repo, or in the shared store otherwise. ' +
         'Paths are normalised to the nearest .git directory walking upward; .git files (worktree pointers) are skipped ' +
         'so all worktrees resolve to the main repo root. ' +
         '"." is always safe for the current project regardless of which subdirectory opencode was launched from. ' +
         'Pass normalize_workspace: false to use the exact path without normalization — required when targeting a ghost atom at a legacy sub-path. ' +
         'This is the source — where the atom currently lives. To move the atom, supply patch.workspace.'
      ),
      normalize_workspace: tool.schema.boolean().optional().describe(
        'When false, the workspace path is used exactly as given — the git-root walk is skipped. ' +
        'Use to target a ghost atom stored at a legacy sub-path (e.g. the exact path shown inside ' +
        '[workspace: <path>] in an alsoIn listing). Only applies to the source workspace; the ' +
        'destination (patch.workspace) is always normalized. Default: true.'
      ),
      patch: tool.schema.object({
        description: tool.schema.string().optional().describe('New description (must be non-empty if supplied)'),
        summary: tool.schema.string().optional().describe(
          'Replacement one-sentence digest of the atom\'s content. Max 280 chars. ' +
          'Use to retroactively add summaries to older atoms, or to correct a stale summary after memory_atom_append.'
        ),
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
        workspace: tool.schema.union([tool.schema.string(), tool.schema.null()]).optional().describe(
          'Optional. If supplied, triggers an atomic move: the atom is deleted from the source workspace and ' +
          're-inserted at the destination in one transaction. Accepts the same null/"."/absolute-path values as ' +
          'the top-level workspace param. Combined with other patch fields: metadata is updated and the atom is ' +
          'moved in one operation. Source == destination: treated as an in-place patch. Destination conflict: overwritten.'
        ),
      }).describe('Fields to patch. At least one field must be present.'),
    },
    async execute({ topic, patch = {}, workspace, normalize_workspace }, context) {
      // patch = {} is a defensive default; schema requires patch but execute() can be
      // called directly in tests that bypass schema validation — the empty-patch guard below handles the fallback.

      // Validate source workspace
      const sourceValidationError = validateWorkspace(workspace);
      if (sourceValidationError) {
        throw new Error(sourceValidationError);
      }

      const { description, summary, tags, created_at, pinned, always_include, status, workspace: destWorkspace } = patch;

      // Validate destination workspace when a move is requested
      if (destWorkspace !== undefined) {
        const destValidationError = validateWorkspace(destWorkspace);
        if (destValidationError) {
          throw new Error(`patch.workspace: ${destValidationError}`);
        }
      }

      // Collect patchable metadata fields (exclude workspace — that's a move trigger, not metadata)
      // tool.schema (Zod) .optional() produces T | undefined — null is rejected at
      // schema validation before execute is called, so `!== undefined` is sufficient
      // to distinguish "caller supplied tags: []" (clear) from "caller omitted tags" (keep).
      const PATCHABLE = ['description', 'summary', 'tags', 'created_at', 'pinned', 'always_include', 'status'];
      const present = PATCHABLE.filter((f) => patch[f] !== undefined);
      const isMove = destWorkspace !== undefined;

      if (present.length === 0 && !isMove) {
        throw new Error('at least one of description, summary, tags, created_at, pinned, always_include, status is required in `patch`.');
      }

      // Validate status enum at the tool layer (before passing to CLI)
      if (status !== undefined) {
        const VALID_STATUSES = ['active', 'resolved', 'deprecated'];
        if (!VALID_STATUSES.includes(status)) {
          throw new Error(`status must be one of: ${VALID_STATUSES.join(', ')}`);
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
            throw new Error(`created_at "${created_at}" is not a valid ISO 8601 date string.`);
          }
          normCreatedAt = parsed;
        }
      }

      // Build the patch JSON with only present fields
      // patch.workspace becomes targetWorkspace in the CLI payload (move trigger)
      const patchPayload = { topic, workspace };
      if (normalize_workspace !== undefined) patchPayload.normalize_workspace = normalize_workspace;
      if (description !== undefined) patchPayload.description = description;
      if (summary !== undefined) patchPayload.summary = summary;
      if (tags !== undefined) patchPayload.tags = tags;
      if (normCreatedAt !== undefined) patchPayload.created_at = normCreatedAt;
      if (pinned !== undefined) patchPayload.pinned = pinned;
      if (always_include !== undefined) patchPayload.always_include = always_include;
      if (status !== undefined) patchPayload.status = status;
      if (isMove) patchPayload.targetWorkspace = destWorkspace;

      // Build a human-readable summary of the patched values for the output.
      // String values are shown quoted and truncated at 80 chars.
      const patchLines = present.map((f) => {
        const val = patchPayload[f];
        let display;
        if (typeof val === 'string') {
          const truncated = val.length > 80 ? `${val.slice(0, 77)}...` : val;
          display = `"${truncated}"`;
        } else {
          display = JSON.stringify(val);
        }
        return `  ${f}: ${display}`;
      }).join('\n');

      try {
        const out = await spawnMemory($, ['atom-patch', context.directory], patchPayload);
        const result = JSON.parse(out.trim());
        if (result.moved) {
          const fromLoc = formatLocation(result.from.scope, result.from.project);
          const toLoc   = formatLocation(result.to.scope, result.to.project);
          const moveLines = patchLines ? `\n${patchLines}` : '';
          return {
            title: 'memory_atom_patch',
            output: `Moved atom '${result.topic || topic}' from ${fromLoc} to ${toLoc}${moveLines}`,
          };
        }
        const location = formatLocation(result.scope, result.project);
        return {
          title: 'memory_atom_patch',
          output: `Patched '${result.topic || topic}' ${location}${patchLines ? `\n${patchLines}` : ''}`,
        };
      } catch (err) {
        throw new Error(spawnError(err));
      }
    },
  });

  /**
   * memory_atom_delete — remove a memory atom.
   */
  const memory_atom_delete = tool({
    description:
      'Delete a memory atom by topic. Errors if the atom does not exist. ' +
      'Returns confirmation including the resolved storage location. ' +
      'PREFER memory_atom_patch with status="deprecated" or status="resolved" over deletion — ' +
      'those preserve history while hiding the atom from normal surfaces. ' +
      'Use delete only when the atom must be permanently removed (e.g. it contains secrets or was created in error).',
    args: {
      topic: tool.schema.string().describe('Topic key of the atom to delete'),
      workspace: tool.schema.union([tool.schema.string(), tool.schema.null()]).optional().describe(
        'Optional. Pass null for the shared store, "." for the current project (resolves to its git root), ' +
        'or an absolute path for a foreign project (also resolved to its git root). ' +
        'When omitted, auto-detects: deletes from the current project when in a git repo, or from the shared store otherwise. ' +
        'Paths are normalised to the nearest .git directory walking upward; .git files (worktree pointers) are skipped ' +
        'so all worktrees resolve to the main repo root. ' +
        '"." is always safe for the current project regardless of which subdirectory opencode was launched from. ' +
        'Pass normalize_workspace: false to use the exact path without normalization — required when deleting a ghost atom at a legacy sub-path.'
      ),
      normalize_workspace: tool.schema.boolean().optional().describe(
        'When false, the workspace path is used exactly as given — the git-root walk is skipped. ' +
        'Use to delete a ghost atom stored at a legacy sub-path (e.g. the exact path shown inside ' +
        '[workspace: <path>] in an alsoIn listing). Default: true (normalize to nearest .git directory).'
      ),
    },
    async execute({ topic, workspace, normalize_workspace }, context) {
      const validationError = validateWorkspace(workspace);
      if (validationError) {
        throw new Error(validationError);
      }
      try {
        const out = await spawnMemory($, ['atom-delete', context.directory], {
          workspace, topic,
          ...(normalize_workspace !== undefined ? { normalize_workspace } : {}),
        });
        const result = JSON.parse(out.trim());
        const location = formatLocation(result.scope, result.project);
        return { title: 'memory_atom_delete', output: `Deleted atom '${topic}' (${result.deleted} row removed) ${location}` };
      } catch (err) {
        throw new Error(spawnError(err));
      }
    },
  });

  /**
   * memory_workspaces_list — list all workspace git-root paths that have stored atoms.
   */
  const memory_workspaces_list = tool({
    description:
      'List all workspace git-root paths that contain at least one stored atom, with per-workspace atom counts. ' +
      'Shared atoms (not attached to any project) are NOT listed here — to list shared atoms use memory_atom_list with workspace: null. ' +
      'Output: one line per workspace — "• /path — N atom(s)"; ends with a usage note. ' +
      'Pass includeDeprecated: true to count deprecated atoms alongside active and resolved ones.',
    args: {
      includeDeprecated: tool.schema.boolean().optional().describe(
        'When true, count deprecated atoms alongside active and resolved ones.'
      ),
    },
    async execute({ includeDeprecated }, _context) {
      try {
        const optionsJson = includeDeprecated !== undefined
          ? JSON.stringify({ includeDeprecated })
          : undefined;
        const out = await spawnMemory($,
          optionsJson ? ['atom-list-workspaces', optionsJson] : ['atom-list-workspaces']
        );
        const results = JSON.parse(out.trim());
        if (!results || results.length === 0) {
          return { title: 'memory_workspaces_list', output: 'No workspaces with stored atoms.' };
        }
        const lines = results.map((r) => `• ${r.workspace} — ${r.count} atom(s)`);
        lines.push(
          '\nPass workspace: <path> to target a specific workspace. Paths are git roots. ' +
          'Shared atoms are not listed here — use scope: "global" on read tools to search the entire space including shared atoms.'
        );
        return { title: 'memory_workspaces_list', output: lines.join('\n') };
      } catch (err) {
        throw new Error(spawnError(err));
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
            let rawDir = info?.directory;

            if (!agent || !rawDir) {
              try {
                const got = await client.session.get({ path: { id: sessionId } });
                const data = got && got.data;
                if (!agent) agent = data && data.agent;
                if (!rawDir) rawDir = data && data.directory;
              } catch (err) {
                log(`session.created: session.get fallback failed for ${sessionId}`, err);
              }
            }

            if (!agent || !TARGET_AGENTS.has(agent)) return;
            if (!rawDir) return;

            // Normalise to git root for git-backed sessions; '' for non-git sessions.
            const project = projectKeyFor(rawDir);
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
                buffers.get(sessionId).agentMessages.push(body.slice(0, AGENT_SIGNAL_CHARS));
              }
            }

            // Fallback load (W9 fix / §4)
            if (!primerLoaded.has(sessionId)) {
              try {
                const got = await client.session.get({ path: { id: sessionId } });
                const data = got && got.data;
                const agent = data && data.agent;
                const rawDir = data && data.directory;
                if (agent && TARGET_AGENTS.has(agent) && rawDir) {
                  const project = projectKeyFor(rawDir);
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
      memory_show_injection,
      memory_atom_write,
      memory_atom_append,
      memory_atom_get,
      memory_atom_patch,
      memory_atom_search,
      memory_atom_list,
      memory_atom_delete,
      memory_workspaces_list,
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
