// src/lib/signal-utils.js — primer assembly and signal reduction helpers.
//
// Extracted from plugin.js so the plugin module exports only the AgentMemory
// factory. opencode iterates all named exports and calls each as a factory;
// keeping utility functions here prevents them from being invoked at load time.

import { renderStaleness } from './git-helper.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_SIGNALS_PER_KIND = 20;

/** Independent cap for agent-turn signals (assistant responses). */
export const MAX_AGENT_SIGNALS = 10;

/**
 * Maximum number of always_include atoms rendered per scope in Standing context.
 * Enforced at render time; atoms beyond the cap are named in an overflow note.
 */
export const MAX_STANDING_ATOMS = 5;

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
 * Render a single atom directory entry line.
 *
 * @param {object} atom — atom row with topic, description, preview, updated_at
 * @param {number} now — reference epoch ms
 * @param {{ pinned?: boolean }} [opts]
 * @returns {string}
 */
function renderAtomLine(atom, now, { pinned = false } = {}) {
  const rawPreview = atom.preview ? String(atom.preview).replace(/[\r\n]+/g, ' ') : '';
  let preview = rawPreview.slice(0, 80);
  // Close any unclosed inline-code span so truncation doesn't corrupt downstream markdown.
  if ((preview.match(/`/g) ?? []).length % 2 !== 0) preview += '`';
  const relTime = atom.updated_at ? formatRelativeTime(atom.updated_at, now) : '';
  const contentPart = preview ? ` — ${preview}…` : '';
  const prefix = pinned ? '[pinned] ' : '';
  return `${prefix}${atom.topic} [${relTime}] — "${atom.description}"${contentPart}`;
}

/**
 * Assemble the memory primer text injected at session start.
 *
 * Supports multi-row session threads, a Standing context section for
 * always_include atoms, and atom directory sections.
 *
 * @param {object} opts
 * @param {object[]|null} opts.rows — hot_state rows for recent sessions (may be null/empty)
 * @param {object[]} opts.projectAtoms — atom directory for current workspace (may be empty)
 * @param {object[]} opts.globalAtoms — atom directory for global scope (may be empty)
 * @param {object[]} [opts.standingAtoms] — atoms with always_include=1; full content injected
 * @param {object[]} [opts.crossProjectRows] — other projects active in last 24h (may be empty)
 * @param {string} opts.agent — e.g. 'engineer'
 * @param {string} opts.project — full abs path (stored key)
 * @param {string|null} [opts.homeDir] — home directory for relative-path rendering (e.g. '/home/user')
 * @param {{ status:string, distance?:number }} opts.staleness
 * @param {number} [opts.cap] — max atoms per compact directory section (default 40)
 * @returns {string|null} — null when both rows and all atoms are empty
 */
export function assemblePrimer({ rows, projectAtoms, globalAtoms, standingAtoms = [], crossProjectRows = [], agent, project, homeDir = null, staleness, cap = 40 }) {
  const displayProject = lastTwoSegments(project);
  const hasRows = Array.isArray(rows) && rows.length > 0;

  // Active-only filter applied once here; all section rendering uses these filtered arrays.
  // Project section: exclude global atoms (scope='global') so they only appear in the Global section.
  // Global atoms are included in the atomList(scope='project') query by design (workspace+global),
  // but the primer must keep them separated to avoid duplication and mislabelling.
  const activeProjectAtoms = (Array.isArray(projectAtoms) ? projectAtoms : [])
    .filter((a) => a.scope !== 'global')
    .filter((a) => !a.status || a.status === 'active');
  const activeGlobalAtoms = (Array.isArray(globalAtoms) ? globalAtoms : []).filter((a) => !a.status || a.status === 'active');

  // Partition standing atoms into workspace and global buckets (already active-filtered by query).
  // always_include atoms are excluded from the compact directory entirely.
  // Sort by updated_at DESC so renderStandingBucket correctly selects the N most-recently-updated
  // when slicing. This makes assemblePrimer correct regardless of caller-supplied input order.
  const safeStanding = Array.isArray(standingAtoms) ? standingAtoms : [];
  const sortedStanding = safeStanding.slice().sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  const standingTopics = new Set(sortedStanding.map((a) => `${a.scope}:${a.project ?? ''}:${a.topic}`));

  const compactProjectAtoms = activeProjectAtoms.filter(
    (a) => !standingTopics.has(`${a.scope}:${a.project ?? ''}:${a.topic}`)
  );
  const compactGlobalAtoms = activeGlobalAtoms.filter(
    (a) => !standingTopics.has(`${a.scope}:${a.project ?? ''}:${a.topic}`)
  );

  // Split standing atoms into workspace vs global for section ordering (workspace first).
  const standingWorkspace = sortedStanding.filter((a) => a.scope !== 'global');
  const standingGlobal = sortedStanding.filter((a) => a.scope === 'global');

  const hasStanding = sortedStanding.length > 0;
  const hasCrossProject = Array.isArray(crossProjectRows) && crossProjectRows.length > 0;

  if (!hasRows && compactProjectAtoms.length === 0 && compactGlobalAtoms.length === 0 && !hasStanding && !hasCrossProject) return null;

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
      const label = row.session_name || (row.session_id ? row.session_id.slice(0, 8) : (row.updated_at ? formatRelativeTime(row.updated_at, now) : ''));
      const relTime = row.updated_at ? formatRelativeTime(row.updated_at, now) : '';
      const summary = row.last_worked_summary ?? '';
      const nextAction = row.next_action ?? '';
      const questions = Array.isArray(row.open_questions)
        ? row.open_questions
        : [];

      lines.push(`▸ ${label} — ${relTime}`);
      const hasContent = summary || nextAction || questions.length > 0;
      if (!hasContent) {
        lines.push('  ⚠ Distillation error — no summary recorded');
      } else {
        if (summary) lines.push(`  Last: ${summary}`);
        if (nextAction) lines.push(`  Next: ${nextAction}`);
        if (questions.length > 0) {
          lines.push(`  Open questions: ${questions.join('; ')}`);
        }
      }
      lines.push('');
    }
  }

  // ── Active projects today (cross-project hot_state) ─────────────────────────
  if (hasCrossProject) {
    lines.push('### Active projects today');
    lines.push('');
    for (const row of crossProjectRows) {
      const relPath = homeDir && row.project && row.project.startsWith(homeDir)
        ? '~' + row.project.slice(homeDir.length)
        : (row.project || '');
      const relTime = row.updated_at ? formatRelativeTime(row.updated_at, now) : '';
      const agentLabel = row.agent ? ` — ${row.agent}` : '';
      lines.push(`- ${relPath}${agentLabel} [${relTime}]`);
    }
    lines.push('');
  }

  // ── Standing context (always_include atoms) ─────────────────────────────────
  if (hasStanding) {
    lines.push('### Standing context');
    lines.push('');

    /**
     * Render at most MAX_STANDING_ATOMS from a bucket.
     * Bucket is ordered by updated_at DESC from the query.
     * Take the N most recent, then re-sort those N alphabetically for stable output.
     * Returns the overflow count (0 when all fit).
     */
    function renderStandingBucket(bucket) {
      // Select the N most recently updated atoms (first N in updated_at DESC order).
      const topN = bucket.slice(0, MAX_STANDING_ATOMS);
      // Re-sort the visible slice alphabetically by topic for stable render order.
      const visible = topN.slice().sort((a, b) => a.topic.localeCompare(b.topic));
      const overflow = bucket.length - topN.length;
      for (const atom of visible) {
        const relTime = atom.updated_at ? formatRelativeTime(atom.updated_at, now) : '';
        lines.push(`#### ${atom.topic} [${relTime}]`);
        lines.push(`*"${atom.description}"*`);
        lines.push('');
        lines.push(atom.content);
        lines.push('');
      }
      return overflow;
    }

    if (standingWorkspace.length > 0) {
      const overflow = renderStandingBucket(standingWorkspace);
      if (overflow > 0) {
        const extras = standingWorkspace
          .slice(MAX_STANDING_ATOMS)
          .slice()
          .sort((a, b) => a.topic.localeCompare(b.topic))
          .map((a) => a.topic)
          .join(', ');
        lines.push(`(+${overflow} more standing atom${overflow === 1 ? '' : 's'} exceed the 5-per-scope cap — fetch with memory_atom_get: ${extras})`);
        lines.push('');
      }
    }

    if (standingGlobal.length > 0) {
      const overflow = renderStandingBucket(standingGlobal);
      if (overflow > 0) {
        const extras = standingGlobal
          .slice(MAX_STANDING_ATOMS)
          .slice()
          .sort((a, b) => a.topic.localeCompare(b.topic))
          .map((a) => a.topic)
          .join(', ');
        lines.push(`(+${overflow} more standing atom${overflow === 1 ? '' : 's'} exceed the 5-per-scope cap — fetch with memory_atom_get: ${extras})`);
        lines.push('');
      }
    }
  }

  // ── Project atom directory ──────────────────────────────────────────────────
  lines.push('### Project atoms — search: memory_atom_search · fetch: memory_atom_get');
  lines.push('');
  if (compactProjectAtoms.length > 0) {
    lines.push('Fetch atoms on demand when relevant — do not pre-fetch at session start.');
    lines.push('');
    const pinnedProject = compactProjectAtoms.filter((a) => a.pinned).sort((a, b) => a.topic.localeCompare(b.topic));
    const regularProject = compactProjectAtoms.filter((a) => !a.pinned);
    const visibleProject = regularProject.slice(0, cap);
    for (const atom of pinnedProject) {
      lines.push(renderAtomLine(atom, now, { pinned: true }));
    }
    for (const atom of visibleProject) {
      lines.push(renderAtomLine(atom, now));
    }
    if (regularProject.length > cap) {
      lines.push(`(+${regularProject.length - cap} more — call memory_atom_list to see all)`);
    }
  } else {
    lines.push('No project atoms yet.');
  }
  lines.push('');

  // ── Global atom directory ───────────────────────────────────────────────────
  lines.push('### Global atoms');
  lines.push('');
  if (compactGlobalAtoms.length > 0) {
    lines.push('Fetch atoms on demand when relevant — do not pre-fetch at session start.');
    lines.push('');
    const pinnedGlobal = compactGlobalAtoms.filter((a) => a.pinned).sort((a, b) => a.topic.localeCompare(b.topic));
    const regularGlobal = compactGlobalAtoms.filter((a) => !a.pinned);
    const visibleGlobal = regularGlobal.slice(0, cap);
    for (const atom of pinnedGlobal) {
      lines.push(renderAtomLine(atom, now, { pinned: true }));
    }
    for (const atom of visibleGlobal) {
      lines.push(renderAtomLine(atom, now));
    }
    if (regularGlobal.length > cap) {
      lines.push(`(+${regularGlobal.length - cap} more — call memory_atom_list to see all)`);
    }
  } else {
    lines.push('No global atoms yet.');
  }
  lines.push('');

  if (stalenessLine !== null) {
    lines.push(`Staleness: ${stalenessLine}`);
  }

  return lines.join('\n');
}

// ── Signal reduction (D2) ────────────────────────────────────────────────────

/**
 * Reduce signals per Addendum D2:
 * - Dedup 'file' signals by path (keep the latest entry per path).
 * - Cap each kind ('file', 'todo', 'message') to the N most recent.
 * - Cap 'agent' signals independently at MAX_AGENT_SIGNALS most recent.
 *
 * @param {Array<{kind:string, payload:string, created_at?:number}>} signals
 * @returns {Array}
 */
export function reduceSignals(signals) {
  if (!signals || signals.length === 0) return [];

  const fileMap = new Map(); // path → signal row (latest wins)
  const todos = [];
  const messages = [];
  const agentMessages = [];

  for (const s of signals) {
    if (s.kind === 'file') {
      fileMap.set(s.payload, s);
    } else if (s.kind === 'todo') {
      todos.push(s);
    } else if (s.kind === 'message') {
      messages.push(s);
    } else if (s.kind === 'agent') {
      agentMessages.push(s);
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
    ...agentMessages.slice(-MAX_AGENT_SIGNALS),
  ];
}
