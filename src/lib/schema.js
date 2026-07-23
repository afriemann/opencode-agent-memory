// src/lib/schema.js — idempotent schema creation for agent-memory.db.
//
// Called by memory.js (sole writer) on init and on every CLI invocation that
// opens the DB. Tables are created with CREATE TABLE IF NOT EXISTS so this is
// safe to call multiple times. The CLI is the only process that ever calls
// this; the plugin never opens the DB directly.
//
// Schema version 2 changes:
//   - hot_state: new UNIQUE(scope, agent, project, session_id); new columns
//     session_id and session_name; adr_candidate column dropped.
//   - memory_atom: new table for durable named knowledge atoms.
//   - memory_atom_fts: FTS5 virtual table (external-content) over memory_atom.
//   - Three FTS sync triggers: memory_atom_ai, memory_atom_ad, memory_atom_au.
//   - PRAGMA user_version = 2 marks migration complete.

// ── Topic normalisation ───────────────────────────────────────────────────────

/**
 * Normalise a memory atom topic key.
 * Rules:
 *   1. Lowercase
 *   2. Spaces and underscores → hyphens
 *   3. Strip leading and trailing slashes
 *
 * @param {string} topic
 * @returns {string}
 */
export function normaliseTopic(topic) {
  if (!topic || typeof topic !== 'string') return '';
  return topic
    .toLowerCase()
    .replace(/[ _]+/g, '-')
    .replace(/^\/+|\/+$/g, '');
}

// ── Migration helpers ─────────────────────────────────────────────────────────

/**
 * Rebuild hot_state with the new schema (version 2).
 * Runs entirely inside the caller's transaction.
 *
 * Steps:
 *  1.  Create hot_state_new with the new column set + UNIQUE(scope,agent,project,session_id)
 *  2.  Copy existing rows (session_id = '', session_name = NULL)
 *  3.  DROP hot_state
 *  4.  RENAME hot_state_new → hot_state
 *  5.  Recreate idx_hot_state_lookup
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function rebuildHotState(db) {
  db.exec(`
    CREATE TABLE hot_state_new (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      scope               TEXT    NOT NULL DEFAULT 'project',
      agent               TEXT    NOT NULL,
      project             TEXT    NOT NULL,
      session_id          TEXT    NOT NULL DEFAULT '',
      session_name        TEXT,
      last_worked_summary TEXT,
      next_action         TEXT,
      open_questions      TEXT,
      anchored_git_sha    TEXT,
      schema_version      INTEGER NOT NULL DEFAULT 2,
      updated_at          INTEGER NOT NULL,
      UNIQUE (scope, agent, project, session_id)
    );

    INSERT INTO hot_state_new
      (id, scope, agent, project, session_id, session_name,
       last_worked_summary, next_action, open_questions,
       anchored_git_sha, schema_version, updated_at)
    SELECT
      id, scope, agent, project, '' AS session_id, NULL AS session_name,
      last_worked_summary, next_action, open_questions,
      anchored_git_sha, 2 AS schema_version, updated_at
    FROM hot_state;

    DROP TABLE hot_state;

    ALTER TABLE hot_state_new RENAME TO hot_state;

    CREATE INDEX IF NOT EXISTS idx_hot_state_lookup
      ON hot_state (agent, project, scope);
  `);
}

/**
 * Migrate legacy hot_state summaries to atoms at topic 'work/migrated-summary'.
 * One upsert per unique project. Runs inside the caller's transaction.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function migrateHotStateToAtoms(db) {
  const rows = db
    .prepare(
      `SELECT project, last_worked_summary, updated_at
       FROM hot_state
       WHERE last_worked_summary IS NOT NULL AND last_worked_summary != ''`
    )
    .all();

  const stmt = db.prepare(`
    INSERT INTO memory_atom
      (scope, project, topic, description, content, tags, created_at, updated_at)
    VALUES ('project', ?, 'work/migrated-summary', 'Migrated from hot_state on schema v2 upgrade', ?, '[]', ?, ?)
    ON CONFLICT(scope, project, topic) DO NOTHING
  `);

  for (const row of rows) {
    stmt.run(row.project, row.last_worked_summary, row.updated_at, row.updated_at);
  }
}

// ── Schema creation ───────────────────────────────────────────────────────────

/**
 * Create all agent-memory tables and indexes if they do not already exist,
 * and run schema migrations as needed.
 * Safe to call repeatedly (idempotent).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function ensureSchema(db) {
  // ── Phase 1: baseline tables (always present) ────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS hot_state (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      scope               TEXT    NOT NULL DEFAULT 'project',
      agent               TEXT    NOT NULL,
      project             TEXT    NOT NULL,
      session_id          TEXT    NOT NULL DEFAULT '',
      session_name        TEXT,
      last_worked_summary TEXT,
      next_action         TEXT,
      open_questions      TEXT,
      anchored_git_sha    TEXT,
      schema_version      INTEGER NOT NULL DEFAULT 2,
      updated_at          INTEGER NOT NULL,
      UNIQUE (scope, agent, project, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_hot_state_lookup
      ON hot_state (agent, project, scope);

    CREATE TABLE IF NOT EXISTS memory_signal (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT    NOT NULL,
      scope       TEXT    NOT NULL DEFAULT 'project',
      agent       TEXT    NOT NULL,
      project     TEXT    NOT NULL,
      kind        TEXT    NOT NULL,
      payload     TEXT    NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_signal_scope
      ON memory_signal (agent, project, session_id);

    CREATE INDEX IF NOT EXISTS idx_signal_created
      ON memory_signal (created_at);

    CREATE TABLE IF NOT EXISTS distil_watermark (
      session_id     TEXT    PRIMARY KEY,
      last_signal_ms INTEGER NOT NULL DEFAULT 0,
      last_distil_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS memory_atom (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      scope        TEXT    NOT NULL DEFAULT 'project',
      project      TEXT    NOT NULL DEFAULT '',
      topic        TEXT    NOT NULL,
      description  TEXT    NOT NULL DEFAULT '',
      content      TEXT    NOT NULL DEFAULT '',
      tags         TEXT    NOT NULL DEFAULT '[]',
      session_id   TEXT,
      session_name TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      UNIQUE (scope, project, topic)
    );

    CREATE INDEX IF NOT EXISTS idx_atom_scope_project
      ON memory_atom (scope, project, topic);
  `);

  // ── Phase 1b: FTS5 virtual table + sync triggers (try/catch: graceful ────
  //   degradation when SQLite is compiled without FTS5)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_atom_fts
        USING fts5(
          topic, description, content, tags,
          content='memory_atom',
          content_rowid='id'
        );

      CREATE TRIGGER IF NOT EXISTS memory_atom_ai
        AFTER INSERT ON memory_atom BEGIN
          INSERT INTO memory_atom_fts(rowid, topic, description, content, tags)
          VALUES (new.id, new.topic, new.description, new.content, new.tags);
        END;

      CREATE TRIGGER IF NOT EXISTS memory_atom_ad
        AFTER DELETE ON memory_atom BEGIN
          INSERT INTO memory_atom_fts(memory_atom_fts, rowid, topic, description, content, tags)
          VALUES ('delete', old.id, old.topic, old.description, old.content, old.tags);
        END;

      CREATE TRIGGER IF NOT EXISTS memory_atom_au
        AFTER UPDATE ON memory_atom BEGIN
          INSERT INTO memory_atom_fts(memory_atom_fts, rowid, topic, description, content, tags)
          VALUES ('delete', old.id, old.topic, old.description, old.content, old.tags);
          INSERT INTO memory_atom_fts(rowid, topic, description, content, tags)
          VALUES (new.id, new.topic, new.description, new.content, new.tags);
        END;
    `);
  } catch {
    // FTS5 not available in this SQLite build — atom search degrades to LIKE scan.
  }

  // ── Phase 2: migration to schema version 2 ───────────────────────────────
  //   Gate: PRAGMA user_version < 2 AND session_id column absent (shape probe)
  const currentVersion = db.prepare('PRAGMA user_version').get()?.user_version ?? 0;
  if (currentVersion < 2) {
    // Shape probe: does session_id column already exist on hot_state?
    const cols = db.prepare("PRAGMA table_info(hot_state)").all().map((c) => c.name);
    if (!cols.includes('session_id')) {
      db.exec('BEGIN');
      try {
        rebuildHotState(db);
        migrateHotStateToAtoms(db);
        db.exec('PRAGMA user_version = 2');
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    } else {
      // session_id already present — just bump the version marker
      db.exec('PRAGMA user_version = 2');
    }
  }
}

// ── pruneHotState ─────────────────────────────────────────────────────────────

/**
 * Delete all but the 5 most recent hot_state rows for (scope='project', agent, project).
 * Cross-project and cross-agent rows are unaffected.
 * Runs inside the caller's transaction (or starts none — safe either way).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} agent
 * @param {string} project
 */
export function pruneHotState(db, agent, project) {
  db.prepare(`
    DELETE FROM hot_state
    WHERE scope = 'project' AND agent = ? AND project = ?
      AND id NOT IN (
        SELECT id FROM hot_state
        WHERE scope = 'project' AND agent = ? AND project = ?
        ORDER BY updated_at DESC, id DESC
        LIMIT 5
      )
  `).run(agent, project, agent, project);
}

// ── Atom DB helpers ───────────────────────────────────────────────────────────

/**
 * Write (upsert) a memory atom.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ scope:string, project:string, topic:string, content:string,
 *            description:string, tags?:string[]|string,
 *            sessionId?:string, sessionName?:string }} opts
 * @returns {{ action: 'created'|'overwritten' }}
 */
export function atomWrite(db, { scope, project, topic, content, description, tags, sessionId, sessionName }) {
  const normTopic = normaliseTopic(topic);
  if (!description || typeof description !== 'string' || !description.trim()) {
    throw new Error('Atom description is required and must be a non-empty string');
  }
  const tagsJson = Array.isArray(tags)
    ? JSON.stringify(tags)
    : (typeof tags === 'string' ? tags : '[]');
  const now = Date.now();

  // Check existence before upsert to report created vs overwritten
  const existing = db
    .prepare('SELECT id FROM memory_atom WHERE scope = ? AND project = ? AND topic = ?')
    .get(scope, project, normTopic);

  db.prepare(`
    INSERT INTO memory_atom
      (scope, project, topic, description, content, tags, session_id, session_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, project, topic) DO UPDATE SET
      description  = excluded.description,
      content      = excluded.content,
      tags         = excluded.tags,
      session_id   = excluded.session_id,
      session_name = excluded.session_name,
      updated_at   = excluded.updated_at
  `).run(
    scope, project, normTopic, description.trim(), content, tagsJson,
    sessionId ?? null, sessionName ?? null,
    now,  // created_at: ignored on update (ON CONFLICT does not include it)
    now
  );

  return { action: existing ? 'overwritten' : 'created' };
}

/**
 * Append content to an existing atom (read-modify-write, BEGIN IMMEDIATE).
 * Errors if the topic does not exist.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ scope:string, project:string, topic:string, content:string }} opts
 * @returns {string} — full updated content
 */
export function atomAppend(db, { scope, project, topic, content }) {
  const normTopic = normaliseTopic(topic);
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db
      .prepare('SELECT content FROM memory_atom WHERE scope = ? AND project = ? AND topic = ?')
      .get(scope, project, normTopic);
    if (!row) {
      db.exec('ROLLBACK');
      throw new Error(`Atom '${normTopic}' does not exist — use memory_atom_write to create it first`);
    }
    const updated = row.content + '\n---\n' + content;
    db.prepare(`
      UPDATE memory_atom SET content = ?, updated_at = ?
      WHERE scope = ? AND project = ? AND topic = ?
    `).run(updated, Date.now(), scope, project, normTopic);
    db.exec('COMMIT');
    return updated;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/**
 * Get an atom by topic, with cross-workspace awareness.
 *
 * Priority: current workspace (scope, project) → global (scope='global', project='').
 * Also returns a listing of atoms at the same topic in other workspaces.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ scope:string, project:string, topic:string }} opts
 * @returns {{ match: object|null, alsoIn: object[] }}
 */
export function atomGet(db, { scope, project, topic }) {
  const normTopic = normaliseTopic(topic);

  // Priority resolution: workspace first, global fallback
  let match = db
    .prepare(
      `SELECT scope, project, topic, description, content, tags, updated_at
       FROM memory_atom
       WHERE scope = ? AND project = ? AND topic = ?`
    )
    .get(scope, project, normTopic);

  if (!match && scope !== 'global') {
    match = db
      .prepare(
        `SELECT scope, project, topic, description, content, tags, updated_at
         FROM memory_atom
         WHERE scope = 'global' AND project = '' AND topic = ?`
      )
      .get(normTopic) ?? null;
  }

  // Other-workspace atoms with the same topic (not the matched one)
  let alsoIn = db
    .prepare(
      `SELECT scope, project, topic, description, substr(content, 1, 80) AS preview, updated_at
       FROM memory_atom
       WHERE topic = ?
         AND NOT (scope = ? AND project = ?)
         AND (? IS NULL OR NOT (scope = 'global' AND project = ''))
       ORDER BY updated_at DESC`
    )
    .all(normTopic, scope, project, match ? 1 : null);

  // If match was found globally, exclude it from alsoIn
  if (match) {
    alsoIn = alsoIn.filter(
      (r) => !(r.scope === match.scope && r.project === match.project)
    );
  }

  return { match: match ?? null, alsoIn };
}

/**
 * Full-text search atoms.
 *
 * Default: all workspaces. scope='workspace' restricts to current project+global.
 * scope='global' restricts to global only.
 * Falls back to LIKE scan if FTS5 MATCH throws.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ scope:string, project:string, query:string, limit?:number }} opts
 * @returns {object[]}
 */
export function atomSearch(db, { scope, project, query, limit = 20 }) {
  const cap = Math.max(1, Math.min(200, Number(limit) || 20));

  const buildFtsQuery = (whereClause) => `
    SELECT a.scope, a.project, a.topic, a.description,
           substr(a.content, 1, 80) AS preview, a.updated_at
    FROM memory_atom a
    JOIN memory_atom_fts fts ON fts.rowid = a.id
    WHERE fts.memory_atom_fts MATCH ?
      ${whereClause}
    ORDER BY rank
    LIMIT ?
  `;

  const buildLikeQuery = (whereClause) => `
    SELECT scope, project, topic, description,
           substr(content, 1, 80) AS preview, updated_at
    FROM memory_atom
    WHERE (topic LIKE ? OR description LIKE ? OR content LIKE ?)
      ${whereClause}
    ORDER BY updated_at DESC
    LIMIT ?
  `;

  try {
    if (scope === 'workspace') {
      return db.prepare(buildFtsQuery(`AND ((a.scope = ? AND a.project = ?) OR (a.scope = 'global' AND a.project = ''))`))
        .all(query, project, '', cap);
    } else if (scope === 'global') {
      return db.prepare(buildFtsQuery(`AND a.scope = 'global' AND a.project = ''`))
        .all(query, cap);
    } else {
      return db.prepare(buildFtsQuery('')).all(query, cap);
    }
  } catch {
    // FTS5 unavailable or query error — fall back to LIKE scan
    const likePattern = `%${query}%`;
    if (scope === 'workspace') {
      return db.prepare(buildLikeQuery(
        `AND ((scope = ? AND project = ?) OR (scope = 'global' AND project = ''))`
      ).replace(/a\./g, '')).all(likePattern, likePattern, likePattern, project, '', cap);
    } else if (scope === 'global') {
      return db.prepare(buildLikeQuery(`AND scope = 'global' AND project = ''`).replace(/a\./g, ''))
        .all(likePattern, likePattern, likePattern, cap);
    } else {
      return db.prepare(buildLikeQuery('').replace(/a\./g, ''))
        .all(likePattern, likePattern, likePattern, cap);
    }
  }
}

/**
 * List atoms by topic prefix.
 * Default: current workspace + global. scope='all' returns all workspaces.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ scope:string, project:string, prefix?:string }} opts
 * @returns {object[]}
 */
export function atomList(db, { scope, project, prefix }) {
  const normPrefix = prefix ? normaliseTopic(prefix) : '';
  const likePattern = normPrefix ? `${normPrefix}%` : '%';

  if (scope === 'all') {
    return db.prepare(`
      SELECT scope, project, topic, description,
             substr(content, 1, 80) AS preview, updated_at
      FROM memory_atom
      WHERE topic LIKE ?
      ORDER BY scope, project, topic
    `).all(likePattern);
  }

  // Default: current workspace + global
  return db.prepare(`
    SELECT scope, project, topic, description,
           substr(content, 1, 80) AS preview, updated_at
    FROM memory_atom
    WHERE topic LIKE ?
      AND ((scope = ? AND project = ?) OR (scope = 'global' AND project = ''))
    ORDER BY scope, project, topic
  `).all(likePattern, scope, project);
}

/**
 * Delete an atom by topic.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ scope:string, project:string, topic:string }} opts
 * @returns {{ deleted: number }}
 */
export function atomDelete(db, { scope, project, topic }) {
  const normTopic = normaliseTopic(topic);
  const row = db
    .prepare('SELECT id FROM memory_atom WHERE scope = ? AND project = ? AND topic = ?')
    .get(scope, project, normTopic);
  if (!row) {
    throw new Error(`Atom '${normTopic}' not found`);
  }
  const result = db
    .prepare('DELETE FROM memory_atom WHERE scope = ? AND project = ? AND topic = ?')
    .run(scope, project, normTopic);
  return { deleted: result.changes };
}

// ── FTS5 integrity-check helper (for tests) ───────────────────────────────────

/**
 * Run the FTS5 integrity check. Throws if the FTS index is corrupt or unavailable.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function checkFtsIntegrity(db) {
  db.prepare("INSERT INTO memory_atom_fts(memory_atom_fts) VALUES('integrity-check')").run();
}
