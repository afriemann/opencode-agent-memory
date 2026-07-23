// test/signal-utils.test.js — formatRelativeTime and assemblePrimer tests.
//
// Covers tasks 8.17–8.18.

import {
  formatRelativeTime,
  assemblePrimer,
  lastTwoSegments,
} from '../src/lib/signal-utils.js';

// ── formatRelativeTime ────────────────────────────────────────────────────────

describe('formatRelativeTime', () => {
  const NOW = 1_700_000_000_000; // fixed reference ms

  test('returns "just now" for timestamps within the last 60 seconds', () => {
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW - 59_999, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW, NOW)).toBe('just now');
  });

  test('returns "Nm ago" for timestamps 1–59 minutes ago', () => {
    expect(formatRelativeTime(NOW - 60_000, NOW)).toBe('1m ago');
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(formatRelativeTime(NOW - 59 * 60_000, NOW)).toBe('59m ago');
  });

  test('returns "Nh ago" for timestamps 1–23 hours ago', () => {
    expect(formatRelativeTime(NOW - 60 * 60_000, NOW)).toBe('1h ago');
    expect(formatRelativeTime(NOW - 3 * 60 * 60_000, NOW)).toBe('3h ago');
    expect(formatRelativeTime(NOW - 23 * 60 * 60_000, NOW)).toBe('23h ago');
  });

  test('returns "yesterday" for exactly 1 day ago', () => {
    expect(formatRelativeTime(NOW - 24 * 60 * 60_000, NOW)).toBe('yesterday');
  });

  test('returns "N days ago" for 2+ days ago', () => {
    expect(formatRelativeTime(NOW - 2 * 24 * 60 * 60_000, NOW)).toBe('2 days ago');
    expect(formatRelativeTime(NOW - 30 * 24 * 60 * 60_000, NOW)).toBe('30 days ago');
  });
});

// ── assemblePrimer ─────────────────────────────────────────────────────────────

describe('assemblePrimer', () => {
  const PROJECT = '/home/user/repos/my/project';
  const NOW = Date.now();

  const WARM_ROW = {
    session_id: 'ses-abc123',
    session_name: 'My coding session',
    last_worked_summary: 'Implemented the widget factory',
    next_action: 'Write tests for widget',
    open_questions: ['Should we use SQLite?'],
    updated_at: NOW - 5 * 60_000, // 5 minutes ago
  };

  const PROJECT_ATOM = {
    topic: 'arch/database',
    description: 'DB design decisions',
    preview: 'Using SQLite for persistence',
    updated_at: NOW - 60_000,
  };

  const GLOBAL_ATOM = {
    topic: 'conventions',
    description: 'Code style guide',
    preview: 'Always use kebab-case topics',
    updated_at: NOW - 2 * 60 * 60_000,
  };

  const STALENESS = { status: '0 commit(s) since this note' };

  test('returns null when rows and all atoms are empty', () => {
    const result = assemblePrimer({
      rows: [], projectAtoms: [], globalAtoms: [],
      agent: 'engineer', project: PROJECT, staleness: STALENESS,
    });
    expect(result).toBeNull();
  });

  test('returns null for null/undefined rows with no atoms', () => {
    const result = assemblePrimer({
      rows: null, projectAtoms: [], globalAtoms: [],
      agent: 'engineer', project: PROJECT, staleness: STALENESS,
    });
    expect(result).toBeNull();
  });

  test('multi-row session threads: renders ▸ label and relative time for each row', () => {
    const result = assemblePrimer({
      rows: [WARM_ROW],
      projectAtoms: [],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
    });
    expect(result).not.toBeNull();
    expect(result).toContain('### Recent sessions');
    expect(result).toContain('▸ My coding session');
    expect(result).toContain('5m ago');
    expect(result).toContain('Implemented the widget factory');
    expect(result).toContain('Write tests for widget');
    expect(result).toContain('Should we use SQLite?');
  });

  test('omits ### Recent sessions section on cold start (empty rows)', () => {
    const result = assemblePrimer({
      rows: [],
      projectAtoms: [PROJECT_ATOM],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
    });
    expect(result).not.toBeNull();
    expect(result).not.toContain('### Recent sessions');
  });

  test('project atom directory section contains atom entries', () => {
    const result = assemblePrimer({
      rows: [],
      projectAtoms: [PROJECT_ATOM],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
    });
    expect(result).toContain('### Project atoms');
    expect(result).toContain('arch/database');
    expect(result).toContain('DB design decisions');
    expect(result).toContain('Using SQLite for persistence');
  });

  test('project atom directory includes no-action framing', () => {
    const result = assemblePrimer({
      rows: [],
      projectAtoms: [PROJECT_ATOM],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
    });
    expect(result).toContain('Fetch atoms on demand');
  });

  test('per-section overflow line appears when count > cap', () => {
    const manyAtoms = Array.from({ length: 5 }, (_, i) => ({
      topic: `atom/${i}`,
      description: `atom ${i}`,
      preview: `content ${i}`,
      updated_at: NOW,
    }));
    const result = assemblePrimer({
      rows: [],
      projectAtoms: manyAtoms,
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
      cap: 3, // cap of 3 → 2 overflow
    });
    expect(result).toContain('+ 2 more');
  });

  test('global atom directory section is rendered', () => {
    const result = assemblePrimer({
      rows: [],
      projectAtoms: [],
      globalAtoms: [GLOBAL_ATOM],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
    });
    expect(result).toContain('### Global atoms');
    expect(result).toContain('conventions');
    expect(result).toContain('Code style guide');
  });

  test('global section shows placeholder when empty', () => {
    const result = assemblePrimer({
      rows: [],
      projectAtoms: [PROJECT_ATOM],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
    });
    expect(result).toContain('### Global atoms');
    expect(result).toContain('No global atoms yet.');
  });

  test('cold-start with global atoms only returns non-null primer', () => {
    const result = assemblePrimer({
      rows: [],
      projectAtoms: [],
      globalAtoms: [GLOBAL_ATOM],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
    });
    expect(result).not.toBeNull();
    expect(result).toContain('### Global atoms');
    expect(result).toContain('conventions');
  });

  test('cold-start with both empty returns null', () => {
    const result = assemblePrimer({
      rows: null,
      projectAtoms: [],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
    });
    expect(result).toBeNull();
  });

  test('no ADR or teach-back block in output', () => {
    const result = assemblePrimer({
      rows: [WARM_ROW],
      projectAtoms: [PROJECT_ATOM],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
    });
    expect(result).not.toContain('adr_candidate');
    expect(result).not.toContain('Possible decision');
    expect(result).not.toContain('teach-back');
  });

  test('staleness line is appended', () => {
    const result = assemblePrimer({
      rows: [WARM_ROW],
      projectAtoms: [],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
    });
    expect(result).toContain('Staleness:');
  });
});
