// src/lib/signal-utils.js — primer assembly and signal reduction helpers.
//
// Extracted from plugin.js so the plugin module exports only the AgentMemory
// factory. opencode iterates all named exports and calls each as a factory;
// keeping utility functions here prevents them from being invoked at load time.

import { renderStaleness } from './git-helper.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_SIGNALS_PER_KIND = 20;

// ── Time formatting ──────────────────────────────────────────────────────────

/**
 * Format a timestamp (ms since epoch) as a human-readable relative time.
 *
 * @param {number} updatedAt — epoch ms
 * @param {number} [now] — reference epoch ms (default: Date.now())
 * @returns {'just now'|'<N>m ago'|'<N>h ago'|'yesterday'|'<N> days ago'}
 */
export function formatRelativeTime(updatedAt, now = Date.now()) {
  const diffMs = now - updatedAt;
  if (diffMs < 0) return 'just now';

  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';

  const diffMin = Math.floor(diffMs / (60 * 1000));
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHour = Math.floor(diffMs / (60 * 60 * 1000));
  if (diffHour < 24) return `${diffHour}h ago`;

  const diffDay = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (diffDay === 1) return 'yesterday';

  return `${diffDay} days ago`;
}

// ── Primer assembly ──────────────────────────────────────────────────────────

/** Return the last two path segments of an absolute path for display. */
export function lastTwoSegments(absPath) {
  if (!absPath) return String(absPath);
  const parts = absPath.replace(/\/+$/, '').split('/');
  return parts.slice(-2).join('/');
}

/**
 * Assemble the memory primer text injected at session start.
 *
 * Supports multi-row session threads and atom directory sections.
 *
 * @param {object} opts
 * @param {object[]|null} opts.rows — hot_state rows for recent sessions (may be null/empty)
 * @param {object[]} opts.projectAtoms — atom directory for current workspace (may be empty)
 * @param {object[]} opts.globalAtoms — atom directory for global scope (may be empty)
 * @param {string} opts.agent — e.g. 'engineer'
 * @param {string} opts.project — full abs path (stored key)
 * @param {{ status:string, distance?:number }} opts.staleness
 * @param {number} [opts.cap] — max atoms per section (default 40)
 * @returns {string|null} — null when both rows and all atoms are empty
 */
export function assemblePrimer({ rows, projectAtoms, globalAtoms, agent, project, staleness, cap = 40 }) {
  const displayProject = lastTwoSegments(project);
  const hasRows = Array.isArray(rows) && rows.length > 0;
  const hasProjectAtoms = Array.isArray(projectAtoms) && projectAtoms.length > 0;
  const hasGlobalAtoms = Array.isArray(globalAtoms) && globalAtoms.length > 0;

  if (!hasRows && !hasProjectAtoms && !hasGlobalAtoms) return null;

  const now = Date.now();
  const stalenessLine = renderStaleness(staleness);

  const lines = [
    `## Project memory — ${displayProject} (background context — no action required)`,
    '',
    "This is a snapshot from your last session. Wait for the user's request before taking any action.",
    '',
  ];

  // ── Recent session threads ──────────────────────────────────────────────────
  if (hasRows) {
    lines.push('### Recent sessions');
    lines.push('');
    for (const row of rows) {
      const label = row.session_name || (row.session_id ? row.session_id.slice(0, 8) : 'unknown');
      const relTime = row.updated_at ? formatRelativeTime(row.updated_at, now) : '';
      const summary = row.last_worked_summary ?? '';
      const nextAction = row.next_action ?? '';
      const questions = Array.isArray(row.open_questions)
        ? row.open_questions
        : [];

      lines.push(`▸ ${label} — ${relTime}`);
      if (summary) lines.push(`  Last: ${summary}`);
      if (nextAction) lines.push(`  Next: ${nextAction}`);
      if (questions.length > 0) {
        lines.push(`  Open questions: ${questions.join('; ')}`);
      }
      lines.push('');
    }
  }

  // ── Project atom directory ──────────────────────────────────────────────────
  lines.push('### Project atoms — search: memory_atom_search · fetch: memory_atom_get');
  lines.push('');
  if (hasProjectAtoms) {
    lines.push('Fetch atoms on demand when relevant — do not pre-fetch at session start.');
    lines.push('');
    const display = projectAtoms.slice(0, cap);
    for (const atom of display) {
      const preview = atom.preview ? String(atom.preview).slice(0, 80) : '';
      const relTime = atom.updated_at ? formatRelativeTime(atom.updated_at, now) : '';
      lines.push(`• ${atom.topic} — ${atom.description}${preview ? ` | ${preview}` : ''} (${relTime})`);
    }
    if (projectAtoms.length > cap) {
      lines.push(`+ ${projectAtoms.length - cap} more`);
    }
  } else {
    lines.push('No project atoms yet.');
  }
  lines.push('');

  // ── Global atom directory ───────────────────────────────────────────────────
  lines.push('### Global atoms');
  lines.push('');
  if (hasGlobalAtoms) {
    lines.push('Fetch atoms on demand when relevant — do not pre-fetch at session start.');
    lines.push('');
    const display = globalAtoms.slice(0, cap);
    for (const atom of display) {
      const preview = atom.preview ? String(atom.preview).slice(0, 80) : '';
      const relTime = atom.updated_at ? formatRelativeTime(atom.updated_at, now) : '';
      lines.push(`• ${atom.topic} — ${atom.description}${preview ? ` | ${preview}` : ''} (${relTime})`);
    }
    if (globalAtoms.length > cap) {
      lines.push(`+ ${globalAtoms.length - cap} more`);
    }
  } else {
    lines.push('No global atoms yet.');
  }
  lines.push('');

  lines.push(`Staleness: ${stalenessLine}`);

  return lines.join('\n');
}

// ── Signal reduction (D2) ────────────────────────────────────────────────────

/**
 * Reduce signals per Addendum D2:
 * - Dedup 'file' signals by path (keep the latest entry per path).
 * - Cap each kind ('file', 'todo', 'message') to the N most recent.
 *
 * @param {Array<{kind:string, payload:string, created_at?:number}>} signals
 * @returns {Array}
 */
export function reduceSignals(signals) {
  if (!signals || signals.length === 0) return [];

  const fileMap = new Map(); // path → signal row (latest wins)
  const todos = [];
  const messages = [];

  for (const s of signals) {
    if (s.kind === 'file') {
      fileMap.set(s.payload, s);
    } else if (s.kind === 'todo') {
      todos.push(s);
    } else if (s.kind === 'message') {
      messages.push(s);
    }
  }

  // Sort by created_at ASC so slice(-N) picks the N most recently edited files.
  // Without this sort, Map's insertion-order means a re-edited file that was
  // first-seen early would be sliced off before newer-first-seen files (W1 fix).
  const sortedFiles = [...fileMap.values()]
    .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));

  return [
    ...sortedFiles.slice(-MAX_SIGNALS_PER_KIND),
    ...todos.slice(-MAX_SIGNALS_PER_KIND),
    ...messages.slice(-MAX_SIGNALS_PER_KIND),
  ];
}
