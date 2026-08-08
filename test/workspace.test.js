// test/workspace.test.js — unit tests for src/lib/workspace.js
// spec: openspec/changes/memory-api-explicit-scope-and-keyword-search/specs/workspace-discovery/spec.md

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findGitRoot, findGitRootOrNull, resolveWorkspace } from '../src/lib/workspace.js';

// ── findGitRootOrNull ─────────────────────────────────────────────────────────
// spec: openspec/changes/git-workspace-and-shared-atoms/specs/memory-atom-tools/spec.md

describe('findGitRootOrNull', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'workspace-test-null-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('returns git root directory when .git directory is found', () => {
    mkdirSync(join(tmp, '.git'));
    expect(findGitRootOrNull(tmp)).toBe(tmp);
  });

  test('walks up and stops at .git directory', () => {
    mkdirSync(join(tmp, '.git'));
    const sub = join(tmp, 'src', 'lib');
    mkdirSync(sub, { recursive: true });
    expect(findGitRootOrNull(sub)).toBe(tmp);
  });

  test('returns null when no .git directory ancestor exists', () => {
    // tmp has no .git directory — walk reaches root and returns null (honest)
    expect(findGitRootOrNull(tmp)).toBeNull();
  });

  test('skips .git file (worktree pointer) and continues walking to .git directory', () => {
    const repoRoot = join(tmp, 'repo');
    mkdirSync(repoRoot);
    mkdirSync(join(repoRoot, '.git'));
    const worktree = join(repoRoot, 'worktrees', 'feat');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), 'gitdir: ../../.git/worktrees/feat\n');
    expect(findGitRootOrNull(worktree)).toBe(repoRoot);
  });
});

// ── findGitRoot ───────────────────────────────────────────────────────────────

describe('findGitRoot', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'workspace-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('returns directory containing .git directory when called from repo root', () => {
    mkdirSync(join(tmp, '.git'));
    expect(findGitRoot(tmp)).toBe(tmp);
  });

  test('walks up and stops at .git directory', () => {
    mkdirSync(join(tmp, '.git'));
    const sub = join(tmp, 'src', 'lib');
    mkdirSync(sub, { recursive: true });
    expect(findGitRoot(sub)).toBe(tmp);
  });

  test('skips .git file (worktree pointer) and continues walking', () => {
    // Create a parent with a real .git directory
    const repoRoot = join(tmp, 'repo');
    mkdirSync(repoRoot);
    mkdirSync(join(repoRoot, '.git'));
    // Create a worktree subdirectory with a .git FILE (pointer)
    const worktree = join(repoRoot, 'worktrees', 'feat');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), 'gitdir: ../../.git/worktrees/feat\n');
    // findGitRoot from worktree should skip the .git file and find the .git directory
    expect(findGitRoot(worktree)).toBe(repoRoot);
  });

  test('returns start path unchanged when no .git directory ancestor exists', () => {
    // tmp has no .git directory — walk reaches root and falls back
    expect(findGitRoot(tmp)).toBe(tmp);
  });

  test('resolves non-existent subdirectory by walking real ancestors', () => {
    // /repo/.git exists; /repo/gone-subdir does not exist on disk
    const repoRoot = join(tmp, 'repo');
    mkdirSync(repoRoot);
    mkdirSync(join(repoRoot, '.git'));
    const gone = join(repoRoot, 'gone-subdir');
    // gone does not exist, but its parent (repoRoot) has .git
    expect(findGitRoot(gone)).toBe(repoRoot);
  });
});

// ── resolveWorkspace ──────────────────────────────────────────────────────────

describe('resolveWorkspace', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'workspace-resolve-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('null → { scope: "global", project: "" } (explicit shared store)', () => {
    expect(resolveWorkspace(null, '/any/dir')).toEqual({ scope: 'global', project: '' });
  });

  test('undefined auto-detects non-git contextDirectory → shared store', () => {
    // '/any/dir' does not exist → findGitRootOrNull returns null → shared
    expect(resolveWorkspace(undefined, '/any/dir')).toEqual({ scope: 'global', project: '' });
  });

  test('undefined auto-detects git root of contextDirectory when in a git repo', () => {
    mkdirSync(join(tmp, '.git'));
    const sub = join(tmp, 'src');
    mkdirSync(sub);
    const result = resolveWorkspace(undefined, sub);
    expect(result).toEqual({ scope: 'project', project: tmp });
  });

  test('"." is expanded to contextDirectory then git-root resolved', () => {
    mkdirSync(join(tmp, '.git'));
    const sub = join(tmp, 'src');
    mkdirSync(sub);
    // contextDirectory is the subdirectory; "." should resolve to the git root
    const result = resolveWorkspace('.', sub);
    expect(result).toEqual({ scope: 'project', project: tmp });
  });

  test('"." expands to contextDirectory regardless of process.cwd()', () => {
    mkdirSync(join(tmp, '.git'));
    // Even if process.cwd() is /, "." must resolve via contextDirectory
    const result = resolveWorkspace('.', tmp);
    expect(result).toEqual({ scope: 'project', project: tmp });
  });

  test('absolute path → git root of that path', () => {
    const repoRoot = join(tmp, 'myrepo');
    mkdirSync(repoRoot);
    mkdirSync(join(repoRoot, '.git'));
    const sub = join(repoRoot, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    const result = resolveWorkspace(sub, '/irrelevant');
    expect(result).toEqual({ scope: 'project', project: repoRoot });
  });

  test('absolute non-git path → scope=project, project=path as-is (graceful fallback for explicit cross-project override)', () => {
    // Explicit absolute paths keep scope='project' regardless of git presence.
    // Only auto-detect (undefined workspace) falls back to shared when not in a git repo.
    const result = resolveWorkspace(tmp, '/irrelevant');
    expect(result).toEqual({ scope: 'project', project: tmp });
  });

  test('relative non-"." string throws validation error', () => {
    expect(() => resolveWorkspace('relative/path', '/ctx')).toThrow(/absolute path/i);
  });

  test('non-string, non-null workspace throws validation error', () => {
    expect(() => resolveWorkspace(42, '/ctx')).toThrow(/null or a string/i);
  });
});

// ── resolveWorkspace — normalize: false ───────────────────────────────────────

describe('resolveWorkspace with normalize: false', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'workspace-no-norm-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('null → shared store regardless of normalize flag', () => {
    expect(resolveWorkspace(null, '/any', { normalize: false }))
      .toEqual({ scope: 'global', project: '' });
  });

  test('undefined auto-detect still resolves to git root even when normalize: false', () => {
    mkdirSync(join(tmp, '.git'));
    const sub = join(tmp, 'src');
    mkdirSync(sub);
    // auto-detect is unaffected: it still walks to the git root
    expect(resolveWorkspace(undefined, sub, { normalize: false }))
      .toEqual({ scope: 'project', project: tmp });
  });

  test('absolute sub-path inside a git repo is kept as-is when normalize: false', () => {
    const repoRoot = join(tmp, 'myrepo');
    mkdirSync(repoRoot);
    mkdirSync(join(repoRoot, '.git'));
    const sub = join(repoRoot, '.config', 'opencode');
    mkdirSync(sub, { recursive: true });
    // Without normalize: false this would resolve to repoRoot
    expect(resolveWorkspace(sub, '/irrelevant', { normalize: false }))
      .toEqual({ scope: 'project', project: sub });
  });

  test('"." is expanded to contextDirectory and used as-is when normalize: false', () => {
    const repoRoot = join(tmp, 'myrepo');
    mkdirSync(repoRoot);
    mkdirSync(join(repoRoot, '.git'));
    const sub = join(repoRoot, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    // "." expands to sub, then kept as sub (not walked to repoRoot)
    expect(resolveWorkspace('.', sub, { normalize: false }))
      .toEqual({ scope: 'project', project: sub });
  });

  test('normalize: true (explicit) behaves identically to the default', () => {
    const repoRoot = join(tmp, 'myrepo');
    mkdirSync(repoRoot);
    mkdirSync(join(repoRoot, '.git'));
    const sub = join(repoRoot, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    expect(resolveWorkspace(sub, '/irrelevant', { normalize: true }))
      .toEqual(resolveWorkspace(sub, '/irrelevant'));
  });
});
