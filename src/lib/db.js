// src/lib/db.js — open agent-memory.db with the standard safety pragmas.
//
// Used exclusively by memory.js (the sole DB writer). The plugin never calls
// this module directly.

import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const DEFAULT_DB = join(homedir(), '.local', 'share', 'opencode', 'agent-memory.db');

/**
 * Open (or create) the agent-memory SQLite database.
 *
 * Respects the AGENT_MEMORY_DB environment variable; falls back to
 * ~/.local/share/opencode/agent-memory.db.
 *
 * @param {string} [path] — override path (used in tests)
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function openDb(path) {
  const dbPath = path ?? process.env.AGENT_MEMORY_DB ?? DEFAULT_DB;

  // Ensure parent directory exists (first run on a fresh machine).
  const dir = dirname(dbPath);
  if (dir) mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(dbPath);
  // WAL mode allows concurrent readers even during a write (multiple CLI processes).
  db.exec('PRAGMA journal_mode = WAL;');
  // Wait up to 5 s for a write lock instead of failing immediately.
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}
