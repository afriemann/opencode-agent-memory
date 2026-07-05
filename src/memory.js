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
//     stdout: { prior: row|null, signals: row[], watermark: { last_signal_ms, last_distil_ms } }
//     Read the latest hot_state + all scratch signals + watermark for this session.
//
//   inspect <agent> <project>
//     stdout: { prior: row|null, signals: row[] }
//     Non-destructive read of hot_state + signals. No watermark, no row mutations.
//
//   distil-write <agent> <project> <jsonData>
//     jsonData: JSON string { distilled: {…}, anchoredSha: string|null, lastSignalMs: number, sessionId: string }
//     UPSERT hot_state (monotonic guard), delete consumed signals, advance watermark.
//     All three steps run in a single transaction.
//
//   correct <agent> <project> <patchJson>
//     patchJson: partial JSON object with any of: last_worked_summary, next_action,
//                open_questions, adr_candidate. Absent fields keep current values.
//     Opens a BEGIN IMMEDIATE transaction to avoid SQLITE_BUSY_SNAPSHOT on concurrent
//     distil-write. UPSERTs hot_state with updated_at = current + 1.
//     Does NOT delete signals or advance the watermark.
//
//   prune
//     Delete memory_signal rows older than 30 days. Idempotent.

import { openDb } from './lib/db.js';
import { ensureSchema } from './lib/schema.js';
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
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  db.close();
}

function cmdRead(sessionId, agent, project) {
  const db = openAndInit();

  // Read hot_state for (scope='project', agent, project)
  const priorRow = db
    .prepare(`
      SELECT id, scope, agent, project,
             last_worked_summary, next_action, open_questions,
             adr_candidate, anchored_git_sha, schema_version, updated_at
      FROM hot_state
      WHERE scope = 'project' AND agent = ? AND project = ?
    `)
    .get(agent, project);

  let prior = null;
  if (priorRow) {
    // Parse JSON TEXT column back to array
    let open_questions = [];
    try {
      open_questions = priorRow.open_questions ? JSON.parse(priorRow.open_questions) : [];
    } catch { /* leave as [] */ }
    prior = { ...priorRow, open_questions };
  }

  // Read all signals for (scope='project', agent, project)
  const signals = db
    .prepare(`
      SELECT id, session_id, scope, agent, project, kind, payload, created_at
      FROM memory_signal
      WHERE scope = 'project' AND agent = ? AND project = ?
      ORDER BY created_at ASC
    `)
    .all(agent, project);

  // Read watermark for this session
  const watermark = readDistilWatermark(db, sessionId);

  db.close();

  process.stdout.write(JSON.stringify({ prior, signals, watermark }) + '\n');
}

function cmdInspect(agent, project) {
  const db = openAndInit();

  // Read hot_state for (scope='project', agent, project) — same query as cmdRead
  const priorRow = db
    .prepare(`
      SELECT id, scope, agent, project,
             last_worked_summary, next_action, open_questions,
             adr_candidate, anchored_git_sha, schema_version, updated_at
      FROM hot_state
      WHERE scope = 'project' AND agent = ? AND project = ?
    `)
    .get(agent, project);

  let prior = null;
  if (priorRow) {
    let open_questions = [];
    try {
      open_questions = priorRow.open_questions ? JSON.parse(priorRow.open_questions) : [];
    } catch { /* leave as [] */ }
    prior = { ...priorRow, open_questions };
  }

  // Read all signals for (scope='project', agent, project) — same query as cmdRead
  const signals = db
    .prepare(`
      SELECT id, session_id, scope, agent, project, kind, payload, created_at
      FROM memory_signal
      WHERE scope = 'project' AND agent = ? AND project = ?
      ORDER BY created_at ASC
    `)
    .all(agent, project);

  db.close();

  process.stdout.write(JSON.stringify({ prior, signals }) + '\n');
}

function cmdCorrect(agent, project, patchJsonArg) {
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

  // Validate field types for any provided fields (same shape checks as parseDistilReply)
  if ('last_worked_summary' in patch && typeof patch.last_worked_summary !== 'string') {
    process.stderr.write('[agent-memory/correct] last_worked_summary must be a string\n');
    process.exit(1);
  }
  if ('next_action' in patch && typeof patch.next_action !== 'string') {
    process.stderr.write('[agent-memory/correct] next_action must be a string\n');
    process.exit(1);
  }
  if ('adr_candidate' in patch && patch.adr_candidate !== null && typeof patch.adr_candidate !== 'string') {
    process.stderr.write('[agent-memory/correct] adr_candidate must be a string or null\n');
    process.exit(1);
  }
  if ('open_questions' in patch && !Array.isArray(patch.open_questions)) {
    process.stderr.write('[agent-memory/correct] open_questions must be an array\n');
    process.exit(1);
  }

  const db = openAndInit();

  // BEGIN IMMEDIATE: prevents SQLITE_BUSY_SNAPSHOT when a concurrent distil-write
  // holds a write lock. A deferred BEGIN + read-first path cannot upgrade to a
  // write lock if another writer is active; IMMEDIATE acquires the write lock
  // upfront, allowing busy_timeout to retry before failing.
  db.exec('BEGIN IMMEDIATE');
  try {
    // Read current hot_state row inside the transaction
    const currentRow = db
      .prepare(`
        SELECT last_worked_summary, next_action, open_questions,
               adr_candidate, anchored_git_sha, updated_at
        FROM hot_state
        WHERE scope = 'project' AND agent = ? AND project = ?
      `)
      .get(agent, project);

    // Base values: current row or EMPTY_RECORD defaults for a cold start.
    // Cold-start updated_at base = 0 so first correct writes updated_at = 1.
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
      adr_candidate:       currentRow?.adr_candidate       ?? EMPTY_RECORD.adr_candidate,
      anchored_git_sha:    currentRow?.anchored_git_sha    ?? null,
      updated_at:          currentRow?.updated_at          ?? 0,
    };

    // Merge patch onto base (absent fields keep current values)
    const merged = {
      last_worked_summary: 'last_worked_summary' in patch ? patch.last_worked_summary : base.last_worked_summary,
      next_action:         'next_action'         in patch ? patch.next_action         : base.next_action,
      open_questions:      'open_questions'      in patch ? patch.open_questions      : base.open_questions,
      adr_candidate:       'adr_candidate'       in patch ? patch.adr_candidate       : base.adr_candidate,
    };

    const newUpdatedAt = base.updated_at + 1;

    // UPSERT hot_state. The new updated_at = current + 1 is strictly greater
    // than the existing row (same exclusive transaction), so the monotonic guard
    // always passes — kept for defence-in-depth per design.md D4.
    db.prepare(`
      INSERT INTO hot_state
        (scope, agent, project, last_worked_summary, next_action,
         open_questions, adr_candidate, anchored_git_sha, schema_version, updated_at)
      VALUES ('project', ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(scope, agent, project) DO UPDATE SET
        last_worked_summary = excluded.last_worked_summary,
        next_action         = excluded.next_action,
        open_questions      = excluded.open_questions,
        adr_candidate       = excluded.adr_candidate,
        schema_version      = excluded.schema_version,
        updated_at          = excluded.updated_at
      WHERE excluded.updated_at > hot_state.updated_at
    `).run(
      agent, project,
      merged.last_worked_summary,
      merged.next_action,
      JSON.stringify(merged.open_questions),
      merged.adr_candidate,
      base.anchored_git_sha,
      newUpdatedAt
    );

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  db.close();

  process.stdout.write(JSON.stringify({ ok: true }) + '\n');
}

async function cmdDistilWrite(agent, project, jsonArg) {
  let input;
  try {
    input = JSON.parse(jsonArg);
  } catch {
    process.stderr.write('[agent-memory/distil-write] invalid JSON argument\n');
    process.exit(1);
  }

  const { distilled, anchoredSha, lastSignalMs, sessionId } = input;

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
  const adrCandidate =
    typeof distilled.adr_candidate === 'string' ? distilled.adr_candidate : null;

  db.exec('BEGIN');
  try {
    // UPSERT hot_state with monotonic guard: only update if the new row is
    // strictly newer than the existing one, so two racing idle distils cannot
    // regress the row.
    db.prepare(`
      INSERT INTO hot_state
        (scope, agent, project, last_worked_summary, next_action,
         open_questions, adr_candidate, anchored_git_sha, schema_version, updated_at)
      VALUES ('project', ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(scope, agent, project) DO UPDATE SET
        last_worked_summary = excluded.last_worked_summary,
        next_action         = excluded.next_action,
        open_questions      = excluded.open_questions,
        adr_candidate       = excluded.adr_candidate,
        anchored_git_sha    = excluded.anchored_git_sha,
        schema_version      = excluded.schema_version,
        updated_at          = excluded.updated_at
      WHERE excluded.updated_at > hot_state.updated_at
    `).run(
      agent, project,
      summary, nextAction, openQuestions, adrCandidate,
      anchoredSha ?? null,
      now
    );

    // Delete consumed signals (at or before lastSignalMs for this agent+project).
    // Signals arriving after lastSignalMs are not yet folded; preserve them.
    if (typeof lastSignalMs === 'number' && lastSignalMs > 0) {
      db.prepare(`
        DELETE FROM memory_signal
        WHERE scope = 'project' AND agent = ? AND project = ?
          AND created_at <= ?
      `).run(agent, project, lastSignalMs);
    }

    // Advance watermark for this session.
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

// ── Dispatch ────────────────────────────────────────────────────────────────

const [,, cmd, ...rest] = process.argv;

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
    const [agent, project, patchJsonArg] = rest;
    if (!agent || !project || !patchJsonArg) {
      process.stderr.write('Usage: memory.js correct <agent> <project> <patchJson>\n');
      process.exit(1);
    }
    cmdCorrect(agent, project, patchJsonArg);
    break;
  }

  default:
    process.stderr.write(
      `Usage: memory.js <init|accrue|read|inspect|distil-write|correct|prune> [args]\n`
    );
    process.exit(1);
}
