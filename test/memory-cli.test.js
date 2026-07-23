// test/memory-cli.test.js — distil-write, read, correct SQL transaction tests
// + atom-* subprocess integration tests + error boundary tests.
//
// Covers tasks 8.12–8.15.
//
// Tests the core SQL operations performed by `memory.js` subcommands directly
// against an in-memory database, verifying session-scoped behaviour.

import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { ensureSchema, pruneHotState } from '../src/lib/schema.js';
import { readDistilWatermark, advanceDistilWatermark } from '../src/lib/watermark.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const MEMORY_JS  = join(__dirname, '../src/memory.js');

function openMemory() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA busy_timeout = 5000;');
  ensureSchema(db);
  return db;
}

/** Insert a memory_signal row. */
function insertSignal(db, sessionId, agent, project, kind, payload, created_at) {
  db.prepare(`
    INSERT INTO memory_signal (session_id, scope, agent, project, kind, payload, created_at)
    VALUES (?, 'project', ?, ?, ?, ?, ?)
  `).run(sessionId, agent, project, kind, payload, created_at);
}

/**
 * Run the session-scoped distil-write SQL (v2 schema).
 */
function runDistilWriteSQL(db, {
  agent,
  project,
  distilled,
  anchoredSha,
  lastSignalMs,
  sessionId,
  sessionName = null,
  now = Date.now(),
}) {
  const summary     = distilled.last_worked_summary ?? '';
  const nextAction  = distilled.next_action ?? '';
  const questions   = JSON.stringify(
    Array.isArray(distilled.open_questions) ? distilled.open_questions : []
  );

  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT INTO hot_state
        (scope, agent, project, session_id, session_name, last_worked_summary, next_action,
         open_questions, anchored_git_sha, schema_version, updated_at)
      VALUES ('project', ?, ?, ?, ?, ?, ?, ?, ?, 2, ?)
      ON CONFLICT(scope, agent, project, session_id) DO UPDATE SET
        session_name        = excluded.session_name,
        last_worked_summary = excluded.last_worked_summary,
        next_action         = excluded.next_action,
        open_questions      = excluded.open_questions,
        anchored_git_sha    = excluded.anchored_git_sha,
        schema_version      = excluded.schema_version,
        updated_at          = excluded.updated_at
      WHERE excluded.updated_at > hot_state.updated_at
    `).run(
      agent, project, sessionId ?? '', sessionName,
      summary, nextAction, questions,
      anchoredSha ?? null,
      now
    );

    if (typeof lastSignalMs === 'number' && lastSignalMs > 0) {
      db.prepare(`
        DELETE FROM memory_signal
        WHERE scope = 'project' AND agent = ? AND project = ?
          AND session_id = ? AND created_at <= ?
      `).run(agent, project, sessionId ?? '', lastSignalMs);
    }

    pruneHotState(db, agent, project);

    if (sessionId) {
      advanceDistilWatermark(db, sessionId, lastSignalMs ?? 0, now);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ── 8.12 distil-write: session-scoped row ────────────────────────────────────

describe('distil-write SQL transaction — session-scoped (v2)', () => {
  const AGENT   = 'build';
  const PROJECT = '/test/project';
  const SES_A   = 'ses_a';
  const SES_B   = 'ses_b';

  const DISTILLED = {
    last_worked_summary: 'done the work',
    next_action:         'write the tests',
    open_questions:      ['is this right?'],
  };

  test('writes session-scoped hot_state row on first call', () => {
    const db = openMemory();
    runDistilWriteSQL(db, {
      agent: AGENT, project: PROJECT, distilled: DISTILLED,
      anchoredSha: 'abc123', lastSignalMs: 0, sessionId: SES_A,
    });

    const row = db
      .prepare("SELECT last_worked_summary, anchored_git_sha, session_id FROM hot_state WHERE agent=? AND project=? AND session_id=?")
      .get(AGENT, PROJECT, SES_A);
    expect(row).toBeDefined();
    expect(row.last_worked_summary).toBe('done the work');
    expect(row.anchored_git_sha).toBe('abc123');
  });

  test('two sessions write independent rows — no cross-session overwriting', () => {
    const db = openMemory();
    runDistilWriteSQL(db, {
      agent: AGENT, project: PROJECT,
      distilled: { ...DISTILLED, last_worked_summary: 'session A work' },
      anchoredSha: null, lastSignalMs: 0, sessionId: SES_A, now: 1000,
    });
    runDistilWriteSQL(db, {
      agent: AGENT, project: PROJECT,
      distilled: { ...DISTILLED, last_worked_summary: 'session B work' },
      anchoredSha: null, lastSignalMs: 0, sessionId: SES_B, now: 2000,
    });

    const rowA = db.prepare("SELECT last_worked_summary FROM hot_state WHERE session_id=?").get(SES_A);
    const rowB = db.prepare("SELECT last_worked_summary FROM hot_state WHERE session_id=?").get(SES_B);
    expect(rowA.last_worked_summary).toBe('session A work');
    expect(rowB.last_worked_summary).toBe('session B work');
  });

  test('deletes only session-scoped signals (not other sessions)', () => {
    const db = openMemory();
    insertSignal(db, SES_A, AGENT, PROJECT, 'file', 'ses-a.js', 100);
    insertSignal(db, SES_B, AGENT, PROJECT, 'file', 'ses-b.js', 100);

    runDistilWriteSQL(db, {
      agent: AGENT, project: PROJECT, distilled: DISTILLED,
      anchoredSha: null, lastSignalMs: 200, sessionId: SES_A, now: 9999,
    });

    // SES_A signal deleted, SES_B signal preserved
    const remaining = db
      .prepare('SELECT session_id, payload FROM memory_signal WHERE agent=? AND project=?')
      .all(AGENT, PROJECT);
    const payloads = remaining.map((r) => r.payload);
    expect(payloads).not.toContain('ses-a.js');
    expect(payloads).toContain('ses-b.js');
  });

  test('keep-last-5 prune removes oldest row when 6 sessions write', () => {
    const db = openMemory();
    for (let i = 1; i <= 6; i++) {
      runDistilWriteSQL(db, {
        agent: AGENT, project: PROJECT, distilled: DISTILLED,
        anchoredSha: null, lastSignalMs: 0, sessionId: `ses-${i}`, now: i * 100,
      });
    }

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM hot_state WHERE agent=? AND project=?')
      .get(AGENT, PROJECT).n;
    expect(count).toBe(5);

    // Oldest row (ses-1, now=100) must be gone
    const oldest = db.prepare("SELECT session_id FROM hot_state WHERE session_id='ses-1'").get();
    expect(oldest).toBeUndefined();
  });

  test('monotonic guard: stale distil does NOT overwrite session row', () => {
    const db = openMemory();
    runDistilWriteSQL(db, {
      agent: AGENT, project: PROJECT,
      distilled: { ...DISTILLED, last_worked_summary: 'fresh' },
      anchoredSha: null, lastSignalMs: 0, sessionId: SES_A, now: 5000,
    });
    runDistilWriteSQL(db, {
      agent: AGENT, project: PROJECT,
      distilled: { ...DISTILLED, last_worked_summary: 'stale' },
      anchoredSha: null, lastSignalMs: 0, sessionId: SES_A, now: 1000,
    });

    const row = db.prepare("SELECT last_worked_summary FROM hot_state WHERE session_id=?").get(SES_A);
    expect(row.last_worked_summary).toBe('fresh');
  });

  test('monotonic guard: same-timestamp distil write is not applied', () => {
    const db = openMemory();
    runDistilWriteSQL(db, {
      agent: AGENT, project: PROJECT,
      distilled: { ...DISTILLED, last_worked_summary: 'original' },
      anchoredSha: null, lastSignalMs: 0, sessionId: SES_A, now: 5000,
    });
    // Second call at the SAME timestamp — should NOT overwrite (guard is strict >)
    runDistilWriteSQL(db, {
      agent: AGENT, project: PROJECT,
      distilled: { ...DISTILLED, last_worked_summary: 'overwrite-attempt' },
      anchoredSha: null, lastSignalMs: 0, sessionId: SES_A, now: 5000,
    });

    const row = db.prepare("SELECT last_worked_summary FROM hot_state WHERE session_id=?").get(SES_A);
    expect(row.last_worked_summary).toBe('original');
  });

  test('stale distil still prunes own signals and advances watermark', () => {
    const db = openMemory();
    // Insert a newer hot_state row directly — no watermark entry yet
    db.prepare(`
      INSERT INTO hot_state
        (scope, agent, project, session_id, last_worked_summary, next_action, open_questions, updated_at)
      VALUES ('project', ?, ?, ?, 'fresh-from-newer-call', '', '[]', 5000)
    `).run(AGENT, PROJECT, SES_A);

    // Insert a signal for SES_A
    db.prepare(`
      INSERT INTO memory_signal (scope, agent, project, session_id, kind, payload, created_at)
      VALUES ('project', ?, ?, ?, 'message', 'ping', 200)
    `).run(AGENT, PROJECT, SES_A);

    // Call distil-write with stale now=1000 but with lastSignalMs=200
    // hot_state UPSERT is blocked (5000 > 1000), but signals+watermark proceed
    runDistilWriteSQL(db, {
      agent: AGENT, project: PROJECT,
      distilled: { ...DISTILLED, last_worked_summary: 'stale-value' },
      anchoredSha: null, lastSignalMs: 200, sessionId: SES_A, now: 1000,
    });

    // hot_state NOT overwritten
    const row = db.prepare("SELECT last_worked_summary FROM hot_state WHERE session_id=?").get(SES_A);
    expect(row.last_worked_summary).toBe('fresh-from-newer-call');

    // Signal IS deleted (lastSignalMs=200 ≥ created_at=200)
    const sig = db.prepare("SELECT id FROM memory_signal WHERE session_id=?").get(SES_A);
    expect(sig).toBeUndefined();

    // Watermark IS advanced (was 0, now set to last_signal_ms=200, last_distil_ms=1000)
    const wm = readDistilWatermark(db, SES_A);
    expect(wm.last_signal_ms).toBe(200);
    expect(wm.last_distil_ms).toBe(1000);
  });

  test('advances watermark after a successful write', () => {
    const db = openMemory();
    runDistilWriteSQL(db, {
      agent: AGENT, project: PROJECT, distilled: DISTILLED,
      anchoredSha: null, lastSignalMs: 500, sessionId: SES_A, now: 1000,
    });

    const wm = readDistilWatermark(db, SES_A);
    expect(wm.last_signal_ms).toBe(500);
    expect(wm.last_distil_ms).toBe(1000);
  });
});

// ── 8.13 read: session-scoped prior + top-3 recent ──────────────────────────

describe('read subcommand — session-scoped prior + recent (white-box)', () => {
  const AGENT   = 'engineer';
  const PROJECT = '/read/test';

  function insertHotStateRow(db, sessionId, summary, updatedAt) {
    db.prepare(`
      INSERT INTO hot_state (scope, agent, project, session_id, last_worked_summary, next_action, open_questions, updated_at)
      VALUES ('project', ?, ?, ?, ?, '', '[]', ?)
    `).run(AGENT, PROJECT, sessionId, summary, updatedAt);
  }

  test('prior is scoped to session_id', () => {
    const db = openMemory();
    insertHotStateRow(db, 'target-ses', 'target summary', 100);
    insertHotStateRow(db, 'other-ses', 'other summary', 200);

    const prior = db.prepare(`
      SELECT session_id, last_worked_summary FROM hot_state
      WHERE scope='project' AND agent=? AND project=? AND session_id=?
    `).get(AGENT, PROJECT, 'target-ses');

    expect(prior).toBeDefined();
    expect(prior.last_worked_summary).toBe('target summary');
  });

  test('recent returns top-3 rows for the project (all sessions)', () => {
    const db = openMemory();
    for (let i = 1; i <= 5; i++) {
      insertHotStateRow(db, `ses-${i}`, `summary ${i}`, i * 100);
    }

    const recent = db.prepare(`
      SELECT session_id FROM hot_state
      WHERE scope='project' AND agent=? AND project=?
      ORDER BY updated_at DESC, id DESC
      LIMIT 3
    `).all(AGENT, PROJECT);

    expect(recent).toHaveLength(3);
    // Top 3 most recent: ses-5, ses-4, ses-3
    expect(recent.map((r) => r.session_id)).toContain('ses-5');
    expect(recent.map((r) => r.session_id)).toContain('ses-4');
    expect(recent.map((r) => r.session_id)).toContain('ses-3');
    expect(recent.map((r) => r.session_id)).not.toContain('ses-1');
  });

  test('signals are scoped to session_id in read SELECT', () => {
    const db = openMemory();
    insertSignal(db, 'ses-x', AGENT, PROJECT, 'file', 'x.js', 100);
    insertSignal(db, 'ses-y', AGENT, PROJECT, 'file', 'y.js', 100);

    const signals = db.prepare(`
      SELECT payload FROM memory_signal
      WHERE scope='project' AND agent=? AND project=? AND session_id=?
      ORDER BY created_at ASC
    `).all(AGENT, PROJECT, 'ses-x');

    expect(signals.map((s) => s.payload)).toEqual(['x.js']);
  });
});

// ── 8.14 correct: new sessionId positional + skeleton upsert ─────────────────

describe('correct subcommand — session-scoped (white-box)', () => {
  const AGENT   = 'engineer';
  const PROJECT = '/correct/test';
  const SES     = 'ses-correct';

  function runCorrectSQL(db, sessionId, patch) {
    const EMPTY = { last_worked_summary: '', next_action: '', open_questions: [] };
    db.exec('BEGIN IMMEDIATE');
    try {
      const cur = db.prepare(`
        SELECT last_worked_summary, next_action, open_questions, anchored_git_sha, updated_at
        FROM hot_state WHERE scope='project' AND agent=? AND project=? AND session_id=?
      `).get(AGENT, PROJECT, sessionId);

      let baseOQ = EMPTY.open_questions;
      if (cur) {
        try { baseOQ = cur.open_questions ? JSON.parse(cur.open_questions) : []; } catch {}
      }
      const base = {
        last_worked_summary: cur?.last_worked_summary ?? EMPTY.last_worked_summary,
        next_action:         cur?.next_action         ?? EMPTY.next_action,
        open_questions:      baseOQ,
        anchored_git_sha:    cur?.anchored_git_sha    ?? null,
        updated_at:          cur?.updated_at          ?? 0,
      };
      const merged = {
        last_worked_summary: 'last_worked_summary' in patch ? patch.last_worked_summary : base.last_worked_summary,
        next_action:         'next_action'         in patch ? patch.next_action         : base.next_action,
        open_questions:      'open_questions'      in patch ? patch.open_questions      : base.open_questions,
      };
      const isNew = !cur;
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
      `).run(AGENT, PROJECT, sessionId, merged.last_worked_summary, merged.next_action,
             JSON.stringify(merged.open_questions), base.anchored_git_sha, base.updated_at + 1);
      db.exec('COMMIT');
      return { isNew };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  test('upserts skeleton row on cold start (no existing session row)', () => {
    const db = openMemory();
    const { isNew } = runCorrectSQL(db, SES, { last_worked_summary: 'cold start patch' });
    expect(isNew).toBe(true);
    const row = db.prepare("SELECT last_worked_summary FROM hot_state WHERE session_id=?").get(SES);
    expect(row).toBeDefined();
    expect(row.last_worked_summary).toBe('cold start patch');
  });

  test('patches only provided fields, keeps others', () => {
    const db = openMemory();
    runCorrectSQL(db, SES, { last_worked_summary: 'original', next_action: 'original next' });
    runCorrectSQL(db, SES, { next_action: 'updated next' });

    const row = db.prepare("SELECT last_worked_summary, next_action FROM hot_state WHERE session_id=?").get(SES);
    expect(row.last_worked_summary).toBe('original'); // unchanged
    expect(row.next_action).toBe('updated next');     // patched
  });

  test('adr_candidate is not accepted (no column exists)', () => {
    const db = openMemory();
    const cols = db.prepare("PRAGMA table_info(hot_state)").all().map((c) => c.name);
    expect(cols).not.toContain('adr_candidate');
  });
});

// ── 8.15 atom-* subprocess integration tests ─────────────────────────────────

describe('memory.js atom-* subcommands (subprocess integration)', () => {
  let tmpDb;

  beforeEach(() => {
    tmpDb = `/tmp/test-atom-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  });

  afterEach(() => {
    try { unlinkSync(tmpDb); } catch {}
  });

  function run(args) {
    return spawnSync(process.execPath, [MEMORY_JS, ...args], {
      env: { ...process.env, AGENT_MEMORY_DB: tmpDb },
      encoding: 'utf8',
    });
  }

  test('atom-write creates a new atom and returns created action', () => {
    const result = run([
      'atom-write', 'project', '/p',
      JSON.stringify({ topic: 'arch/db', content: 'Using SQLite', description: 'DB design' }),
    ]);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.action).toBe('created');
    expect(out.message).toContain('Created atom at arch/db');
  });

  test('atom-write on existing topic returns overwritten action', () => {
    run(['atom-write', 'project', '/p',
      JSON.stringify({ topic: 'arch/db', content: 'v1', description: 'desc' })]);
    const result = run(['atom-write', 'project', '/p',
      JSON.stringify({ topic: 'arch/db', content: 'v2', description: 'desc updated' })]);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.action).toBe('overwritten');
  });

  test('atom-append appends with separator', () => {
    run(['atom-write', 'project', '/p',
      JSON.stringify({ topic: 'log', content: 'first', description: 'd' })]);
    const result = run(['atom-append', 'project', '/p',
      JSON.stringify({ topic: 'log', content: 'second' })]);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.content).toBe('first\n---\nsecond');
  });

  test('atom-append exits non-zero for missing topic', () => {
    const result = run(['atom-append', 'project', '/p',
      JSON.stringify({ topic: 'no-such-topic', content: 'x' })]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not exist');
  });

  test('atom-get returns match for existing atom', () => {
    run(['atom-write', 'project', '/p',
      JSON.stringify({ topic: 'notes', content: 'body text', description: 'my notes' })]);
    const result = run(['atom-get', 'project', '/p', 'notes']);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.match).not.toBeNull();
    expect(out.match.content).toBe('body text');
  });

  test('atom-get returns null match for missing topic', () => {
    run(['init']); // ensure DB initialised
    const result = run(['atom-get', 'project', '/p', 'nonexistent']);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.match).toBeNull();
  });

  test('atom-list returns written atoms', () => {
    run(['atom-write', 'project', '/p',
      JSON.stringify({ topic: 'arch/db', content: 'x', description: 'DB' })]);
    run(['atom-write', 'project', '/p',
      JSON.stringify({ topic: 'arch/api', content: 'y', description: 'API' })]);
    const result = run(['atom-list', 'project', '/p']);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    const topics = out.map((r) => r.topic);
    expect(topics).toContain('arch/db');
    expect(topics).toContain('arch/api');
  });

  test('atom-search finds atom by content', () => {
    run(['atom-write', 'project', '/p',
      JSON.stringify({ topic: 'search-target', content: 'findme content', description: 'searchable' })]);
    const result = run(['atom-search', 'project', '/p', JSON.stringify({ query: 'findme' })]);
    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout.trim());
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].topic).toBe('search-target');
  });

  test('atom-delete removes the atom', () => {
    run(['atom-write', 'project', '/p',
      JSON.stringify({ topic: 'deleteme', content: 'bye', description: 'd' })]);
    const del = run(['atom-delete', 'project', '/p', 'deleteme']);
    expect(del.status).toBe(0);
    const out = JSON.parse(del.stdout.trim());
    expect(out.deleted).toBe(1);

    // Verify it's gone
    const get = run(['atom-get', 'project', '/p', 'deleteme']);
    const getOut = JSON.parse(get.stdout.trim());
    expect(getOut.match).toBeNull();
  });

  test('atom-delete exits non-zero for missing topic', () => {
    run(['init']);
    const result = run(['atom-delete', 'project', '/p', 'ghost']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ghost');
  });
});

// ── prune SQL transaction tests ───────────────────────────────────────────────

function runPruneSQL(db, { cutoff }) {
  db.exec('BEGIN');
  try {
    const result = db.prepare('DELETE FROM memory_signal WHERE created_at < ?').run(cutoff);
    const wm = db.prepare('DELETE FROM distil_watermark WHERE MAX(last_signal_ms, last_distil_ms) < ?').run(cutoff);
    db.exec('COMMIT');
    return { pruned: result.changes, prunedWatermarks: wm.changes };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

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
  const CUTOFF = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const OLD    = CUTOFF - 1;
  const FRESH  = Date.now();

  test('deletes old watermarks and keeps fresh ones', () => {
    const db = openMemory();
    insertWatermark(db, 'old-session',   OLD,   OLD);
    insertWatermark(db, 'fresh-session', FRESH, FRESH);
    insertWatermark(db, 'mixed-session', OLD,   FRESH);

    const out = runPruneSQL(db, { cutoff: CUTOFF });
    expect(out.prunedWatermarks).toBe(1);

    const remaining = db.prepare('SELECT session_id FROM distil_watermark ORDER BY session_id')
      .all().map((r) => r.session_id);
    expect(remaining).toEqual(['fresh-session', 'mixed-session']);
  });

  test('deletes zero-epoch watermarks', () => {
    const db = openMemory();
    insertWatermark(db, 'zero-session', 0, 0);
    const out = runPruneSQL(db, { cutoff: CUTOFF });
    expect(out.prunedWatermarks).toBe(1);
  });
});

// ── error boundary ────────────────────────────────────────────────────────────

describe('memory.js dispatch error boundary', () => {
  test('formats uncaught internal error as [memory.js] <cmd> failed: on stderr', () => {
    const tmpDb2 = `/tmp/invalid-sqlite-${Date.now()}.db`;
    writeFileSync(tmpDb2, 'NOT A SQLITE DATABASE FILE\n');
    try {
      const result = spawnSync(
        process.execPath,
        [MEMORY_JS, 'read', 'ses_test', 'engineer', '/some/project'],
        { env: { ...process.env, AGENT_MEMORY_DB: tmpDb2 }, encoding: 'utf8' }
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/\[memory\.js\] read failed:/);
    } finally {
      try { unlinkSync(tmpDb2); } catch {}
    }
  });
});
