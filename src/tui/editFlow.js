// src/tui/editFlow.js — $EDITOR edit flow: temp-file write/diff/cleanup,
// decoupled from Ink rendering (design.md Decision 4 / Decision 6).
//
// spec: openspec/changes/memory-tui/specs/memory-tui/spec.md
//   Requirement: Edit content via $EDITOR
//
// suspendTerminal is injected rather than imported, because it only comes
// from Ink's useApp() hook at render time (see design.md Decision 4).

import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnMemory} from './spawn/memoryClient.js';

const DEFAULT_EDITOR = 'vi';

// POSIX single-quote escaping: wrap in single quotes, and turn every
// embedded single quote into '\'' (close quote, escaped literal quote,
// reopen quote). This is real shell quoting, unlike JSON.stringify (whose
// double-quoted output still permits $(), backticks, and $VAR expansion
// once handed to `sh -c`). filePath is always mkdtemp/tmpdir-derived here,
// so this is currently defense-in-depth rather than a live injection fix —
// kept correct anyway so this helper stays safe if ever reused for a path
// with different provenance.
function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function runEditorProcess(command, filePath) {
  return new Promise((resolve, reject) => {
    // shell:true is required to support multi-word $EDITOR values (e.g.
    // "code --wait"). Combining that with an args array triggers Node's
    // DEP0190 warning (args get concatenated unescaped), so the path is
    // quoted and folded into a single command string instead of passed as
    // a separate array element.
    const quotedPath = shellQuote(filePath);
    const child = spawn(`${command} ${quotedPath}`, {stdio: 'inherit', shell: true});
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });
}

/**
 * Opens `content` in the user's $EDITOR (falling back to `vi`), and — if the
 * editor exits successfully and the content actually changed — persists it
 * via `atom-write`, re-sending the atom's existing description/summary/tags
 * unchanged (atom-write requires non-empty description and has no
 * content-only patch path).
 *
 * @returns {Promise<{changed: false} | {changed: true, content: string}>}
 */
export async function editAtomContent({atom, content, suspendTerminal}) {
  let outcome = {changed: false};

  await suspendTerminal(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-memory-tui-'));
    const filePath = join(dir, 'atom.md');
    try {
      await writeFile(filePath, content ?? '', 'utf8');

      const editor = process.env.EDITOR || DEFAULT_EDITOR;
      const exitCode = await runEditorProcess(editor, filePath);
      if (exitCode !== 0) {
        return;
      }

      const newContent = await readFile(filePath, 'utf8');
      if (newContent === content) {
        return;
      }

      const contextDirectory = atom.scope === 'global' ? process.cwd() : atom.project;
      const workspace = atom.scope === 'global' ? null : '.';
      await spawnMemory('atom-write', [
        contextDirectory,
        JSON.stringify({
          workspace,
          topic: atom.topic,
          content: newContent,
          description: atom.description,
          summary: atom.summary,
          tags: atom.tags,
        }),
      ]);

      outcome = {changed: true, content: newContent};
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  return outcome;
}
