#!/usr/bin/env node
// src/memory.js — sole DB writer for opencode-agent-memory.
//
// This CLI is the ONLY process that opens agent-memory.db for writing. The
// plugin (src/plugin.js) spawns it via $ and never touches the DB directly.
// All subcommands are idempotent or safe to retry on failure.
//
// Subcommands:
//   init
//     Create the schema (idempotent). Safe to run at any time.
//
//   accrue <sessionId> <agent> <project> <jsonData>
//     jsonData: JSON string { files: string[], todos: string[], messages: string[] }
//     Write accumulated buffer signals to memory_signal.
//
//   read <sessionId> <agent> <project>
//     stdout: { prior: row|null, recent: row[], signals: row[], watermark: … }
//     Read the session-scoped hot_state row, top-3 recent rows for the project,
//     session-scoped signals, and watermark.
//
//   inspect <agent> <project>
//     stdout: { prior: row|null, signals: row[] }
//     Non-destructive read of all hot_state rows + signals for the project.
//
//   distil-write <agent> <project> <jsonData>
//     jsonData: { distilled:{…}, anchoredSha:string|null, lastSignalMs:number,
//                 sessionId:string, sessionName?:string }
//     UPSERT session-scoped hot_state (monotonic guard per session_id),
//     delete consumed signals scoped to session_id, prune old rows, advance watermark.
//
//   correct <agent> <project> <sessionId> <patchJson>
//     patchJson: partial JSON object with any of: last_worked_summary, next_action,
//                open_questions. Absent fields keep current values.
//     Upserts a skeleton row when absent (cold-start safe).
//
//   atom-write <contextDirectory> <json>
//     json: { workspace, topic, content, description, summary, tags?, sessionId?, sessionName? }
//     workspace: null | "." | absolute path (resolved to git root)
//
//   atom-append <contextDirectory> <json>
//     json: { workspace, topic, content }
//
//   atom-get <scope> <project> <topic>
//
//   atom-search <scope> <project> <json>
//     json: { keywords, limit?, status?, includeDeprecated? }
//
//   atom-list <scope> <project> [<prefix>] [<optionsJson>]
//     optionsJson (optional): { status?, includeDeprecated? }
//
//   atom-list-full <scope> <project>
//     stdout: JSON array of { scope, project, topic, description, content, updated_at }
//     Returns full content for all always_include=1 active atoms in scope.
//
//   atom-delete <contextDirectory> <json>
//     json: { workspace, topic }
//
//   atom-list-workspaces [<optionsJson>]
//     optionsJson (optional): { includeDeprecated? }
//     stdout: JSON array of { workspace, count }
//
//   prune
//     Delete memory_signal rows older than 30 days. Idempotent.
//
//   hot-state-cross-project <currentProject> <sinceMs>
//     stdout: JSON array of { project, updated_at }
//     Query hot_state for projects other than currentProject active since sinceMs.
//     Returns one row per distinct project, most recently active first.

import { openDb } from './lib/db.js';
import {
  ensureSchema,
  pruneHotState,
  normaliseTopic,
  atomWrite,
  atomAppend,
  atomGet,
  atomPatch,
  atomSearch,
  atomList,
  atomListFull,
  atomDelete,
  atomListWorkspaces,
  hotStateCrossProject,
  hotStateDelete,
} from './lib/schema.js';
import { resolveWorkspace } from './lib/workspace.js';
import { readDistilWatermark, advanceDistilWatermark } from './lib/watermark.js';
import { EMPTY_RECORD } from './lib/distil-prompt.js';

// ── DB bootstrap ────────────────────────────────────────────────────────────

function openAndInit() {
  const db = openDb();
  ensureSchema(db);
  return db;
}

// ── Subcommand handlers ─────────────────────────────────────────────────────

function cmdInit() {
  const db = openAndInit();
  db.close();
}

async function cmdAccrue(sessionId, agent, project, jsonArg) {
  if (!jsonArg || !jsonArg.trim()) return; // Nothing to write

  let delta;
  try {
    delta = JSON.parse(jsonArg);
  } catch {
    process.stderr.write('[agent-memory/accrue] invalid JSON argument\n');
    process.exit(1);
  }

  const db = openAndInit();
  const now = Date.now();

  const insert = db.prepare(`
    INSERT INTO memory_signal (session_id, scope, agent, project, kind, payload, created_at)
    VALUES (?, 'project', ?, ?, ?, ?, ?)
  `);

  const files = Array.isArray(delta.files) ? delta.files : [];
  const todos = Array.isArray(delta.todos) ? delta.todos : [];
  const messages = Array.isArray(delta.messages) ? delta.messages : [];
  const agentMessages = Array.isArray(delta.agentMessages) ? delta.agentMessages : [];

  db.exec('BEGIN');
  try {
    for (const file of files) {
      if (typeof file === 'string' && file) {
        insert.run(sessionId, agent, project, 'file', file, now);
      }
    }
    for (const todo of todos) {
      if (typeof todo === 'string' && todo) {
        insert.run(sessionId, agent, project, 'todo', todo, now);
      }
    }
    for (const msg of messages) {
      if (typeof msg === 'string' && msg) {
        insert.run(sessionId, agent, project, 'message', msg, now);
      }
    }
    for (const agentMsg of agentMessages) {
      if (typeof agentMsg === 'string' && agentMsg) {
        insert.run(sessionId, agent, project, 'agent', agentMsg, now);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  db.close();
}

function cmdRead(sessionId, agent, project) {
  const db = openAndInit();

  // Session-scoped prior row
  const priorRow = db
    .prepare(`
      SELECT id, scope, agent, project, session_id, session_name,
             last_worked_summary, next_action, open_questions,
             anchored_git_sha, schema_version, updated_at
      FROM hot_state
      WHERE scope = 'project' AND agent = ? AND project = ? AND session_id = ?
    `)
    .get(agent, project, sessionId);

  let prior = null;
  if (priorRow) {
    let open_questions = [];
    try {
      open_questions = priorRow.open_questions ? JSON.parse(priorRow.open_questions) : [];
    } catch { /* leave as [] */ }
    prior = { ...priorRow, open_questions };
  }

  // Top-3 most recent hot_state rows for the project (for session threads display)
  const recentRows = db
    .prepare(`
      SELECT id, scope, agent, project, session_id, session_name,
             last_worked_summary, next_action, open_questions,
             anchored_git_sha, schema_version, updated_at
      FROM hot_state
      WHERE scope = 'project' AND agent = ? AND project = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 3
    `)
    .all(agent, project);

  const recent = recentRows.map((row) => {
    let open_questions = [];
    try {
      open_questions = row.open_questions ? JSON.parse(row.open_questions) : [];
    } catch { /* leave as [] */ }
    return { ...row, open_questions };
  });

  // Session-scoped signals
  const signals = db
    .prepare(`
      SELECT id, session_id, scope, agent, project, kind, payload, created_at
      FROM memory_signal
      WHERE scope = 'project' AND agent = ? AND project = ? AND session_id = ?
      ORDER BY created_at ASC
    `)
    .all(agent, project, sessionId);

  // Read watermark for this session
  const watermark = readDistilWatermark(db, sessionId);

  db.close();

  process.stdout.write(JSON.stringify({ prior, recent, signals, watermark }) + '\n');
}

function cmdInspect(agent, project) {
  const db = openAndInit();

  // All hot_state rows for (scope='project', agent, project)
  const allRows = db
    .prepare(`
      SELECT id, scope, agent, project, session_id, session_name,
             last_worked_summary, next_action, open_questions,
             anchored_git_sha, distil_cost_usd, distil_tokens_in, distil_tokens_out, updated_at
      FROM hot_state
      WHERE scope = 'project' AND agent = ? AND project = ?
      ORDER BY updated_at DESC, id DESC
    `)
    .all(agent, project);

  const rows = allRows.map((row) => {
    let open_questions = [];
    try {
      open_questions = row.open_questions ? JSON.parse(row.open_questions) : [];
    } catch { /* leave as [] */ }
    return { ...row, open_questions };
  });

  // All signals for (scope='project', agent, project) — not session-scoped for inspect
  const signals = db
    .prepare(`
      SELECT id, session_id, scope, agent, project, kind, payload, created_at
      FROM memory_signal
      WHERE scope = 'project' AND agent = ? AND project = ?
      ORDER BY created_at ASC
    `)
    .all(agent, project);

  db.close();

  // prior = most recent row (first after ORDER BY updated_at DESC)
  const prior = rows.length > 0 ? rows[0] : null;
  process.stdout.write(JSON.stringify({ prior, rows, signals }) + '\n');
}

function cmdCorrect(agent, project, sessionId, patchJsonArg) {
  let patch;
  try {
    patch = JSON.parse(patchJsonArg);
  } catch {
    process.stderr.write('[agent-memory/correct] invalid JSON argument\n');
    process.exit(1);
  }

  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    process.stderr.write('[agent-memory/correct] patch must be a JSON object\n');
    process.exit(1);
  }

  // Validate allowed fields (adr_candidate removed)
  if ('last_worked_summary' in patch && typeof patch.last_worked_summary !== 'string') {
    process.stderr.write('[agent-memory/correct] last_worked_summary must be a string\n');
    process.exit(1);
  }
  if ('next_action' in patch && typeof patch.next_action !== 'string') {
    process.stderr.write('[agent-memory/correct] next_action must be a string\n');
    process.exit(1);
  }
  if ('open_questions' in patch && !Array.isArray(patch.open_questions)) {
    process.stderr.write('[agent-memory/correct] open_questions must be an array\n');
    process.exit(1);
  }

  const db = openAndInit();

  db.exec('BEGIN IMMEDIATE');
  try {
    const currentRow = db
      .prepare(`
        SELECT last_worked_summary, next_action, open_questions,
               anchored_git_sha, updated_at
        FROM hot_state
        WHERE scope = 'project' AND agent = ? AND project = ? AND session_id = ?
      `)
      .get(agent, project, sessionId);

    let baseOpenQuestions = EMPTY_RECORD.open_questions;
    if (currentRow) {
      try {
        baseOpenQuestions = currentRow.open_questions
          ? JSON.parse(currentRow.open_questions)
          : [];
      } catch { /* leave as [] */ }
    }

    const base = {
      last_worked_summary: currentRow?.last_worked_summary ?? EMPTY_RECORD.last_worked_summary,
      next_action:         currentRow?.next_action         ?? EMPTY_RECORD.next_action,
      open_questions:      baseOpenQuestions,
      anchored_git_sha:    currentRow?.anchored_git_sha    ?? null,
      updated_at:          currentRow?.updated_at          ?? 0,
    };

    const merged = {
      last_worked_summary: 'last_worked_summary' in patch ? patch.last_worked_summary : base.last_worked_summary,
      next_action:         'next_action'         in patch ? patch.next_action         : base.next_action,
      open_questions:      'open_questions'      in patch ? patch.open_questions      : base.open_questions,
    };

    const newUpdatedAt = base.updated_at + 1;
    const isNew = !currentRow;

    // Upsert with session_id — ON CONFLICT now targets (scope,agent,project,session_id)
    db.prepare(`
      INSERT INTO hot_state
        (scope, agent, project, session_id, last_worked_summary, next_action,
         open_questions, anchored_git_sha, schema_version, updated_at)
      VALUES ('project', ?, ?, ?, ?, ?, ?, ?, 2, ?)
      ON CONFLICT(scope, agent, project, session_id) DO UPDATE SET
        last_worked_summary = excluded.last_worked_summary,
        next_action         = excluded.next_action,
        open_questions      = excluded.open_questions,
        schema_version      = excluded.schema_version,
        updated_at          = excluded.updated_at
      WHERE excluded.updated_at > hot_state.updated_at
    `).run(
      agent, project, sessionId,
      merged.last_worked_summary,
      merged.next_action,
      JSON.stringify(merged.open_questions),
      base.anchored_git_sha,
      newUpdatedAt
    );

    db.exec('COMMIT');

    process.stdout.write(JSON.stringify({ ok: true, created: isNew }) + '\n');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  db.close();
}

async function cmdDistilWrite(agent, project, jsonArg) {
  let input;
  try {
    input = JSON.parse(jsonArg);
  } catch {
    process.stderr.write('[agent-memory/distil-write] invalid JSON argument\n');
    process.exit(1);
  }

  const { distilled, anchoredSha, lastSignalMs, sessionId, sessionName,
          distilCostUsd, distilTokensIn, distilTokensOut } = input;

  if (!distilled || typeof distilled !== 'object') {
    process.stderr.write('[agent-memory/distil-write] missing distilled field\n');
    process.exit(1);
  }

  const db = openAndInit();
  const now = Date.now();

  const summary = distilled.last_worked_summary ?? '';
  const nextAction = distilled.next_action ?? '';
  const openQuestions = JSON.stringify(
    Array.isArray(distilled.open_questions) ? distilled.open_questions : []
  );

  // Normalise cost fields: store null when absent or not a number
  const costUsd = typeof distilCostUsd === 'number' ? distilCostUsd : null;
  const tokensIn = typeof distilTokensIn === 'number' ? distilTokensIn : null;
  const tokensOut = typeof distilTokensOut === 'number' ? distilTokensOut : null;

  db.exec('BEGIN');
  try {
    // UPSERT session-scoped hot_state with monotonic guard
    db.prepare(`
      INSERT INTO hot_state
        (scope, agent, project, session_id, session_name, last_worked_summary, next_action,
         open_questions, anchored_git_sha, schema_version,
         distil_cost_usd, distil_tokens_in, distil_tokens_out, updated_at)
      VALUES ('project', ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?)
      ON CONFLICT(scope, agent, project, session_id) DO UPDATE SET
        session_name        = excluded.session_name,
        last_worked_summary = excluded.last_worked_summary,
        next_action         = excluded.next_action,
        open_questions      = excluded.open_questions,
        anchored_git_sha    = excluded.anchored_git_sha,
        schema_version      = excluded.schema_version,
        distil_cost_usd     = excluded.distil_cost_usd,
        distil_tokens_in    = excluded.distil_tokens_in,
        distil_tokens_out   = excluded.distil_tokens_out,
        updated_at          = excluded.updated_at
      WHERE excluded.updated_at > hot_state.updated_at
    `).run(
      agent, project, sessionId ?? '', sessionName ?? null,
      summary, nextAction, openQuestions,
      anchoredSha ?? null,
      costUsd, tokensIn, tokensOut,
      now
    );

    // Delete consumed signals scoped to this session
    if (typeof lastSignalMs === 'number' && lastSignalMs > 0) {
      db.prepare(`
        DELETE FROM memory_signal
        WHERE scope = 'project' AND agent = ? AND project = ?
          AND session_id = ? AND created_at <= ?
      `).run(agent, project, sessionId ?? '', lastSignalMs);
    }

    // Prune hot_state to keep last 5 per project
    pruneHotState(db, agent, project);

    // Advance watermark for this session
    if (sessionId) {
      advanceDistilWatermark(db, sessionId, lastSignalMs ?? 0, now);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  db.close();
}

function cmdPrune() {
  const db = openAndInit();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago

  db.exec('BEGIN');
  try {
    const result = db
      .prepare('DELETE FROM memory_signal WHERE created_at < ?')
      .run(cutoff);
    const wm = db
      .prepare('DELETE FROM distil_watermark WHERE MAX(last_signal_ms, last_distil_ms) < ?')
      .run(cutoff);
    db.exec('COMMIT');
    process.stdout.write(
      JSON.stringify({ pruned: result.changes, prunedWatermarks: wm.changes }) + '\n'
    );
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  db.close();
}

// ── Atom subcommand handlers ─────────────────────────────────────────────────

function cmdAtomWrite(contextDirectory, jsonArg) {
  let data;
  try {
    data = JSON.parse(jsonArg);
  } catch {
    process.stderr.write('[agent-memory/atom-write] invalid JSON argument\n');
    process.exit(1);
  }

  const { workspace, topic, content, description, summary, tags, pinned, alwaysInclude, sessionId, sessionName, createdAt } = data;
  if (!topic) {
    process.stderr.write('[agent-memory/atom-write] topic is required\n');
    process.exit(1);
  }

  let resolved;
  try {
    resolved = resolveWorkspace(workspace, contextDirectory);
  } catch (err) {
    process.stderr.write(`[agent-memory/atom-write] ${err.message}\n`);
    process.exit(1);
  }

  const { scope, project } = resolved;
  const db = openAndInit();
  try {
    const normTopic = normaliseTopic(topic);
    const result = atomWrite(db, {
      scope, project, topic: normTopic, content: content ?? '',
      description, summary, tags, pinned, alwaysInclude, sessionId, sessionName, createdAt
    });
    db.close();
    const msg = result.action === 'created'
      ? `Created atom at ${normTopic}`
      : `Updated existing atom at ${normTopic} (previous content overwritten)`;
    process.stdout.write(JSON.stringify({ ok: true, action: result.action, message: msg, scope, project }) + '\n');
  } catch (err) {
    db.close();
    process.stderr.write(`[agent-memory/atom-write] ${err.message}\n`);
    process.exit(1);
  }
}

function cmdAtomAppend(contextDirectory, jsonArg) {
  let data;
  try {
    data = JSON.parse(jsonArg);
  } catch {
    process.stderr.write('[agent-memory/atom-append] invalid JSON argument\n');
    process.exit(1);
  }

  const { workspace, topic, content } = data;
  if (!topic) {
    process.stderr.write('[agent-memory/atom-append] topic is required\n');
    process.exit(1);
  }

  let resolved;
  try {
    resolved = resolveWorkspace(workspace, contextDirectory);
  } catch (err) {
    process.stderr.write(`[agent-memory/atom-append] ${err.message}\n`);
    process.exit(1);
  }

  const { scope, project } = resolved;
  const db = openAndInit();
  try {
    const updated = atomAppend(db, { scope, project, topic, content: content ?? '' });
    db.close();
    process.stdout.write(JSON.stringify({ ok: true, content: updated, scope, project }) + '\n');
  } catch (err) {
    db.close();
    process.stderr.write(`[agent-memory/atom-append] ${err.message}\n`);
    process.exit(1);
  }
}

function cmdAtomGet(scope, project, topic) {
  const db = openAndInit();
  const result = atomGet(db, { scope, project, topic });
  db.close();
  process.stdout.write(JSON.stringify(result) + '\n');
}

function cmdAtomSearch(scope, project, jsonArg) {
  let data;
  try {
    data = JSON.parse(jsonArg);
  } catch {
    process.stderr.write('[agent-memory/atom-search] invalid JSON argument\n');
    process.exit(1);
  }

  const { keywords, limit, status, includeDeprecated } = data;
  if (!keywords) {
    process.stderr.write('[agent-memory/atom-search] keywords is required\n');
    process.exit(1);
  }

  // When scope='all', pass 'all' so atomSearch drops scope predicate
  const searchScope = scope === 'all' ? 'all' : scope;
  const db = openAndInit();
  const results = atomSearch(db, { scope: searchScope, project, keywords, limit, status, includeDeprecated });
  db.close();
  process.stdout.write(JSON.stringify(results) + '\n');
}

function cmdAtomList(scope, project, prefix, optionsJson) {
  let status;
  let includeDeprecated;
  if (optionsJson) {
    let opts;
    try {
      opts = JSON.parse(optionsJson);
    } catch {
      process.stderr.write('[agent-memory/atom-list] invalid options JSON\n');
      process.exit(1);
    }
    status = opts.status;
    includeDeprecated = opts.includeDeprecated;
  }
  const db = openAndInit();
  const results = atomList(db, { scope, project, prefix, status, includeDeprecated });
  db.close();
  process.stdout.write(JSON.stringify(results) + '\n');
}

function cmdAtomPatch(contextDirectory, jsonArg) {
  let data;
  try {
    data = JSON.parse(jsonArg);
  } catch {
    process.stderr.write('[agent-memory/atom-patch] invalid JSON argument\n');
    process.exit(1);
  }

  const { workspace, targetWorkspace, topic, description, summary, tags, created_at: createdAt, pinned, always_include: alwaysInclude, status } = data;
  if (!topic) {
    process.stderr.write('[agent-memory/atom-patch] topic is required\n');
    process.exit(1);
  }

  let source;
  try {
    source = resolveWorkspace(workspace, contextDirectory);
  } catch (err) {
    process.stderr.write(`[agent-memory/atom-patch] ${err.message}\n`);
    process.exit(1);
  }

  // Resolve destination (move target) when targetWorkspace is provided
  let dest = source;
  if (targetWorkspace !== undefined) {
    try {
      dest = resolveWorkspace(targetWorkspace, contextDirectory);
    } catch (err) {
      process.stderr.write(`[agent-memory/atom-patch] targetWorkspace: ${err.message}\n`);
      process.exit(1);
    }
  }

  const patch = {};
  if ('description' in data) patch.description = description;
  if ('summary' in data) patch.summary = summary;
  if ('tags' in data) patch.tags = tags;
  if ('created_at' in data) patch.created_at = createdAt;
  if ('pinned' in data) patch.pinned = pinned;
  if ('always_include' in data) patch.always_include = alwaysInclude;
  if ('status' in data) patch.status = status;

  const db = openAndInit();
  try {
    const result = atomPatch(db, { source, dest, topic, patch });
    db.close();
    if (result.moved) {
      process.stdout.write(
        JSON.stringify({
          ok: true, topic: normaliseTopic(topic),
          moved: true,
          from: result.from,
          to: result.to,
          patched: result.patched,
        }) + '\n'
      );
    } else {
      process.stdout.write(
        JSON.stringify({
          ok: true, topic: normaliseTopic(topic),
          patched: result.patched,
          scope: source.scope,
          project: source.project,
        }) + '\n'
      );
    }
  } catch (err) {
    db.close();
    process.stderr.write(`[agent-memory/atom-patch] ${err.message}\n`);
    process.exit(1);
  }
}

function cmdAtomListFull(scope, project) {
  const db = openAndInit();
  const results = atomListFull(db, { scope, project });
  db.close();
  process.stdout.write(JSON.stringify(results) + '\n');
}

function cmdAtomListWorkspaces(optionsJson) {
  let includeDeprecated = false;
  if (optionsJson) {
    let opts;
    try {
      opts = JSON.parse(optionsJson);
    } catch {
      process.stderr.write('[agent-memory/atom-list-workspaces] invalid options JSON\n');
      process.exit(1);
    }
    includeDeprecated = opts.includeDeprecated ?? false;
  }
  const db = openAndInit();
  const results = atomListWorkspaces(db, { includeDeprecated });
  db.close();
  process.stdout.write(JSON.stringify(results) + '\n');
}

function cmdAtomDelete(contextDirectory, jsonArg) {
  let data;
  try {
    data = JSON.parse(jsonArg);
  } catch {
    process.stderr.write('[agent-memory/atom-delete] invalid JSON argument\n');
    process.exit(1);
  }

  const { workspace, topic } = data;
  if (!topic) {
    process.stderr.write('[agent-memory/atom-delete] topic is required\n');
    process.exit(1);
  }

  let resolved;
  try {
    resolved = resolveWorkspace(workspace, contextDirectory);
  } catch (err) {
    process.stderr.write(`[agent-memory/atom-delete] ${err.message}\n`);
    process.exit(1);
  }

  const { scope, project } = resolved;
  const db = openAndInit();
  try {
    const result = atomDelete(db, { scope, project, topic });
    db.close();
    process.stdout.write(JSON.stringify({ ok: true, deleted: result.deleted, scope, project }) + '\n');
  } catch (err) {
    db.close();
    process.stderr.write(`[agent-memory/atom-delete] ${err.message}\n`);
    process.exit(1);
  }
}

function cmdHotStateCrossProject(currentProject, sinceMs) {
  const ms = Number(sinceMs);
  if (!Number.isFinite(ms)) {
    process.stderr.write('memory.js hot-state-cross-project: sinceMs must be a finite integer\n');
    process.exit(1);
  }
  const db = openAndInit();
  const rows = hotStateCrossProject(db, currentProject, ms);
  db.close();
  process.stdout.write(JSON.stringify(rows) + '\n');
}

function cmdHotStateDelete(project, sessionId) {
  if (project == null || sessionId == null) {
    process.stderr.write('Usage: memory.js hot-state-delete <project> <sessionId>\n');
    process.exit(1);
  }
  const db = openAndInit();
  const result = hotStateDelete(db, project, sessionId);
  db.close();
  process.stdout.write(JSON.stringify(result) + '\n');
}

// ── Dispatch ────────────────────────────────────────────────────────────────

const [,, cmd, ...rest] = process.argv;

try {
switch (cmd) {
  case 'init':
    cmdInit();
    break;

  case 'accrue': {
    const [sessionId, agent, project, jsonArg] = rest;
    if (!sessionId || !agent || !project || !jsonArg) {
      process.stderr.write('Usage: memory.js accrue <sessionId> <agent> <project> <jsonData>\n');
      process.exit(1);
    }
    await cmdAccrue(sessionId, agent, project, jsonArg);
    break;
  }

  case 'read': {
    const [sessionId, agent, project] = rest;
    if (!sessionId || !agent || !project) {
      process.stderr.write('Usage: memory.js read <sessionId> <agent> <project>\n');
      process.exit(1);
    }
    cmdRead(sessionId, agent, project);
    break;
  }

  case 'inspect': {
    const [agent, project] = rest;
    if (!agent || !project) {
      process.stderr.write('Usage: memory.js inspect <agent> <project>\n');
      process.exit(1);
    }
    cmdInspect(agent, project);
    break;
  }

  case 'distil-write': {
    const [agent, project, jsonArg] = rest;
    if (!agent || !project || !jsonArg) {
      process.stderr.write('Usage: memory.js distil-write <agent> <project> <jsonData>\n');
      process.exit(1);
    }
    await cmdDistilWrite(agent, project, jsonArg);
    break;
  }

  case 'prune':
    cmdPrune();
    break;

  case 'correct': {
    const [agent, project, sessionId, patchJsonArg] = rest;
    if (!agent || !project || !sessionId || !patchJsonArg) {
      process.stderr.write('Usage: memory.js correct <agent> <project> <sessionId> <patchJson>\n');
      process.exit(1);
    }
    cmdCorrect(agent, project, sessionId, patchJsonArg);
    break;
  }

  case 'atom-write': {
    const [contextDirectory, jsonArg] = rest;
    if (!contextDirectory || !jsonArg) {
      process.stderr.write('Usage: memory.js atom-write <contextDirectory> <json>\n');
      process.exit(1);
    }
    cmdAtomWrite(contextDirectory, jsonArg);
    break;
  }

  case 'atom-append': {
    const [contextDirectory, jsonArg] = rest;
    if (!contextDirectory || !jsonArg) {
      process.stderr.write('Usage: memory.js atom-append <contextDirectory> <json>\n');
      process.exit(1);
    }
    cmdAtomAppend(contextDirectory, jsonArg);
    break;
  }

  case 'atom-get': {
    const [scope, project, topic] = rest;
    if (!scope || project == null || !topic) {
      process.stderr.write('Usage: memory.js atom-get <scope> <project> <topic>\n');
      process.exit(1);
    }
    cmdAtomGet(scope, project, topic);
    break;
  }

  case 'atom-search': {
    const [scope, project, jsonArg] = rest;
    if (!scope || project == null || !jsonArg) {
      process.stderr.write('Usage: memory.js atom-search <scope> <project> <json>\n');
      process.exit(1);
    }
    cmdAtomSearch(scope, project, jsonArg);
    break;
  }

  case 'atom-list': {
    const [scope, project, prefix, optionsJson] = rest;
    if (!scope || project == null) {
      process.stderr.write('Usage: memory.js atom-list <scope> <project> [<prefix>] [<optionsJson>]\n');
      process.exit(1);
    }
    cmdAtomList(scope, project, prefix, optionsJson);
    break;
  }

  case 'atom-list-full': {
    const [scope, project] = rest;
    if (!scope || project == null) {
      process.stderr.write('Usage: memory.js atom-list-full <scope> <project>\n');
      process.exit(1);
    }
    cmdAtomListFull(scope, project);
    break;
  }

  case 'atom-list-workspaces': {
    const [optionsJson] = rest;
    cmdAtomListWorkspaces(optionsJson);
    break;
  }

  case 'atom-delete': {
    const [contextDirectory, jsonArg] = rest;
    if (!contextDirectory || !jsonArg) {
      process.stderr.write('Usage: memory.js atom-delete <contextDirectory> <json>\n');
      process.exit(1);
    }
    cmdAtomDelete(contextDirectory, jsonArg);
    break;
  }

  case 'atom-patch': {
    const [contextDirectory, jsonArg] = rest;
    if (!contextDirectory || !jsonArg) {
      process.stderr.write('Usage: memory.js atom-patch <contextDirectory> <json>\n');
      process.exit(1);
    }
    cmdAtomPatch(contextDirectory, jsonArg);
    break;
  }

  case 'hot-state-cross-project': {
    const [currentProject, sinceMs] = rest;
    if (currentProject == null || sinceMs == null) {
      process.stderr.write('Usage: memory.js hot-state-cross-project <currentProject> <sinceMs>\n');
      process.exit(1);
    }
    cmdHotStateCrossProject(currentProject, sinceMs);
    break;
  }

  case 'hot-state-delete': {
    const [project, sessionId] = rest;
    cmdHotStateDelete(project, sessionId);
    break;
  }

  default:
    process.stderr.write(
      `Usage: memory.js <init|accrue|read|inspect|distil-write|correct|prune|atom-write|atom-append|atom-get|atom-search|atom-list|atom-list-full|atom-delete|atom-patch|atom-list-workspaces|hot-state-cross-project|hot-state-delete> [args]\n`
    );
    process.exit(1);
}
} catch (err) {
  process.stderr.write(`[memory.js] ${cmd ?? 'unknown'} failed: ${err?.message ?? err}\n`);
  process.exit(1);
}
