// test/signal-utils.test.js — formatRelativeTime and assemblePrimer tests.
//
// Covers tasks 8.17–8.18.

import {
  formatRelativeTime,
  assemblePrimer,
  lastTwoSegments,
  MAX_STANDING_ATOMS,
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
    expect(result).toContain('(+2 more — call memory_atom_list to see all)');
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

// ── assemblePrimer — pinned atom rendering ────────────────────────────────────
// spec: openspec/changes/pin-memory-atoms/specs/signal-processing/spec.md

describe('assemblePrimer — pinned atom rendering', () => {
  const PROJECT = '/home/user/repos/my/project';
  const NOW = Date.now();
  const STALENESS = { status: '0 commit(s) since this note' };

  test('pinned project atom appears before non-pinned atoms in primer', () => {
    const atoms = [
      { topic: 'zzz-normal', description: 'normal atom', preview: 'content', pinned: 0, updated_at: NOW },
      { topic: 'aaa-pinned', description: 'pinned atom', preview: 'pinned', pinned: 1, updated_at: NOW },
    ];
    const result = assemblePrimer({ rows: [], projectAtoms: atoms, globalAtoms: [], agent: 'engineer', project: PROJECT, staleness: STALENESS });
    const pinnedIdx = result.indexOf('aaa-pinned');
    const normalIdx = result.indexOf('zzz-normal');
    expect(pinnedIdx).toBeGreaterThanOrEqual(0);
    expect(normalIdx).toBeGreaterThanOrEqual(0);
    expect(pinnedIdx).toBeLessThan(normalIdx);
  });

  test('pinned project atom has [pinned] prefix in primer', () => {
    const atoms = [{ topic: 'key-fact', description: 'a pinned fact', preview: 'fact body', pinned: 1, updated_at: NOW }];
    const result = assemblePrimer({ rows: [], projectAtoms: atoms, globalAtoms: [], agent: 'engineer', project: PROJECT, staleness: STALENESS });
    expect(result).toContain('[pinned] key-fact');
  });

  test('non-pinned project atom does not have [pinned] prefix', () => {
    const atoms = [{ topic: 'regular', description: 'regular atom', preview: 'body', pinned: 0, updated_at: NOW }];
    const result = assemblePrimer({ rows: [], projectAtoms: atoms, globalAtoms: [], agent: 'engineer', project: PROJECT, staleness: STALENESS });
    expect(result).not.toContain('[pinned] regular');
    expect(result).toContain('regular');
  });

  test('pinned atoms are not capped — all appear even when regular atoms overflow cap', () => {
    const pinned = Array.from({ length: 5 }, (_, i) => ({
      topic: `pinned/${i}`, description: `pinned ${i}`, preview: '', pinned: 1, updated_at: NOW,
    }));
    const regular = Array.from({ length: 5 }, (_, i) => ({
      topic: `regular/${i}`, description: `regular ${i}`, preview: '', pinned: 0, updated_at: NOW,
    }));
    const result = assemblePrimer({
      rows: [], projectAtoms: [...pinned, ...regular], globalAtoms: [],
      agent: 'engineer', project: PROJECT, staleness: STALENESS, cap: 2,
    });
    for (const a of pinned) {
      expect(result).toContain(a.topic);
    }
    expect(result).toContain('(+3 more — call memory_atom_list to see all)');
  });

  test('overflow message counts only non-pinned atoms', () => {
    const pinned = [{ topic: 'pinned/z', description: 'pinned', preview: '', pinned: 1, updated_at: NOW }];
    const regular = Array.from({ length: 4 }, (_, i) => ({
      topic: `reg/${i}`, description: `reg`, preview: '', pinned: 0, updated_at: NOW,
    }));
    const result = assemblePrimer({
      rows: [], projectAtoms: [...pinned, ...regular], globalAtoms: [],
      agent: 'engineer', project: PROJECT, staleness: STALENESS, cap: 2,
    });
    expect(result).toContain('(+2 more — call memory_atom_list to see all)');
  });

  test('pinned global atom appears before non-pinned globals in primer', () => {
    const globals = [
      { topic: 'zzz-global', description: 'normal global', preview: '', pinned: 0, updated_at: NOW },
      { topic: 'aaa-global-pinned', description: 'pinned global', preview: '', pinned: 1, updated_at: NOW },
    ];
    const result = assemblePrimer({ rows: [], projectAtoms: [], globalAtoms: globals, agent: 'engineer', project: PROJECT, staleness: STALENESS });
    const pinnedIdx = result.indexOf('aaa-global-pinned');
    const normalIdx = result.indexOf('zzz-global');
    expect(pinnedIdx).toBeLessThan(normalIdx);
  });

  test('pinned global atom has [pinned] prefix in primer', () => {
    const globals = [{ topic: 'must-know', description: 'critical global', preview: '', pinned: 1, updated_at: NOW }];
    const result = assemblePrimer({ rows: [], projectAtoms: [], globalAtoms: globals, agent: 'engineer', project: PROJECT, staleness: STALENESS });
    expect(result).toContain('[pinned] must-know');
  });

  test('multiple pinned atoms appear in topic order within the pinned group', () => {
    const atoms = [
      { topic: 'zzz/last',   description: 'z', preview: '', pinned: 1, updated_at: NOW },
      { topic: 'aaa/first',  description: 'a', preview: '', pinned: 1, updated_at: NOW },
      { topic: 'mmm/middle', description: 'm', preview: '', pinned: 1, updated_at: NOW },
    ];
    const result = assemblePrimer({ rows: [], projectAtoms: atoms, globalAtoms: [], agent: 'engineer', project: PROJECT, staleness: STALENESS });
    const positions = ['aaa/first', 'mmm/middle', 'zzz/last'].map((t) => result.indexOf(t));
    expect(positions[0]).toBeLessThan(positions[1]);
    expect(positions[1]).toBeLessThan(positions[2]);
  });

  test('pinned atom appears exactly once in the primer section (no duplication)', () => {
    const atoms = [{ topic: 'arch/db', description: 'DB', preview: '', pinned: 1, updated_at: NOW }];
    const result = assemblePrimer({ rows: [], projectAtoms: atoms, globalAtoms: [], agent: 'engineer', project: PROJECT, staleness: STALENESS });
    const occurrences = result.split('\n').filter((l) => l.includes('[pinned] arch/db'));
    expect(occurrences).toHaveLength(1);
  });
});

// ── assemblePrimer — active-only status filter ────────────────────────────────
// spec: openspec/changes/atom-status/specs/signal-processing/spec.md

describe('assemblePrimer — active-only status filter', () => {
  const PROJECT = '/home/user/repos/my/project';
  const NOW = Date.now();
  const STALENESS = { status: '0 commit(s) since this note' };

  test('resolved project atom is excluded from primer', () => {
    const atoms = [
      { topic: 'arch/active', description: 'active', preview: '', pinned: 0, status: 'active', updated_at: NOW },
      { topic: 'arch/resolved', description: 'resolved', preview: '', pinned: 0, status: 'resolved', updated_at: NOW },
    ];
    const result = assemblePrimer({ rows: [], projectAtoms: atoms, globalAtoms: [], agent: 'engineer', project: PROJECT, staleness: STALENESS });
    expect(result).toContain('arch/active');
    expect(result).not.toContain('arch/resolved');
  });

  test('deprecated project atom is excluded from primer', () => {
    const atoms = [
      { topic: 'arch/active', description: 'active', preview: '', pinned: 0, status: 'active', updated_at: NOW },
      { topic: 'arch/deprecated', description: 'deprecated', preview: '', pinned: 0, status: 'deprecated', updated_at: NOW },
    ];
    const result = assemblePrimer({ rows: [], projectAtoms: atoms, globalAtoms: [], agent: 'engineer', project: PROJECT, staleness: STALENESS });
    expect(result).toContain('arch/active');
    expect(result).not.toContain('arch/deprecated');
  });

  test('only active atoms appear in the primer (all three statuses mixed)', () => {
    const atoms = [
      { topic: 'a/active',     description: 'active',     preview: '', pinned: 0, status: 'active',     updated_at: NOW },
      { topic: 'a/resolved',   description: 'resolved',   preview: '', pinned: 0, status: 'resolved',   updated_at: NOW },
      { topic: 'a/deprecated', description: 'deprecated', preview: '', pinned: 0, status: 'deprecated', updated_at: NOW },
    ];
    const result = assemblePrimer({ rows: [], projectAtoms: atoms, globalAtoms: [], agent: 'engineer', project: PROJECT, staleness: STALENESS });
    expect(result).toContain('a/active');
    expect(result).not.toContain('a/resolved');
    expect(result).not.toContain('a/deprecated');
  });

  test('atoms without a status field are treated as active', () => {
    const atoms = [
      { topic: 'no-status', description: 'no status field', preview: '', pinned: 0, updated_at: NOW },
    ];
    const result = assemblePrimer({ rows: [], projectAtoms: atoms, globalAtoms: [], agent: 'engineer', project: PROJECT, staleness: STALENESS });
    expect(result).toContain('no-status');
  });

  test('resolved global atom is excluded from primer', () => {
    const globals = [
      { topic: 'global/active',   description: 'active',   preview: '', pinned: 0, status: 'active',   updated_at: NOW },
      { topic: 'global/resolved', description: 'resolved', preview: '', pinned: 0, status: 'resolved', updated_at: NOW },
    ];
    const result = assemblePrimer({ rows: [], projectAtoms: [], globalAtoms: globals, agent: 'engineer', project: PROJECT, staleness: STALENESS });
    expect(result).toContain('global/active');
    expect(result).not.toContain('global/resolved');
  });

  test('overflow cap counts only active atoms (resolved excluded from overflow count)', () => {
    const atoms = [
      { topic: 'active/0', description: 'a0', preview: '', pinned: 0, status: 'active',   updated_at: NOW },
      { topic: 'active/1', description: 'a1', preview: '', pinned: 0, status: 'active',   updated_at: NOW },
      { topic: 'active/2', description: 'a2', preview: '', pinned: 0, status: 'active',   updated_at: NOW },
      { topic: 'resolved/x', description: 'rx', preview: '', pinned: 0, status: 'resolved', updated_at: NOW },
    ];
    const result = assemblePrimer({
      rows: [], projectAtoms: atoms, globalAtoms: [],
      agent: 'engineer', project: PROJECT, staleness: STALENESS, cap: 2,
    });
    // Only 3 active atoms, cap=2 → 1 overflow
    expect(result).toContain('(+1 more — call memory_atom_list to see all)');
    expect(result).not.toContain('resolved/x');
  });

  test('pinned but resolved atom is excluded from primer (active-only filter precedes pinned partition)', () => {
    const atoms = [
      { topic: 'pinned/resolved', description: 'pinned but resolved', preview: '', pinned: 1, status: 'resolved', updated_at: NOW },
      { topic: 'active/unpinned', description: 'active unpinned', preview: '', pinned: 0, status: 'active', updated_at: NOW },
    ];
    const result = assemblePrimer({ rows: [], projectAtoms: atoms, globalAtoms: [], agent: 'engineer', project: PROJECT, staleness: STALENESS });
    expect(result).not.toContain('pinned/resolved');
    expect(result).not.toContain('[pinned] pinned');
    expect(result).toContain('active/unpinned');
  });

  test('active-only filter applied before pinned/non-pinned partition — pinned active atom appears first, resolved absent', () => {
    const atoms = [
      { topic: 'pinned/active',    description: 'pinned active',    preview: '', pinned: 1, status: 'active',   updated_at: NOW },
      { topic: 'regular/active-1', description: 'regular active 1', preview: '', pinned: 0, status: 'active',   updated_at: NOW },
      { topic: 'regular/active-2', description: 'regular active 2', preview: '', pinned: 0, status: 'active',   updated_at: NOW },
      { topic: 'resolved/one',     description: 'resolved 1',       preview: '', pinned: 0, status: 'resolved', updated_at: NOW },
      { topic: 'resolved/two',     description: 'resolved 2',       preview: '', pinned: 0, status: 'resolved', updated_at: NOW },
    ];
    const result = assemblePrimer({ rows: [], projectAtoms: atoms, globalAtoms: [], agent: 'engineer', project: PROJECT, staleness: STALENESS });
    // Active atoms present, resolved absent
    expect(result).toContain('pinned/active');
    expect(result).toContain('regular/active-1');
    expect(result).toContain('regular/active-2');
    expect(result).not.toContain('resolved/one');
    expect(result).not.toContain('resolved/two');
    // Pinned active atom appears before non-pinned active atoms
    const pinnedIdx = result.indexOf('pinned/active');
    const regularIdx = result.indexOf('regular/active-1');
    expect(pinnedIdx).toBeLessThan(regularIdx);
    // [pinned] prefix on the pinned active atom
    expect(result).toContain('[pinned] pinned/active');
  });
});

// ── assemblePrimer — global atom deduplication ────────────────────────────────
// Global atoms included in the atomList(scope='project') query must not appear
// in the "Project atoms" section; they belong only in the "Global atoms" section.

describe('assemblePrimer — global atoms not duplicated in project section', () => {
  const PROJECT = '/home/user/repos/my/project';
  const NOW = Date.now();
  const STALENESS = { status: '0 commit(s) since this note' };

  test('global atom in projectAtoms is NOT rendered in the project section', () => {
    const projectAtoms = [
      { scope: 'project', topic: 'arch/db', description: 'DB design', preview: '', pinned: 0, updated_at: NOW },
      { scope: 'global',  topic: 'global/fact', description: 'global fact', preview: '', pinned: 0, updated_at: NOW },
    ];
    const globalAtoms = [
      { scope: 'global', topic: 'global/fact', description: 'global fact', preview: '', pinned: 0, updated_at: NOW },
    ];
    const result = assemblePrimer({ rows: [], projectAtoms, globalAtoms, agent: 'engineer', project: PROJECT, staleness: STALENESS });
    // global/fact should appear exactly once (in the Global atoms section)
    const occurrences = result.split('\n').filter((l) => l.includes('global/fact'));
    expect(occurrences).toHaveLength(1);
    // arch/db should appear in the project section
    expect(result).toContain('arch/db');
  });

  test('project section shows "No project atoms yet." when projectAtoms contains only global atoms', () => {
    const projectAtoms = [
      { scope: 'global', topic: 'global/only', description: 'global only', preview: '', pinned: 0, updated_at: NOW },
    ];
    const globalAtoms = [
      { scope: 'global', topic: 'global/only', description: 'global only', preview: '', pinned: 0, updated_at: NOW },
    ];
    const result = assemblePrimer({ rows: [], projectAtoms, globalAtoms, agent: 'engineer', project: PROJECT, staleness: STALENESS });
    expect(result).not.toBeNull();
    expect(result).toContain('No project atoms yet.');
    // global atom renders in the global section
    expect(result).toContain('global/only');
  });
});

// ── assemblePrimer — Standing context (always_include) ────────────────────────
// spec: openspec/changes/atom-always-include/specs/signal-processing/spec.md

const PROJECT = '/home/user/git/my-project';
const STALENESS = { status: 'ok', distance: 0 };
const NOW_REF = 1_700_000_000_000;

function makeStandingAtom(topic, overrides = {}) {
  return {
    scope: 'project',
    project: '/p',
    topic,
    description: `desc for ${topic}`,
    content: `Full content of ${topic}`,
    updated_at: NOW_REF,
    ...overrides,
  };
}

describe('assemblePrimer — Standing context section', () => {
  // 10.8 — Standing context section rendered when standingAtoms provided
  test('renders ### Standing context section when standingAtoms is non-empty', () => {
    const standing = [makeStandingAtom('conventions/style')];
    const result = assemblePrimer({
      rows: [], projectAtoms: [], globalAtoms: [], standingAtoms: standing,
      agent: 'engineer', project: PROJECT, staleness: STALENESS,
    });
    expect(result).not.toBeNull();
    expect(result).toContain('### Standing context');
    expect(result).toContain('Full content of conventions/style');
  });

  test('Standing context section placed after Recent sessions and before Project atoms', () => {
    const rows = [{ session_name: 'mysession', session_id: 'abc', updated_at: NOW_REF, last_worked_summary: 'did stuff', next_action: '', open_questions: [] }];
    const standing = [makeStandingAtom('proj-convention')];
    const result = assemblePrimer({
      rows, projectAtoms: [], globalAtoms: [], standingAtoms: standing,
      agent: 'engineer', project: PROJECT, staleness: STALENESS,
    });
    const recentIdx = result.indexOf('### Recent sessions');
    const standingIdx = result.indexOf('### Standing context');
    const projectIdx = result.indexOf('### Project atoms');
    expect(recentIdx).toBeGreaterThanOrEqual(0);
    expect(standingIdx).toBeGreaterThan(recentIdx);
    expect(projectIdx).toBeGreaterThan(standingIdx);
  });

  test('renders full content block with #### heading, description, and content', () => {
    const standing = [makeStandingAtom('my/convention')];
    const result = assemblePrimer({
      rows: [], projectAtoms: [], globalAtoms: [], standingAtoms: standing,
      agent: 'engineer', project: PROJECT, staleness: STALENESS,
    });
    expect(result).toContain('#### my/convention');
    expect(result).toContain('"desc for my/convention"');
    expect(result).toContain('Full content of my/convention');
  });

  // 10.9 — cap of 5 per scope, overflow note
  test('renders exactly MAX_STANDING_ATOMS (5) workspace atoms when more are provided', () => {
    const standing = Array.from({ length: 7 }, (_, i) =>
      makeStandingAtom(`topic-${String(i + 1).padStart(2, '0')}`)
    );
    const result = assemblePrimer({
      rows: [], projectAtoms: [], globalAtoms: [], standingAtoms: standing,
      agent: 'engineer', project: PROJECT, staleness: STALENESS,
    });
    // 5 atoms rendered
    for (let i = 1; i <= 5; i++) {
      expect(result).toContain(`Full content of topic-0${i}`);
    }
    // 2 overflow named
    expect(result).toContain('+2 more standing atom');
    expect(result).toContain('exceed the 5-per-scope cap');
    expect(result).toContain('topic-06');
    expect(result).toContain('topic-07');
  });

  test('cap selects 5 most recently updated atoms, not alphabetically-first', () => {
    // Create 7 workspace atoms; atoms 3,4,5,6,7 have older timestamps; atoms 1 and 2 also old
    // BUT give the 5 with NEWER timestamps to be: zzz, yyy, xxx, www, vvv (alphabetically last!)
    // and give older timestamps to: aaa, bbb (alphabetically first).
    // The cap should select zzz,yyy,xxx,www,vvv (newest), NOT aaa,bbb,vvv,www,xxx.
    const older = NOW_REF - 10000;
    const newer = NOW_REF;
    const standing = [
      makeStandingAtom('aaa', { updated_at: older }),
      makeStandingAtom('bbb', { updated_at: older }),
      makeStandingAtom('vvv', { updated_at: newer }),
      makeStandingAtom('www', { updated_at: newer }),
      makeStandingAtom('xxx', { updated_at: newer }),
      makeStandingAtom('yyy', { updated_at: newer }),
      makeStandingAtom('zzz', { updated_at: newer }),
    ];
    const result = assemblePrimer({
      rows: [], projectAtoms: [], globalAtoms: [], standingAtoms: standing,
      agent: 'engineer', project: PROJECT, staleness: STALENESS,
    });
    // 5 newest (vvv,www,xxx,yyy,zzz) must be rendered
    expect(result).toContain('Full content of vvv');
    expect(result).toContain('Full content of www');
    expect(result).toContain('Full content of xxx');
    expect(result).toContain('Full content of yyy');
    expect(result).toContain('Full content of zzz');
    // 2 oldest (aaa,bbb) must be in overflow note, NOT rendered as content
    expect(result).toContain('+2 more standing atom');
    expect(result).toContain('aaa');
    expect(result).toContain('bbb');
    // aaa and bbb content must NOT appear as full blocks
    expect(result).not.toContain('Full content of aaa');
    expect(result).not.toContain('Full content of bbb');
  });

  test('rendered atoms within cap appear in alphabetical topic order', () => {
    const standing = [
      makeStandingAtom('z/last', { updated_at: NOW_REF }),
      makeStandingAtom('a/first', { updated_at: NOW_REF }),
      makeStandingAtom('m/middle', { updated_at: NOW_REF }),
    ];
    const result = assemblePrimer({
      rows: [], projectAtoms: [], globalAtoms: [], standingAtoms: standing,
      agent: 'engineer', project: PROJECT, staleness: STALENESS,
    });
    const firstIdx = result.indexOf('a/first');
    const middleIdx = result.indexOf('m/middle');
    const lastIdx = result.indexOf('z/last');
    expect(firstIdx).toBeLessThan(middleIdx);
    expect(middleIdx).toBeLessThan(lastIdx);
  });

  test('MAX_STANDING_ATOMS constant equals 5', () => {
    expect(MAX_STANDING_ATOMS).toBe(5);
  });

  // 10.10 — global standing atoms rendered separately, capped independently
  test('renders global standing atoms in separate bucket', () => {
    const globalStanding = [makeStandingAtom('global/prefs', { scope: 'global', project: '' })];
    const wsStanding = [makeStandingAtom('ws/rules')];
    const result = assemblePrimer({
      rows: [], projectAtoms: [], globalAtoms: [], standingAtoms: [...wsStanding, ...globalStanding],
      agent: 'engineer', project: PROJECT, staleness: STALENESS,
    });
    expect(result).toContain('Full content of ws/rules');
    expect(result).toContain('Full content of global/prefs');
  });

  // 10.11 — always_include atoms excluded from compact directory
  test('always_include atoms are excluded from compact project atom directory', () => {
    const projectAtoms = [
      { scope: 'project', project: '/p', topic: 'standing-atom', description: 'desc', preview: 'preview', pinned: 0, status: 'active', updated_at: NOW_REF },
      { scope: 'project', project: '/p', topic: 'regular-atom', description: 'desc', preview: 'preview', pinned: 0, status: 'active', updated_at: NOW_REF },
    ];
    const standing = [
      { scope: 'project', project: '/p', topic: 'standing-atom', description: 'desc', content: 'Full standing content', updated_at: NOW_REF },
    ];
    const result = assemblePrimer({
      rows: [], projectAtoms, globalAtoms: [], standingAtoms: standing,
      agent: 'engineer', project: PROJECT, staleness: STALENESS,
    });
    // standing-atom appears in Standing context section with full content
    expect(result).toContain('Full standing content');
    // regular-atom still appears as compact directory entry
    expect(result).toContain('regular-atom');
    // standing-atom must NOT appear twice (not in compact directory)
    const occurrences = result.split('\n').filter((l) => l.includes('standing-atom') && !l.startsWith('####'));
    expect(occurrences.length).toBe(0);
  });

  test('always_include global atoms excluded from compact global directory', () => {
    const globalAtoms = [
      { scope: 'global', project: '', topic: 'global-standing', description: 'desc', preview: 'p', pinned: 0, status: 'active', updated_at: NOW_REF },
      { scope: 'global', project: '', topic: 'global-regular', description: 'desc', preview: 'p', pinned: 0, status: 'active', updated_at: NOW_REF },
    ];
    const standing = [
      { scope: 'global', project: '', topic: 'global-standing', description: 'desc', content: 'Full global content', updated_at: NOW_REF },
    ];
    const result = assemblePrimer({
      rows: [], projectAtoms: [], globalAtoms, standingAtoms: standing,
      agent: 'engineer', project: PROJECT, staleness: STALENESS,
    });
    expect(result).toContain('Full global content');
    expect(result).toContain('global-regular');
    // global-standing must not appear in compact directory (not as a one-liner entry)
    const compactLines = result.split('\n').filter((l) => l.includes('global-standing') && !l.startsWith('####'));
    expect(compactLines.length).toBe(0);
  });

  // 10.12 — Standing context omitted when standingAtoms is empty/absent
  test('omits Standing context section when standingAtoms is empty', () => {
    const projectAtoms = [{ scope: 'project', project: '/p', topic: 'atom', description: 'desc', preview: 'p', pinned: 0, status: 'active', updated_at: NOW_REF }];
    const result = assemblePrimer({
      rows: [], projectAtoms, globalAtoms: [], standingAtoms: [],
      agent: 'engineer', project: PROJECT, staleness: STALENESS,
    });
    expect(result).not.toContain('### Standing context');
  });

  test('omits Standing context section when standingAtoms param is absent (default)', () => {
    const projectAtoms = [{ scope: 'project', project: '/p', topic: 'atom', description: 'desc', preview: 'p', pinned: 0, status: 'active', updated_at: NOW_REF }];
    const result = assemblePrimer({
      rows: [], projectAtoms, globalAtoms: [],
      agent: 'engineer', project: PROJECT, staleness: STALENESS,
    });
    expect(result).not.toContain('### Standing context');
  });

  // 10.13 — cold-start with only standingAtoms returns non-null primer
  test('cold-start with only standingAtoms returns non-null primer', () => {
    const standing = [makeStandingAtom('always-available')];
    const result = assemblePrimer({
      rows: [], projectAtoms: [], globalAtoms: [], standingAtoms: standing,
      agent: 'engineer', project: PROJECT, staleness: STALENESS,
    });
    expect(result).not.toBeNull();
    expect(result).toContain('### Standing context');
    expect(result).toContain('Full content of always-available');
  });

  test('cold-start with empty rows, atoms, and no standingAtoms returns null', () => {
    const result = assemblePrimer({
      rows: [], projectAtoms: [], globalAtoms: [], standingAtoms: [],
      agent: 'engineer', project: PROJECT, staleness: STALENESS,
    });
    expect(result).toBeNull();
  });
});

describe('assemblePrimer — additional Standing context scenarios', () => {
  // Pinned + always_include — no double-render
  test('pinned+always_include atom renders only in Standing context, not in compact directory', () => {
    const projectAtoms = [
      { scope: 'project', project: '/p', topic: 'both-flags', description: 'desc', preview: 'preview', pinned: 1, status: 'active', updated_at: NOW_REF },
      { scope: 'project', project: '/p', topic: 'regular', description: 'desc', preview: 'preview', pinned: 0, status: 'active', updated_at: NOW_REF },
    ];
    const standing = [
      { scope: 'project', project: '/p', topic: 'both-flags', description: 'desc', content: 'Full content of both-flags', updated_at: NOW_REF },
    ];
    const result = assemblePrimer({
      rows: [], projectAtoms, globalAtoms: [], standingAtoms: standing,
      agent: 'engineer', project: PROJECT, staleness: STALENESS,
    });
    // Appears in Standing context as full block
    expect(result).toContain('Full content of both-flags');
    expect(result).toContain('#### both-flags');
    // Must NOT appear as a compact [pinned] line in Project atoms section
    const lines = result.split('\n');
    const compactPinnedLine = lines.find((l) => l.includes('[pinned]') && l.includes('both-flags'));
    expect(compactPinnedLine).toBeUndefined();
  });

  // 40-cap unaffected by always_include atoms
  test('40-cap for compact directory is unaffected by standing atoms', () => {
    // 42 regular atoms (not flagged) — compact directory should show 40 and overflow 2
    const projectAtoms = Array.from({ length: 42 }, (_, i) => ({
      scope: 'project', project: '/p', topic: `regular-${String(i).padStart(3, '0')}`,
      description: 'desc', preview: 'preview', pinned: 0, status: 'active', updated_at: NOW_REF,
    }));
    const standing = [
      makeStandingAtom('standing-1'),
      makeStandingAtom('standing-2'),
    ];
    const result = assemblePrimer({
      rows: [], projectAtoms, globalAtoms: [], standingAtoms: standing,
      agent: 'engineer', project: PROJECT, staleness: STALENESS,
    });
    // Compact directory overflow note shows 2 (42 regular - 40 cap)
    expect(result).toContain('(+2 more — call memory_atom_list to see all)');
  });

  // Global and workspace caps are independent (6+6 → 5+5 + two overflow notes)
  test('workspace and global caps are independent: 6+6 → 5+5 with two overflow notes', () => {
    const wsStanding = Array.from({ length: 6 }, (_, i) =>
      makeStandingAtom(`ws/atom-${String(i + 1).padStart(2, '0')}`)
    );
    const globalStanding = Array.from({ length: 6 }, (_, i) =>
      makeStandingAtom(`gl/atom-${String(i + 1).padStart(2, '0')}`, { scope: 'global', project: '' })
    );
    const result = assemblePrimer({
      rows: [], projectAtoms: [], globalAtoms: [], standingAtoms: [...wsStanding, ...globalStanding],
      agent: 'engineer', project: PROJECT, staleness: STALENESS,
    });
    // 5 ws atoms rendered, 1 overflow
    for (let i = 1; i <= 5; i++) {
      expect(result).toContain(`Full content of ws/atom-0${i}`);
    }
    // 5 global atoms rendered, 1 overflow
    for (let i = 1; i <= 5; i++) {
      expect(result).toContain(`Full content of gl/atom-0${i}`);
    }
    // Two overflow notes
    const overflowNotes = result.split('\n').filter((l) => l.includes('+1 more standing atom') && l.includes('5-per-scope cap'));
    expect(overflowNotes.length).toBe(2);
  });
});

// ── assemblePrimer — session label fallback (primer-ux-improvements) ──────────
// spec: openspec/changes/primer-ux-improvements/specs/signal-processing/spec.md

describe('assemblePrimer — session label fallback', () => {
  const PROJECT = '/home/user/repos/my/project';
  const STALENESS = { status: 'ok', distance: 0 };

  test('session label uses relative time when session_name and session_id are both absent', () => {
    const now = Date.now();
    const row = {
      session_id: '',
      session_name: null,
      last_worked_summary: 'did some work',
      next_action: '',
      open_questions: [],
      updated_at: now - 4 * 24 * 60 * 60_000, // 4 days ago
    };
    const result = assemblePrimer({
      rows: [row],
      projectAtoms: [],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
    });
    expect(result).not.toBeNull();
    expect(result).toContain('▸');
    expect(result).not.toContain('unknown');
    expect(result).toContain('4 days ago');
  });

  test('session label uses short session_id when name is absent but id is present', () => {
    const now = Date.now();
    const row = {
      session_id: 'ses-abc123xyz',
      session_name: null,
      last_worked_summary: '',
      next_action: '',
      open_questions: [],
      updated_at: now - 60_000,
    };
    const result = assemblePrimer({
      rows: [row],
      projectAtoms: [],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
    });
    expect(result).toContain('▸ ses-abc1');
    expect(result).not.toContain('unknown');
  });

  test('session label uses session_name when present, ignoring id', () => {
    const now = Date.now();
    const row = {
      session_id: 'ses-abc123',
      session_name: 'My Named Session',
      last_worked_summary: '',
      next_action: '',
      open_questions: [],
      updated_at: now - 60_000,
    };
    const result = assemblePrimer({
      rows: [row],
      projectAtoms: [],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
    });
    expect(result).toContain('▸ My Named Session');
  });
});

// ── assemblePrimer — session_id bracket in thread header ──────────────────────
// spec: openspec/changes/hot-state-session-delete/specs/signal-processing/spec.md

describe('assemblePrimer — session_id bracket in thread header', () => {
  const PROJECT = '/home/user/repos/project';
  const STALENESS = { status: 'ok', distance: 0 };

  test('row with non-empty session_id shows full session_id in bracket', () => {
    const row = {
      session_id: 'ses_abc123fullid',
      session_name: null,
      last_worked_summary: 'did work',
      next_action: '',
      open_questions: [],
      updated_at: Date.now() - 60_000,
    };
    const result = assemblePrimer({ rows: [row], projectAtoms: [], globalAtoms: [], agent: 'engineer', project: PROJECT, staleness: STALENESS });
    expect(result).not.toBeNull();
    const headerLine = result.split('\n').find((l) => l.startsWith('▸'));
    expect(headerLine).toBeDefined();
    expect(headerLine).toContain('[ses_abc123fullid]');
  });

  test('row with empty session_id omits bracket from header line', () => {
    const row = {
      session_id: '',
      session_name: null,
      last_worked_summary: 'did work',
      next_action: '',
      open_questions: [],
      updated_at: Date.now() - 60_000,
    };
    const result = assemblePrimer({ rows: [row], projectAtoms: [], globalAtoms: [], agent: 'engineer', project: PROJECT, staleness: STALENESS });
    expect(result).not.toBeNull();
    const headerLine = result.split('\n').find((l) => l.startsWith('▸'));
    expect(headerLine).toBeDefined();
    expect(headerLine).not.toContain('[');
  });

  test('row with null session_id omits bracket from header line', () => {
    const row = {
      session_id: null,
      session_name: 'Named Session',
      last_worked_summary: 'did work',
      next_action: '',
      open_questions: [],
      updated_at: Date.now() - 60_000,
    };
    const result = assemblePrimer({ rows: [row], projectAtoms: [], globalAtoms: [], agent: 'engineer', project: PROJECT, staleness: STALENESS });
    const headerLine = result.split('\n').find((l) => l.startsWith('▸'));
    expect(headerLine).not.toContain('[');
  });
});

// ── assemblePrimer — staleness improvements (primer-ux-improvements) ──────────
// spec: openspec/changes/primer-ux-improvements/specs/signal-processing/spec.md

describe('assemblePrimer — staleness improvements', () => {
  const PROJECT = '/home/user/repos/my/project';
  const WARM_ROW = {
    session_id: 'ses-abc123',
    session_name: 'session',
    last_worked_summary: 'did stuff',
    next_action: '',
    open_questions: [],
    updated_at: Date.now() - 5 * 60_000,
  };

  test('no-anchor staleness renders "not yet anchored to a commit" phrase', () => {
    const result = assemblePrimer({
      rows: [WARM_ROW],
      projectAtoms: [],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: { status: 'no-anchor' },
    });
    expect(result).toContain('not yet anchored to a commit');
  });

  test('no-git staleness omits staleness line entirely', () => {
    const result = assemblePrimer({
      rows: [WARM_ROW],
      projectAtoms: [],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: { status: 'no-git' },
    });
    expect(result).not.toContain('Staleness:');
  });
});

// ── assemblePrimer — cross-project activity section (primer-ux-improvements) ──
// spec: openspec/changes/primer-ux-improvements/specs/primer-cross-project-activity/spec.md

describe('assemblePrimer — cross-project activity section', () => {
  const PROJECT = '/home/user/repos/project';
  const STALENESS = { status: 'ok', distance: 0 };
  const NOW = Date.now();

  test('includes "### Active projects today" when crossProjectRows is non-empty', () => {
    const cpRows = [{ project: '/home/user/repos/other', agent: 'engineer', updated_at: NOW - 60_000 }];
    const result = assemblePrimer({
      rows: [],
      projectAtoms: [],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
      crossProjectRows: cpRows,
      homeDir: '/home/user',
    });
    expect(result).not.toBeNull();
    expect(result).toContain('### Active projects today');
    expect(result).toContain('repos/other');
    expect(result).toContain('engineer');
  });

  test('omits "### Active projects today" when crossProjectRows is empty', () => {
    const projectAtoms = [{ topic: 'x', description: 'd', preview: 'p', updated_at: NOW }];
    const result = assemblePrimer({
      rows: [],
      projectAtoms,
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
      crossProjectRows: [],
    });
    expect(result).not.toContain('### Active projects today');
  });

  test('renders relative "~/" path when homeDir is provided', () => {
    const cpRows = [{ project: '/home/user/repos/other-project', agent: 'engineer', updated_at: NOW - 60_000 }];
    const result = assemblePrimer({
      rows: [],
      projectAtoms: [],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
      crossProjectRows: cpRows,
      homeDir: '/home/user',
    });
    expect(result).not.toBeNull();
    expect(result).toContain('~/repos/other-project');
  });

  test('"### Active projects today" appears after ### Recent sessions', () => {
    const cpRows = [{ project: '/home/user/repos/other', agent: 'engineer', updated_at: NOW - 60_000 }];
    const recentRows = [{
      session_id: 'abc', session_name: 'my session',
      updated_at: NOW - 5 * 60_000, last_worked_summary: 'stuff',
      next_action: '', open_questions: [],
    }];
    const result = assemblePrimer({
      rows: recentRows,
      projectAtoms: [],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
      crossProjectRows: cpRows,
      homeDir: '/home/user',
    });
    const recentIdx = result.indexOf('### Recent sessions');
    const crossIdx = result.indexOf('### Active projects today');
    expect(recentIdx).toBeGreaterThanOrEqual(0);
    expect(crossIdx).toBeGreaterThan(recentIdx);
  });

  test('cold-start with only cross-project rows returns non-null primer', () => {
    const cpRows = [{ project: '/home/user/repos/other', agent: 'engineer', updated_at: NOW - 60_000 }];
    const result = assemblePrimer({
      rows: [],
      projectAtoms: [],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
      crossProjectRows: cpRows,
      homeDir: '/home/user',
    });
    expect(result).not.toBeNull();
  });
});

// ── assemblePrimer — empty distil row handling ────────────────────────────────
// Rows where last_worked_summary is empty indicate a distillation error and
// should render a visible error indicator rather than a blank entry.

describe('assemblePrimer — empty distil row handling', () => {
  const PROJECT = '/home/user/repos/project';
  const STALENESS = { status: 'ok', distance: 0 };
  const NOW = Date.now();

  const EMPTY_ROW = {
    session_id: 'ses-abc123',
    session_name: 'My session',
    last_worked_summary: '',
    next_action: '',
    open_questions: [],
    updated_at: NOW - 5 * 60_000,
  };

  const CONTENTFUL_ROW = {
    session_id: 'ses-def456',
    session_name: 'Good session',
    last_worked_summary: 'Implemented the widget',
    next_action: 'Write tests',
    open_questions: [],
    updated_at: NOW - 10 * 60_000,
  };

  test('empty last_worked_summary renders a distillation error indicator', () => {
    const result = assemblePrimer({
      rows: [EMPTY_ROW],
      projectAtoms: [],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
    });
    expect(result).not.toBeNull();
    expect(result).toContain('▸ My session');
    expect(result).toContain('Distillation error');
  });

  test('empty row does not show Last:/Next: lines', () => {
    const result = assemblePrimer({
      rows: [EMPTY_ROW],
      projectAtoms: [],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
    });
    expect(result).not.toContain('Last:');
    expect(result).not.toContain('Next:');
  });

  test('contentful row still renders normally alongside empty row', () => {
    const result = assemblePrimer({
      rows: [CONTENTFUL_ROW, EMPTY_ROW],
      projectAtoms: [],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
    });
    expect(result).toContain('▸ Good session');
    expect(result).toContain('Last: Implemented the widget');
    expect(result).toContain('▸ My session');
    expect(result).toContain('Distillation error');
  });

  test('null last_worked_summary also renders distillation error indicator', () => {
    const nullRow = { ...EMPTY_ROW, last_worked_summary: null };
    const result = assemblePrimer({
      rows: [nullRow],
      projectAtoms: [],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
    });
    expect(result).toContain('Distillation error');
  });
});

// ── assemblePrimer — atom preview newline stripping ───────────────────────────
// Atom content previews may contain newlines (e.g. "## Error\n\nBad Request").
// They must be collapsed to spaces so the atom directory stays single-line per
// entry and headings in preview text don't get rendered as UI error blocks.

describe('assemblePrimer — atom preview newline stripping', () => {
  const PROJECT = '/home/user/repos/project';
  const STALENESS = { status: 'ok', distance: 0 };
  const NOW = Date.now();

  test('newlines in atom preview are replaced with spaces', () => {
    const atom = {
      topic: 'reality/some-bug',
      description: 'A bug report',
      preview: '# Heading\n\n## Error\nBad Request: This model does not support',
      updated_at: NOW - 60_000,
    };
    const result = assemblePrimer({
      rows: [],
      projectAtoms: [atom],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
    });
    expect(result).not.toBeNull();
    // No standalone "## Error" heading on its own line
    const lines = result.split('\n');
    expect(lines.some((l) => l.trim() === '## Error')).toBe(false);
    // The preview content is still present, just on a single line
    expect(result).toContain('reality/some-bug');
  });

  test('atom entry with multiline preview renders as a single directory line', () => {
    const atom = {
      topic: 'my/atom',
      description: 'desc',
      preview: 'line one\nline two',
      updated_at: NOW - 60_000,
    };
    const result = assemblePrimer({
      rows: [],
      projectAtoms: [atom],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
    });
    const lines = result.split('\n');
    const atomLine = lines.find((l) => l.includes('my/atom'));
    expect(atomLine).toBeDefined();
    // The topic must appear exactly once, on a single line
    expect(lines.filter((l) => l.includes('my/atom'))).toHaveLength(1);
  });

  test('unclosed backtick in truncated preview is closed so downstream markdown is not corrupted', () => {
    // Simulate a preview that ends mid-backtick span after slicing to 80 chars:
    // "Always use `--profile cloudops` (or `AWS_PROFILE=" — 51 chars, but a longer
    // real-world body truncated at 80 would leave the final backtick open.
    const preview80 = 'Always use `--profile cloudops` (or `AWS_PROFILE=cloudops`) for the project -- '.slice(0, 80);
    // preview80 should now end with an open backtick context; force the odd case:
    const oddPreview = preview80.slice(0, 77) + ' `A'; // 80 chars, 3 backticks (odd)
    const atom = {
      topic: 'clarky-aws-profile',
      description: 'AWS profile',
      preview: oddPreview,
      updated_at: NOW - 60_000,
    };
    const result = assemblePrimer({
      rows: [],
      projectAtoms: [atom],
      globalAtoms: [],
      agent: 'engineer',
      project: PROJECT,
      staleness: STALENESS,
    });
    expect(result).not.toBeNull();
    const lines = result.split('\n');
    const atomLine = lines.find((l) => l.includes('clarky-aws-profile'));
    expect(atomLine).toBeDefined();
    // The rendered line must contain an even number of backticks.
    const backticks = (atomLine.match(/`/g) ?? []).length;
    expect(backticks % 2).toBe(0);
  });
});
