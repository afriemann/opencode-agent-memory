// test/memory-cli.test.js — distil-write SQL transaction tests + error boundary tests.
//
// Tests the core SQL operations performed by `memory.js distil-write` directly
// against an in-memory database, verifying the three-step transaction:
//   1. UPSERT hot_state with monotonic updated_at guard
//   2. DELETE consumed memory_signal rows (≤ lastSignalMs)
//   3. advanceDistilWatermark for the session
//
// This is a white-box integration test of the SQL logic; it mirrors the exact
// statements in cmdDistilWrite so a future refactor catches regressions.

import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { ensureSchema } from '../src/lib/schema.js';
import { readDistilWatermark, advanceDistilWatermark } from '../src/lib/watermark.js';

function openMemory() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA busy_timeout = 5000;');
  ensureSchema(db);
  return db;
}

/**
 * Run the same SQL transaction as `cmdDistilWrite` against the provided db.
 */
function runDistilWriteSQL(db, {
  agent,
  project,
  distilled,
  anchoredSha,
  lastSignalMs,
  sessionId,
  now = Date.now(),
}) {
  const summary     = distilled.last_worked_summary ?? '';
  const nextAction  = distilled.next_action ?? '';
  const questions   = JSON.stringify(
    Array.isArray(distilled.open_questions) ? distilled.open_questions : []
  );
  const adrCandidate =
    typeof distilled.adr_candidate === 'string' ? distilled.adr_candidate : null;

  db.exec('BEGIN');
  try {
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
      summary, nextAction, questions, adrCandidate,
      anchoredSha ?? null,
      now
    );

    if (typeof lastSignalMs === 'number' && lastSignalMs > 0) {
      db.prepare(`
        DELETE FROM memory_signal
        WHERE scope = 'project' AND agent = ? AND project = ?
          AND created_at <= ?
      `).run(agent, project, lastSignalMs);
    }

    if (sessionId) {
      advanceDistilWatermark(db, sessionId, lastSignalMs ?? 0, now);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Insert a memory_signal row. */
function insertSignal(db, sessionId, agent, project, kind, payload, created_at) {
  db.prepare(`
    INSERT INTO memory_signal (session_id, scope, agent, project, kind, payload, created_at)
    VALUES (?, 'project', ?, ?, ?, ?, ?)
  `).run(sessionId, agent, project, kind, payload, created_at);
}

// ── distil-write transaction tests ───────────────────────────────────────────

describe('distil-write SQL transaction', () => {
  const AGENT   = 'build';
  const PROJECT = '/test/project';
  const SES     = 'ses_dw_test';

  const DISTILLED = {
    last_worked_summary: 'done the work',
    next_action:         'write the tests',
    open_questions:      ['is this right?'],
    adr_candidate:       null,
  };

  test('writes hot_state on first call', () => {
    const db = openMemory();
    runDistilWriteSQL(db, {
      agent: AGENT, project: PROJECT, distilled: DISTILLED,
      anchoredSha: 'abc123', lastSignalMs: 0, sessionId: SES,
    });

    const row = db
      .prepare("SELECT last_worked_summary, next_action, anchored_git_sha FROM hot_state WHERE agent=? AND project=?")
      .get(AGENT, PROJECT);

    expect(row).toBeDefined();
    expect(row.last_worked_summary).toBe('done the work');
    expect(row.next_action).toBe('write the tests');
    expect(row.anchored_git_sha).toBe('abc123');
  });

  test('deletes signals with created_at <= lastSignalMs, preserves newer ones', () => {
    const db = openMemory();

    insertSignal(db, SES, AGENT, PROJECT, 'file', 'src/a.js', 100);
    insertSignal(db, SES, AGENT, PROJECT, 'file', 'src/b.js', 200);
    insertSignal(db, SES, AGENT, PROJECT, 'file', 'src/c.js', 300); // after cutoff

    runDistilWriteSQL(db, {
      agent: AGENT, project: PROJECT, distilled: DISTILLED,
      anchoredSha: null, lastSignalMs: 200, sessionId: SES,
      now: 9999,
    });

    const remaining = db
      .prepare('SELECT payload FROM memory_signal WHERE agent=? AND project=?')
      .all(AGENT, PROJECT)
      .map((r) => r.payload);

    expect(remaining).not.toContain('src/a.js');
    expect(remaining).not.toContain('src/b.js');
    expect(remaining).toContain('src/c.js'); // created_at=300 > 200 → preserved
  });

  test('does not delete signals when lastSignalMs is 0', () => {
    const db = openMemory();
    insertSignal(db, SES, AGENT, PROJECT, 'file', 'keep.js', 50);

    runDistilWriteSQL(db, {
      agent: AGENT, project: PROJECT, distilled: DISTILLED,
      anchoredSha: null, lastSignalMs: 0, sessionId: SES,
      now: 9999,
    });

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM memory_signal WHERE agent=? AND project=?')
      .get(AGENT, PROJECT).n;
    expect(count).toBe(1); // signal preserved
  });

  test('advances watermark after a successful write', () => {
    const db = openMemory();
    runDistilWriteSQL(db, {
      agent: AGENT, project: PROJECT, distilled: DISTILLED,
      anchoredSha: null, lastSignalMs: 500, sessionId: SES,
      now: 1000,
    });

    const wm = readDistilWatermark(db, SES);
    expect(wm.last_signal_ms).toBe(500);
    expect(wm.last_distil_ms).toBe(1000);
  });

  test('monotonic guard: a stale distil does NOT overwrite hot_state, but does prune signals and advance watermark', () => {
    const db = openMemory();

    // First (fresh) write at t=5000
    runDistilWriteSQL(db, {
      agent: AGENT, project: PROJECT,
      distilled: { ...DISTILLED, last_worked_summary: 'fresh version' },
      anchoredSha: 'fresh', lastSignalMs: 100, sessionId: SES,
      now: 5000,
    });

    // Insert a new signal
    insertSignal(db, SES, AGENT, PROJECT, 'file', 'stale-signal.js', 200);

    // Second (stale) write at t=1000 — older than t=5000, guard should block hot_state update
    runDistilWriteSQL(db, {
      agent: AGENT, project: PROJECT,
      distilled: { ...DISTILLED, last_worked_summary: 'stale version' },
      anchoredSha: 'stale', lastSignalMs: 200, sessionId: SES,
      now: 1000,
    });

    const row = db
      .prepare('SELECT last_worked_summary, anchored_git_sha FROM hot_state WHERE agent=? AND project=?')
      .get(AGENT, PROJECT);
    // hot_state must NOT have been overwritten
    expect(row.last_worked_summary).toBe('fresh version');
    expect(row.anchored_git_sha).toBe('fresh');

    // Signal cleanup and watermark advance must still have happened
    const signalCount = db
      .prepare('SELECT COUNT(*) AS n FROM memory_signal WHERE agent=? AND project=?')
      .get(AGENT, PROJECT).n;
    expect(signalCount).toBe(0); // stale-signal.js (t=200) <= lastSignalMs(200) was pruned

    const wm = readDistilWatermark(db, SES);
    expect(wm.last_signal_ms).toBeGreaterThanOrEqual(200); // advanced
  });
});

// ── prune SQL transaction tests ───────────────────────────────────────────────

/**
 * Run the same SQL transaction as `cmdPrune` against the provided db.
 * Returns { pruned, prunedWatermarks } mirroring the stdout JSON.
 *
 * NOTE: This is a white-box copy of cmdPrune's transaction.
 * If the SQL in cmdPrune changes, update this helper to match.
 */
function runPruneSQL(db, { cutoff }) {
  db.exec('BEGIN');
  try {
    const result = db
      .prepare('DELETE FROM memory_signal WHERE created_at < ?')
      .run(cutoff);
    const wm = db
      .prepare('DELETE FROM distil_watermark WHERE MAX(last_signal_ms, last_distil_ms) < ?')
      .run(cutoff);
    db.exec('COMMIT');
    return { pruned: result.changes, prunedWatermarks: wm.changes };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Insert a distil_watermark row. */
function insertWatermark(db, sessionId, lastSignalMs, lastDistilMs) {
  db.prepare(`
    INSERT INTO distil_watermark (session_id, last_signal_ms, last_distil_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      last_signal_ms = excluded.last_signal_ms,
      last_distil_ms = excluded.last_distil_ms
  `).run(sessionId, lastSignalMs, lastDistilMs);
}

describe('prune SQL transaction', () => {
  const CUTOFF = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago (ms)
  const OLD    = CUTOFF - 1;          // one ms before the cutoff — should be deleted
  const FRESH  = Date.now();          // now — should be kept

  test('deletes distil_watermark rows older than 30 days and keeps newer ones', () => {
    const db = openMemory();

    insertWatermark(db, 'old-session',   OLD,   OLD);    // both old → delete
    insertWatermark(db, 'fresh-session', FRESH, FRESH);  // both fresh → keep
    insertWatermark(db, 'mixed-session', OLD,   FRESH);  // one fresh → keep

    const out = runPruneSQL(db, { cutoff: CUTOFF });

    expect(out.prunedWatermarks).toBe(1); // only 'old-session' deleted

    const remaining = db
      .prepare('SELECT session_id FROM distil_watermark ORDER BY session_id')
      .all()
      .map((r) => r.session_id);
    expect(remaining).toEqual(['fresh-session', 'mixed-session']);
  });

  test('deletes distil_watermark rows where both columns are 0 (epoch = trivially old)', () => {
    const db = openMemory();

    insertWatermark(db, 'zero-session', 0, 0); // MAX(0,0) = 0 < cutoff → delete

    const out = runPruneSQL(db, { cutoff: CUTOFF });

    expect(out.prunedWatermarks).toBe(1);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM distil_watermark')
      .get().n;
    expect(count).toBe(0);
  });

  test('returns { pruned: N, prunedWatermarks: M } output shape with correct counts', () => {
    const db = openMemory();
    const AGENT   = 'engineer';
    const PROJECT = '/test/project';
    const SES     = 'ses-prune-shape';

    // One old signal
    insertSignal(db, SES, AGENT, PROJECT, 'message', 'hello', OLD);
    // One fresh signal (should be kept)
    insertSignal(db, SES, AGENT, PROJECT, 'message', 'world', FRESH);
    // One old watermark
    insertWatermark(db, SES, OLD, OLD);

    const out = runPruneSQL(db, { cutoff: CUTOFF });

    expect(out).toEqual({ pruned: 1, prunedWatermarks: 1 });

    // Fresh signal is intact
    const remaining = db
      .prepare('SELECT COUNT(*) AS n FROM memory_signal')
      .get().n;
    expect(remaining).toBe(1);
  });
});

// ── error boundary (fix-error-observability spec scenario EO-S6) ─────────────
//
// RED-STEP test: verifies that the dispatch try/catch in memory.js writes a
// structured `[memory.js] <cmd> failed: ...` message to stderr when a command
// handler throws, rather than letting Node.js emit an unformatted stack trace.

describe('memory.js dispatch error boundary', () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname  = dirname(__filename);
  const MEMORY_JS  = join(__dirname, '../src/memory.js');

  test('formats uncaught internal error as [memory.js] <cmd> failed: on stderr', () => {
    // Provide a non-SQLite file as the DB to force DatabaseSync / PRAGMA to throw.
    const tmpDb = `/tmp/invalid-sqlite-${Date.now()}.db`;
    writeFileSync(tmpDb, 'NOT A SQLITE DATABASE FILE\n');
    try {
      const result = spawnSync(
        process.execPath,
        [MEMORY_JS, 'read', 'ses_test', 'engineer', '/some/project'],
        { env: { ...process.env, AGENT_MEMORY_DB: tmpDb }, encoding: 'utf8' }
      );

      // Must exit with code 1.
      expect(result.status).toBe(1);
      // Before the fix: Node emits a raw stack trace without the [memory.js] prefix.
      // After the fix: stderr begins with the structured prefix.
      expect(result.stderr).toMatch(/\[memory\.js\] read failed:/);
    } finally {
      try { unlinkSync(tmpDb); } catch { /* cleanup only */ }
    }
  });
});
