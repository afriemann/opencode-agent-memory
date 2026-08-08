// src/lib/workspace.js — workspace resolution helpers for agent-memory.
//
// Provides pure fs-based functions for resolving a workspace locator to
// { scope, project } — the canonical form stored in the DB.
//
// These functions are unit-testable without spawning any process and have
// no git-binary dependency: findGitRoot walks the filesystem using node:fs
// only, degrading gracefully when git is absent or the path is non-git.

import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Walk up the filesystem from `start` looking for a `.git` *directory*.
 * Skips `.git` *files* (worktree pointers) — all worktrees nested inside the
 * main tree collapse to the main repo root. A worktree checked out outside
 * the main tree walks to the filesystem root and returns `null`.
 *
 * Returns `null` when no `.git` directory ancestor is found (honest result
 * for non-git directories, as opposed to `findGitRoot` which falls back to
 * `start`). Use this function when the caller needs to distinguish a git repo
 * from a non-git path.
 *
 * @param {string} start — absolute path to begin the walk from
 * @returns {string|null}
 */
export function findGitRootOrNull(start) {
  let dir = start;
  while (true) {
    const gitPath = join(dir, '.git');
    try {
      const s = statSync(gitPath);
      if (s.isDirectory()) {
        return dir; // found the main repo root
      }
      // .git exists but is a file (worktree pointer) — keep walking upward
    } catch {
      // .git does not exist or is otherwise inaccessible — keep walking
    }

    const parent = dirname(dir);
    if (parent === dir) {
      // Reached filesystem root — no .git directory found
      return null;
    }
    dir = parent;
  }
}

/**
 * Walk up the filesystem from `start` looking for a `.git` *directory*.
 * Skips `.git` *files* (worktree pointers) — all worktrees nested inside the
 * main tree collapse to the main repo root. A worktree checked out outside
 * the main tree walks to the filesystem root and falls back to `start`.
 *
 * Returns `start` unchanged when no `.git` directory ancestor is found
 * (graceful fallback for non-git projects or non-existent paths).
 * When you need to distinguish a git repo from a non-git path, use
 * `findGitRootOrNull` instead.
 *
 * @param {string} start — absolute path to begin the walk from
 * @returns {string}
 */
export function findGitRoot(start) {
  return findGitRootOrNull(start) ?? start;
}

/**
 * Resolve a workspace locator to `{ scope, project }`.
 *
 * Accepted forms:
 *   undefined         → auto-detect: git root of `contextDirectory` when in a
 *                       git repo, or `{ scope: 'global', project: '' }` (shared)
 *                       when not in any git repo.
 *   null              → explicit shared store: `{ scope: 'global', project: '' }`
 *   "."               → git root of `contextDirectory` (expanded first)
 *   "/abs/path"       → git root of `/abs/path`
 *   other relative    → throws a validation error (only "." is accepted as relative)
 *
 * "." is always expanded to `contextDirectory` BEFORE being passed to
 * `findGitRootOrNull` — it must never reach the git-root walk as a literal character.
 *
 * @param {string|null|undefined} workspace
 * @param {string} contextDirectory — absolute path to expand `"."` against
 * @param {{ normalize?: boolean }} [options]
 *   `normalize` (default `true`) — when `false`, the git-root walk is skipped for
 *   explicit paths: the expanded path is used as-is. The `null` (shared store) and
 *   `undefined` (auto-detect) cases are unaffected. Use `normalize: false` to target
 *   an atom stored at a legacy sub-path that predates git-root normalization.
 * @returns {{ scope: string, project: string }}
 */
export function resolveWorkspace(workspace, contextDirectory, options = {}) {
  const { normalize = true } = options;

  if (workspace === null) {
    // Explicit shared store — always shared regardless of directory
    return { scope: 'global', project: '' };
  }

  if (workspace === undefined) {
    // Auto-detect: project if in a git repo, shared if not
    const root = findGitRootOrNull(resolve(contextDirectory));
    return root ? { scope: 'project', project: root } : { scope: 'global', project: '' };
  }

  if (typeof workspace !== 'string') {
    throw new Error('workspace must be null or a string');
  }

  let expanded;
  if (workspace === '.') {
    // "." must be expanded to the resolved contextDirectory first, then walked
    expanded = resolve(contextDirectory);
  } else if (workspace.startsWith('/')) {
    // Absolute path — normalise with resolve() to strip trailing slashes / ".."
    expanded = resolve(workspace);
  } else {
    throw new Error(
      `workspace must be null, ".", or an absolute path — got: "${workspace}"`
    );
  }

  if (!normalize) {
    // Skip git-root walk — use the expanded path as-is.
    return { scope: 'project', project: expanded };
  }

  const root = findGitRootOrNull(expanded);
  if (root) return { scope: 'project', project: root };
  // No git root found for an explicit absolute path — keep the path as-is.
  // Explicit paths are deliberate cross-project overrides and retain scope='project'
  // even when not in a git repo; the "no git → shared" rule governs only auto-detect.
  return { scope: 'project', project: expanded };
}
