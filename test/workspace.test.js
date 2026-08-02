// test/workspace.test.js — unit tests for src/lib/workspace.js
// spec: openspec/changes/memory-api-explicit-scope-and-keyword-search/specs/workspace-discovery/spec.md

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findGitRoot, resolveWorkspace } from '../src/lib/workspace.js';

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

  test('null → { scope: "global", project: "" }', () => {
    expect(resolveWorkspace(null, '/any/dir')).toEqual({ scope: 'global', project: '' });
  });

  test('undefined → { scope: "global", project: "" }', () => {
    expect(resolveWorkspace(undefined, '/any/dir')).toEqual({ scope: 'global', project: '' });
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

  test('absolute non-git path → scope=project, project=path as-is', () => {
    // tmp has no .git → findGitRoot returns it as-is
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
