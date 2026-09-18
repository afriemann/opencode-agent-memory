// test/tui/soleWriterBoundary.test.js
//
// spec: openspec/changes/memory-tui/specs/memory-tui/spec.md
//   Requirement: Sole-writer boundary
//
// Codifies the manual grep check performed at implementation time (tasks.md
// 13.2) as an automated regression test, so a future change can't silently
// reintroduce a direct database import under src/tui/.

import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join, extname} from 'node:path';
import {fileURLToPath} from 'node:url';

const TUI_ROOT = fileURLToPath(new URL('../../src/tui', import.meta.url));

const FORBIDDEN_PATTERNS = [/lib\/db\.js/, /lib\/schema\.js/];

function listJsFiles(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...listJsFiles(fullPath));
    } else if (extname(fullPath) === '.js') {
      files.push(fullPath);
    }
  }
  return files;
}

describe('Sole-writer boundary', () => {
  it('No TUI module imports src/lib/db.js or src/lib/schema.js', () => {
    const files = listJsFiles(TUI_ROOT);
    expect(files.length).toBeGreaterThan(0);

    const offenders = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(content)) {
          offenders.push(`${file} matches ${pattern}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
