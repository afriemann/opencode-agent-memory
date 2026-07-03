// test/watermark.test.js — distil watermark read/advance tests.

import { DatabaseSync } from 'node:sqlite';
import { ensureSchema } from '../src/lib/schema.js';
import { readDistilWatermark, advanceDistilWatermark } from '../src/lib/watermark.js';

function openMemory() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA busy_timeout = 5000;');
  ensureSchema(db);
  return db;
}

describe('readDistilWatermark', () => {
  test('returns zeros when no row exists', () => {
    const db = openMemory();
    const wm = readDistilWatermark(db, 'ses_unknown');
    expect(wm.last_signal_ms).toBe(0);
    expect(wm.last_distil_ms).toBe(0);
  });

  test('returns stored values after advance', () => {
    const db = openMemory();
    advanceDistilWatermark(db, 'ses_1', 1000, 2000);
    const wm = readDistilWatermark(db, 'ses_1');
    expect(wm.last_signal_ms).toBe(1000);
    expect(wm.last_distil_ms).toBe(2000);
  });
});

describe('advanceDistilWatermark', () => {
  test('upserts a new row', () => {
    const db = openMemory();
    expect(() => advanceDistilWatermark(db, 'ses_new', 500, 600)).not.toThrow();
    const wm = readDistilWatermark(db, 'ses_new');
    expect(wm.last_signal_ms).toBe(500);
    expect(wm.last_distil_ms).toBe(600);
  });

  test('advances last_signal_ms to the higher value', () => {
    const db = openMemory();
    advanceDistilWatermark(db, 'ses_a', 1000, 0);
    advanceDistilWatermark(db, 'ses_a', 2000, 0); // higher → must take effect
    expect(readDistilWatermark(db, 'ses_a').last_signal_ms).toBe(2000);
  });

  test('never decreases last_signal_ms (monotonic — lower value ignored)', () => {
    const db = openMemory();
    advanceDistilWatermark(db, 'ses_b', 5000, 0);
    advanceDistilWatermark(db, 'ses_b', 1000, 0); // lower → must be ignored
    expect(readDistilWatermark(db, 'ses_b').last_signal_ms).toBe(5000);
  });

  test('advances last_distil_ms to the higher value', () => {
    const db = openMemory();
    advanceDistilWatermark(db, 'ses_c', 0, 1000);
    advanceDistilWatermark(db, 'ses_c', 0, 3000);
    expect(readDistilWatermark(db, 'ses_c').last_distil_ms).toBe(3000);
  });

  test('never decreases last_distil_ms (monotonic)', () => {
    const db = openMemory();
    advanceDistilWatermark(db, 'ses_d', 0, 9000);
    advanceDistilWatermark(db, 'ses_d', 0, 100);
    expect(readDistilWatermark(db, 'ses_d').last_distil_ms).toBe(9000);
  });

  test('each session_id has its own watermark row', () => {
    const db = openMemory();
    advanceDistilWatermark(db, 'ses_x', 100, 200);
    advanceDistilWatermark(db, 'ses_y', 300, 400);
    expect(readDistilWatermark(db, 'ses_x').last_signal_ms).toBe(100);
    expect(readDistilWatermark(db, 'ses_y').last_signal_ms).toBe(300);
  });
});
