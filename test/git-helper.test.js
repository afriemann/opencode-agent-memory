// test/git-helper.test.js — git reconciliation helper tests.
//
// All gitRevParse/gitStaleness/renderStaleness tests use a mock $ tagged-template
// function so no real git repo is needed. gitStalenessNode tests use a real git
// repo (created via execFileSync) since it invokes git directly via
// node:child_process, not the Bun `$` shell.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitRevParse, gitStaleness, gitStalenessNode, renderStaleness } from '../src/lib/git-helper.js';

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

// ── gitStalenessNode ──────────────────────────────────────────────────────────
// spec: openspec/changes/memory-tui/specs/memory-tui/spec.md — Primer preview subcommand
//
// Uses a real git repo (via execFileSync) since gitStalenessNode invokes git
// through node:child_process, not the Bun `$` shell gitStaleness uses.

describe('gitStalenessNode', () => {
  let repoDir;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'agent-memory-gitstale-'));
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    execFileSync('git', ['init', '-q'], { cwd: repoDir, env: gitEnv });
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'first'], { cwd: repoDir, env: gitEnv });
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  test('returns { status: "no-anchor" } when storedSha is null', () => {
    const result = gitStalenessNode(repoDir, null);
    expect(result.status).toBe('no-anchor');
  });

  test('returns { status: "ok", distance: 0 } when storedSha equals HEAD (git repo)', () => {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
    const result = gitStalenessNode(repoDir, sha);
    expect(result.status).toBe('ok');
    expect(result.distance).toBe(0);
  });

  test('returns { status: "ok", distance: N } after further commits', () => {
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    };
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'second'], { cwd: repoDir, env: gitEnv });
    execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'third'], { cwd: repoDir, env: gitEnv });
    const result = gitStalenessNode(repoDir, sha);
    expect(result.status).toBe('ok');
    expect(result.distance).toBe(2);
  });

  test('returns { status: "no-git" } for a non-git directory', () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), 'agent-memory-nogit-'));
    try {
      const result = gitStalenessNode(nonGitDir, 'deadbeef');
      expect(result.status).toBe('no-git');
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  test('returns { status: "no-git" } for an inaccessible/nonexistent path (never throws)', () => {
    expect(() => gitStalenessNode('/nonexistent/path/does-not-exist', 'deadbeef')).not.toThrow();
    const result = gitStalenessNode('/nonexistent/path/does-not-exist', 'deadbeef');
    expect(result.status).toBe('no-git');
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

  test('no-anchor status renders "not yet anchored to a commit"', () => {
    const s = renderStaleness({ status: 'no-anchor' });
    expect(s).toBe('not yet anchored to a commit');
  });

  test('no-git status returns null (staleness line should be omitted)', () => {
    const s = renderStaleness({ status: 'no-git' });
    expect(s).toBeNull();
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
