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
  atomPatch,
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
                       'pinned', 'status', 'session_id', 'session_name', 'created_at', 'updated_at']) {
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

  test('user_version is set to 4 after first ensureSchema', () => {
    const db = openMemory();
    ensureSchema(db);
    const v = db.prepare('PRAGMA user_version').get().user_version;
    expect(v).toBe(4);
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

  // spec: openspec/changes/atom-timestamps/specs/memory-atom/spec.md
  test('atom-write with explicit createdAt stores that timestamp', () => {
    const db = openMemory();
    ensureSchema(db);
    const fixedCreatedAt = 1_700_000_000_000;
    atomWrite(db, { scope: 'project', project: '/p', topic: 'ts-test', content: 'body', description: 'd', createdAt: fixedCreatedAt });
    const row = db.prepare("SELECT created_at FROM memory_atom WHERE topic='ts-test'").get();
    expect(row.created_at).toBe(fixedCreatedAt);
  });

  // spec: openspec/changes/atom-timestamps/specs/memory-atom/spec.md
  test('atom-write without createdAt uses current time', () => {
    const db = openMemory();
    ensureSchema(db);
    const before = Date.now();
    atomWrite(db, { scope: 'project', project: '/p', topic: 'ts-default', content: 'body', description: 'd' });
    const after = Date.now();
    const row = db.prepare("SELECT created_at FROM memory_atom WHERE topic='ts-default'").get();
    expect(row.created_at).toBeGreaterThanOrEqual(before);
    expect(row.created_at).toBeLessThanOrEqual(after);
  });

  test('atom-write upsert preserves original created_at on subsequent writes', () => {
    const db = openMemory();
    ensureSchema(db);
    const originalCreatedAt = 1_000;
    atomWrite(db, { scope: 'project', project: '/p', topic: 'ts-upsert', content: 'v1', description: 'd', createdAt: originalCreatedAt });
    // Write again with a different createdAt — upsert must not overwrite created_at
    atomWrite(db, { scope: 'project', project: '/p', topic: 'ts-upsert', content: 'v2', description: 'd updated', createdAt: 9_999 });
    const row = db.prepare("SELECT created_at, updated_at, content FROM memory_atom WHERE topic='ts-upsert'").get();
    expect(row.created_at).toBe(originalCreatedAt);
    expect(row.content).toBe('v2');
    expect(row.updated_at).toBeGreaterThan(originalCreatedAt);
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

  // spec: openspec/changes/atom-timestamps/specs/memory-atom/spec.md
  test('atom-get match row includes created_at and updated_at', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'ts-atom', content: 'content', description: 'd' });
    const result = atomGet(db, { scope: 'project', project: '/p', topic: 'ts-atom' });
    expect(result.match).not.toBeNull();
    expect(typeof result.match.created_at).toBe('number');
    expect(result.match.created_at).toBeGreaterThan(0);
    expect(typeof result.match.updated_at).toBe('number');
    expect(result.match.updated_at).toBeGreaterThan(0);
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

  test('scope=project restriction: same behaviour as scope=workspace', () => {
    const db = setupSearchFixture();
    // resolveScope maps workspace → {scope:'project', project:dir}; ensure it restricts correctly
    const results = atomSearch(db, { scope: 'project', project: '/myproj', query: 'Unrelated', limit: 10 });
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

  // spec: openspec/changes/atom-timestamps/specs/memory-atom/spec.md
  test('atom-search results include created_at and updated_at', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'ts-search', content: 'timestamp search content', description: 'ts desc' });
    const results = atomSearch(db, { scope: 'all', project: '/p', query: 'timestamp search', limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    const r = results[0];
    expect(typeof r.created_at).toBe('number');
    expect(r.created_at).toBeGreaterThan(0);
    expect(typeof r.updated_at).toBe('number');
    expect(r.updated_at).toBeGreaterThan(0);
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

  // spec: openspec/changes/atom-timestamps/specs/memory-atom/spec.md
  test('atom-list results include created_at and updated_at', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'ts-list', content: 'x', description: 'd' });
    const results = atomList(db, { scope: 'project', project: '/p' });
    expect(results.length).toBeGreaterThan(0);
    const r = results.find((item) => item.topic === 'ts-list');
    expect(r).toBeDefined();
    expect(typeof r.created_at).toBe('number');
    expect(r.created_at).toBeGreaterThan(0);
    expect(typeof r.updated_at).toBe('number');
    expect(r.updated_at).toBeGreaterThan(0);
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

  test('user_version is 4 after migration', () => {
    const db = buildOldSchemaDb();
    ensureSchema(db);
    const v = db.prepare('PRAGMA user_version').get().user_version;
    expect(v).toBe(4);
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
    expect(v2).toBe(4);

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

// ── atomPatch ─────────────────────────────────────────────────────────────────
// spec: openspec/specs/memory-atom/spec.md

describe('atomPatch', () => {
  function seedAtom(db, overrides = {}) {
    // Insert directly to control updated_at precisely
    const defaults = {
      scope: 'project', project: '/p', topic: 'work/notes',
      description: 'original desc', content: 'original content',
      tags: '["old-tag"]', created_at: 1000, updated_at: 2000,
    };
    const d = { ...defaults, ...overrides };
    db.prepare(`
      INSERT INTO memory_atom (scope, project, topic, description, content, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(d.scope, d.project, d.topic, d.description, d.content, d.tags, d.created_at, d.updated_at);
  }

  test('atomPatch with description and tags updates both and bumps updated_at', () => {
    const db = openMemory();
    ensureSchema(db);
    seedAtom(db);

    atomPatch(db, {
      scope: 'project', project: '/p', topic: 'work/notes',
      patch: { description: 'new desc', tags: ['new-tag'] },
    });

    const row = db.prepare("SELECT * FROM memory_atom WHERE topic='work/notes'").get();
    expect(row.description).toBe('new desc');
    expect(row.tags).toBe('["new-tag"]');
    expect(row.content).toBe('original content');
    expect(row.updated_at).toBeGreaterThan(2000);
  });

  test('atomPatch with created_at only does not bump updated_at', () => {
    const db = openMemory();
    ensureSchema(db);
    seedAtom(db);

    atomPatch(db, {
      scope: 'project', project: '/p', topic: 'work/notes',
      patch: { created_at: 500 },
    });

    const row = db.prepare("SELECT * FROM memory_atom WHERE topic='work/notes'").get();
    expect(row.created_at).toBe(500);
    expect(row.updated_at).toBe(2000);
    expect(row.content).toBe('original content');
  });

  test('atomPatch with tags:[] clears existing tags', () => {
    const db = openMemory();
    ensureSchema(db);
    seedAtom(db);

    atomPatch(db, {
      scope: 'project', project: '/p', topic: 'work/notes',
      patch: { tags: [] },
    });

    const row = db.prepare("SELECT tags FROM memory_atom WHERE topic='work/notes'").get();
    expect(row.tags).toBe('[]');
  });

  test('atomPatch with absent tags field leaves existing tags unchanged', () => {
    const db = openMemory();
    ensureSchema(db);
    seedAtom(db);

    atomPatch(db, {
      scope: 'project', project: '/p', topic: 'work/notes',
      patch: { description: 'updated desc' },
    });

    const row = db.prepare("SELECT tags FROM memory_atom WHERE topic='work/notes'").get();
    expect(row.tags).toBe('["old-tag"]');
  });

  test('atomPatch rejects an empty patch', () => {
    const db = openMemory();
    ensureSchema(db);
    seedAtom(db);

    expect(() =>
      atomPatch(db, { scope: 'project', project: '/p', topic: 'work/notes', patch: {} })
    ).toThrow(/at least one/i);
  });

  test('atomPatch rejects an empty description', () => {
    const db = openMemory();
    ensureSchema(db);
    seedAtom(db);

    expect(() =>
      atomPatch(db, { scope: 'project', project: '/p', topic: 'work/notes', patch: { description: '' } })
    ).toThrow(/non-empty/i);
  });

  test('atomPatch errors when atom does not exist', () => {
    const db = openMemory();
    ensureSchema(db);

    expect(() =>
      atomPatch(db, { scope: 'project', project: '/p', topic: 'arch/missing', patch: { description: 'x' } })
    ).toThrow(/does not exist/i);
  });

  test('atomPatch preserves content unchanged', () => {
    const db = openMemory();
    ensureSchema(db);
    seedAtom(db);

    atomPatch(db, {
      scope: 'project', project: '/p', topic: 'work/notes',
      patch: { description: 'changed', tags: ['t'] },
    });

    const row = db.prepare("SELECT content FROM memory_atom WHERE topic='work/notes'").get();
    expect(row.content).toBe('original content');
  });

  test('atomPatch returns patched field names', () => {
    const db = openMemory();
    ensureSchema(db);
    seedAtom(db);

    const result = atomPatch(db, {
      scope: 'project', project: '/p', topic: 'work/notes',
      patch: { description: 'new', tags: ['t'] },
    });

    expect(result.patched).toEqual(expect.arrayContaining(['description', 'tags']));
  });
});

// ── v2→v3 migration (pinned column) ──────────────────────────────────────────
// spec: openspec/changes/pin-memory-atoms/specs/memory-atom/spec.md

describe('migration — v2 to v3 (pinned column)', () => {
  function buildV2SchemaDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA busy_timeout = 5000;');
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
      CREATE TABLE memory_atom (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL DEFAULT 'project',
        project TEXT NOT NULL DEFAULT '',
        topic TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        session_id TEXT,
        session_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (scope, project, topic)
      );
      PRAGMA user_version = 2;
    `);
    db.prepare(`
      INSERT INTO memory_atom (scope, project, topic, description, content, tags, created_at, updated_at)
      VALUES ('project', '/p', 'existing-atom', 'existing atom', 'body', '[]', 100, 200)
    `).run();
    return db;
  }

  test('adds pinned column to existing memory_atom table', () => {
    const db = buildV2SchemaDb();
    ensureSchema(db);
    const cols = db.prepare('PRAGMA table_info(memory_atom)').all().map((c) => c.name);
    expect(cols).toContain('pinned');
  });

  test('existing rows get pinned = 0 after migration', () => {
    const db = buildV2SchemaDb();
    ensureSchema(db);
    const row = db.prepare("SELECT pinned FROM memory_atom WHERE topic = 'existing-atom'").get();
    expect(row).toBeDefined();
    expect(row.pinned).toBe(0);
  });

  test('user_version is 4 after v2 to v3 migration', () => {
    const db = buildV2SchemaDb();
    ensureSchema(db);
    const v = db.prepare('PRAGMA user_version').get().user_version;
    expect(v).toBe(4);
  });

  test('v3 migration is idempotent — calling ensureSchema twice does not throw', () => {
    const db = buildV2SchemaDb();
    ensureSchema(db);
    expect(() => ensureSchema(db)).not.toThrow();
  });

  test('v3 migration is idempotent when pinned already present (user_version < 3)', () => {
    const db = buildV2SchemaDb();
    db.exec('ALTER TABLE memory_atom ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
    expect(() => ensureSchema(db)).not.toThrow();
    const v = db.prepare('PRAGMA user_version').get().user_version;
    expect(v).toBe(4);
  });

  test('fresh and migrated databases have identical pinned column definition', () => {
    const fresh = openMemory();
    ensureSchema(fresh);
    const migrated = buildV2SchemaDb();
    ensureSchema(migrated);

    const pinnedCol = (db) => db.prepare('PRAGMA table_info(memory_atom)').all().find((c) => c.name === 'pinned');
    const f = pinnedCol(fresh);
    const m = pinnedCol(migrated);
    expect(f).toBeDefined();
    expect(m).toBeDefined();
    expect(f.type).toBe(m.type);
    expect(f.dflt_value).toBe(m.dflt_value);
    expect(f.notnull).toBe(m.notnull);
  });
});

// ── atomWrite with pinned ─────────────────────────────────────────────────────
// spec: openspec/changes/pin-memory-atoms/specs/memory-atom/spec.md

describe('atomWrite with pinned', () => {
  test('pinned=true stores pinned=1 in the DB', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'important', content: 'x', description: 'd', pinned: true });
    const row = db.prepare("SELECT pinned FROM memory_atom WHERE topic='important'").get();
    expect(row.pinned).toBe(1);
  });

  test('pinned omitted defaults to 0', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'normal', content: 'x', description: 'd' });
    const row = db.prepare("SELECT pinned FROM memory_atom WHERE topic='normal'").get();
    expect(row.pinned).toBe(0);
  });

  test('pinned=false stores pinned=0', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'unpinned', content: 'x', description: 'd', pinned: false });
    const row = db.prepare("SELECT pinned FROM memory_atom WHERE topic='unpinned'").get();
    expect(row.pinned).toBe(0);
  });

  test('re-writing a pinned atom does not unpin it (INSERT-only)', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'sticky', content: 'v1', description: 'd', pinned: true });
    atomWrite(db, { scope: 'project', project: '/p', topic: 'sticky', content: 'v2', description: 'd updated' });
    const row = db.prepare("SELECT pinned, content FROM memory_atom WHERE topic='sticky'").get();
    expect(row.pinned).toBe(1);
    expect(row.content).toBe('v2');
  });

  test('re-writing with explicit pinned=false does not override existing pin (INSERT-only)', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'anchored', content: 'v1', description: 'd', pinned: true });
    atomWrite(db, { scope: 'project', project: '/p', topic: 'anchored', content: 'v2', description: 'd', pinned: false });
    const row = db.prepare("SELECT pinned FROM memory_atom WHERE topic='anchored'").get();
    expect(row.pinned).toBe(1);
  });
});

// ── atomPatch with pinned ─────────────────────────────────────────────────────
// spec: openspec/changes/pin-memory-atoms/specs/memory-atom/spec.md

describe('atomPatch with pinned', () => {
  function seedUnpinned(db) {
    atomWrite(db, { scope: 'project', project: '/p', topic: 'pin-target', content: 'body', description: 'desc' });
  }

  function seedPinned(db) {
    atomWrite(db, { scope: 'project', project: '/p', topic: 'pin-target', content: 'body', description: 'desc', pinned: true });
  }

  test('atomPatch with pinned:true pins the atom and bumps updated_at', () => {
    const db = openMemory();
    ensureSchema(db);
    db.prepare(`
      INSERT INTO memory_atom (scope, project, topic, description, content, tags, pinned, created_at, updated_at)
      VALUES ('project', '/p', 'pin-target', 'desc', 'body', '[]', 0, 1000, 2000)
    `).run();

    atomPatch(db, { scope: 'project', project: '/p', topic: 'pin-target', patch: { pinned: true } });

    const row = db.prepare("SELECT pinned, updated_at FROM memory_atom WHERE topic='pin-target'").get();
    expect(row.pinned).toBe(1);
    expect(row.updated_at).toBeGreaterThan(2000);
  });

  test('atomPatch with pinned:false unpins the atom and bumps updated_at', () => {
    const db = openMemory();
    ensureSchema(db);
    db.prepare(`
      INSERT INTO memory_atom (scope, project, topic, description, content, tags, pinned, created_at, updated_at)
      VALUES ('project', '/p', 'pin-target', 'desc', 'body', '[]', 1, 1000, 2000)
    `).run();

    atomPatch(db, { scope: 'project', project: '/p', topic: 'pin-target', patch: { pinned: false } });

    const row = db.prepare("SELECT pinned, updated_at FROM memory_atom WHERE topic='pin-target'").get();
    expect(row.pinned).toBe(0);
    expect(row.updated_at).toBeGreaterThan(2000);
  });

  test('atomPatch with pinned alone is accepted (single-field patch)', () => {
    const db = openMemory();
    ensureSchema(db);
    seedUnpinned(db);

    const result = atomPatch(db, { scope: 'project', project: '/p', topic: 'pin-target', patch: { pinned: true } });
    expect(result.patched).toContain('pinned');
  });

  test('atomPatch without pinned field leaves existing pinned value unchanged', () => {
    const db = openMemory();
    ensureSchema(db);
    db.prepare(`
      INSERT INTO memory_atom (scope, project, topic, description, content, tags, pinned, created_at, updated_at)
      VALUES ('project', '/p', 'pin-target', 'desc', 'body', '[]', 1, 1000, 2000)
    `).run();

    atomPatch(db, { scope: 'project', project: '/p', topic: 'pin-target', patch: { description: 'updated' } });

    const row = db.prepare("SELECT pinned FROM memory_atom WHERE topic='pin-target'").get();
    expect(row.pinned).toBe(1);
  });

  test('atomPatch with pinned does not change content', () => {
    const db = openMemory();
    ensureSchema(db);
    db.prepare(`
      INSERT INTO memory_atom (scope, project, topic, description, content, tags, pinned, created_at, updated_at)
      VALUES ('project', '/p', 'pin-target', 'desc', 'original body', '[]', 0, 1000, 2000)
    `).run();

    atomPatch(db, { scope: 'project', project: '/p', topic: 'pin-target', patch: { pinned: true } });

    const row = db.prepare("SELECT content FROM memory_atom WHERE topic='pin-target'").get();
    expect(row.content).toBe('original body');
  });

  test('atomPatch empty patch still requires at least one field (pinned extends PATCHABLE)', () => {
    const db = openMemory();
    ensureSchema(db);
    seedUnpinned(db);

    expect(() =>
      atomPatch(db, { scope: 'project', project: '/p', topic: 'pin-target', patch: {} })
    ).toThrow(/at least one/i);
  });
});

// ── atomList with pinned ──────────────────────────────────────────────────────
// spec: openspec/changes/pin-memory-atoms/specs/memory-atom/spec.md

describe('atomList with pinned', () => {
  test('pinned field is returned in list rows', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'pinned-atom', content: 'x', description: 'd', pinned: true });
    atomWrite(db, { scope: 'project', project: '/p', topic: 'regular-atom', content: 'y', description: 'd' });

    const results = atomList(db, { scope: 'project', project: '/p' });
    const pinned = results.find((r) => r.topic === 'pinned-atom');
    const regular = results.find((r) => r.topic === 'regular-atom');
    expect(pinned).toBeDefined();
    expect(pinned.pinned).toBe(1);
    expect(regular).toBeDefined();
    expect(regular.pinned).toBe(0);
  });

  test('pinned atoms appear before non-pinned atoms in the returned list', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'zzz-regular', content: 'x', description: 'd' });
    atomWrite(db, { scope: 'project', project: '/p', topic: 'aaa-pinned', content: 'y', description: 'd', pinned: true });

    const results = atomList(db, { scope: 'project', project: '/p' });
    const pinnedIdx = results.findIndex((r) => r.topic === 'aaa-pinned');
    const regularIdx = results.findIndex((r) => r.topic === 'zzz-regular');
    expect(pinnedIdx).toBeLessThan(regularIdx);
  });

  test('scope=all includes pinned field for all rows', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'global', project: '', topic: 'global-pinned', content: 'x', description: 'd', pinned: true });

    const results = atomList(db, { scope: 'all', project: '' });
    const row = results.find((r) => r.topic === 'global-pinned');
    expect(row).toBeDefined();
    expect(row.pinned).toBe(1);
  });
});

// ── migration — v3 to v4 (status column) ─────────────────────────────────────
// spec: openspec/changes/atom-status/specs/memory-atom/spec.md

describe('migration — v3 to v4 (status column)', () => {
  function buildV3SchemaDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA busy_timeout = 5000;');
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
      CREATE TABLE memory_atom (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL DEFAULT 'project',
        project TEXT NOT NULL DEFAULT '',
        topic TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        pinned INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        session_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (scope, project, topic)
      );
      PRAGMA user_version = 3;
    `);
    db.prepare(`
      INSERT INTO memory_atom (scope, project, topic, description, content, tags, pinned, created_at, updated_at)
      VALUES ('project', '/p', 'existing-atom', 'existing atom', 'body', '[]', 0, 100, 200)
    `).run();
    return db;
  }

  test('adds status column to existing memory_atom table', () => {
    const db = buildV3SchemaDb();
    ensureSchema(db);
    const cols = db.prepare('PRAGMA table_info(memory_atom)').all().map((c) => c.name);
    expect(cols).toContain('status');
  });

  test('existing rows get status = "active" after migration', () => {
    const db = buildV3SchemaDb();
    ensureSchema(db);
    const row = db.prepare("SELECT status FROM memory_atom WHERE topic = 'existing-atom'").get();
    expect(row).toBeDefined();
    expect(row.status).toBe('active');
  });

  test('user_version is 4 after v3 to v4 migration', () => {
    const db = buildV3SchemaDb();
    ensureSchema(db);
    const v = db.prepare('PRAGMA user_version').get().user_version;
    expect(v).toBe(4);
  });

  test('v4 migration is idempotent — calling ensureSchema twice does not throw', () => {
    const db = buildV3SchemaDb();
    ensureSchema(db);
    expect(() => ensureSchema(db)).not.toThrow();
  });

  test('v4 migration is idempotent when status already present (user_version < 4)', () => {
    const db = buildV3SchemaDb();
    db.exec(`ALTER TABLE memory_atom ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'resolved', 'deprecated'))`);
    expect(() => ensureSchema(db)).not.toThrow();
    const v = db.prepare('PRAGMA user_version').get().user_version;
    expect(v).toBe(4);
  });

  test('fresh and migrated databases have identical status column definition', () => {
    const fresh = openMemory();
    ensureSchema(fresh);
    const migrated = buildV3SchemaDb();
    ensureSchema(migrated);

    const statusCol = (db) => db.prepare('PRAGMA table_info(memory_atom)').all().find((c) => c.name === 'status');
    const f = statusCol(fresh);
    const m = statusCol(migrated);
    expect(f).toBeDefined();
    expect(m).toBeDefined();
    expect(f.type).toBe(m.type);
    expect(f.dflt_value).toBe(m.dflt_value);
    expect(f.notnull).toBe(m.notnull);
  });
});

// ── atomWrite preserves existing status on upsert ─────────────────────────────
// spec: openspec/changes/atom-status/specs/memory-atom/spec.md

describe('atomWrite preserves existing status on upsert', () => {
  test('new atom has status = "active" by default', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'brand-new', content: 'x', description: 'd' });
    const row = db.prepare("SELECT status FROM memory_atom WHERE topic='brand-new'").get();
    expect(row.status).toBe('active');
  });

  test('re-writing an active atom preserves status = "active"', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'rewritten', content: 'v1', description: 'd' });
    atomWrite(db, { scope: 'project', project: '/p', topic: 'rewritten', content: 'v2', description: 'd updated' });
    const row = db.prepare("SELECT status FROM memory_atom WHERE topic='rewritten'").get();
    expect(row.status).toBe('active');
  });

  test('re-writing a deprecated atom preserves status = "deprecated" (DEFAULT-only, ON CONFLICT excludes status)', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'deprecated-one', content: 'v1', description: 'd' });
    db.prepare("UPDATE memory_atom SET status='deprecated' WHERE topic='deprecated-one'").run();
    atomWrite(db, { scope: 'project', project: '/p', topic: 'deprecated-one', content: 'v2', description: 'd updated' });
    const row = db.prepare("SELECT status FROM memory_atom WHERE topic='deprecated-one'").get();
    expect(row.status).toBe('deprecated');
  });

  test('re-writing a resolved atom preserves status = "resolved"', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'resolved-one', content: 'v1', description: 'd' });
    db.prepare("UPDATE memory_atom SET status='resolved' WHERE topic='resolved-one'").run();
    atomWrite(db, { scope: 'project', project: '/p', topic: 'resolved-one', content: 'v2', description: 'd updated' });
    const row = db.prepare("SELECT status FROM memory_atom WHERE topic='resolved-one'").get();
    expect(row.status).toBe('resolved');
  });
});

// ── atomPatch with status ─────────────────────────────────────────────────────
// spec: openspec/changes/atom-status/specs/memory-atom/spec.md

describe('atomPatch with status', () => {
  function seedActive(db) {
    atomWrite(db, { scope: 'project', project: '/p', topic: 'status-target', content: 'body', description: 'desc' });
  }

  test('atomPatch with status="resolved" updates status and bumps updated_at', () => {
    const db = openMemory();
    ensureSchema(db);
    db.prepare(`
      INSERT INTO memory_atom (scope, project, topic, description, content, tags, pinned, created_at, updated_at)
      VALUES ('project', '/p', 'status-target', 'desc', 'body', '[]', 0, 1000, 2000)
    `).run();

    atomPatch(db, { scope: 'project', project: '/p', topic: 'status-target', patch: { status: 'resolved' } });

    const row = db.prepare("SELECT status, updated_at FROM memory_atom WHERE topic='status-target'").get();
    expect(row.status).toBe('resolved');
    expect(row.updated_at).toBeGreaterThan(2000);
  });

  test('atomPatch with status="deprecated" updates status and bumps updated_at', () => {
    const db = openMemory();
    ensureSchema(db);
    seedActive(db);

    atomPatch(db, { scope: 'project', project: '/p', topic: 'status-target', patch: { status: 'deprecated' } });

    const row = db.prepare("SELECT status FROM memory_atom WHERE topic='status-target'").get();
    expect(row.status).toBe('deprecated');
  });

  test('atomPatch with status="active" re-activates a deprecated atom', () => {
    const db = openMemory();
    ensureSchema(db);
    seedActive(db);
    atomPatch(db, { scope: 'project', project: '/p', topic: 'status-target', patch: { status: 'deprecated' } });

    atomPatch(db, { scope: 'project', project: '/p', topic: 'status-target', patch: { status: 'active' } });

    const row = db.prepare("SELECT status FROM memory_atom WHERE topic='status-target'").get();
    expect(row.status).toBe('active');
  });

  test('atomPatch with invalid status throws', () => {
    const db = openMemory();
    ensureSchema(db);
    seedActive(db);

    expect(() =>
      atomPatch(db, { scope: 'project', project: '/p', topic: 'status-target', patch: { status: 'invalid' } })
    ).toThrow(/must be one of/);
  });

  test('atomPatch without status field leaves existing status unchanged', () => {
    const db = openMemory();
    ensureSchema(db);
    db.prepare(`
      INSERT INTO memory_atom (scope, project, topic, description, content, tags, pinned, created_at, updated_at)
      VALUES ('project', '/p', 'status-target', 'desc', 'body', '[]', 0, 1000, 2000)
    `).run();
    db.prepare("UPDATE memory_atom SET status='resolved' WHERE topic='status-target'").run();

    atomPatch(db, { scope: 'project', project: '/p', topic: 'status-target', patch: { description: 'updated' } });

    const row = db.prepare("SELECT status FROM memory_atom WHERE topic='status-target'").get();
    expect(row.status).toBe('resolved');
  });

  test('atomPatch with status alone is accepted (single-field patch)', () => {
    const db = openMemory();
    ensureSchema(db);
    seedActive(db);

    const result = atomPatch(db, { scope: 'project', project: '/p', topic: 'status-target', patch: { status: 'resolved' } });
    expect(result.patched).toContain('status');
  });

  test('atomPatch with status does not change content', () => {
    const db = openMemory();
    ensureSchema(db);
    db.prepare(`
      INSERT INTO memory_atom (scope, project, topic, description, content, tags, pinned, created_at, updated_at)
      VALUES ('project', '/p', 'status-target', 'desc', 'original body', '[]', 0, 1000, 2000)
    `).run();

    atomPatch(db, { scope: 'project', project: '/p', topic: 'status-target', patch: { status: 'deprecated' } });

    const row = db.prepare("SELECT content FROM memory_atom WHERE topic='status-target'").get();
    expect(row.content).toBe('original body');
  });
});

// ── atomList with status ──────────────────────────────────────────────────────
// spec: openspec/changes/atom-status/specs/memory-atom/spec.md

describe('atomList with status filtering', () => {
  function seedMixed(db) {
    atomWrite(db, { scope: 'project', project: '/p', topic: 'active-one', content: 'x', description: 'active', pinned: false });
    atomWrite(db, { scope: 'project', project: '/p', topic: 'resolved-one', content: 'x', description: 'resolved' });
    atomWrite(db, { scope: 'project', project: '/p', topic: 'deprecated-one', content: 'x', description: 'deprecated' });
    db.prepare("UPDATE memory_atom SET status='resolved' WHERE topic='resolved-one'").run();
    db.prepare("UPDATE memory_atom SET status='deprecated' WHERE topic='deprecated-one'").run();
  }

  test('status field is returned in list rows', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'status-atom', content: 'x', description: 'd' });
    const results = atomList(db, { scope: 'project', project: '/p' });
    const row = results.find((r) => r.topic === 'status-atom');
    expect(row).toBeDefined();
    expect(row.status).toBe('active');
  });

  test('default filter returns active and resolved, excludes deprecated', () => {
    const db = openMemory();
    ensureSchema(db);
    seedMixed(db);

    const results = atomList(db, { scope: 'project', project: '/p' });
    const topics = results.map((r) => r.topic);
    expect(topics).toContain('active-one');
    expect(topics).toContain('resolved-one');
    expect(topics).not.toContain('deprecated-one');
  });

  test('includeDeprecated=true returns all three statuses', () => {
    const db = openMemory();
    ensureSchema(db);
    seedMixed(db);

    const results = atomList(db, { scope: 'project', project: '/p', includeDeprecated: true });
    const topics = results.map((r) => r.topic);
    expect(topics).toContain('active-one');
    expect(topics).toContain('resolved-one');
    expect(topics).toContain('deprecated-one');
  });

  test('status="deprecated" exact-match returns only deprecated atoms', () => {
    const db = openMemory();
    ensureSchema(db);
    seedMixed(db);

    const results = atomList(db, { scope: 'project', project: '/p', status: 'deprecated' });
    const topics = results.map((r) => r.topic);
    expect(topics).toContain('deprecated-one');
    expect(topics).not.toContain('active-one');
    expect(topics).not.toContain('resolved-one');
  });

  test('status="active" exact-match returns only active atoms', () => {
    const db = openMemory();
    ensureSchema(db);
    seedMixed(db);

    const results = atomList(db, { scope: 'project', project: '/p', status: 'active' });
    const topics = results.map((r) => r.topic);
    expect(topics).toContain('active-one');
    expect(topics).not.toContain('resolved-one');
    expect(topics).not.toContain('deprecated-one');
  });

  test('status exact-match takes precedence over includeDeprecated when both are supplied', () => {
    const db = openMemory();
    ensureSchema(db);
    seedMixed(db);

    // status='active' + includeDeprecated=true → only active atoms returned (status wins)
    const results = atomList(db, { scope: 'project', project: '/p', status: 'active', includeDeprecated: true });
    const topics = results.map((r) => r.topic);
    expect(topics).toContain('active-one');
    expect(topics).not.toContain('resolved-one');
    expect(topics).not.toContain('deprecated-one');
  });

  test('scope=all with includeDeprecated=true returns deprecated atoms across all workspaces', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'global', project: '', topic: 'deprecated-global', content: 'x', description: 'd' });
    db.prepare("UPDATE memory_atom SET status='deprecated' WHERE topic='deprecated-global'").run();

    const results = atomList(db, { scope: 'all', project: '', includeDeprecated: true });
    const topics = results.map((r) => r.topic);
    expect(topics).toContain('deprecated-global');
  });
});

// ── atomSearch with status ────────────────────────────────────────────────────
// spec: openspec/changes/atom-status/specs/memory-atom/spec.md

describe('atomSearch with status filtering', () => {
  function seedSearchable(db) {
    atomWrite(db, { scope: 'project', project: '/p', topic: 'find-active', content: 'searchable content alpha', description: 'active atom' });
    atomWrite(db, { scope: 'project', project: '/p', topic: 'find-resolved', content: 'searchable content beta', description: 'resolved atom' });
    atomWrite(db, { scope: 'project', project: '/p', topic: 'find-deprecated', content: 'searchable content gamma', description: 'deprecated atom' });
    db.prepare("UPDATE memory_atom SET status='resolved' WHERE topic='find-resolved'").run();
    db.prepare("UPDATE memory_atom SET status='deprecated' WHERE topic='find-deprecated'").run();
  }

  test('status field is returned in search results', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'srch-status', content: 'unique content xyz', description: 'd' });
    const results = atomSearch(db, { scope: 'project', project: '/p', query: 'xyz' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('status');
    expect(results[0].status).toBe('active');
  });

  test('default search filter excludes deprecated atoms', () => {
    const db = openMemory();
    ensureSchema(db);
    seedSearchable(db);

    const results = atomSearch(db, { scope: 'project', project: '/p', query: 'searchable' });
    const topics = results.map((r) => r.topic);
    expect(topics).toContain('find-active');
    expect(topics).toContain('find-resolved');
    expect(topics).not.toContain('find-deprecated');
  });

  test('includeDeprecated=true includes deprecated atoms in search', () => {
    const db = openMemory();
    ensureSchema(db);
    seedSearchable(db);

    const results = atomSearch(db, { scope: 'project', project: '/p', query: 'searchable', includeDeprecated: true });
    const topics = results.map((r) => r.topic);
    expect(topics).toContain('find-active');
    expect(topics).toContain('find-resolved');
    expect(topics).toContain('find-deprecated');
  });

  test('status="deprecated" exact-match returns only deprecated atoms in search', () => {
    const db = openMemory();
    ensureSchema(db);
    seedSearchable(db);

    const results = atomSearch(db, { scope: 'project', project: '/p', query: 'searchable', status: 'deprecated' });
    const topics = results.map((r) => r.topic);
    expect(topics).toContain('find-deprecated');
    expect(topics).not.toContain('find-active');
    expect(topics).not.toContain('find-resolved');
  });
});

// ── atomGet with status ───────────────────────────────────────────────────────
// spec: openspec/changes/atom-status/specs/memory-atom/spec.md

describe('atomGet with status', () => {
  test('status field is returned in match row', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'get-status', content: 'body', description: 'd' });

    const result = atomGet(db, { scope: 'project', project: '/p', topic: 'get-status' });
    expect(result.match).not.toBeNull();
    expect(result.match).toHaveProperty('status');
    expect(result.match.status).toBe('active');
  });

  test('atomGet always returns regardless of status (no predicate filtering)', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/p', topic: 'dep-get', content: 'body', description: 'd' });
    db.prepare("UPDATE memory_atom SET status='deprecated' WHERE topic='dep-get'").run();

    const result = atomGet(db, { scope: 'project', project: '/p', topic: 'dep-get' });
    expect(result.match).not.toBeNull();
    expect(result.match.status).toBe('deprecated');
  });

  test('alsoIn entries include status field and deprecated atoms are included', () => {
    const db = openMemory();
    ensureSchema(db);
    atomWrite(db, { scope: 'project', project: '/other', topic: 'cross-status', content: 'foreign body', description: 'd' });
    db.prepare("UPDATE memory_atom SET status='deprecated' WHERE topic='cross-status'").run();

    const result = atomGet(db, { scope: 'project', project: '/p', topic: 'cross-status' });
    expect(result.alsoIn.length).toBeGreaterThan(0);
    expect(result.alsoIn[0]).toHaveProperty('status');
    expect(result.alsoIn[0].status).toBe('deprecated');
  });
});
