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
 * the main tree walks to the filesystem root and falls back to `start`.
 *
 * Returns `start` unchanged when no `.git` directory ancestor is found
 * (graceful fallback for non-git projects or non-existent paths).
 *
 * @param {string} start — absolute path to begin the walk from
 * @returns {string}
 */
export function findGitRoot(start) {
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
      // Reached filesystem root — no .git directory found; return input path
      return start;
    }
    dir = parent;
  }
}

/**
 * Resolve a workspace locator to `{ scope, project }`.
 *
 * Accepted forms:
 *   null / undefined  → `{ scope: 'global', project: '' }`
 *   "."               → git root of `contextDirectory` (expanded first)
 *   "/abs/path"       → git root of `/abs/path`
 *   other relative    → throws a validation error (only "." is accepted as relative)
 *
 * "." is always expanded to `contextDirectory` BEFORE being passed to
 * `findGitRoot` — it must never reach the git-root walk as a literal character.
 *
 * @param {string|null|undefined} workspace
 * @param {string} contextDirectory — absolute path to expand `"."` against
 * @returns {{ scope: string, project: string }}
 */
export function resolveWorkspace(workspace, contextDirectory) {
  if (workspace === null || workspace === undefined) {
    return { scope: 'global', project: '' };
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

  const root = findGitRoot(expanded);
  return { scope: 'project', project: root };
}
