// test/schema.test.js — schema creation and UPSERT monotonic guard tests.

import { DatabaseSync } from 'node:sqlite';
import { ensureSchema } from '../src/lib/schema.js';

function openMemory() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

describe('ensureSchema', () => {
  test('creates all three tables without error', () => {
    const db = openMemory();
    expect(() => ensureSchema(db)).not.toThrow();

    // Verify tables exist by querying sqlite_master
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(tables).toContain('hot_state');
    expect(tables).toContain('memory_signal');
    expect(tables).toContain('distil_watermark');
  });

  test('is idempotent — calling twice does not throw', () => {
    const db = openMemory();
    ensureSchema(db);
    expect(() => ensureSchema(db)).not.toThrow();
  });

  test('creates indexes on hot_state and memory_signal', () => {
    const db = openMemory();
    ensureSchema(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all()
      .map((r) => r.name);
    expect(indexes).toContain('idx_hot_state_lookup');
    expect(indexes).toContain('idx_signal_scope');
    expect(indexes).toContain('idx_signal_created');
  });
});

describe('hot_state UPSERT monotonic guard', () => {
  function insertHotState(db, project, summary, updatedAt) {
    return db
      .prepare(`
        INSERT INTO hot_state
          (scope, agent, project, last_worked_summary, next_action,
           open_questions, adr_candidate, anchored_git_sha, schema_version, updated_at)
        VALUES ('project', 'build', ?, ?, '', '[]', null, null, 1, ?)
        ON CONFLICT(scope, agent, project) DO UPDATE SET
          last_worked_summary = excluded.last_worked_summary,
          next_action         = excluded.next_action,
          open_questions      = excluded.open_questions,
          adr_candidate       = excluded.adr_candidate,
          anchored_git_sha    = excluded.anchored_git_sha,
          schema_version      = excluded.schema_version,
          updated_at          = excluded.updated_at
        WHERE excluded.updated_at > hot_state.updated_at
      `)
      .run(project, summary, updatedAt);
  }

  test('initial insert writes the row', () => {
    const db = openMemory();
    ensureSchema(db);

    insertHotState(db, '/proj/alpha', 'first summary', 1000);

    const row = db
      .prepare("SELECT last_worked_summary FROM hot_state WHERE project='/proj/alpha'")
      .get();
    expect(row).toBeDefined();
    expect(row.last_worked_summary).toBe('first summary');
  });

  test('newer timestamp overwrites the row', () => {
    const db = openMemory();
    ensureSchema(db);

    insertHotState(db, '/proj/beta', 'old', 1000);
    insertHotState(db, '/proj/beta', 'new', 2000);

    const row = db
      .prepare("SELECT last_worked_summary FROM hot_state WHERE project='/proj/beta'")
      .get();
    expect(row.last_worked_summary).toBe('new');
  });

  test('older timestamp does NOT overwrite the row (monotonic guard)', () => {
    const db = openMemory();
    ensureSchema(db);

    insertHotState(db, '/proj/gamma', 'current', 5000);
    insertHotState(db, '/proj/gamma', 'stale', 3000); // older → must not apply

    const row = db
      .prepare("SELECT last_worked_summary FROM hot_state WHERE project='/proj/gamma'")
      .get();
    expect(row.last_worked_summary).toBe('current');
  });

  test('same timestamp does NOT overwrite (strict >)', () => {
    const db = openMemory();
    ensureSchema(db);

    insertHotState(db, '/proj/delta', 'first', 1000);
    insertHotState(db, '/proj/delta', 'second', 1000); // same ts → guard blocks

    const row = db
      .prepare("SELECT last_worked_summary FROM hot_state WHERE project='/proj/delta'")
      .get();
    expect(row.last_worked_summary).toBe('first');
  });

  test('UNIQUE constraint keyed by (scope, agent, project)', () => {
    const db = openMemory();
    ensureSchema(db);

    insertHotState(db, '/proj/shared', 'row-A', 1000);
    // Same project but different agent — must produce a separate row
    db
      .prepare(`
        INSERT INTO hot_state
          (scope, agent, project, last_worked_summary, next_action,
           open_questions, adr_candidate, anchored_git_sha, schema_version, updated_at)
        VALUES ('project', 'other-agent', '/proj/shared', 'row-B', '', '[]', null, null, 1, 1000)
      `)
      .run();

    const rows = db
      .prepare("SELECT agent, last_worked_summary FROM hot_state WHERE project='/proj/shared'")
      .all();
    expect(rows).toHaveLength(2);
  });
});
