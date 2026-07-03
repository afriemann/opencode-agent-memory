// src/lib/schema.js — idempotent schema creation for agent-memory.db.
//
// Called by memory.js (sole writer) on init and on every CLI invocation that
// opens the DB. All tables are created with CREATE TABLE IF NOT EXISTS so
// this is safe to call multiple times. The CLI is the only process that ever
// calls this; the plugin never opens the DB directly.

/**
 * Create all agent-memory tables and indexes if they do not already exist.
 * Safe to call repeatedly (idempotent).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hot_state (
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
  `);
}
