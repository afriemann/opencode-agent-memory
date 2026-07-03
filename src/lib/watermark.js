// src/lib/watermark.js — per-session distil watermark helpers.
//
// CLI-SIDE ONLY. The plugin never imports this module — it receives watermark
// data from `memory.js read` and advances it via `memory.js distil-write`.
// This module is used only inside memory.js.

/**
 * Read the current watermark for a session, or a zero watermark if none exists.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @returns {{ last_signal_ms: number, last_distil_ms: number }}
 */
export function readDistilWatermark(db, sessionId) {
  const row = db
    .prepare(
      'SELECT last_signal_ms, last_distil_ms FROM distil_watermark WHERE session_id = ?'
    )
    .get(sessionId);
  return row ?? { last_signal_ms: 0, last_distil_ms: 0 };
}

/**
 * Advance the watermark for a session.
 * Uses MAX() so the watermark can never go backwards.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sessionId
 * @param {number} lastSignalMs — highest signal created_at folded so far
 * @param {number} lastDistilMs — epoch ms of the completed distil run
 */
export function advanceDistilWatermark(db, sessionId, lastSignalMs, lastDistilMs) {
  db.prepare(`
    INSERT INTO distil_watermark (session_id, last_signal_ms, last_distil_ms)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      last_signal_ms = MAX(last_signal_ms, excluded.last_signal_ms),
      last_distil_ms = MAX(last_distil_ms, excluded.last_distil_ms)
  `).run(sessionId, lastSignalMs ?? 0, lastDistilMs ?? 0);
}
