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
//
// Schema version 3 changes:
//   - memory_atom: new column pinned INTEGER NOT NULL DEFAULT 0.
//   - PRAGMA user_version = 3 marks migration complete.
//
// Schema version 4 changes:
//   - memory_atom: new column status TEXT NOT NULL DEFAULT 'active'
//     CHECK(status IN ('active', 'resolved', 'deprecated')).
//   - PRAGMA user_version = 4 marks migration complete.
//
// Schema version 5 changes:
//   - hot_state: new nullable columns distil_cost_usd REAL,
//     distil_tokens_in INTEGER, distil_tokens_out INTEGER.
//   - PRAGMA user_version = 5 marks migration complete.
//
// Schema version 6 changes:
//   - memory_atom: new column always_include INTEGER NOT NULL DEFAULT 0.
//     When 1, the atom's full content is injected into the session primer's
//     Standing context section instead of appearing as a compact directory line.
//   - PRAGMA user_version = 6 marks migration complete.

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
      distil_cost_usd     REAL,
      distil_tokens_in    INTEGER,
      distil_tokens_out   INTEGER,
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
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      scope          TEXT    NOT NULL DEFAULT 'project',
      project        TEXT    NOT NULL DEFAULT '',
      topic          TEXT    NOT NULL,
      description    TEXT    NOT NULL DEFAULT '',
      content        TEXT    NOT NULL DEFAULT '',
      tags           TEXT    NOT NULL DEFAULT '[]',
      pinned         INTEGER NOT NULL DEFAULT 0,
      always_include INTEGER NOT NULL DEFAULT 0,
      status         TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'resolved', 'deprecated')),
      session_id     TEXT,
      session_name   TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
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

  // ── Phase 3: migration to schema version 3 ───────────────────────────────
  //   Gate: PRAGMA user_version < 3 AND pinned column absent (shape probe)
  //   ALTER TABLE ADD COLUMN is not idempotent in SQLite (no IF NOT EXISTS),
  //   so the column-existence probe prevents a duplicate-column error on re-run.
  const versionAfterV2 = db.prepare('PRAGMA user_version').get()?.user_version ?? 0;
  if (versionAfterV2 < 3) {
    const atomCols = db.prepare("PRAGMA table_info(memory_atom)").all().map((c) => c.name);
    if (!atomCols.includes('pinned')) {
      db.exec('BEGIN');
      try {
        db.exec('ALTER TABLE memory_atom ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
        db.exec('PRAGMA user_version = 3');
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    } else {
      // pinned already present — just bump the version marker
      db.exec('PRAGMA user_version = 3');
    }
  }

  // ── Phase 4: migration to schema version 4 ───────────────────────────────
  //   Gate: PRAGMA user_version < 4 AND status column absent (shape probe)
  //   SQLite supports CHECK on ALTER TABLE ADD COLUMN (validates existing rows;
  //   the DEFAULT 'active' ensures all existing rows pass the constraint).
  const versionAfterV3 = db.prepare('PRAGMA user_version').get()?.user_version ?? 0;
  if (versionAfterV3 < 4) {
    const atomCols4 = db.prepare("PRAGMA table_info(memory_atom)").all().map((c) => c.name);
    if (!atomCols4.includes('status')) {
      db.exec('BEGIN');
      try {
        db.exec(`ALTER TABLE memory_atom ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'resolved', 'deprecated'))`);
        db.exec('PRAGMA user_version = 4');
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    } else {
      // status already present — just bump the version marker
      db.exec('PRAGMA user_version = 4');
    }
  }

  // ── Phase 5: migration to schema version 5 ───────────────────────────────
  //   Gate: PRAGMA user_version < 5 AND distil_cost_usd column absent (shape probe)
  //   Three nullable columns added to hot_state for per-distil cost tracking.
  //   Each column is added only when absent (idempotent under repeated calls).
  const versionAfterV4 = db.prepare('PRAGMA user_version').get()?.user_version ?? 0;
  if (versionAfterV4 < 5) {
    const hotStateCols5 = db.prepare("PRAGMA table_info(hot_state)").all().map((c) => c.name);
    const needsCostCols = !hotStateCols5.includes('distil_cost_usd') ||
                          !hotStateCols5.includes('distil_tokens_in') ||
                          !hotStateCols5.includes('distil_tokens_out');
    if (needsCostCols) {
      db.exec('BEGIN');
      try {
        if (!hotStateCols5.includes('distil_cost_usd')) {
          db.exec('ALTER TABLE hot_state ADD COLUMN distil_cost_usd REAL');
        }
        if (!hotStateCols5.includes('distil_tokens_in')) {
          db.exec('ALTER TABLE hot_state ADD COLUMN distil_tokens_in INTEGER');
        }
        if (!hotStateCols5.includes('distil_tokens_out')) {
          db.exec('ALTER TABLE hot_state ADD COLUMN distil_tokens_out INTEGER');
        }
        db.exec('PRAGMA user_version = 5');
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    } else {
      // All cost columns already present — just bump the version marker
      db.exec('PRAGMA user_version = 5');
    }
  }

  // ── Phase 6: migration to schema version 6 ───────────────────────────────
  //   Gate: PRAGMA user_version < 6 AND always_include column absent (shape probe)
  //   always_include mirrors the pinned precedent: added via ALTER TABLE ADD COLUMN,
  //   idempotent under repeated calls via column-existence probe.
  const versionAfterV5 = db.prepare('PRAGMA user_version').get()?.user_version ?? 0;
  if (versionAfterV5 < 6) {
    const atomCols6 = db.prepare("PRAGMA table_info(memory_atom)").all().map((c) => c.name);
    if (!atomCols6.includes('always_include')) {
      db.exec('BEGIN');
      try {
        db.exec('ALTER TABLE memory_atom ADD COLUMN always_include INTEGER NOT NULL DEFAULT 0');
        db.exec('PRAGMA user_version = 6');
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    } else {
      // always_include already present — just bump the version marker
      db.exec('PRAGMA user_version = 6');
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
 *            pinned?:boolean, alwaysInclude?:boolean,
 *            sessionId?:string, sessionName?:string,
 *            createdAt?:number }} opts
 * @returns {{ action: 'created'|'overwritten' }}
 */
export function atomWrite(db, { scope, project, topic, content, description, tags, pinned, alwaysInclude, sessionId, sessionName, createdAt }) {
  const normTopic = normaliseTopic(topic);
  if (!description || typeof description !== 'string' || !description.trim()) {
    throw new Error('Atom description is required and must be a non-empty string');
  }
  const tagsJson = Array.isArray(tags)
    ? JSON.stringify(tags)
    : (typeof tags === 'string' ? tags : '[]');
  const now = Date.now();
  // Use caller-supplied creation timestamp when provided; ignored on update (ON CONFLICT
  // does not include created_at), so it only affects the initial INSERT row.
  const insertCreatedAt = typeof createdAt === 'number' ? createdAt : now;
  // pinned and always_include are INSERT-only: set on first insert, never overwritten
  // by a content update. Both flags must be changed via atomPatch to prevent silent
  // state loss on re-write.
  const pinnedValue = pinned ? 1 : 0;
  const alwaysIncludeValue = alwaysInclude ? 1 : 0;

  // Check existence before upsert to report created vs overwritten
  const existing = db
    .prepare('SELECT id FROM memory_atom WHERE scope = ? AND project = ? AND topic = ?')
    .get(scope, project, normTopic);

  db.prepare(`
    INSERT INTO memory_atom
      (scope, project, topic, description, content, tags, pinned, always_include, session_id, session_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope, project, topic) DO UPDATE SET
      description  = excluded.description,
      content      = excluded.content,
      tags         = excluded.tags,
      session_id   = excluded.session_id,
      session_name = excluded.session_name,
      updated_at   = excluded.updated_at
  `).run(
    scope, project, normTopic, description.trim(), content, tagsJson, pinnedValue, alwaysIncludeValue,
    sessionId ?? null, sessionName ?? null,
    insertCreatedAt,
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
 * Partial, content-preserving metadata update for an existing atom.
 *
 * Patches one or more of description, tags, created_at, pinned, always_include, status in-place.
 * - Absent fields are left unchanged.
 * - tags:[] clears tags; omitted tags keeps existing tags.
 * - updated_at is bumped when description, tags, pinned, always_include, or status is present.
 * - created_at-only patch leaves updated_at unchanged.
 * - status must be one of 'active', 'resolved', 'deprecated'.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ scope:string, project:string, topic:string,
 *            patch: { description?:string, tags?:string[], created_at?:number,
 *                     pinned?:boolean, always_include?:boolean, status?:string } }} opts
 * @returns {{ patched: string[] }}
 */
export function atomPatch(db, { scope, project, topic, patch }) {
  const normTopic = normaliseTopic(topic);
  const PATCHABLE = ['description', 'tags', 'created_at', 'pinned', 'always_include', 'status'];
  const present = PATCHABLE.filter((f) => f in patch);
  if (present.length === 0) {
    throw new Error('at least one of description, tags, created_at, pinned, always_include, status is required');
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db
      .prepare('SELECT id, updated_at FROM memory_atom WHERE scope = ? AND project = ? AND topic = ?')
      .get(scope, project, normTopic);
    if (!row) {
      db.exec('ROLLBACK');
      throw new Error(`Atom '${normTopic}' does not exist`);
    }

    if ('description' in patch) {
      const trimmed = typeof patch.description === 'string' ? patch.description.trim() : '';
      if (!trimmed) {
        db.exec('ROLLBACK');
        throw new Error('Atom description must be a non-empty string');
      }
    }

    if ('status' in patch) {
      const VALID_STATUSES = ['active', 'resolved', 'deprecated'];
      if (!VALID_STATUSES.includes(patch.status)) {
        db.exec('ROLLBACK');
        throw new Error(`Atom status must be one of: ${VALID_STATUSES.join(', ')}`);
      }
    }

    const setClauses = [];
    const values = [];

    if ('description' in patch) {
      setClauses.push('description = ?');
      values.push(patch.description.trim());
    }
    if ('tags' in patch) {
      setClauses.push('tags = ?');
      values.push(Array.isArray(patch.tags) ? JSON.stringify(patch.tags) : '[]');
    }
    if ('created_at' in patch) {
      setClauses.push('created_at = ?');
      values.push(patch.created_at);
    }
    if ('pinned' in patch) {
      setClauses.push('pinned = ?');
      values.push(patch.pinned ? 1 : 0);
    }
    if ('always_include' in patch) {
      setClauses.push('always_include = ?');
      values.push(patch.always_include ? 1 : 0);
    }
    if ('status' in patch) {
      setClauses.push('status = ?');
      values.push(patch.status);
    }

    const bumpUpdatedAt = ('description' in patch) || ('tags' in patch) || ('pinned' in patch) || ('always_include' in patch) || ('status' in patch);
    if (bumpUpdatedAt) {
      setClauses.push('updated_at = ?');
      values.push(Date.now());
    }

    values.push(scope, project, normTopic);
    db.prepare(
      `UPDATE memory_atom SET ${setClauses.join(', ')} WHERE scope = ? AND project = ? AND topic = ?`
    ).run(...values);

    db.exec('COMMIT');
    return { patched: present };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/**
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
      `SELECT scope, project, topic, description, content, tags, status, created_at, updated_at
       FROM memory_atom
       WHERE scope = ? AND project = ? AND topic = ?`
    )
    .get(scope, project, normTopic);

  if (!match && scope !== 'global') {
    match = db
      .prepare(
        `SELECT scope, project, topic, description, content, tags, status, created_at, updated_at
         FROM memory_atom
         WHERE scope = 'global' AND project = '' AND topic = ?`
      )
      .get(normTopic) ?? null;
  }

  // Other-workspace atoms with the same topic (not the matched one)
  let alsoIn = db
    .prepare(
      `SELECT scope, project, topic, description, substr(content, 1, 80) AS preview, status, created_at, updated_at
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
 * Status filter precedence (D4): status exact-match wins → includeDeprecated (all) →
 * default IN ('active','resolved').
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ scope:string, project:string, query:string, limit?:number,
 *            status?:string, includeDeprecated?:boolean }} opts
 * @returns {object[]}
 */
export function atomSearch(db, { scope, project, query, limit = 20, status, includeDeprecated }) {
  const cap = Math.max(1, Math.min(200, Number(limit) || 20));

  const statusArgs = status ? [status] : [];
  const statusClauseFts = status
    ? `AND a.status = ?`
    : includeDeprecated ? '' : `AND a.status IN ('active', 'resolved')`;
  const statusClausePlain = status
    ? `AND status = ?`
    : includeDeprecated ? '' : `AND status IN ('active', 'resolved')`;

  const buildFtsQuery = (whereClause) => `
    SELECT a.scope, a.project, a.topic, a.description,
           substr(a.content, 1, 80) AS preview, a.status, a.created_at, a.updated_at
    FROM memory_atom a
    JOIN memory_atom_fts fts ON fts.rowid = a.id
    WHERE fts.memory_atom_fts MATCH ?
      ${whereClause}
      ${statusClauseFts}
    ORDER BY rank
    LIMIT ?
  `;

  const buildLikeQuery = (whereClause) => `
    SELECT scope, project, topic, description,
           substr(content, 1, 80) AS preview, status, created_at, updated_at
    FROM memory_atom
    WHERE (topic LIKE ? OR description LIKE ? OR content LIKE ?)
      ${whereClause}
      ${statusClausePlain}
    ORDER BY updated_at DESC
    LIMIT ?
  `;

  try {
    if (scope === 'workspace' || scope === 'project') {
      return db.prepare(buildFtsQuery(`AND ((a.scope = ? AND a.project = ?) OR (a.scope = 'global' AND a.project = ''))`))
        .all(query, scope, project, ...statusArgs, cap);
    } else if (scope === 'global') {
      return db.prepare(buildFtsQuery(`AND a.scope = 'global' AND a.project = ''`))
        .all(query, ...statusArgs, cap);
    } else {
      return db.prepare(buildFtsQuery('')).all(query, ...statusArgs, cap);
    }
  } catch {
    // FTS5 unavailable or query error — fall back to LIKE scan
    const likePattern = `%${query}%`;
    if (scope === 'workspace' || scope === 'project') {
      return db.prepare(buildLikeQuery(
        `AND ((scope = ? AND project = ?) OR (scope = 'global' AND project = ''))`
      )).all(likePattern, likePattern, likePattern, scope, project, ...statusArgs, cap);
    } else if (scope === 'global') {
      return db.prepare(buildLikeQuery(`AND scope = 'global' AND project = ''`))
        .all(likePattern, likePattern, likePattern, ...statusArgs, cap);
    } else {
      return db.prepare(buildLikeQuery(''))
        .all(likePattern, likePattern, likePattern, ...statusArgs, cap);
    }
  }
}

/**
 * List atoms by topic prefix.
 * Default: current workspace + global. scope='all' returns all workspaces.
 *
 * Status filter precedence (D4): status exact-match wins → includeDeprecated (all) →
 * default IN ('active','resolved').
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ scope:string, project:string, prefix?:string,
 *            status?:string, includeDeprecated?:boolean }} opts
 * @returns {object[]}
 */
export function atomList(db, { scope, project, prefix, status, includeDeprecated }) {
  const normPrefix = prefix ? normaliseTopic(prefix) : '';
  const likePattern = normPrefix ? `${normPrefix}%` : '%';

  const statusArgs = status ? [status] : [];
  const statusClause = status
    ? `AND status = ?`
    : includeDeprecated ? '' : `AND status IN ('active', 'resolved')`;

  if (scope === 'all') {
    return db.prepare(`
      SELECT scope, project, topic, description,
             substr(content, 1, 80) AS preview, pinned, always_include, status, created_at, updated_at
      FROM memory_atom
      WHERE topic LIKE ?
        ${statusClause}
      ORDER BY pinned DESC, scope, project, topic
    `).all(likePattern, ...statusArgs);
  }

  // Default: current workspace + global
  return db.prepare(`
    SELECT scope, project, topic, description,
           substr(content, 1, 80) AS preview, pinned, always_include, status, created_at, updated_at
    FROM memory_atom
    WHERE topic LIKE ?
      AND ((scope = ? AND project = ?) OR (scope = 'global' AND project = ''))
      ${statusClause}
    ORDER BY pinned DESC, scope, project, topic
  `).all(likePattern, scope, project, ...statusArgs);
}

/**
 * Return full content for all active atoms that have always_include = 1.
 *
 * Scope semantics:
 *   - 'project' (or 'workspace'): current workspace atoms + global atoms
 *   - 'global': global-only atoms
 *   - 'all': all workspaces
 *
 * Results are ordered by updated_at DESC (for cap selection in the caller),
 * with topic ASC as a tiebreaker. The caller (assemblePrimer) takes the top N
 * by updated_at and then re-sorts those N alphabetically for stable render order.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ scope:string, project:string }} opts
 * @returns {object[]} — rows with scope, project, topic, description, content, updated_at
 */
export function atomListFull(db, { scope, project }) {
  if (scope === 'all') {
    return db.prepare(`
      SELECT scope, project, topic, description, content, updated_at
      FROM memory_atom
      WHERE always_include = 1 AND status = 'active'
      ORDER BY updated_at DESC, topic ASC
    `).all();
  }
  if (scope === 'global') {
    return db.prepare(`
      SELECT scope, project, topic, description, content, updated_at
      FROM memory_atom
      WHERE always_include = 1 AND status = 'active'
        AND scope = 'global' AND project = ''
      ORDER BY updated_at DESC, topic ASC
    `).all();
  }
  // Default: current workspace + global
  return db.prepare(`
    SELECT scope, project, topic, description, content, updated_at
    FROM memory_atom
    WHERE always_include = 1 AND status = 'active'
      AND ((scope = ? AND project = ?) OR (scope = 'global' AND project = ''))
    ORDER BY updated_at DESC, topic ASC
  `).all(scope, project);
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
