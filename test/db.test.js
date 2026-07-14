// test/db.test.js — openDb PRAGMA safety order tests.
//
// RED-STEP test (fix-error-observability spec scenario EO-S7):
// Verifies that `PRAGMA busy_timeout` is set BEFORE `PRAGMA journal_mode = WAL`
// in openDb(), so that the busy_timeout is already active when WAL mode is
// established (which requires a write lock on first creation).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const dbSource   = readFileSync(join(__dirname, '../src/lib/db.js'), 'utf8');
const srcLines   = dbSource.split('\n');

describe('openDb PRAGMA execution order', () => {
  test('PRAGMA busy_timeout is set before PRAGMA journal_mode = WAL', () => {
    const busyIdx = srcLines.findIndex((l) => l.includes('busy_timeout'));
    const walIdx  = srcLines.findIndex((l) => l.includes('journal_mode'));

    expect(busyIdx).toBeGreaterThanOrEqual(0);
    expect(walIdx).toBeGreaterThanOrEqual(0);
    // Before the fix: busyIdx > walIdx (busy_timeout comes after journal_mode).
    // After the fix: busyIdx < walIdx.
    expect(busyIdx).toBeLessThan(walIdx);
  });
});
