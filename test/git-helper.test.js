// test/git-helper.test.js — git reconciliation helper tests.
//
// All tests use a mock $ tagged-template function so no real git repo is needed.

import { gitRevParse, gitStaleness, renderStaleness } from '../src/lib/git-helper.js';

// ── Mock $ factory ───────────────────────────────────────────────────────────

/**
 * Build a mock $ tagged-template function.
 *
 * @param {{ exitCode?: number, stdout?: string, throws?: boolean }} options
 * - exitCode: 0 (default) or non-zero → triggers throw
 * - stdout: what .text() returns
 * - throws: if true the template call itself throws (simulates no-git)
 */
function mockShell({ stdout = '', throws = false } = {}) {
  return function $(strings, ...values) {
    const result = {
      quiet: () => result,
      text: async () => {
        if (throws) throw new Error('git: command not found');
        return stdout;
      },
    };
    if (throws) {
      // Make the tagged call itself throw to simulate git not found
      return {
        quiet: () => ({
          text: async () => { throw new Error('git: command not found'); },
        }),
      };
    }
    return result;
  };
}

// A factory that returns different responses based on the command string
function multiMockShell(responses) {
  // responses: array of { match: string, stdout?: string, throws?: boolean }
  return function $(strings, ...values) {
    const cmd = strings.reduce(
      (acc, str, i) => acc + str + (values[i] !== undefined ? String(values[i]) : ''),
      ''
    );
    for (const r of responses) {
      if (cmd.includes(r.match)) {
        const result = {
          quiet: () => result,
          text: async () => {
            if (r.throws) throw new Error('git failed');
            return r.stdout ?? '';
          },
        };
        return result;
      }
    }
    // Default: success with empty output
    const fallback = {
      quiet: () => fallback,
      text: async () => '',
    };
    return fallback;
  };
}

// ── gitRevParse ───────────────────────────────────────────────────────────────

describe('gitRevParse', () => {
  test('returns the trimmed SHA on success', async () => {
    const $ = mockShell({ stdout: 'abc1234\n' });
    expect(await gitRevParse($, '/some/project')).toBe('abc1234');
  });

  test('returns null when git throws', async () => {
    const $ = mockShell({ throws: true });
    expect(await gitRevParse($, '/no/git')).toBeNull();
  });

  test('returns null for empty stdout', async () => {
    const $ = mockShell({ stdout: '   ' });
    expect(await gitRevParse($, '/proj')).toBeNull();
  });
});

// ── gitStaleness ─────────────────────────────────────────────────────────────

describe('gitStaleness', () => {
  test('returns { status: "no-anchor" } when storedSha is null', async () => {
    const $ = mockShell();
    const result = await gitStaleness($, '/proj', null);
    expect(result.status).toBe('no-anchor');
  });

  test('returns { status: "ok", distance: N } when rev-list succeeds', async () => {
    const $ = mockShell({ stdout: '3\n' });
    const result = await gitStaleness($, '/proj', 'deadbeef');
    expect(result.status).toBe('ok');
    expect(result.distance).toBe(3);
  });

  test('returns { status: "ok", distance: 0 } when SHA equals HEAD', async () => {
    const $ = mockShell({ stdout: '0\n' });
    const result = await gitStaleness($, '/proj', 'deadbeef');
    expect(result.status).toBe('ok');
    expect(result.distance).toBe(0);
  });

  test('returns { status: "diverged" } when rev-list fails but git exists (SHA unreachable)', async () => {
    // First call (rev-list) throws, second call (rev-parse) succeeds
    const $ = multiMockShell([
      { match: 'rev-list', throws: true },
      { match: 'rev-parse', stdout: 'abc123\n' },
    ]);
    const result = await gitStaleness($, '/proj', 'deadbeef');
    expect(result.status).toBe('diverged');
  });

  test('returns { status: "no-git" } when both rev-list and rev-parse fail', async () => {
    const $ = multiMockShell([
      { match: 'rev-list', throws: true },
      { match: 'rev-parse', throws: true },
    ]);
    const result = await gitStaleness($, '/no-git', 'deadbeef');
    expect(result.status).toBe('no-git');
  });

  test('returns { status: "diverged" } when rev-list returns NaN (§9-Q6)', async () => {
    // Non-integer output (e.g. git error mixed into stdout, or empty)
    const $ = mockShell({ stdout: 'fatal: bad object\n' });
    const result = await gitStaleness($, '/proj', 'deadbeef');
    // parseInt('fatal:...') → NaN → diverged
    expect(result.status).toBe('diverged');
  });
});

// ── renderStaleness ───────────────────────────────────────────────────────────

describe('renderStaleness', () => {
  test('ok status renders N commits phrasing', () => {
    const s = renderStaleness({ status: 'ok', distance: 5 });
    expect(s).toBe('5 commit(s) since this note');
  });

  test('ok status distance 0 renders zero commits', () => {
    const s = renderStaleness({ status: 'ok', distance: 0 });
    expect(s).toBe('0 commit(s) since this note');
  });

  test('no-anchor status renders unavailable phrasing', () => {
    const s = renderStaleness({ status: 'no-anchor' });
    expect(s).toBe('git anchor unavailable');
  });

  test('no-git status renders unavailable phrasing', () => {
    const s = renderStaleness({ status: 'no-git' });
    expect(s).toBe('git anchor unavailable');
  });

  test('diverged status renders history-diverged phrasing', () => {
    const s = renderStaleness({ status: 'diverged' });
    expect(s).toBe("history diverged from this note's anchor");
  });

  test('null staleness renders unavailable phrasing', () => {
    const s = renderStaleness(null);
    expect(s).toBe('git anchor unavailable');
  });
});
