// src/lib/signal-utils.js — primer assembly and signal reduction helpers.
//
// Extracted from plugin.js so the plugin module exports only the AgentMemory
// factory. opencode iterates all named exports and calls each as a factory;
// keeping utility functions here prevents them from being invoked at load time.

import { renderStaleness } from './git-helper.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_SIGNALS_PER_KIND = 20;

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
 * @param {object} prior — hot_state row with open_questions as an array
 * @param {string} agent — e.g. 'engineer'
 * @param {string} project — full abs path (stored key)
 * @param {{ status:string, distance?:number }} staleness
 * @returns {string}
 */
export function assemblePrimer(prior, agent, project, staleness) {
  const displayProject = lastTwoSegments(project);
  const summary = prior.last_worked_summary ?? '';
  const nextAction = prior.next_action ?? '';
  const questions = Array.isArray(prior.open_questions)
    ? prior.open_questions
    : [];
  const adrCandidate = prior.adr_candidate || null;
  const stalenessLine = renderStaleness(staleness);

  const lines = [
    `## Project memory — ${displayProject} (background context — no action required)`,
    '',
    "This is a snapshot from your last session. Wait for the user's request before taking any action.",
    '',
    `Last session: ${summary}`,
    '',
    `Suggested next step: ${nextAction}`,
    '',
  ];

  if (questions.length > 0) {
    lines.push('Open questions:');
    for (const q of questions) lines.push(`- ${q}`);
  } else {
    lines.push('Open questions: none');
  }
  lines.push('');

  if (adrCandidate) {
    lines.push(
      `Possible decision to record: ${adrCandidate} — if confirmed, capture it as an ADR under docs/adr/ (see the ADR convention).`
    );
    lines.push('');
  }

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
