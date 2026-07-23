// test/memory-inspect-correct.test.js — white-box SQL tests for the
// `memory.js inspect` and `memory.js correct` subcommands.
//
// Updated for v2 schema: session-scoped UNIQUE(scope,agent,project,session_id),
// no adr_candidate column, correct subcommand takes sessionId positional.

import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { ensureSchema } from '../src/lib/schema.js';
import { readDistilWatermark, advanceDistilWatermark } from '../src/lib/watermark.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const MEMORY_SCRIPT = join(__dir, '..', 'src', 'memory.js');

function openMemory() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA busy_timeout = 5000;');
  ensureSchema(db);
  return db;
}

/** Insert a v2 hot_state row directly. */
function insertHotState(db, { agent, project, sessionId = '', summary, nextAction, openQuestions = [], sha = null, updatedAt = 1 }) {
  db.prepare(`
    INSERT INTO hot_state
      (scope, agent, project, session_id, last_worked_summary, next_action,
       open_questions, anchored_git_sha, schema_version, updated_at)
    VALUES ('project', ?, ?, ?, ?, ?, ?, ?, 2, ?)
    ON CONFLICT(scope, agent, project, session_id) DO UPDATE SET
      last_worked_summary = excluded.last_worked_summary,
      next_action         = excluded.next_action,
      open_questions      = excluded.open_questions,
      anchored_git_sha    = excluded.anchored_git_sha,
      schema_version      = excluded.schema_version,
      updated_at          = excluded.updated_at
  `).run(agent, project, sessionId, summary, nextAction, JSON.stringify(openQuestions), sha, updatedAt);
}

/** Insert a memory_signal row. */
function insertSignal(db, sessionId, agent, project, kind, payload, created_at) {
  db.prepare(`
    INSERT INTO memory_signal (session_id, scope, agent, project, kind, payload, created_at)
    VALUES (?, 'project', ?, ?, ?, ?, ?)
  `).run(sessionId, agent, project, kind, payload, created_at);
}

/**
 * Run the same SQL logic as cmdInspect against the provided db.
 * Returns { prior, rows, signals }.
 */
function runInspectSQL(db, agent, project) {
  const allRows = db
    .prepare(`
      SELECT id, scope, agent, project, session_id, session_name,
             last_worked_summary, next_action, open_questions,
             anchored_git_sha, schema_version, updated_at
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

  const signals = db
    .prepare(`
      SELECT id, session_id, scope, agent, project, kind, payload, created_at
      FROM memory_signal
      WHERE scope = 'project' AND agent = ? AND project = ?
      ORDER BY created_at ASC
    `)
    .all(agent, project);

  const prior = rows.length > 0 ? rows[0] : null;
  return { prior, rows, signals };
}

/**
 * Run the same SQL logic as cmdCorrect (v2) against the provided db.
 */
function runCorrectSQL(db, agent, project, sessionId, patchObj) {
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

    let baseOpenQuestions = [];
    if (currentRow) {
      try {
        baseOpenQuestions = currentRow.open_questions
          ? JSON.parse(currentRow.open_questions)
          : [];
      } catch { /* leave as [] */ }
    }

    const base = {
      last_worked_summary: currentRow?.last_worked_summary ?? '',
      next_action:         currentRow?.next_action         ?? '',
      open_questions:      baseOpenQuestions,
      anchored_git_sha:    currentRow?.anchored_git_sha    ?? null,
      updated_at:          currentRow?.updated_at          ?? 0,
    };

    const merged = {
      last_worked_summary: 'last_worked_summary' in patchObj ? patchObj.last_worked_summary : base.last_worked_summary,
      next_action:         'next_action'         in patchObj ? patchObj.next_action         : base.next_action,
      open_questions:      'open_questions'      in patchObj ? patchObj.open_questions      : base.open_questions,
    };

    const isNew = !currentRow;
    const newUpdatedAt = base.updated_at + 1;

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
    return { ok: true, isNew, newUpdatedAt };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ── inspect SQL tests ─────────────────────────────────────────────────────────

describe('inspect SQL logic', () => {
  const AGENT   = 'engineer';
  const PROJECT = '/test/project';
  const SES     = 'ses_inspect_test';

  test('returns prior hot_state (most recent) and signals when both are present', () => {
    const db = openMemory();

    insertHotState(db, {
      agent: AGENT, project: PROJECT, sessionId: SES,
      summary: 'did the thing', nextAction: 'test next',
      openQuestions: ['q1?'], updatedAt: 42,
    });
    insertSignal(db, SES, AGENT, PROJECT, 'file', 'src/a.js', 100);
    insertSignal(db, SES, AGENT, PROJECT, 'todo', 'fix bug',   200);

    const { prior, signals } = runInspectSQL(db, AGENT, PROJECT);

    expect(prior).not.toBeNull();
    expect(prior.last_worked_summary).toBe('did the thing');
    expect(prior.next_action).toBe('test next');
    expect(prior.open_questions).toEqual(['q1?']);
    expect(prior.updated_at).toBe(42);

    expect(signals).toHaveLength(2);
    expect(signals.map((s) => s.payload)).toContain('src/a.js');
    expect(signals.map((s) => s.payload)).toContain('fix bug');
  });

  test('returns null prior for cold start (no hot_state row)', () => {
    const db = openMemory();
    const { prior, signals } = runInspectSQL(db, AGENT, PROJECT);
    expect(prior).toBeNull();
    expect(signals).toEqual([]);
  });

  test('returns prior but empty signals when no signals exist', () => {
    const db = openMemory();
    insertHotState(db, {
      agent: AGENT, project: PROJECT, sessionId: SES,
      summary: 'state only', nextAction: 'continue',
    });
    const { prior, signals } = runInspectSQL(db, AGENT, PROJECT);
    expect(prior).not.toBeNull();
    expect(prior.last_worked_summary).toBe('state only');
    expect(signals).toEqual([]);
  });

  test('database rows are unchanged after inspect (no inserts/updates/deletes)', () => {
    const db = openMemory();
    insertHotState(db, {
      agent: AGENT, project: PROJECT, sessionId: SES,
      summary: 'before', nextAction: 'after', updatedAt: 7,
    });
    insertSignal(db, SES, AGENT, PROJECT, 'file', 'kept.js', 50);

    runInspectSQL(db, AGENT, PROJECT);

    const row = db
      .prepare("SELECT last_worked_summary, updated_at FROM hot_state WHERE agent=? AND project=? AND session_id=?")
      .get(AGENT, PROJECT, SES);
    expect(row.last_worked_summary).toBe('before');
    expect(row.updated_at).toBe(7);

    const signalCount = db
      .prepare('SELECT COUNT(*) AS n FROM memory_signal WHERE agent=? AND project=?')
      .get(AGENT, PROJECT).n;
    expect(signalCount).toBe(1);
  });

  test('open_questions JSON TEXT column is parsed back to array', () => {
    const db = openMemory();
    insertHotState(db, {
      agent: AGENT, project: PROJECT, sessionId: SES,
      summary: 'x', nextAction: 'y',
      openQuestions: ['what about performance?', 'is this correct?'],
    });
    const { prior } = runInspectSQL(db, AGENT, PROJECT);
    expect(Array.isArray(prior.open_questions)).toBe(true);
    expect(prior.open_questions).toEqual(['what about performance?', 'is this correct?']);
  });
});

// ── correct SQL tests ─────────────────────────────────────────────────────────

describe('correct SQL logic (v2 — session-scoped)', () => {
  const AGENT   = 'engineer';
  const PROJECT = '/test/project';
  const SES     = 'ses_correct_test';

  test('single-field patch updates only that field; all others are preserved', () => {
    const db = openMemory();
    insertHotState(db, {
      agent: AGENT, project: PROJECT, sessionId: SES,
      summary: 'original summary', nextAction: 'original action',
      openQuestions: ['orig q1'], updatedAt: 5,
    });

    runCorrectSQL(db, AGENT, PROJECT, SES, { next_action: 'updated action' });

    const row = db
      .prepare('SELECT last_worked_summary, next_action, open_questions FROM hot_state WHERE agent=? AND project=? AND session_id=?')
      .get(AGENT, PROJECT, SES);

    expect(row.next_action).toBe('updated action');
    expect(row.last_worked_summary).toBe('original summary');
    expect(JSON.parse(row.open_questions)).toEqual(['orig q1']);
  });

  test('cold-start upserts skeleton row (isNew=true)', () => {
    const db = openMemory();
    const { isNew } = runCorrectSQL(db, AGENT, PROJECT, SES, { next_action: 'first action' });
    expect(isNew).toBe(true);

    const row = db
      .prepare('SELECT last_worked_summary, next_action, open_questions, updated_at FROM hot_state WHERE session_id=?')
      .get(SES);
    expect(row).toBeDefined();
    expect(row.next_action).toBe('first action');
    expect(row.last_worked_summary).toBe('');
    expect(JSON.parse(row.open_questions)).toEqual([]);
    expect(row.updated_at).toBe(1);
  });

  test('updated_at = current + 1 after each correct call', () => {
    const db = openMemory();
    insertHotState(db, { agent: AGENT, project: PROJECT, sessionId: SES, summary: 'start', nextAction: 'go', updatedAt: 10 });

    const { newUpdatedAt: ua1 } = runCorrectSQL(db, AGENT, PROJECT, SES, { last_worked_summary: 'patch 1' });
    expect(ua1).toBe(11);

    const { newUpdatedAt: ua2 } = runCorrectSQL(db, AGENT, PROJECT, SES, { last_worked_summary: 'patch 2' });
    expect(ua2).toBe(12);

    const row = db.prepare('SELECT updated_at FROM hot_state WHERE session_id=?').get(SES);
    expect(row.updated_at).toBe(12);
  });

  test('open_questions array is round-tripped through JSON TEXT', () => {
    const db = openMemory();
    insertHotState(db, { agent: AGENT, project: PROJECT, sessionId: SES, summary: 's', nextAction: 'n', openQuestions: ['original q'] });
    runCorrectSQL(db, AGENT, PROJECT, SES, { open_questions: ['new q1', 'new q2'] });

    const row = db.prepare('SELECT open_questions FROM hot_state WHERE session_id=?').get(SES);
    expect(JSON.parse(row.open_questions)).toEqual(['new q1', 'new q2']);
  });

  test('signals are untouched after correct', () => {
    const db = openMemory();
    insertHotState(db, { agent: AGENT, project: PROJECT, sessionId: SES, summary: 's', nextAction: 'n' });
    insertSignal(db, SES, AGENT, PROJECT, 'file', 'src/a.js', 100);
    insertSignal(db, SES, AGENT, PROJECT, 'todo', 'do task',  200);

    runCorrectSQL(db, AGENT, PROJECT, SES, { last_worked_summary: 'patched' });

    const signalCount = db
      .prepare('SELECT COUNT(*) AS n FROM memory_signal WHERE agent=? AND project=?')
      .get(AGENT, PROJECT).n;
    expect(signalCount).toBe(2);
  });

  test('distil_watermark rows are untouched after correct', () => {
    const db = openMemory();
    const wmSes = 'ses_wm_untouched';
    insertHotState(db, { agent: AGENT, project: PROJECT, sessionId: SES, summary: 's', nextAction: 'n' });
    advanceDistilWatermark(db, wmSes, 500, 1000);

    runCorrectSQL(db, AGENT, PROJECT, SES, { last_worked_summary: 'corrected' });

    const wm = readDistilWatermark(db, wmSes);
    expect(wm.last_signal_ms).toBe(500);
    expect(wm.last_distil_ms).toBe(1000);
  });
});

// ── correct CLI validation tests ──────────────────────────────────────────────

describe('correct CLI argument validation (v2)', () => {
  function runMemoryCLI(args, env = {}) {
    return spawnSync('node', [MEMORY_SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  }

  test('exits non-zero for invalid JSON', () => {
    const result = runMemoryCLI(['correct', 'engineer', '/proj', 'ses123', 'not-json']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('invalid JSON');
  });

  test('exits non-zero for non-object JSON (array)', () => {
    const result = runMemoryCLI(['correct', 'engineer', '/proj', 'ses123', '["array"]']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('patch must be a JSON object');
  });

  test('exits non-zero when last_worked_summary is not a string', () => {
    const patch = JSON.stringify({ last_worked_summary: 42 });
    const result = runMemoryCLI(['correct', 'engineer', '/proj', 'ses123', patch]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('last_worked_summary');
  });

  test('exits non-zero when next_action is not a string', () => {
    const patch = JSON.stringify({ next_action: true });
    const result = runMemoryCLI(['correct', 'engineer', '/proj', 'ses123', patch]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('next_action');
  });

  test('exits non-zero when open_questions is not an array', () => {
    const patch = JSON.stringify({ open_questions: 'not an array' });
    const result = runMemoryCLI(['correct', 'engineer', '/proj', 'ses123', patch]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('open_questions');
  });

  test('exits non-zero when required args are missing (no sessionId)', () => {
    const result = runMemoryCLI(['correct', 'engineer', '/proj']); // missing sessionId and patchJson
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Usage');
  });
});

// ── CLI guard: distil-force is not a valid subcommand ────────────────────────

describe('CLI guard: distil-force is not a valid subcommand', () => {
  function runMemoryCLI(args) {
    return spawnSync('node', [MEMORY_SCRIPT, ...args], { encoding: 'utf8' });
  }

  test('node src/memory.js distil-force exits non-zero', () => {
    const result = runMemoryCLI(['distil-force']);
    expect(result.status).not.toBe(0);
  });

  test('node src/memory.js distil-force prints the unknown-command usage line', () => {
    const result = runMemoryCLI(['distil-force']);
    expect(result.stderr).toMatch(/Usage:/);
    expect(result.stderr).not.toContain('distil-force');
  });
});
