// test/tui/binEntry.test.js
//
// spec: openspec/changes/memory-tui/specs/memory-tui/spec.md
//   Requirement: TUI invocation
//
// A real subprocess smoke test (not mocked) — this is the one place where
// spawning the actual entry point end-to-end is the point, since it exists
// to catch the entry point's own import path breaking, not application
// logic. AGENT_MEMORY_DB is pointed at a scratch path so it never touches a
// real database. This sandboxed environment has no PTY, so Ink's own
// "Raw mode is not supported" error is an accepted, environment-specific
// failure mode here — the assertion only cares that the entry point's own
// module resolution succeeded (no "Cannot find module" / import-path
// defect), not that the interactive UI itself rendered.

import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function runEntryPoint(relativePath) {
  const scratchDir = mkdtempSync(join(tmpdir(), 'agent-memory-tui-bin-test-'));
  try {
    const result = spawnSync(process.execPath, [relativePath], {
      cwd: REPO_ROOT,
      env: {...process.env, AGENT_MEMORY_DB: join(scratchDir, 'scratch.db')},
      encoding: 'utf8',
      timeout: 5000,
      input: '',
    });
    return result;
  } finally {
    rmSync(scratchDir, {recursive: true, force: true});
  }
}

describe('TUI invocation (real subprocess smoke test)', () => {
  it('Launched via bin entry — module resolves without error', () => {
    const result = runEntryPoint('bin/agent-memory-tui');

    expect(result.stderr).not.toMatch(/Cannot find module/);
    expect(result.stdout + result.stderr).not.toMatch(/SyntaxError/);
  });

  it('Launched directly via node — module resolves identically to the bin entry', () => {
    const result = runEntryPoint('src/tui.js');

    expect(result.stderr).not.toMatch(/Cannot find module/);
    expect(result.stdout + result.stderr).not.toMatch(/SyntaxError/);
  });
});
