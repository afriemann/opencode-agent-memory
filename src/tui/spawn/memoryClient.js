// src/tui/spawn/memoryClient.js — spawn/IO wrapper around memory.js.
//
// Wraps node:child_process execFile (NOT Bun's $ — the TUI runs under plain
// Node). This is a separate implementation from plugin.js's spawnMemory; no
// code is shared between them (see design.md Decision 2).
//
// spec: openspec/changes/memory-tui/specs/memory-tui/spec.md
//   Requirement: Spawn/IO error and timeout surfacing
//   Requirement: Sole-writer boundary (mutation goes through memory.js)

import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const MEMORY_JS_PATH = fileURLToPath(
  new URL('../../memory.js', import.meta.url)
);

const TIMEOUT_MS = 8000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Invoke a memory.js subcommand as a child process and normalise the
 * result into a uniform {ok, data|message} contract. Never throws.
 *
 * @param {string} cmd - memory.js subcommand name.
 * @param {string[]} args - positional arguments for the subcommand.
 * @returns {Promise<{ok: true, data: unknown} | {ok: false, message: string}>}
 */
export function spawnMemory(cmd, args) {
  return new Promise((resolve) => {
    const options = {
      env: {...process.env, AGENT_MEMORY_DB: process.env.AGENT_MEMORY_DB},
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
    };

    execFile(
      process.execPath,
      [MEMORY_JS_PATH, cmd, ...args],
      options,
      (error, stdout, stderr) => {
        if (error) {
          if (error.killed || error.signal === 'SIGTERM') {
            resolve({
              ok: false,
              message: 'memory.js timed out (>8s) — the database may be locked',
            });
            return;
          }
          const trimmedStderr = typeof stderr === 'string' ? stderr.trim() : '';
          resolve({ok: false, message: trimmedStderr || error.message});
          return;
        }

        try {
          const data = JSON.parse(stdout);
          resolve({ok: true, data});
        } catch {
          resolve({ok: false, message: 'malformed response from memory.js'});
        }
      }
    );
  });
}
