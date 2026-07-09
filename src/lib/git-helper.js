// src/lib/git-helper.js — git reconciliation helpers (component 6).
//
// Wraps git rev-parse and rev-list for staleness computation.
// All functions are read-only and never throw (failures degrade gracefully).

/**
 * Get the current HEAD SHA for a project directory.
 * Returns null if git is absent, the directory is not a repo, or any error occurs.
 *
 * @param {Function} $ — tagged-template shell function from the plugin context
 * @param {string} project — absolute path to the project directory
 * @returns {Promise<string|null>}
 */
export async function gitRevParse($, project) {
  try {
    const result = await $`git -C ${project} rev-parse HEAD`.quiet().text();
    const sha = result.trim();
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * Compute the staleness of a stored anchor SHA relative to the current HEAD.
 *
 * @param {Function} $ — tagged-template shell function
 * @param {string} project — absolute path to the project directory
 * @param {string|null} storedSha — the SHA stored in hot_state (null = no anchor)
 * @returns {Promise<
 *   { status: 'ok', distance: number } |
 *   { status: 'no-anchor' } |
 *   { status: 'no-git' } |
 *   { status: 'diverged' }
 * >}
 */
export async function gitStaleness($, project, storedSha) {
  // NULL stored SHA: no anchor was ever recorded (no-git project or first distil
  // in a no-git environment).
  if (!storedSha) return { status: 'no-anchor' };

  try {
    const result = await $`git -C ${project} rev-list --count ${storedSha}..HEAD`.quiet().text();
    const n = parseInt(result.trim(), 10);
    // Non-integer result (e.g. empty output, "fatal:" line) → treat as diverged.
    if (isNaN(n)) return { status: 'diverged' };
    return { status: 'ok', distance: n };
  } catch {
    // The command failed. Distinguish between "no git repo" and "SHA unreachable".
    try {
      await $`git -C ${project} rev-parse HEAD`.quiet().text();
      // git exists but the rev-list failed → SHA is unreachable (rebase/force-push)
      return { status: 'diverged' };
    } catch {
      // git is absent or the directory is not a repo
      return { status: 'no-git' };
    }
  }
}

/**
 * Render a staleness result as one of the three exact primer phrases.
 *
 * @param {{ status: string, distance?: number }} staleness
 * @returns {string}
 */
export function renderStaleness(staleness) {
  if (!staleness) return 'git anchor unavailable';

  switch (staleness.status) {
    case 'ok': {
      const n = staleness.distance ?? 0;
      return `${n} commit(s) since this note`;
    }
    case 'no-anchor':
    case 'no-git':
      return 'git anchor unavailable';
    case 'diverged':
    default:
      return 'history diverged from this note\'s anchor';
  }
}
