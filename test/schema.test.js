// test/schema.test.js — ensureSchema, atom helpers, migration, and pruneHotState tests.
//
// Covers tasks 8.1–8.12.

import { DatabaseSync } from 'node:sqlite';
import {
  ensureSchema,
  normaliseTopic,
  pruneHotState,
  atomWrite,
  atomAppend,
  atomGet,
  atomSearch,
  atomList,
  atomDelete,
  checkFtsIntegrity,
} from '../src/lib/schema.js';

function openMemory() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

// ── 8.1 ensureSchema — fresh DB ──────────────────────────────────────────────

describe('ensureSchema — fresh DB', () => {
  test('creates all required tables', () => {
    const db = openMemory();
    expect(() => ensureSchema(db)).not.toThrow();

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(tables).toContain('hot_state');
    expect(tables).toContain('memory_signal');
    expect(tables).toContain('distil_watermark');
    expect(tables).toContain('memory_atom');
  });

  test('memory_atom has required columns and UNIQUE constraint', () => {
    const db = openMemory();
    ensureSchema(db);

    const cols = db.prepare("PRAGMA table_info(memory_atom)").all().map((c) => c.name);
    for (const col of ['id', 'scope', 'project', 'topic', 'description', 'content', 'tags',
                       'session_id', 'session_name', 'created_at', 'updated_at']) {
      expect(cols).toContain(col);
    }

    // UNIQUE(scope, project, topic) — inserting a duplicate must fail
    ensureSchema(db);
    db.prepare(`
      INSERT INTO memory_atom (scope, project, topic, description, content, tags, created_at, updated_at)
      VALUES ('project', '/p', 'test', 'desc', 'body', '[]', 1, 1)
    `).run();
    expect(() =>
      db.prepare(`
        INSERT INTO memory_atom (scope, project, topic, description, content, tags, created_at, updated_at)
        VALUES ('project', '/p', 'test', 'desc2', 'body2', '[]', 2, 2)
      `).run()
    ).toThrow();
  });

  test('FTS virtual table and 3 triggers are present (or absent+degraded when FTS5 unavailable)', () => {
    const db = openMemory();
    ensureSchema(db);

    const ftsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_atom_fts'")
      .get();
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all()
      .map((r) => r.name);

    if (ftsTable) {
      // FTS5 available — all three triggers must exist
      expect(triggers).toContain('memory_atom_ai');
      expect(triggers).toContain('memory_atom_ad');
      expect(triggers).toContain('memory_atom_au');
    } else {
      // Graceful degradation — no triggers expected
      expect(triggers.filter((t) => t.startsWith('memory_atom_'))).toHaveLength(0);
    }
  });

  test('hot_state has session_id and session_name columns (no adr_candidate)', () => {
    const db = openMemory();
    ensureSchema(db);
    const cols = db.prepare("PRAGMA table_info(hot_state)").all().map((c) => c.name);
    expect(cols).toContain('session_id');
    expect(cols).toContain('session_name');
    expect(cols).not.toContain('adr_candidate');
  });

  test('is idempotent — calling twice does not throw', () => {
    const db = openMemory();
    ensureSchema(db);
    expect(() => ensureSchema(db)).not.toThrow();
  });

  test('user_version is set to 2 after first ensureSchema', () => {
    const db = openMemory();
    ensureSchema(db);
    const v = db.prepare('PRAGMA user_version').get().user_version;
    expect(v).toBe(2);
  });
});

// ── 8.2 normaliseTopic ────────────────────────────────────────────────────────

describe('normaliseTopic', () => {
  test('lowercases the topic', () => {
    expect(normaliseTopic('Arch/DB-Layer')).toBe('arch/db-layer');
  });

  test('replaces underscores with hyphens', () => {
    expect(normaliseTopic('work_items')).toBe('work-items');
  });

  test('replaces spaces with hyphens', () => {
    expect(normaliseTopic('my topic here')).toBe('my-topic-here');
  });

  test('strips leading and trailing slashes', () => {
    expect(normaliseTopic('/arch/db/')).toBe('arch/db');
  });

  test('collapses multiple spaces/underscores to one hyphen', () => {
    expect(normaliseTopic('foo  bar')).toBe('foo-bar');
    expect(normaliseTopic('foo__bar')).toBe('foo-bar');
  });
});

// ── 8.3 atomWrite ─────────────────────────────────────────────────────────────

describe('atomWrite', () => {
  test('rejects missing/empty description', () => {
    const db = openMemory();
    ensureSchema(db);
    expect(() =>
      atomWrite(db, { scope: 'project', project: '/p', topic: 'test', content: 'body', description: '' })
    ).toThrow(/description/i);
    expect(() =>
      atomWrite(db, { scope: 'project', project: '/p', topic: 'test', content: 'body', description: null })
    ).toThrow(/description/i);
  });

  test('returns action "created" for new atom', () => {
    const db = openMemory();
    ensureSchema(db);
    const result = atomWrite(db, { scope: 'project', project: '/p', topic: 'arch/db', content: 'body', description: 'DB layer design' });
    expect(result.action).toBe('created');
  });

  test('returns action "overwritten" when atom already exists', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'arch/db', content: 'v1', description: 'desc' });
    const result = atomWrite(db, { scope: 'project', project: '/p', topic: 'arch/db', content: 'v2', description: 'desc updated' });
    expect(result.action).toBe('overwritten');
    // Verify content was updated
    const row = db.prepare("SELECT content FROM memory_atom WHERE topic='arch/db'").get();
    expect(row.content).toBe('v2');
  });

  test('rowid stays stable on ON CONFLICT DO UPDATE (upsert does not change id)', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'stable', content: 'v1', description: 'desc' });
    const before = db.prepare("SELECT id FROM memory_atom WHERE topic='stable'").get().id;
    atomWrite(db, { scope: 'project', project: '/p', topic: 'stable', content: 'v2', description: 'desc' });
    const after = db.prepare("SELECT id FROM memory_atom WHERE topic='stable'").get().id;
    expect(after).toBe(before);
  });

  test('normalises the topic key on write', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'Arch/DB Layer', content: 'x', description: 'd' });
    const row = db.prepare("SELECT topic FROM memory_atom WHERE topic='arch/db-layer'").get();
    expect(row).toBeDefined();
  });
});

// ── 8.4 atomAppend ───────────────────────────────────────────────────────────

describe('atomAppend', () => {
  test('errors if topic does not exist', () => {
    const db = openMemory();
    ensureSchema(db);
    expect(() =>
      atomAppend(db, { scope: 'project', project: '/p', topic: 'missing', content: 'extra' })
    ).toThrow(/does not exist/);
  });

  test('appends with \\n---\\n separator', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'log', content: 'first', description: 'd' });
    const updated = atomAppend(db, { scope: 'project', project: '/p', topic: 'log', content: 'second' });
    expect(updated).toBe('first\n---\nsecond');
    // Verify in DB
    const row = db.prepare("SELECT content FROM memory_atom WHERE topic='log'").get();
    expect(row.content).toBe('first\n---\nsecond');
  });

  test('FTS integrity check passes after append (when FTS5 available)', () => {
    const db = openMemory();
    ensureSchema(db);
    const ftsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_atom_fts'")
      .get();
    if (!ftsTable) return; // Skip when FTS5 unavailable

    atomWrite(db, { scope: 'project', project: '/p', topic: 'fts-test', content: 'hello', description: 'test' });
    atomAppend(db, { scope: 'project', project: '/p', topic: 'fts-test', content: 'world' });
    expect(() => checkFtsIntegrity(db)).not.toThrow();
  });
});

// ── 8.5 atomGet ──────────────────────────────────────────────────────────────

describe('atomGet', () => {
  test('workspace-priority: returns current workspace atom over global', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'notes', content: 'ws-content', description: 'ws' });
    atomWrite(db, { scope: 'global', project: '', topic: 'notes', content: 'global-content', description: 'global' });

    const result = atomGet(db, { scope: 'project', project: '/p', topic: 'notes' });
    expect(result.match).not.toBeNull();
    expect(result.match.content).toBe('ws-content');
  });

  test('global fallback: returns global atom when no workspace atom exists', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'global', project: '', topic: 'shared', content: 'global-only', description: 'd' });

    const result = atomGet(db, { scope: 'project', project: '/p', topic: 'shared' });
    expect(result.match).not.toBeNull();
    expect(result.match.content).toBe('global-only');
  });

  test('null match + alsoIn when only foreign atoms exist', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/other', topic: 'foreign', content: 'foreign-body', description: 'd' });

    const result = atomGet(db, { scope: 'project', project: '/p', topic: 'foreign' });
    expect(result.match).toBeNull();
    expect(result.alsoIn.length).toBeGreaterThan(0);
    expect(result.alsoIn[0].topic).toBe('foreign');
  });
});

// ── 8.6 atomSearch ───────────────────────────────────────────────────────────

describe('atomSearch', () => {
  function setupSearchFixture() {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/myproj', topic: 'arch/database', content: 'Using SQLite for persistence', description: 'DB design' });
    atomWrite(db, { scope: 'global', project: '', topic: 'conventions', content: 'Always use kebab-case topics', description: 'Style guide' });
    atomWrite(db, { scope: 'project', project: '/other', topic: 'notes', content: 'Unrelated content', description: 'Other notes' });
    return db;
  }

  test('all-workspaces default: returns matches from all scopes', () => {
    const db = setupSearchFixture();
    // 'scope=all' or undefined → all workspaces
    const results = atomSearch(db, { scope: 'all', project: '/myproj', query: 'SQLite', limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    const topics = results.map((r) => r.topic);
    expect(topics).toContain('arch/database');
  });

  test('scope=workspace restriction: excludes /other project', () => {
    const db = setupSearchFixture();
    // Write something searchable to /other project
    const results = atomSearch(db, { scope: 'workspace', project: '/myproj', query: 'Unrelated', limit: 10 });
    const projs = results.map((r) => r.project);
    expect(projs).not.toContain('/other');
  });

  test('LIKE fallback returns results when FTS5 throws (mock FTS5 failure)', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'fallback-test', content: 'LIKE scan test value', description: 'for testing' });

    // Simulate FTS5 absent: drop the FTS table if it exists
    try {
      db.exec('DROP TABLE IF EXISTS memory_atom_fts');
    } catch { /* ignore */ }

    // atomSearch should fall back to LIKE scan without throwing
    expect(() => {
      const results = atomSearch(db, { scope: 'all', project: '/p', query: 'LIKE scan test value', limit: 10 });
      expect(results.length).toBeGreaterThan(0);
    }).not.toThrow();
  });
});

// ── 8.7 atomList ─────────────────────────────────────────────────────────────

describe('atomList', () => {
  function setupListFixture() {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'arch/db', content: 'a', description: 'arch DB' });
    atomWrite(db, { scope: 'project', project: '/p', topic: 'arch/api', content: 'b', description: 'arch API' });
    atomWrite(db, { scope: 'global', project: '', topic: 'global/style', content: 'c', description: 'global style' });
    atomWrite(db, { scope: 'project', project: '/other', topic: 'other/thing', content: 'd', description: 'other' });
    return db;
  }

  test('workspace+global default: returns current project + global atoms', () => {
    const db = setupListFixture();
    const results = atomList(db, { scope: 'project', project: '/p' });
    const topics = results.map((r) => r.topic);
    expect(topics).toContain('arch/db');
    expect(topics).toContain('arch/api');
    expect(topics).toContain('global/style');
    expect(topics).not.toContain('other/thing'); // excluded
  });

  test('scope=all includes all workspaces', () => {
    const db = setupListFixture();
    const results = atomList(db, { scope: 'all', project: '/p' });
    const topics = results.map((r) => r.topic);
    expect(topics).toContain('other/thing');
  });

  test('prefix filtering returns only matching topics', () => {
    const db = setupListFixture();
    const results = atomList(db, { scope: 'all', project: '/p', prefix: 'arch' });
    const topics = results.map((r) => r.topic);
    expect(topics).toContain('arch/db');
    expect(topics).toContain('arch/api');
    expect(topics).not.toContain('global/style');
    expect(topics).not.toContain('other/thing');
  });

  test('prefix is normalised before comparison', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'arch/db-layer', content: 'x', description: 'd' });
    // Prefix with uppercase + space should still match
    const results = atomList(db, { scope: 'project', project: '/p', prefix: 'Arch' });
    expect(results.map((r) => r.topic)).toContain('arch/db-layer');
  });
});

// ── 8.8 atomDelete ───────────────────────────────────────────────────────────

describe('atomDelete', () => {
  test('removes atom and FTS integrity check passes', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'to-delete', content: 'bye', description: 'd' });
    const result = atomDelete(db, { scope: 'project', project: '/p', topic: 'to-delete' });
    expect(result.deleted).toBe(1);

    const ftsTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_atom_fts'")
      .get();
    if (ftsTable) {
      expect(() => checkFtsIntegrity(db)).not.toThrow();
    }
  });

  test('throws when topic does not exist', () => {
    const db = openMemory();
    ensureSchema(db);
    expect(() =>
      atomDelete(db, { scope: 'project', project: '/p', topic: 'nonexistent' })
    ).toThrow(/not found/);
  });
});

// ── 8.9 migration — populated old-schema DB ───────────────────────────────────

describe('migration — populated old-schema DB', () => {
  /**
   * Build a database that simulates the pre-v2 schema:
   * hot_state with adr_candidate, no session_id, UNIQUE(scope,agent,project).
   */
  function buildOldSchemaDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA busy_timeout = 5000;');
    // Old schema DDL (hot_state v1)
    db.exec(`
      CREATE TABLE hot_state (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        scope               TEXT    NOT NULL DEFAULT 'project',
        agent               TEXT    NOT NULL,
        project             TEXT    NOT NULL,
        last_worked_summary TEXT,
        next_action         TEXT,
        open_questions      TEXT,
        adr_candidate       TEXT,
        anchored_git_sha    TEXT,
        schema_version      INTEGER NOT NULL DEFAULT 1,
        updated_at          INTEGER NOT NULL,
        UNIQUE (scope, agent, project)
      );
      CREATE INDEX idx_hot_state_lookup ON hot_state (agent, project, scope);
      CREATE TABLE memory_signal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'project',
        agent TEXT NOT NULL,
        project TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE distil_watermark (
        session_id TEXT PRIMARY KEY,
        last_signal_ms INTEGER NOT NULL DEFAULT 0,
        last_distil_ms INTEGER NOT NULL DEFAULT 0
      );
    `);
    // Insert two rows with summaries
    db.prepare(`
      INSERT INTO hot_state (scope, agent, project, last_worked_summary, next_action, open_questions, adr_candidate, updated_at)
      VALUES ('project', 'engineer', '/proj/alpha', 'worked on alpha', 'write tests', '[]', 'use sqlite', 1000)
    `).run();
    db.prepare(`
      INSERT INTO hot_state (scope, agent, project, last_worked_summary, next_action, open_questions, adr_candidate, updated_at)
      VALUES ('project', 'engineer', '/proj/beta', 'worked on beta', 'deploy', '[]', null, 2000)
    `).run();
    return db;
  }

  test('hot_state rows are preserved with session_id=""', () => {
    const db = buildOldSchemaDb();
    ensureSchema(db);

    const rows = db.prepare("SELECT agent, project, session_id FROM hot_state ORDER BY project").all();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.session_id).toBe('');
    }
  });

  test('adr_candidate column is absent after migration', () => {
    const db = buildOldSchemaDb();
    ensureSchema(db);
    const cols = db.prepare("PRAGMA table_info(hot_state)").all().map((c) => c.name);
    expect(cols).not.toContain('adr_candidate');
  });

  test('user_version is 2 after migration', () => {
    const db = buildOldSchemaDb();
    ensureSchema(db);
    const v = db.prepare('PRAGMA user_version').get().user_version;
    expect(v).toBe(2);
  });

  test('legacy summaries are migrated to work/migrated-summary atom', () => {
    const db = buildOldSchemaDb();
    ensureSchema(db);

    const atoms = db
      .prepare("SELECT project, content FROM memory_atom WHERE topic='work/migrated-summary' ORDER BY project")
      .all();
    // Both rows with non-empty summaries should produce atoms
    expect(atoms.length).toBeGreaterThanOrEqual(1);
    const contents = atoms.map((r) => r.content);
    expect(contents.some((c) => c.includes('alpha') || c.includes('beta'))).toBe(true);
  });
});

// ── 8.10 migration idempotency ────────────────────────────────────────────────

describe('migration idempotency', () => {
  test('no rebuild when user_version = 2', () => {
    const db = openMemory();
    ensureSchema(db); // sets user_version=2

    // Insert a fresh session-scoped row
    db.prepare(`
      INSERT INTO hot_state (scope, agent, project, session_id, last_worked_summary, next_action, open_questions, updated_at)
      VALUES ('project', 'engineer', '/p', 'ses1', 'summary', 'next', '[]', 100)
    `).run();

    // Second ensureSchema must not touch the row
    ensureSchema(db);

    const rows = db.prepare("SELECT session_id FROM hot_state").all();
    expect(rows.some((r) => r.session_id === 'ses1')).toBe(true);
  });

  test('no rebuild when session_id column already present', () => {
    // Build a DB with session_id already present but user_version = 0
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE hot_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL DEFAULT 'project',
        agent TEXT NOT NULL,
        project TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT '',
        session_name TEXT,
        last_worked_summary TEXT,
        next_action TEXT,
        open_questions TEXT,
        anchored_git_sha TEXT,
        schema_version INTEGER NOT NULL DEFAULT 2,
        updated_at INTEGER NOT NULL,
        UNIQUE (scope, agent, project, session_id)
      );
      CREATE TABLE memory_signal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'project',
        agent TEXT NOT NULL,
        project TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE distil_watermark (
        session_id TEXT PRIMARY KEY,
        last_signal_ms INTEGER NOT NULL DEFAULT 0,
        last_distil_ms INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.prepare(`
      INSERT INTO hot_state (agent, project, session_id, last_worked_summary, next_action, open_questions, updated_at)
      VALUES ('engineer', '/p', 'existing-ses', 'existing', '', '[]', 1)
    `).run();

    expect(() => ensureSchema(db)).not.toThrow();

    // Row must still be there
    const row = db.prepare("SELECT session_id FROM hot_state WHERE session_id='existing-ses'").get();
    expect(row).toBeDefined();
  });
});

// ── Migration rollback ────────────────────────────────────────────────────────

describe('migration failure rolls back entirely and retries cleanly', () => {
  test('failed migration leaves hot_state unchanged and user_version < 2; retry succeeds', () => {
    // Build a v1 DB: hot_state without session_id, with an existing row
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE hot_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL DEFAULT 'project',
        agent TEXT NOT NULL,
        project TEXT NOT NULL,
        last_worked_summary TEXT,
        next_action TEXT,
        open_questions TEXT,
        anchored_git_sha TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE memory_signal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'project',
        agent TEXT NOT NULL,
        project TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE distil_watermark (
        session_id TEXT PRIMARY KEY,
        last_signal_ms INTEGER NOT NULL DEFAULT 0,
        last_distil_ms INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.prepare(`
      INSERT INTO hot_state (agent, project, last_worked_summary, next_action, open_questions, updated_at)
      VALUES ('engineer', '/rollback-test', 'v1-summary', '', '[]', 42)
    `).run();

    // Plant a hot_state_new table to sabotage rebuildHotState
    db.exec(`CREATE TABLE hot_state_new (id INTEGER PRIMARY KEY)`);

    // ensureSchema must throw because rebuildHotState cannot create hot_state_new
    expect(() => ensureSchema(db)).toThrow();

    // user_version must still be 0 (not 2)
    const v = db.prepare('PRAGMA user_version').get().user_version;
    expect(v).toBe(0);

    // hot_state must still be in v1 shape with the original row
    const row = db.prepare("SELECT last_worked_summary FROM hot_state").get();
    expect(row).toBeDefined();
    expect(row.last_worked_summary).toBe('v1-summary');

    // Remove the sabotage table so the retry can succeed
    db.exec(`DROP TABLE hot_state_new`);

    // Second ensureSchema call must complete migration successfully
    expect(() => ensureSchema(db)).not.toThrow();
    const v2 = db.prepare('PRAGMA user_version').get().user_version;
    expect(v2).toBe(2);

    // hot_state row preserved after migration
    const migratedRow = db.prepare(
      "SELECT last_worked_summary, session_id FROM hot_state WHERE project='/rollback-test'"
    ).get();
    expect(migratedRow).toBeDefined();
    expect(migratedRow.last_worked_summary).toBe('v1-summary');
    expect(migratedRow.session_id).toBe('');
  });
});

// ── 8.11 pruneHotState ───────────────────────────────────────────────────────

describe('pruneHotState', () => {
  const AGENT = 'engineer';
  const PROJECT = '/prune/test';

  function insertRow(db, sessionId, updatedAt) {
    db.prepare(`
      INSERT INTO hot_state (scope, agent, project, session_id, last_worked_summary, next_action, open_questions, updated_at)
      VALUES ('project', ?, ?, ?, '', '', '[]', ?)
    `).run(AGENT, PROJECT, sessionId, updatedAt);
  }

  test('6th session evicts the oldest (keeps last 5)', () => {
    const db = openMemory();
    ensureSchema(db);

    for (let i = 1; i <= 6; i++) {
      insertRow(db, `ses-${i}`, i * 100);
    }

    pruneHotState(db, AGENT, PROJECT);

    const remaining = db
      .prepare('SELECT session_id FROM hot_state WHERE agent=? AND project=? ORDER BY updated_at DESC')
      .all(AGENT, PROJECT)
      .map((r) => r.session_id);

    expect(remaining).toHaveLength(5);
    // ses-1 (oldest, updated_at=100) should be evicted
    expect(remaining).not.toContain('ses-1');
    expect(remaining).toContain('ses-6');
  });

  test('cross-project rows are unaffected by pruning', () => {
    const db = openMemory();
    ensureSchema(db);

    // Insert 6 rows for PROJECT
    for (let i = 1; i <= 6; i++) {
      insertRow(db, `ses-${i}`, i * 100);
    }
    // Insert 1 row for a different project
    db.prepare(`
      INSERT INTO hot_state (scope, agent, project, session_id, last_worked_summary, next_action, open_questions, updated_at)
      VALUES ('project', ?, '/other/project', 'other-ses', '', '', '[]', 999)
    `).run(AGENT);

    pruneHotState(db, AGENT, PROJECT);

    // /other/project row must still exist
    const otherRow = db
      .prepare("SELECT session_id FROM hot_state WHERE project='/other/project'")
      .get();
    expect(otherRow).toBeDefined();
    expect(otherRow.session_id).toBe('other-ses');
  });
});
